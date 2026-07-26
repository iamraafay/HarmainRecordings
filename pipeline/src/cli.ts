#!/usr/bin/env tsx
/**
 * Pipeline CLI.
 *
 *   npm run catalog                 build dist/catalog.json (+ dist/unparsed.json)
 *   npm run quran                   build dist/quran.sqlite
 *   npm run transcribe -- <videoId> Gemini transcript -> cache/<id>.transcript.json
 *   npm run align -- <videoId>      transcript -> dist/timelines/<id>.json
 *   npm run sync                    catalog, then transcribe+align anything new
 *
 * Environment:
 *   YOUTUBE_API_KEY   optional; without it the catalogue falls back to RSS (15 videos)
 *   GEMINI_API_KEY    required for transcribe/sync
 */

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { alignSegments, coverageOf, QuranIndex } from "./align.js";
import { buildCatalog } from "./catalog.js";
import { compareModels, formatComparison } from "./compare.js";
import { estimate, formatEstimate, withinLastDays } from "./estimate.js";
import { partition, REASON_LABELS } from "./prayerRules.js";
import { buildQuranDatabase, loadAyahs } from "./quran.js";
import { generateSite } from "./site.js";
import { formatReport, runSync } from "./sync.js";
import { parseTimestamp, transcribeVideo } from "./transcribe.js";
import { ALIGNER_VERSION, type Catalog, type Timeline, type TranscriptSegment } from "./types.js";

/** Recent uploads get the stronger model; see the note in estimate.ts. */
const DEFAULT_SYNC_MODEL = "gemini-3.6-flash";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const CACHE = join(ROOT, "cache");
const TIMELINES = join(DIST, "timelines");
const QURAN_DB = join(DIST, "quran.sqlite");

const log = (msg: string) => console.log(msg);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function cmdCatalog(): Promise<void> {
  const { catalog, unparsed, source } = await buildCatalog({
    apiKey: process.env.YOUTUBE_API_KEY,
    log,
  });

  await writeJson(join(DIST, "catalog.json"), catalog);
  await writeJson(join(DIST, "unparsed.json"), unparsed);

  const withPrayer = catalog.entries.filter((e) => e.prayer || e.isAdhaan).length;
  const sheikhs = new Set(catalog.entries.map((e) => e.sheikhKey).filter(Boolean));

  log("");
  log(`source            ${source}`);
  log(`videos            ${catalog.count}`);
  log(`prayer identified ${withPrayer} (${pct(withPrayer, catalog.count)})`);
  log(`distinct sheikhs  ${sheikhs.size}`);
  log(`needs review      ${unparsed.length} -> dist/unparsed.json`);
  log("");
  for (const e of catalog.entries.slice(0, 8)) {
    log(
      `  ${e.date ?? "????-??-??"}  ${(e.mosque ?? "?").padEnd(9)} ${(e.isAdhaan ? "adhaan" : e.prayer ?? "?").padEnd(9)} ${e.sheikh ?? ""}`,
    );
  }
}

async function cmdQuran(): Promise<void> {
  const result = await buildQuranDatabase(QURAN_DB, undefined, log);
  log("");
  log(`wrote ${result.path}`);
  log(`  ${result.ayahCount} ayahs`);
  for (const t of result.translations) log(`  ${t.id}: ${t.rows} rows`);
}

async function cmdTranscribe(videoId: string): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const catalogPath = join(DIST, "catalog.json");
  let duration: number | null = null;
  if (await exists(catalogPath)) {
    const catalog = await readJson<Catalog>(catalogPath);
    duration = catalog.entries.find((e) => e.videoId === videoId)?.durationSeconds ?? null;
  }
  if (duration === null) {
    // RSS carries no duration. 25 minutes covers a daily fard salah; the
    // windowing is harmless if the real video is shorter.
    duration = 1500;
    log("duration unknown (no Data API key?) — assuming 25 minutes");
  }

  const result = await transcribeVideo(videoId, { apiKey, durationSeconds: duration, log });
  const path = join(CACHE, `${videoId}.transcript.json`);
  await writeJson(path, result);
  log("");
  log(`wrote ${path} — ${result.segments.length} segments across ${result.windows} window(s)`);
}

/**
 * Imports a transcript produced by hand — typically by pasting the
 * transcription prompt into the Gemini app and copying the JSON back out.
 *
 * This exists so the aligner can be developed and evaluated with no API key at
 * all, and so a video the API refuses can still be processed manually.
 * Accepts either `[{start,end,arabic}]` or `{segments:[…]}`.
 */
async function cmdImport(videoId: string, filePath: string): Promise<void> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as
    | { start: string; end: string; arabic: string }[]
    | { segments: { start: string; end: string; arabic: string }[] };
  const rows = Array.isArray(raw) ? raw : raw.segments;

  const segments: TranscriptSegment[] = [];
  for (const row of rows) {
    const t0 = parseTimestamp(row.start);
    const t1 = parseTimestamp(row.end);
    if (t0 === null || t1 === null || t1 <= t0 || !row.arabic?.trim()) continue;
    segments.push({ t0, t1, arabic: row.arabic.trim() });
  }

  const path = join(CACHE, `${videoId}.transcript.json`);
  await writeJson(path, { model: "manual-import", segments, windows: 1 });
  log(`imported ${segments.length} segments -> ${path}`);
}

async function cmdAlign(videoId: string): Promise<void> {
  if (!(await exists(QURAN_DB))) throw new Error(`${QURAN_DB} missing — run: npm run quran`);
  const transcriptPath = join(CACHE, `${videoId}.transcript.json`);
  if (!(await exists(transcriptPath))) {
    throw new Error(`${transcriptPath} missing — run: npm run transcribe -- ${videoId}`);
  }

  const { segments, model } = await readJson<{ segments: TranscriptSegment[]; model: string }>(
    transcriptPath,
  );
  const index = new QuranIndex(loadAyahs(QURAN_DB));
  const aligned = alignSegments(segments, index);
  const coverage = coverageOf(aligned);

  const timeline: Timeline = {
    videoId,
    generatedAt: new Date().toISOString(),
    modelVersion: model,
    alignerVersion: ALIGNER_VERSION,
    coverage,
    segments: aligned,
  };
  const path = join(TIMELINES, `${videoId}.json`);
  await writeJson(path, timeline);

  log(`wrote ${path}`);
  log(`  ${aligned.length} segments, coverage ${(coverage * 100).toFixed(1)}%`);
  const low = aligned.filter((s) => s.surah !== null && s.conf < 0.75).length;
  if (low) log(`  ${low} low-confidence matches worth eyeballing`);
}

/**
 * Runs several models over the same videos and scores them by how well the
 * aligner could place what they heard. Costs a couple of dollars and settles
 * the model choice for the whole archive.
 */
async function cmdCompare(count: number, models: string[]): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  if (!(await exists(QURAN_DB))) throw new Error(`${QURAN_DB} missing — run: npm run quran`);

  const catalog = await readJson<Catalog>(join(DIST, "catalog.json"));
  const { analyzable } = partition(catalog.entries);
  const sample = analyzable.slice(0, count);
  if (sample.length === 0) throw new Error("no analysable videos in the catalogue");

  log(`comparing ${models.join(" vs ")} over ${sample.length} video(s)`);
  const index = new QuranIndex(loadAyahs(QURAN_DB));
  const rows = await compareModels(sample, { apiKey, models, index, log });

  await writeJson(join(DIST, "comparison.json"), { generatedAt: new Date().toISOString(), models, rows });
  log(formatComparison(rows, models));
  log(`full detail in dist/comparison.json`);
}

async function cmdEstimate(days?: number): Promise<void> {
  const catalog = await readJson<Catalog>(join(DIST, "catalog.json"));
  const entries = days ? withinLastDays(catalog.entries, days) : catalog.entries;
  const scope = days ? `last ${days} days` : `entire catalogue`;
  log(formatEstimate(estimate(entries), `${scope} (${entries.length} uploads)`));
}

async function cmdSite(): Promise<void> {
  const result = await generateSite({
    catalogPath: join(DIST, "catalog.json"),
    timelinesDir: TIMELINES,
    quranDbPath: QURAN_DB,
    outDir: join(ROOT, "site"),
    log,
  });
  log("");
  log(`open pipeline/site/index.html`);
  log(`  ${result.pages} pages, ${result.analysed} analysed recordings`);
}

/**
 * Bulk run. Concurrent, resumable, and isolates per-video failures.
 *
 *   npm run sync                      last 90 days, default model
 *   npm run sync -- --days 90         explicit window
 *   npm run sync -- --limit 10        pilot a handful first
 *   npm run sync -- --model gemini-3.5-flash-lite --before 2026-01-01
 */
async function cmdSync(args: string[]): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const flag = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at !== -1 ? args[at + 1] : undefined;
  };
  const days = flag("days") ? Number(flag("days")) : undefined;
  const limit = flag("limit") ? Number(flag("limit")) : undefined;
  const before = flag("before");
  const model = flag("model") ?? DEFAULT_SYNC_MODEL;
  const concurrency = flag("concurrency") ? Number(flag("concurrency")) : 4;

  if (!(await exists(QURAN_DB))) await cmdQuran();
  if (!(await exists(join(DIST, "catalog.json")))) await cmdCatalog();

  const catalog = await readJson<Catalog>(join(DIST, "catalog.json"));
  let entries = catalog.entries;
  if (days) entries = withinLastDays(entries, days);
  if (before) entries = entries.filter((e) => (e.date ?? e.publishedAt.slice(0, 10)) < before);

  // Skip adhaans (no Qur'an) and Dhuhr/Asr (recited silently) before spending
  // anything — together roughly 70% of the channel's uploads.
  const { analyzable, skipped } = partition(entries);
  const counts = skipped.reduce<Record<string, number>>((acc, item) => {
    acc[item.reason] = (acc[item.reason] ?? 0) + 1;
    return acc;
  }, {});
  for (const [reason, count] of Object.entries(counts)) {
    log(`skipping ${count} — ${REASON_LABELS[reason as keyof typeof REASON_LABELS]}`);
  }

  const queue = limit ? analyzable.slice(0, limit) : analyzable;
  log(`${queue.length} video(s) queued · model ${model} · concurrency ${concurrency}`);
  log("");

  const index = new QuranIndex(loadAyahs(QURAN_DB));
  const report = await runSync(queue, {
    apiKey,
    model,
    index,
    cacheDir: CACHE,
    timelinesDir: TIMELINES,
    concurrency,
    log,
  });

  log(formatReport(report));
  await writeJson(join(DIST, "last-sync.json"), report);
}

const pct = (n: number, total: number) => (total ? `${((n / total) * 100).toFixed(0)}%` : "0%");

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "catalog":
      return cmdCatalog();
    case "quran":
      return cmdQuran();
    case "transcribe": {
      const id = rest[0];
      if (!id) throw new Error("usage: transcribe <videoId>");
      return cmdTranscribe(id);
    }
    case "import": {
      const [id, file] = rest;
      if (!id || !file) throw new Error("usage: import <videoId> <file.json>");
      return cmdImport(id, file);
    }
    case "align": {
      const id = rest[0];
      if (!id) throw new Error("usage: align <videoId>");
      return cmdAlign(id);
    }
    case "compare": {
      const count = rest[0] ? Number(rest[0]) : 10;
      const models = rest.slice(1);
      return cmdCompare(
        Number.isFinite(count) ? count : 10,
        models.length ? models : ["gemini-2.5-flash", "gemini-2.5-pro"],
      );
    }
    case "estimate": {
      const days = rest[0] ? Number(rest[0]) : undefined;
      return cmdEstimate(Number.isFinite(days) ? days : undefined);
    }
    case "site":
      return cmdSite();
    case "sync":
      return cmdSync(rest);
    default:
      console.error("commands: catalog | quran | estimate [days] | compare [n] [models...] | transcribe <id> | import <id> <file> | align <id> | site | sync");
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`\n${(err as Error).message}`);
  process.exitCode = 1;
});
