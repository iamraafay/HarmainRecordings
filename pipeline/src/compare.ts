/**
 * Flash versus Pro, decided by measurement rather than by vibes.
 *
 * This is the cheapest high-leverage experiment in the project: it costs a
 * couple of dollars and decides whether the full archive costs ~$550 or ~$4,000.
 *
 * The trick is that we already have a scoring function that needs no human
 * judgement. The aligner reports, per video, what fraction of transcribed
 * segments matched a real ayah and how confidently. A model that mishears
 * produces segments the aligner cannot place — so **alignment coverage is a
 * proxy for transcription quality**, and it is free to compute.
 *
 * Where a hand-labelled ground truth exists (see `test/fixtures`), the
 * comparison also reports exact verse agreement, which is stronger evidence.
 */

import { alignSegments, coverageOf, QuranIndex } from "./align.js";
import { transcribeVideo } from "./transcribe.js";
import type { CatalogEntry, TimelineSegment } from "./types.js";

export interface ModelResult {
  model: string;
  videoId: string;
  segmentCount: number;
  coverage: number;
  meanConfidence: number;
  /** Segments the aligner refused to place. */
  unmatched: number;
  elapsedMs: number;
  error?: string;
  segments: TimelineSegment[];
}

export interface ComparisonRow {
  videoId: string;
  title: string;
  results: ModelResult[];
  /** Fraction of positions where the models agree on the verse, when both ran. */
  agreement: number | null;
}

function meanConfidence(segments: TimelineSegment[]): number {
  const matched = segments.filter((segment) => segment.surah !== null);
  if (matched.length === 0) return 0;
  return matched.reduce((sum, segment) => sum + segment.conf, 0) / matched.length;
}

/**
 * How much two runs agree on what was recited.
 *
 * Uses the longest common subsequence of the two verse sequences, not a
 * position-by-position comparison.
 *
 * The first version of this compared index to index, and it was badly wrong. A
 * weaker model emits the same verses but with extra unmatched fragments in
 * between; those shift every later position, so two runs that agreed
 * completely on the recitation scored 72%. That number sent me looking for a
 * disagreement that did not exist — and, by luck, into a real aligner bug
 * instead. A metric that can be off by 28% is worse than no metric.
 *
 * LCS ignores insertions and deletions and asks the question that actually
 * matters: did both runs hear the same verses, in the same order?
 */
export function verseAgreement(a: TimelineSegment[], b: TimelineSegment[]): number {
  const keysOf = (segments: TimelineSegment[]) =>
    segments.filter((segment) => segment.surah !== null).map((segment) => `${segment.surah}:${segment.ayah}`);
  const left = keysOf(a);
  const right = keysOf(b);
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;

  // Rolling two-row LCS — the full matrix is unnecessary for a length count.
  let previous = new Array<number>(right.length + 1).fill(0);
  let current = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i++) {
    current[0] = 0;
    for (let j = 1; j <= right.length; j++) {
      current[j] =
        left[i - 1] === right[j - 1]
          ? previous[j - 1]! + 1
          : Math.max(previous[j]!, current[j - 1]!);
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length]! / Math.max(left.length, right.length);
}

export interface CompareOptions {
  apiKey: string;
  models: string[];
  index: QuranIndex;
  log?: (message: string) => void;
}

async function runOne(
  entry: CatalogEntry,
  model: string,
  options: CompareOptions,
): Promise<ModelResult> {
  const started = Date.now();
  try {
    const transcript = await transcribeVideo(entry.videoId, {
      apiKey: options.apiKey,
      model,
      durationSeconds: entry.durationSeconds ?? 900,
      log: () => {},
    });
    const segments = alignSegments(transcript.segments, options.index);
    return {
      model,
      videoId: entry.videoId,
      segmentCount: segments.length,
      coverage: coverageOf(segments),
      meanConfidence: meanConfidence(segments),
      unmatched: segments.filter((segment) => segment.surah === null).length,
      elapsedMs: Date.now() - started,
      segments,
    };
  } catch (error) {
    return {
      model,
      videoId: entry.videoId,
      segmentCount: 0,
      coverage: 0,
      meanConfidence: 0,
      unmatched: 0,
      elapsedMs: Date.now() - started,
      error: (error as Error).message,
      segments: [],
    };
  }
}

export async function compareModels(
  entries: CatalogEntry[],
  options: CompareOptions,
): Promise<ComparisonRow[]> {
  const log = options.log ?? console.log;
  const rows: ComparisonRow[] = [];

  for (const [position, entry] of entries.entries()) {
    log(`[${position + 1}/${entries.length}] ${entry.title}`);
    const results: ModelResult[] = [];
    for (const model of options.models) {
      const result = await runOne(entry, model, options);
      results.push(result);
      log(
        result.error
          ? `    ${model.padEnd(20)} FAILED — ${result.error.slice(0, 90)}`
          : `    ${model.padEnd(20)} coverage ${(result.coverage * 100).toFixed(0).padStart(3)}%  ` +
              `conf ${result.meanConfidence.toFixed(2)}  ` +
              `${result.segmentCount} segments  ${(result.elapsedMs / 1000).toFixed(0)}s`,
      );
    }

    const [first, second] = results;
    rows.push({
      videoId: entry.videoId,
      title: entry.title,
      results,
      agreement:
        first && second && !first.error && !second.error
          ? verseAgreement(first.segments, second.segments)
          : null,
    });
  }

  return rows;
}

export function formatComparison(rows: ComparisonRow[], models: string[]): string {
  const lines: string[] = ["", "Model comparison", "─".repeat(64)];

  for (const model of models) {
    const results = rows.map((row) => row.results.find((r) => r.model === model)).filter(Boolean) as ModelResult[];
    const ok = results.filter((result) => !result.error);
    if (ok.length === 0) {
      lines.push(`${model.padEnd(22)} all runs failed`);
      continue;
    }
    const avg = (pick: (r: ModelResult) => number) =>
      ok.reduce((sum, result) => sum + pick(result), 0) / ok.length;
    lines.push(
      `${model.padEnd(22)} coverage ${(avg((r) => r.coverage) * 100).toFixed(1)}%   ` +
        `confidence ${avg((r) => r.meanConfidence).toFixed(3)}   ` +
        `${(avg((r) => r.elapsedMs) / 1000).toFixed(0)}s/video   ` +
        `${results.length - ok.length} failed`,
    );
  }

  const agreements = rows.map((row) => row.agreement).filter((value): value is number => value !== null);
  if (agreements.length > 0) {
    const mean = agreements.reduce((sum, value) => sum + value, 0) / agreements.length;
    lines.push("");
    lines.push(`verse agreement between models: ${(mean * 100).toFixed(1)}%`);
    lines.push(
      mean > 0.95
        ? "  -> the models effectively agree. Use the cheaper one."
        : mean > 0.85
          ? "  -> mostly agree. Spot-check the disagreements before choosing."
          : "  -> they disagree materially. Hand-label a few and see which is right.",
    );
  }

  lines.push("");
  return lines.join("\n");
}
