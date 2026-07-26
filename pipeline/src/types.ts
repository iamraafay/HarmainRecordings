/** Shared domain types. These mirror the Swift types in HRCore. */

export type Mosque = "makkah" | "madeenah";

export type Prayer =
  | "fajr"
  | "dhuhr"
  | "asr"
  | "maghrib"
  | "isha"
  | "jumuah"
  | "taraweeh"
  | "tahajjud"
  | "witr"
  | "eid"
  | "janazah"
  | "istisqa"
  | "kusuf"
  | "other";

/** What `parseTitle` extracts from a raw YouTube video title. */
export interface ParsedTitle {
  /** ISO yyyy-mm-dd, or null when the title carried no usable date. */
  date: string | null;
  mosque: Mosque | null;
  prayer: Prayer | null;
  /** True for the call-to-prayer videos, which contain no Quran and are skipped by the analyzer. */
  isAdhaan: boolean;
  /** Sheikh name as written, minus the "Sheikh"/"Shaykh" honorific. */
  sheikh: string | null;
  /** Canonical key for grouping aliases: lowercased, punctuation-stripped. */
  sheikhKey: string | null;
  /** 0..1 — how much of the title we understood. Below `MIN_TITLE_CONFIDENCE` it lands in unparsed.json. */
  confidence: number;
  /** Tokens the parser could not account for. Useful for spotting new title formats. */
  leftovers: string[];
}

export interface CatalogEntry extends ParsedTitle {
  videoId: string;
  title: string;
  publishedAt: string;
  /** Seconds. Null when the source (RSS) does not report duration. */
  durationSeconds: number | null;
  /** True once a timeline JSON exists for this video. */
  analyzed?: boolean;
}

export interface Catalog {
  channelId: string;
  generatedAt: string;
  count: number;
  entries: CatalogEntry[];
}

/** One transcribed span of recitation, straight from Gemini, before alignment. */
export interface TranscriptSegment {
  /** Absolute seconds from the start of the video. */
  t0: number;
  t1: number;
  /** Arabic as heard. May contain ASR errors — that is the aligner's problem. */
  arabic: string;
}

/** One aligned ayah. `surah`/`ayah` are null when nothing matched confidently. */
export interface TimelineSegment {
  t0: number;
  t1: number;
  surah: number | null;
  ayah: number | null;
  /** 0..1 similarity between the transcript and the matched ayah. */
  conf: number;
  /** Set when the match is partial (imam recited only part of the ayah). */
  partial?: boolean;
}

export interface Timeline {
  videoId: string;
  generatedAt: string;
  modelVersion: string;
  alignerVersion: string;
  /** Fraction of segments that matched above threshold. The number to watch. */
  coverage: number;
  segments: TimelineSegment[];
}

export const ALIGNER_VERSION = "1.0.0";
export const MIN_TITLE_CONFIDENCE = 0.6;
