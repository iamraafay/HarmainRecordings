/**
 * The bulk runner.
 *
 * `sync` is the only part of the pipeline that runs unattended over hundreds of
 * videos, so it is built around the assumption that things go wrong: rate
 * limits, a video pulled from the channel, a transcript that comes back empty.
 * Any of those must cost one video, never the run.
 *
 * Three properties matter:
 *
 *  - **Resumable.** A video with a timeline on disk is skipped. Kill the process
 *    and start it again and it picks up where it stopped, at no cost.
 *  - **Concurrent.** Transcription is almost entirely waiting on Gemini. Run
 *    sequentially and 595 videos takes ten hours; at four at a time it is under
 *    three, and the API is nowhere near its limits.
 *  - **Isolated.** Failures are collected and reported at the end, not thrown.
 */

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";

import { alignSegments, coverageOf, QuranIndex } from "./align.js";
import { transcribeVideo } from "./transcribe.js";
import { ALIGNER_VERSION, type CatalogEntry, type Timeline, type TranscriptSegment } from "./types.js";

export interface SyncOptions {
  apiKey: string;
  model: string;
  index: QuranIndex;
  cacheDir: string;
  timelinesDir: string;
  /** How many videos to transcribe at once. */
  concurrency: number;
  /** Re-transcribe even when a cached transcript exists. */
  force?: boolean;
  log?: (message: string) => void;
}

export interface SyncOutcome {
  videoId: string;
  title: string;
  status: "done" | "skipped" | "empty" | "failed";
  coverage?: number;
  segments?: number;
  error?: string;
}

export interface SyncReport {
  attempted: number;
  done: number;
  skipped: number;
  empty: number;
  failed: number;
  outcomes: SyncOutcome[];
  /** Videos whose coverage came out low enough to be worth a human look. */
  needsReview: SyncOutcome[];
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Coverage below this is reported for review rather than published silently. */
export const REVIEW_THRESHOLD = 0.85;

async function processOne(entry: CatalogEntry, options: SyncOptions): Promise<SyncOutcome> {
  const { videoId, title } = entry;
  const timelinePath = join(options.timelinesDir, `${videoId}.json`);
  const transcriptPath = join(options.cacheDir, `${videoId}.transcript.json`);

  if (!options.force && (await exists(timelinePath))) {
    return { videoId, title, status: "skipped" };
  }

  try {
    // The transcript is cached separately from the timeline on purpose: it is
    // the expensive half. Improving the aligner and re-running costs nothing.
    let segments: TranscriptSegment[];
    let model: string;

    if (!options.force && (await exists(transcriptPath))) {
      const cached = JSON.parse(await readFile(transcriptPath, "utf8")) as {
        segments: TranscriptSegment[];
        model: string;
      };
      segments = cached.segments;
      model = cached.model;
    } else {
      const result = await transcribeVideo(videoId, {
        apiKey: options.apiKey,
        model: options.model,
        durationSeconds: entry.durationSeconds ?? 900,
        log: () => {},
      });
      segments = result.segments;
      model = result.model;
      await writeJson(transcriptPath, result);
    }

    if (segments.length === 0) {
      return { videoId, title, status: "empty" };
    }

    const aligned = alignSegments(segments, options.index);
    const coverage = coverageOf(aligned);
    const timeline: Timeline = {
      videoId,
      generatedAt: new Date().toISOString(),
      modelVersion: model,
      alignerVersion: ALIGNER_VERSION,
      coverage,
      segments: aligned,
    };
    await writeJson(timelinePath, timeline);

    return { videoId, title, status: "done", coverage, segments: aligned.length };
  } catch (error) {
    return { videoId, title, status: "failed", error: (error as Error).message };
  }
}

/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * A hand-rolled pool rather than chunked `Promise.all`: chunking stalls on the
 * slowest item in each chunk, and salah lengths vary from eight minutes to two
 * hours. A pool keeps every slot busy.
 */
async function pool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}

export async function runSync(entries: CatalogEntry[], options: SyncOptions): Promise<SyncReport> {
  const log = options.log ?? console.log;
  let completed = 0;

  const outcomes = await pool(entries, options.concurrency, async (entry) => {
    const outcome = await processOne(entry, options);
    completed++;

    const badge =
      outcome.status === "done"
        ? `${((outcome.coverage ?? 0) * 100).toFixed(0)}% coverage`
        : outcome.status === "failed"
          ? `FAILED ${outcome.error?.slice(0, 70)}`
          : outcome.status;

    log(`[${String(completed).padStart(4)}/${entries.length}] ${badge.padEnd(26)} ${entry.title}`);
    return outcome;
  });

  const by = (status: SyncOutcome["status"]) => outcomes.filter((o) => o.status === status);
  return {
    attempted: entries.length,
    done: by("done").length,
    skipped: by("skipped").length,
    empty: by("empty").length,
    failed: by("failed").length,
    outcomes,
    needsReview: by("done").filter((o) => (o.coverage ?? 1) < REVIEW_THRESHOLD),
  };
}

export function formatReport(report: SyncReport): string {
  const lines = ["", "Sync report", "─".repeat(56)];
  lines.push(`attempted     ${report.attempted}`);
  lines.push(`analysed      ${report.done}`);
  lines.push(`already done  ${report.skipped}`);
  lines.push(`no Qur'an     ${report.empty}`);
  lines.push(`failed        ${report.failed}`);

  if (report.failed > 0) {
    lines.push("");
    lines.push("Failures (re-run sync to retry — completed work is not repeated):");
    for (const outcome of report.outcomes.filter((o) => o.status === "failed").slice(0, 10)) {
      lines.push(`  ${outcome.videoId}  ${outcome.error?.slice(0, 90)}`);
    }
  }

  if (report.needsReview.length > 0) {
    lines.push("");
    lines.push(`Low coverage — worth a look before publishing (${report.needsReview.length}):`);
    for (const outcome of report.needsReview.slice(0, 10)) {
      lines.push(`  ${((outcome.coverage ?? 0) * 100).toFixed(0)}%  ${outcome.title}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
