/**
 * Renders the index as a static website.
 *
 * No server, no database at runtime, no client-side framework: plain HTML files
 * generated from `catalog.json`, `timelines/*.json` and `quran.sqlite`. The
 * whole thing can sit on GitHub Pages or Cloudflare Pages for nothing, and the
 * cron that ingests new uploads simply regenerates it.
 *
 * The pages that matter are the *reverse* ones. Forwards — "what was recited in
 * this video" — is useful. Backwards — "every salah in the archive where Surah
 * Ar-Rahman was recited, jump straight to it" — does not exist anywhere else,
 * and falls out of the same data for free.
 */

import Database from "better-sqlite3";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { decideAnalysis, REASON_LABELS, type AnalysisDecision } from "./prayerRules.js";
import type { Catalog, CatalogEntry, Timeline, TimelineSegment } from "./types.js";

// MARK: - Data shaping

/** A run of consecutive ayahs from one surah — how a recitation is described. */
export interface VerseRange {
  surah: number;
  from: number;
  to: number;
  startSeconds: number;
}

/**
 * Collapses a timeline into the ranges a person would actually say out loud:
 * "Al-Fatihah, then Al-Waqi'ah 75–96".
 *
 * Consecutive ayahs merge; a jump (new surah, or a gap in ayah numbers) starts
 * a new range. Al-Fatihah recurring each rak'ah therefore appears once per
 * rak'ah, which is correct — it was recited more than once.
 */
export function summarizeRanges(segments: TimelineSegment[]): VerseRange[] {
  const ranges: VerseRange[] = [];
  for (const segment of segments) {
    if (segment.surah === null || segment.ayah === null) continue;
    const last = ranges[ranges.length - 1];
    if (last && last.surah === segment.surah && segment.ayah === last.to + 1) {
      last.to = segment.ayah;
      continue;
    }
    if (last && last.surah === segment.surah && segment.ayah === last.to) continue;
    ranges.push({
      surah: segment.surah,
      from: segment.ayah,
      to: segment.ayah,
      startSeconds: segment.t0,
    });
  }
  return ranges;
}

interface SurahMeta {
  id: number;
  nameSimple: string;
  nameArabic: string;
  nameEnglish: string;
  versesCount: number;
}

interface QuranData {
  surahs: Map<number, SurahMeta>;
  ayahText: Map<string, string>;
  translations: Map<string, string>;
  translationLabel: string;
}

function loadQuran(dbPath: string, translationId: string): QuranData {
  const db = new Database(dbPath, { readonly: true });

  const surahs = new Map<number, SurahMeta>();
  for (const row of db.prepare("SELECT * FROM surah ORDER BY id").all() as any[]) {
    surahs.set(row.id, {
      id: row.id,
      nameSimple: row.name_simple,
      nameArabic: row.name_arabic,
      nameEnglish: row.name_english,
      versesCount: row.verses_count,
    });
  }

  const ayahText = new Map<string, string>();
  for (const row of db.prepare("SELECT surah, ayah, text_uthmani FROM ayah").all() as any[]) {
    ayahText.set(`${row.surah}:${row.ayah}`, row.text_uthmani);
  }

  const translations = new Map<string, string>();
  for (const row of db
    .prepare("SELECT surah, ayah, text FROM translation WHERE source_id = ?")
    .all(translationId) as any[]) {
    translations.set(`${row.surah}:${row.ayah}`, row.text);
  }

  const source = db
    .prepare("SELECT author FROM translation_source WHERE id = ?")
    .get(translationId) as { author?: string } | undefined;

  db.close();
  return { surahs, ayahText, translations, translationLabel: source?.author ?? translationId };
}

// MARK: - HTML helpers

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

const clock = (seconds: number): string => {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
};

const watchAt = (videoId: string, seconds: number) =>
  `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(seconds)}s`;

function page(title: string, depth: number, body: string, description = ""): string {
  const root = depth === 0 ? "." : "..".concat("/..".repeat(depth - 1));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
${description ? `<meta name="description" content="${escape(description)}">` : ""}
<link rel="stylesheet" href="${root}/styles.css">
</head>
<body>
<header class="site">
  <a class="wordmark" href="${root}/index.html">Haramain Index</a>
  <nav>
    <a href="${root}/index.html">Days</a>
    <a href="${root}/surahs.html">Surahs</a>
    <a href="${root}/sheikhs.html">Imams</a>
  </nav>
</header>
<main>
${body}
</main>
<footer>
  <p>Recitations belong to <a href="https://www.youtube.com/@Haramain_Recordings">Haramain Recordings</a>. This index links to their videos; it hosts no audio.</p>
  <p class="warn">Verses are identified automatically from the audio and can be wrong. Do not rely on this for memorisation.</p>
</footer>
</body>
</html>
`;
}

const STYLES = `:root {
  color-scheme: light dark;
  --bg: #fbfaf8;
  --surface: #ffffff;
  --ink: #1a1a19;
  --muted: #6b6a67;
  --faint: #97958f;
  --line: #e6e3dd;
  --accent: #1f6f5c;
  --accent-soft: #eaf3f0;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14150f;
    --surface: #1c1d17;
    --ink: #ecebe5;
    --muted: #a3a199;
    --faint: #75736c;
    --line: #2c2d26;
    --accent: #6cc0a5;
    --accent-soft: #1d2b26;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.6 ui-serif, Georgia, "Times New Roman", serif;
}
main { max-width: 46rem; margin: 0 auto; padding: 0 1.25rem 5rem; }
a { color: inherit; }
header.site {
  max-width: 46rem;
  margin: 0 auto;
  padding: 2rem 1.25rem 1.5rem;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  flex-wrap: wrap;
}
.wordmark { font-weight: 600; letter-spacing: -0.01em; text-decoration: none; font-size: 1.05rem; }
header.site nav { display: flex; gap: 1.1rem; font-size: 0.85rem; font-family: ui-sans-serif, system-ui, sans-serif; }
header.site nav a { color: var(--muted); text-decoration: none; }
header.site nav a:hover { color: var(--accent); }
h1 { font-size: 1.6rem; font-weight: 600; letter-spacing: -0.02em; margin: 1rem 0 0.25rem; }
h2 { font-size: 0.78rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.09em;
     color: var(--faint); font-family: ui-sans-serif, system-ui, sans-serif; margin: 2.5rem 0 0.75rem; }
.lede { color: var(--muted); margin: 0 0 2rem; }
.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 0.9rem 1.1rem;
  margin-bottom: 0.5rem;
}
.card.skipped { background: transparent; border-style: dashed; }
.row { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; flex-wrap: wrap; }
.title { font-weight: 600; text-decoration: none; }
.title:hover { color: var(--accent); }
.meta { color: var(--muted); font-size: 0.85rem; font-family: ui-sans-serif, system-ui, sans-serif; }
.recited { margin-top: 0.4rem; font-size: 0.95rem; }
.recited a { color: var(--accent); text-decoration: none; }
.recited a:hover { text-decoration: underline; }
.note { color: var(--faint); font-size: 0.85rem; font-style: italic; margin-top: 0.3rem; }
.stats { display: flex; gap: 2rem; flex-wrap: wrap; margin: 0 0 2rem; padding: 0; list-style: none;
         font-family: ui-sans-serif, system-ui, sans-serif; }
.stats li { display: flex; flex-direction: column; }
.stats .n { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; }
.stats .k { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--faint); }
.ayah { border-top: 1px solid var(--line); padding: 1.1rem 0; }
.ayah:first-of-type { border-top: 0; }
.ayah .ref { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.75rem;
             color: var(--accent); text-decoration: none; letter-spacing: 0.02em; }
.ayah .ar {
  direction: rtl; text-align: right; font-size: 1.5rem; line-height: 2.2;
  margin: 0.5rem 0 0.55rem;
  font-family: "SF Arabic", "Geeza Pro", "Noto Naskh Arabic", "Times New Roman", serif;
}
.ayah .tr { color: var(--muted); }
.ayah .low { color: var(--faint); font-size: 0.75rem; font-family: ui-sans-serif, system-ui, sans-serif; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: 0.4rem; padding: 0; list-style: none; }
.grid a { display: block; padding: 0.55rem 0.7rem; border: 1px solid var(--line); border-radius: 8px;
          text-decoration: none; background: var(--surface); }
.grid a:hover { border-color: var(--accent); }
.grid .c { color: var(--faint); font-size: 0.78rem; font-family: ui-sans-serif, system-ui, sans-serif; }
footer { max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; border-top: 1px solid var(--line);
         color: var(--faint); font-size: 0.8rem; font-family: ui-sans-serif, system-ui, sans-serif; }
footer a { color: var(--muted); }
footer .warn { color: var(--faint); }
.empty { color: var(--muted); font-style: italic; padding: 2rem 0; }
`;

// MARK: - Generator

export interface SiteOptions {
  catalogPath: string;
  timelinesDir: string;
  quranDbPath: string;
  outDir: string;
  translationId?: string;
  log?: (message: string) => void;
}

interface Record_ {
  entry: CatalogEntry;
  timeline: Timeline | null;
  ranges: VerseRange[];
  decision: AnalysisDecision;
}

export async function generateSite(options: SiteOptions): Promise<{ pages: number; analysed: number }> {
  const log = options.log ?? console.log;
  const translationId = options.translationId ?? "clear-quran";
  const quran = loadQuran(options.quranDbPath, translationId);

  const catalog = JSON.parse(await readFile(options.catalogPath, "utf8")) as Catalog;

  const timelines = new Map<string, Timeline>();
  let files: string[] = [];
  try {
    files = await readdir(options.timelinesDir);
  } catch {
    log("no timelines directory yet — the site will show the catalogue only");
  }
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const timeline = JSON.parse(await readFile(join(options.timelinesDir, file), "utf8")) as Timeline;
    timelines.set(timeline.videoId, timeline);
  }

  const records: Record_[] = catalog.entries.map((entry) => {
    const timeline = timelines.get(entry.videoId) ?? null;
    return {
      entry,
      timeline,
      ranges: timeline ? summarizeRanges(timeline.segments) : [],
      decision: decideAnalysis(entry),
    };
  });

  const write = async (relativePath: string, html: string) => {
    const full = join(options.outDir, relativePath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, html, "utf8");
  };

  let pages = 0;
  await write("styles.css", STYLES);

  // — Days ————————————————————————————————————————————————
  const byDay = new Map<string, Record_[]>();
  for (const record of records) {
    const day = record.entry.date ?? record.entry.publishedAt.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(record);
  }
  const days = [...byDay.keys()].sort().reverse();

  for (const day of days) {
    await write(`day/${day}.html`, renderDay(day, byDay.get(day)!, quran, 1));
    pages++;
  }

  // — Surahs ——————————————————————————————————————————————
  const bySurah = new Map<number, { record: Record_; range: VerseRange }[]>();
  for (const record of records) {
    for (const range of record.ranges) {
      if (!bySurah.has(range.surah)) bySurah.set(range.surah, []);
      bySurah.get(range.surah)!.push({ record, range });
    }
  }
  for (const [surah, occurrences] of bySurah) {
    await write(`surah/${surah}.html`, renderSurah(surah, occurrences, quran, 1));
    pages++;
  }
  await write("surahs.html", renderSurahIndex(bySurah, quran));
  pages++;

  // — Imams ———————————————————————————————————————————————
  const bySheikh = new Map<string, Record_[]>();
  for (const record of records) {
    const key = record.entry.sheikhKey;
    if (!key) continue;
    if (!bySheikh.has(key)) bySheikh.set(key, []);
    bySheikh.get(key)!.push(record);
  }
  for (const [key, items] of bySheikh) {
    await write(`sheikh/${key}.html`, renderSheikh(key, items, quran, 1));
    pages++;
  }
  await write("sheikhs.html", renderSheikhIndex(bySheikh));
  pages++;

  // — Videos ——————————————————————————————————————————————
  for (const record of records.filter((item) => item.timeline)) {
    await write(`video/${record.entry.videoId}.html`, renderVideo(record, quran, 1));
    pages++;
  }

  // — Home ————————————————————————————————————————————————
  await write("index.html", renderHome(days, byDay, records, bySurah, quran));
  pages++;

  const analysed = records.filter((item) => item.timeline).length;
  log(`wrote ${pages} pages to ${options.outDir} (${analysed} of ${records.length} recordings analysed)`);
  return { pages, analysed };
}

// MARK: - Renderers

function rangeLabel(range: VerseRange, quran: QuranData): string {
  const meta = quran.surahs.get(range.surah);
  const name = meta ? meta.nameSimple : `Surah ${range.surah}`;
  const whole = meta && range.from === 1 && range.to === meta.versesCount;
  return whole ? name : `${name} ${range.from}${range.to !== range.from ? `–${range.to}` : ""}`;
}

function recitedLine(record: Record_, quran: QuranData, depth: number): string {
  const root = "..".repeat(depth).replace(/\.\.$/, "..");
  if (!record.timeline) {
    return `<p class="note">${escape(REASON_LABELS[record.decision.reason])}</p>`;
  }
  if (record.ranges.length === 0) {
    return `<p class="note">No Qur'an detected in the audio.</p>`;
  }
  const parts = record.ranges.map(
    (range) =>
      `<a href="${watchAt(record.entry.videoId, range.startSeconds)}">${escape(rangeLabel(range, quran))}</a>`,
  );
  return `<p class="recited">${parts.join(" · ")}</p>`;
}

function cardFor(record: Record_, quran: QuranData, depth: number, showDate = false): string {
  const { entry } = record;
  const label = entry.isAdhaan
    ? `${entry.prayer ? entry.prayer[0]!.toUpperCase() + entry.prayer.slice(1) : "Prayer"} Adhan`
    : entry.prayer
      ? entry.prayer[0]!.toUpperCase() + entry.prayer.slice(1)
      : entry.title;
  const root = depth === 0 ? "." : "..".concat("/..".repeat(depth - 1));
  const href = record.timeline
    ? `${root}/video/${entry.videoId}.html`
    : `https://www.youtube.com/watch?v=${entry.videoId}`;

  const meta = [
    entry.mosque === "makkah" ? "Makkah" : entry.mosque === "madeenah" ? "Madeenah" : null,
    entry.sheikh ? `Sheikh ${entry.sheikh}` : null,
    showDate && entry.date ? entry.date : null,
    entry.durationSeconds ? clock(entry.durationSeconds) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return `<article class="card${record.timeline ? "" : " skipped"}">
  <div class="row">
    <a class="title" href="${href}">${escape(label)}</a>
    <span class="meta">${escape(meta)}</span>
  </div>
  ${recitedLine(record, quran, depth)}
</article>`;
}

function renderDay(day: string, records: Record_[], quran: QuranData, depth: number): string {
  const order = ["fajr", "dhuhr", "jumuah", "asr", "maghrib", "isha", "taraweeh", "tahajjud"];
  const sorted = [...records].sort((a, b) => {
    const rank = (record: Record_) => {
      const base = order.indexOf(record.entry.prayer ?? "");
      return (base === -1 ? 99 : base) * 4 + (record.entry.isAdhaan ? 2 : 0) + (record.entry.mosque === "madeenah" ? 1 : 0);
    };
    return rank(a) - rank(b);
  });

  const pretty = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  const analysed = sorted.filter((record) => record.timeline).length;
  return page(
    `${pretty} — Haramain Index`,
    depth,
    `<h1>${escape(pretty)}</h1>
<p class="lede">${sorted.length} recordings · ${analysed} analysed</p>
${sorted.map((record) => cardFor(record, quran, depth)).join("\n")}`,
    `Every prayer recorded at Makkah and Madinah on ${pretty}, and what was recited.`,
  );
}

function renderVideo(record: Record_, quran: QuranData, depth: number): string {
  const { entry, timeline } = record;
  const segments = timeline!.segments;

  const body = segments
    .map((segment) => {
      if (segment.surah === null || segment.ayah === null) {
        return `<div class="ayah"><span class="low">Recitation — not identified</span></div>`;
      }
      const key = `${segment.surah}:${segment.ayah}`;
      const meta = quran.surahs.get(segment.surah);
      const arabic = quran.ayahText.get(key) ?? "";
      const translation = quran.translations.get(key) ?? "";
      const low = segment.conf < 0.8 ? ` <span class="low">· lower confidence</span>` : "";
      const partial = segment.partial ? ` <span class="low">· partial</span>` : "";
      return `<div class="ayah">
  <a class="ref" href="${watchAt(entry.videoId, segment.t0)}">${escape(meta?.nameSimple ?? `Surah ${segment.surah}`)} ${key} · ${clock(segment.t0)}</a>${low}${partial}
  <p class="ar">${escape(arabic)}</p>
  <p class="tr">${escape(translation)}</p>
</div>`;
    })
    .join("\n");

  const heading = [
    entry.prayer ? entry.prayer[0]!.toUpperCase() + entry.prayer.slice(1) : "Recording",
    entry.mosque === "makkah" ? "Makkah" : entry.mosque === "madeenah" ? "Madeenah" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const summary = record.ranges.map((range) => rangeLabel(range, quran)).join(" · ");

  return page(
    `${heading} — Haramain Index`,
    depth,
    `<h1>${escape(heading)}</h1>
<p class="lede">${escape([entry.date, entry.sheikh ? `Sheikh ${entry.sheikh}` : null].filter(Boolean).join(" · "))}<br>
<a href="https://www.youtube.com/watch?v=${entry.videoId}">Watch on YouTube</a></p>
<h2>Recited</h2>
<p class="recited">${escape(summary)}</p>
<h2>Verse by verse — translation by ${escape(quran.translationLabel)}</h2>
${body}`,
    `${heading}: ${summary}`,
  );
}

function renderSurah(
  surah: number,
  occurrences: { record: Record_; range: VerseRange }[],
  quran: QuranData,
  depth: number,
): string {
  const meta = quran.surahs.get(surah);
  const name = meta?.nameSimple ?? `Surah ${surah}`;
  const sorted = [...occurrences].sort((a, b) =>
    (b.record.entry.date ?? "").localeCompare(a.record.entry.date ?? ""),
  );

  const rows = sorted
    .map(({ record, range }) => {
      const entry = record.entry;
      const label = [
        entry.date,
        entry.prayer ? entry.prayer[0]!.toUpperCase() + entry.prayer.slice(1) : null,
        entry.mosque === "makkah" ? "Makkah" : "Madeenah",
      ]
        .filter(Boolean)
        .join(" · ");
      return `<article class="card">
  <div class="row">
    <a class="title" href="${watchAt(entry.videoId, range.startSeconds)}">${escape(rangeLabel(range, quran))}</a>
    <span class="meta">${escape(label)}</span>
  </div>
  <p class="note">${escape(entry.sheikh ? `Sheikh ${entry.sheikh}` : "")}</p>
</article>`;
    })
    .join("\n");

  return page(
    `${name} — Haramain Index`,
    depth,
    `<h1>${escape(name)} <span class="meta">${escape(meta?.nameArabic ?? "")}</span></h1>
<p class="lede">Recited in ${sorted.length} recorded prayer${sorted.length === 1 ? "" : "s"}. Each link opens the video at the moment it begins.</p>
${rows}`,
    `Every recorded prayer at Makkah and Madinah where ${name} was recited.`,
  );
}

function renderSurahIndex(bySurah: Map<number, unknown[]>, quran: QuranData): string {
  const items = [...quran.surahs.values()]
    .map((meta) => {
      const count = bySurah.get(meta.id)?.length ?? 0;
      if (count === 0) {
        return `<li><a style="opacity:.42" href="#">${meta.id}. ${escape(meta.nameSimple)}<br><span class="c">not yet recorded</span></a></li>`;
      }
      return `<li><a href="./surah/${meta.id}.html">${meta.id}. ${escape(meta.nameSimple)}<br><span class="c">${count} prayer${count === 1 ? "" : "s"}</span></a></li>`;
    })
    .join("\n");

  return page(
    "Surahs — Haramain Index",
    0,
    `<h1>By surah</h1>
<p class="lede">Pick a surah to see every recorded prayer where it was recited, and jump to the moment.</p>
<ul class="grid">${items}</ul>`,
    "Find every Haramain prayer recording by the surah recited in it.",
  );
}

function renderSheikh(key: string, records: Record_[], quran: QuranData, depth: number): string {
  const name = records[0]?.entry.sheikh ?? key;
  const sorted = [...records].sort((a, b) => (b.entry.date ?? "").localeCompare(a.entry.date ?? ""));
  return page(
    `Sheikh ${name} — Haramain Index`,
    depth,
    `<h1>Sheikh ${escape(name)}</h1>
<p class="lede">${sorted.length} recording${sorted.length === 1 ? "" : "s"}</p>
${sorted.map((record) => cardFor(record, quran, depth, true)).join("\n")}`,
    `Recordings led by Sheikh ${name} at the Two Holy Mosques.`,
  );
}

function renderSheikhIndex(bySheikh: Map<string, Record_[]>): string {
  const items = [...bySheikh.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(
      ([key, records]) =>
        `<li><a href="./sheikh/${key}.html">${escape(records[0]?.entry.sheikh ?? key)}<br><span class="c">${records.length} recording${records.length === 1 ? "" : "s"}</span></a></li>`,
    )
    .join("\n");
  return page(
    "Imams — Haramain Index",
    0,
    `<h1>By imam</h1>
<ul class="grid">${items}</ul>`,
    "Browse Haramain prayer recordings by the imam who led them.",
  );
}

function renderHome(
  days: string[],
  byDay: Map<string, Record_[]>,
  records: Record_[],
  bySurah: Map<number, unknown[]>,
  quran: QuranData,
): string {
  const analysed = records.filter((record) => record.timeline).length;
  const recent = days.slice(0, 14);

  const dayList = recent
    .map((day) => {
      const items = byDay.get(day)!;
      const done = items.filter((record) => record.timeline).length;
      const pretty = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: "UTC",
      });
      const recited = items
        .flatMap((record) => record.ranges.map((range) => rangeLabel(range, quran)))
        .filter((label) => !label.startsWith("Al-Fatihah"));
      return `<article class="card">
  <div class="row">
    <a class="title" href="./day/${day}.html">${escape(pretty)}</a>
    <span class="meta">${items.length} recordings${done ? ` · ${done} analysed` : ""}</span>
  </div>
  ${recited.length ? `<p class="recited">${escape([...new Set(recited)].slice(0, 6).join(" · "))}</p>` : ""}
</article>`;
    })
    .join("\n");

  return page(
    "Haramain Index — what was recited, and when",
    0,
    `<h1>What was recited at the Haramain</h1>
<p class="lede">Every prayer from Masjid al-Haram and Masjid an-Nabawi, with the verses recited in it — searchable by day, by surah, and by imam. Each verse links to the exact second on YouTube.</p>

<ul class="stats">
  <li><span class="n">${records.length}</span><span class="k">recordings</span></li>
  <li><span class="n">${analysed}</span><span class="k">analysed</span></li>
  <li><span class="n">${bySurah.size}</span><span class="k">surahs indexed</span></li>
  <li><span class="n">${days.length}</span><span class="k">days</span></li>
</ul>

<h2>Recent days</h2>
${dayList || `<p class="empty">No recordings yet.</p>`}`,
    "A searchable index of what was recited in every prayer at Makkah and Madinah.",
  );
}
