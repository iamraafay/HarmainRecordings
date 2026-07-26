/**
 * Gemini transcription of a salah recording.
 *
 * Scope note: the model is asked to do exactly one thing — write down the
 * Arabic it hears, with timestamps. It is never asked which surah or ayah that
 * is. Verse identification happens in `align.ts`, where it can be measured and
 * fixed. A model that mishears a word produces a slightly wrong string the
 * aligner still matches; a model that misidentifies a verse produces a
 * confident lie nothing downstream can catch.
 *
 * Videos are processed in overlapping windows because Gemini's timestamp
 * accuracy degrades over long media. Each window is re-anchored to absolute
 * video time on the way out.
 */

import { GoogleGenAI, MediaResolution } from "@google/genai";
import type { TranscriptSegment } from "./types.js";

export const DEFAULT_MODEL = "gemini-2.5-pro";

/** Window length in seconds. Short enough to keep timestamps tight. */
export const WINDOW_SECONDS = 600;
/** Overlap between windows so an ayah spanning a boundary is not lost. */
export const WINDOW_OVERLAP_SECONDS = 20;

const PROMPT = `You are transcribing the audio of a congregational prayer (salah) recorded at Masjid al-Haram or Masjid an-Nabawi.

Transcribe ONLY the recited Qur'an. Write the Arabic in standard Arabic script.

Include:
- Qur'anic recitation by the imam, including the opening Surah Al-Fatihah of each rak'ah.

Exclude entirely (do not emit segments for these):
- takbir ("Allahu akbar"), tasmi', tasbih, tashahhud
- du'a and qunut that is not Qur'an
- the adhan or iqamah
- any speech, announcements, or crowd noise
- silence

Rules:
- Emit one segment per ayah wherever you can hear the boundary. If you cannot, a segment may span several ayahs.
- "start" and "end" are timestamps in MM:SS or HH:MM:SS, measured from the beginning of THIS audio clip.
- Segments must be in chronological order and must not overlap.
- Transcribe what you actually hear. Do not correct, complete, or continue a verse from memory. If the imam stops mid-ayah, stop mid-ayah.
- If nothing Qur'anic is recited, return an empty array.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "string", description: "MM:SS or HH:MM:SS from the start of this clip" },
          end: { type: "string", description: "MM:SS or HH:MM:SS from the start of this clip" },
          arabic: { type: "string", description: "The Arabic actually heard" },
        },
        required: ["start", "end", "arabic"],
      },
    },
  },
  required: ["segments"],
} as const;

/** `1:02:03` / `12:34` / `45` -> seconds. Returns null on nonsense. */
export function parseTimestamp(value: string): number | null {
  const parts = value.trim().split(":").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return null;
}

export interface Window {
  start: number;
  end: number;
}

/** Splits a duration into overlapping windows. A short video yields one window. */
export function planWindows(
  durationSeconds: number,
  windowSeconds = WINDOW_SECONDS,
  overlap = WINDOW_OVERLAP_SECONDS,
): Window[] {
  if (durationSeconds <= windowSeconds) return [{ start: 0, end: Math.ceil(durationSeconds) }];
  const windows: Window[] = [];
  let start = 0;
  while (start < durationSeconds) {
    const end = Math.min(durationSeconds, start + windowSeconds);
    windows.push({ start: Math.floor(start), end: Math.ceil(end) });
    if (end >= durationSeconds) break;
    start = end - overlap;
  }
  return windows;
}

interface RawSegment {
  start: string;
  end: string;
  arabic: string;
}

/**
 * Converts a window's segments to absolute video time.
 *
 * The API documents `start_offset` as clipping the media, which implies
 * returned timestamps are relative to the clip — but that is worth not betting
 * on. If every timestamp already falls inside the window's absolute range and
 * the window does not start at zero, they are taken as absolute. Verify this
 * against a known video before trusting long-video output.
 */
export function anchorToAbsolute(segments: TranscriptSegment[], window: Window): TranscriptSegment[] {
  if (window.start === 0 || segments.length === 0) return segments;

  const windowLength = window.end - window.start;
  const maxTime = Math.max(...segments.map((s) => s.t1));
  const minTime = Math.min(...segments.map((s) => s.t0));
  const looksAbsolute = minTime >= window.start - 1 && maxTime <= window.end + 5 && maxTime > windowLength;

  if (looksAbsolute) return segments;
  return segments.map((s) => ({ ...s, t0: s.t0 + window.start, t1: s.t1 + window.start }));
}

/** Drops segments that duplicate the previous window's overlap region. */
export function dedupeOverlap(segments: TranscriptSegment[]): TranscriptSegment[] {
  const sorted = [...segments].sort((a, b) => a.t0 - b.t0);
  const out: TranscriptSegment[] = [];
  for (const segment of sorted) {
    const prev = out[out.length - 1];
    // Same text inside the overlap region: the second window heard it again.
    if (prev && segment.t0 < prev.t1 - 0.5 && segment.arabic.trim() === prev.arabic.trim()) continue;
    const trimmed = prev && segment.t0 < prev.t1 ? { ...segment, t0: prev.t1 } : segment;
    if (trimmed.t1 - trimmed.t0 < 0.2) continue;
    out.push(trimmed);
  }
  return out;
}

export interface TranscribeOptions {
  apiKey: string;
  model?: string;
  /** Total video length in seconds; drives windowing. */
  durationSeconds: number;
  log?: (m: string) => void;
}

export interface TranscribeResult {
  model: string;
  segments: TranscriptSegment[];
  windows: number;
}

/**
 * Transcribes a public YouTube video. Private and unlisted videos are not
 * supported by the API and will fail.
 */
export async function transcribeVideo(
  videoId: string,
  options: TranscribeOptions,
): Promise<TranscribeResult> {
  const log = options.log ?? console.log;
  const model = options.model ?? DEFAULT_MODEL;
  const ai = new GoogleGenAI({ apiKey: options.apiKey });
  const windows = planWindows(options.durationSeconds);
  const all: TranscriptSegment[] = [];

  log(`transcribing ${videoId} in ${windows.length} window(s) with ${model}`);

  for (const [i, window] of windows.entries()) {
    log(`  window ${i + 1}/${windows.length}: ${window.start}s–${window.end}s`);

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` },
              videoMetadata: { startOffset: `${window.start}s`, endOffset: `${window.end}s` },
            },
            { text: PROMPT },
          ],
        },
      ],
      config: {
        // Only the audio matters; the picture is a near-static mosque shot.
        // Low resolution cuts token cost roughly threefold.
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0,
      },
    });

    const text = response.text;
    if (!text) {
      log(`  window ${i + 1} returned no text — skipping`);
      continue;
    }

    let parsed: { segments?: RawSegment[] };
    try {
      parsed = JSON.parse(text) as { segments?: RawSegment[] };
    } catch {
      log(`  window ${i + 1} returned unparseable JSON — skipping`);
      continue;
    }

    const converted: TranscriptSegment[] = [];
    for (const raw of parsed.segments ?? []) {
      const t0 = parseTimestamp(raw.start);
      const t1 = parseTimestamp(raw.end);
      if (t0 === null || t1 === null || t1 <= t0) continue;
      if (!raw.arabic?.trim()) continue;
      converted.push({ t0, t1, arabic: raw.arabic.trim() });
    }

    all.push(...anchorToAbsolute(converted, window));
    log(`  window ${i + 1}: ${converted.length} segments`);
  }

  return { model, segments: dedupeOverlap(all), windows: windows.length };
}
