/**
 * Turns the catalogue into a bill before you pay it.
 *
 * Every number here except the token rates comes from the actual catalogue, so
 * once `catalog` has run with a YouTube Data API key — which returns exact
 * durations for free — this stops being an estimate and becomes arithmetic.
 *
 * Rates last checked July 2026 against https://ai.google.dev/gemini-api/docs/pricing
 * and https://ai.google.dev/gemini-api/docs/video-understanding. Prices move;
 * `--rate` lets you override without editing code.
 */

import { partition } from "./prayerRules.js";
import type { CatalogEntry } from "./types.js";

/**
 * Tokens per second of video at `MEDIA_RESOLUTION_LOW`.
 *
 * Measured, not assumed: a 60-second window of HcWru4_Soxs billed 5,519 input
 * tokens across three different models — 92 tokens/second. The split below is
 * the documented video/audio breakdown and only matters for models that price
 * the two differently (the 2.5 line did; the 3.x line does not).
 */
export const TOKENS_PER_SECOND = {
  video: 60,
  audio: 32,
} as const;

export interface ModelPricing {
  id: string;
  label: string;
  /** USD per million input tokens for the video stream. */
  videoInput: number;
  /** USD per million input tokens for the audio stream. */
  audioInput: number;
  /** USD per million output tokens. Thinking tokens bill at this rate too. */
  output: number;
}

/**
 * Only models a current API key can actually reach.
 *
 * The 2.5 line is retired for new accounts — `gemini-2.5-flash` still appears
 * in `models.list` but `generateContent` returns 404 "no longer available to
 * new users". That retirement is what makes this job cost about $100 rather
 * than about $20: 2.5 Flash took video input at $0.30/M, and nothing in the
 * 3.x line that can do the job is cheaper than $1.50/M.
 *
 * Flash-Lite is priced like the old 2.5 Flash but is disqualified on quality,
 * not cost — see the note on `MODEL_QUALITY` below.
 */
export const MODELS: ModelPricing[] = [
  {
    id: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    videoInput: 1.5,
    audioInput: 1.5,
    output: 7.5,
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    videoInput: 1.5,
    audioInput: 1.5,
    output: 9.0,
  },
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    videoInput: 0.3,
    audioInput: 0.3,
    output: 2.5,
  },
];

/**
 * What a 60-second probe of a known salah produced, for reference.
 *
 * The window covered Al-Fatihah 1:2-1:7 — six short ayahs with clear pauses,
 * the easiest possible segmentation task.
 *
 *   gemini-3.5-flash-lite  ONE 27-second blob containing four ayahs, the rest
 *                          dropped. 49 output tokens. Cannot drive per-ayah
 *                          sync at any price.
 *   gemini-3.6-flash       Six segments, one per ayah, timestamps within a
 *                          second of hand-checked truth. Absolute timestamps.
 *   gemini-3.1-pro-preview Correct verses but split 1:7 across two segments,
 *                          and returned clip-relative timestamps.
 *
 * Flash-Lite being five times cheaper is irrelevant when its output cannot be
 * aligned. Cost per *usable* timeline is what matters.
 */
export const MODEL_QUALITY = {
  recommended: "gemini-3.6-flash",
  disqualified: ["gemini-3.5-flash-lite"],
} as const;

/** The Batch API trades latency for half the price. This work is not latency-sensitive. */
export const BATCH_DISCOUNT = 0.5;

/**
 * Output tokens per minute of video.
 *
 * Measured: gemini-3.6-flash emitted 402 output tokens for a 60-second window.
 * That window was unusually dense (six short ayahs back to back), so 350 is
 * used as a slightly optimistic average across a whole salah, where long ayahs
 * produce fewer segments per minute.
 */
export const OUTPUT_TOKENS_PER_MINUTE = 350;

/**
 * Fallback duration for entries with no reported length, in seconds.
 *
 * Only used when the catalogue came from RSS, which carries no durations. With
 * a Data API key every entry has a real duration and this is never consulted.
 */
export const ASSUMED_DURATION: Record<string, number> = {
  fajr: 1200,
  maghrib: 600,
  isha: 900,
  jumuah: 1500,
  taraweeh: 5400,
  tahajjud: 5400,
  default: 900,
};

export interface CostLine {
  model: ModelPricing;
  inputCost: number;
  outputCost: number;
  total: number;
  batchTotal: number;
}

export interface Estimate {
  videoCount: number;
  skipped: Record<string, number>;
  totalSeconds: number;
  /** True when any duration was guessed rather than reported. */
  hasAssumedDurations: boolean;
  assumedCount: number;
  videoTokens: number;
  audioTokens: number;
  outputTokens: number;
  lines: CostLine[];
}

function durationOf(entry: CatalogEntry): { seconds: number; assumed: boolean } {
  if (entry.durationSeconds && entry.durationSeconds > 0) {
    return { seconds: entry.durationSeconds, assumed: false };
  }
  const key = entry.prayer ?? "default";
  return { seconds: ASSUMED_DURATION[key] ?? ASSUMED_DURATION.default!, assumed: true };
}

export function estimate(entries: CatalogEntry[], models: ModelPricing[] = MODELS): Estimate {
  const { analyzable, skipped } = partition(entries);

  const skippedCounts: Record<string, number> = {};
  for (const item of skipped) {
    skippedCounts[item.reason] = (skippedCounts[item.reason] ?? 0) + 1;
  }

  let totalSeconds = 0;
  let assumedCount = 0;
  for (const entry of analyzable) {
    const { seconds, assumed } = durationOf(entry);
    totalSeconds += seconds;
    if (assumed) assumedCount++;
  }

  const videoTokens = totalSeconds * TOKENS_PER_SECOND.video;
  const audioTokens = totalSeconds * TOKENS_PER_SECOND.audio;
  const outputTokens = (totalSeconds / 60) * OUTPUT_TOKENS_PER_MINUTE;

  const lines = models.map((model) => {
    const inputCost =
      (videoTokens / 1_000_000) * model.videoInput + (audioTokens / 1_000_000) * model.audioInput;
    const outputCost = (outputTokens / 1_000_000) * model.output;
    const total = inputCost + outputCost;
    return {
      model,
      inputCost,
      outputCost,
      total,
      batchTotal: total * BATCH_DISCOUNT,
    };
  });

  return {
    videoCount: analyzable.length,
    skipped: skippedCounts,
    totalSeconds,
    hasAssumedDurations: assumedCount > 0,
    assumedCount,
    videoTokens,
    audioTokens,
    outputTokens,
    lines,
  };
}

/** Keeps only entries published within the last `days` days. */
export function withinLastDays(entries: CatalogEntry[], days: number): CatalogEntry[] {
  const cutoff = Date.now() - days * 86_400_000;
  return entries.filter((entry) => Date.parse(entry.publishedAt) >= cutoff);
}

const usd = (value: number) => `$${value.toFixed(2)}`;
const hours = (seconds: number) => `${(seconds / 3600).toFixed(1)}h`;

export function formatEstimate(result: Estimate, scope: string): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`Cost estimate — ${scope}`);
  lines.push("─".repeat(56));
  lines.push(`videos to analyse   ${result.videoCount}`);
  for (const [reason, count] of Object.entries(result.skipped)) {
    lines.push(`  skipped (${reason})`.padEnd(22) + count);
  }
  lines.push(`total runtime       ${hours(result.totalSeconds)}`);
  lines.push(
    `input tokens        ${(result.videoTokens + result.audioTokens).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
  );
  lines.push(
    `output tokens       ${result.outputTokens.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
  );
  lines.push("");
  lines.push("  model".padEnd(24) + "standard".padStart(12) + "batch (-50%)".padStart(16));
  for (const line of result.lines) {
    lines.push(
      `  ${line.model.label}`.padEnd(24) +
        usd(line.total).padStart(12) +
        usd(line.batchTotal).padStart(16),
    );
  }

  if (result.hasAssumedDurations) {
    lines.push("");
    lines.push(
      `  ${result.assumedCount} of ${result.videoCount} durations were assumed (RSS carries none).`,
    );
    lines.push(`  Set YOUTUBE_API_KEY and re-run catalog for exact figures.`);
  }
  lines.push("");
  return lines.join("\n");
}
