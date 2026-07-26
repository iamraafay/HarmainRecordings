/**
 * Builds `quran.sqlite` — the database that ships inside the iOS app bundle.
 *
 * Bundling rather than calling an API at runtime means the meaning pane renders
 * instantly and works on aeroplane mode, and the app carries no API credentials
 * of any kind. The cost is ~8 MB of binary and a rebuild whenever a translation
 * is added, both of which are cheap.
 *
 * Sources:
 *   - Uthmani script: api.quran.com v4 (`/quran/verses/uthmani`), unauthenticated.
 *   - Surah metadata: api.quran.com v4 (`/chapters`), unauthenticated.
 *   - Translations:   fawazahmed0/quran-api via jsDelivr, unauthenticated.
 *
 * Note on quran.com: its v4 translation endpoints now return empty arrays —
 * translation access moved to the Quran Foundation Content API, which requires
 * OAuth2 client credentials. Rather than put a credential in the build, this
 * pulls translations from the open CDN mirror. If you register a
 * Quran.Foundation client later, swap `fetchTranslation` for it and nothing
 * else changes.
 */

import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeArabic } from "./arabic.js";

const QURAN_API = "https://api.quran.com/api/v4";
const TRANSLATION_CDN = "https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions";

export interface TranslationSpec {
  /** Stable id used by the app to reference this translation. */
  id: string;
  /** Edition slug on the CDN. */
  edition: string;
  name: string;
  author: string;
  language: string;
}

/**
 * Ships three by default: a plain-modern rendering, a scholarly one, and a
 * literary one. Add more here — the app reads the list out of the database.
 */
export const DEFAULT_TRANSLATIONS: TranslationSpec[] = [
  { id: "clear-quran", edition: "eng-mustafakhattaba", name: "The Clear Quran", author: "Dr. Mustafa Khattab", language: "en" },
  { id: "usmani", edition: "eng-muftitaqiusmani", name: "Translation", author: "Mufti Taqi Usmani", language: "en" },
  { id: "haleem", edition: "eng-abdelhaleem", name: "The Qur'an", author: "M.A.S. Abdel Haleem", language: "en" },
];

interface UthmaniVerse {
  verse_key: string;
  text_uthmani: string;
}

interface ChapterMeta {
  id: number;
  name_simple: string;
  name_arabic: string;
  verses_count: number;
  revelation_place: string;
  translated_name: { name: string };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function fetchUthmani(): Promise<UthmaniVerse[]> {
  const data = await getJson<{ verses: UthmaniVerse[] }>(`${QURAN_API}/quran/verses/uthmani`);
  if (data.verses.length !== 6236) {
    throw new Error(`expected 6236 verses, got ${data.verses.length}`);
  }
  return data.verses;
}

async function fetchChapters(): Promise<ChapterMeta[]> {
  const data = await getJson<{ chapters: ChapterMeta[] }>(`${QURAN_API}/chapters?language=en`);
  return data.chapters;
}

interface CdnVerse {
  chapter: number;
  verse: number;
  text: string;
}

async function fetchTranslation(spec: TranslationSpec): Promise<CdnVerse[]> {
  const data = await getJson<{ quran: CdnVerse[] }>(`${TRANSLATION_CDN}/${spec.edition}.json`);
  if (!Array.isArray(data.quran) || data.quran.length === 0) {
    throw new Error(`translation ${spec.edition} came back empty`);
  }
  return data.quran;
}

export interface BuildResult {
  path: string;
  ayahCount: number;
  translations: { id: string; rows: number }[];
}

/**
 * Fetches everything and writes the database. Idempotent: the output file is
 * replaced wholesale.
 */
export async function buildQuranDatabase(
  outputPath: string,
  specs: TranslationSpec[] = DEFAULT_TRANSLATIONS,
  log: (msg: string) => void = console.log,
): Promise<BuildResult> {
  await mkdir(dirname(outputPath), { recursive: true });

  log("fetching Uthmani text…");
  const [verses, chapters] = await Promise.all([fetchUthmani(), fetchChapters()]);
  log(`  ${verses.length} ayahs, ${chapters.length} surahs`);

  const db = new Database(outputPath);
  db.pragma("journal_mode = DELETE"); // single-file output for bundling
  db.exec(`
    DROP TABLE IF EXISTS ayah;
    DROP TABLE IF EXISTS surah;
    DROP TABLE IF EXISTS translation;
    DROP TABLE IF EXISTS translation_source;

    CREATE TABLE surah (
      id            INTEGER PRIMARY KEY,
      name_simple   TEXT NOT NULL,
      name_arabic   TEXT NOT NULL,
      name_english  TEXT NOT NULL,
      verses_count  INTEGER NOT NULL,
      revelation    TEXT NOT NULL
    );

    CREATE TABLE ayah (
      surah          INTEGER NOT NULL,
      ayah           INTEGER NOT NULL,
      text_uthmani   TEXT NOT NULL,
      text_normalized TEXT NOT NULL,
      PRIMARY KEY (surah, ayah)
    );

    CREATE TABLE translation_source (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      author    TEXT NOT NULL,
      language  TEXT NOT NULL
    );

    CREATE TABLE translation (
      source_id TEXT NOT NULL,
      surah     INTEGER NOT NULL,
      ayah      INTEGER NOT NULL,
      text      TEXT NOT NULL,
      PRIMARY KEY (source_id, surah, ayah)
    );
  `);

  const insertSurah = db.prepare(
    `INSERT INTO surah VALUES (@id, @name_simple, @name_arabic, @name_english, @verses_count, @revelation)`,
  );
  db.transaction(() => {
    for (const c of chapters) {
      insertSurah.run({
        id: c.id,
        name_simple: c.name_simple,
        name_arabic: c.name_arabic,
        name_english: c.translated_name.name,
        verses_count: c.verses_count,
        revelation: c.revelation_place,
      });
    }
  })();

  const insertAyah = db.prepare(`INSERT INTO ayah VALUES (?, ?, ?, ?)`);
  db.transaction(() => {
    for (const v of verses) {
      const [s, a] = v.verse_key.split(":").map(Number);
      insertAyah.run(s, a, v.text_uthmani, normalizeArabic(v.text_uthmani));
    }
  })();

  const insertSource = db.prepare(`INSERT INTO translation_source VALUES (?, ?, ?, ?)`);
  const insertTranslation = db.prepare(`INSERT OR REPLACE INTO translation VALUES (?, ?, ?, ?)`);
  const summary: { id: string; rows: number }[] = [];

  for (const spec of specs) {
    log(`fetching translation ${spec.id} (${spec.edition})…`);
    try {
      const rows = await fetchTranslation(spec);
      insertSource.run(spec.id, spec.name, spec.author, spec.language);
      db.transaction(() => {
        for (const r of rows) insertTranslation.run(spec.id, r.chapter, r.verse, r.text);
      })();
      summary.push({ id: spec.id, rows: rows.length });
      log(`  ${rows.length} rows`);
    } catch (err) {
      // A missing translation should not sink the build — the app degrades to
      // whatever translations did land.
      log(`  SKIPPED ${spec.id}: ${(err as Error).message}`);
    }
  }

  db.exec(`CREATE INDEX idx_translation_verse ON translation (surah, ayah);`);
  db.exec(`VACUUM;`);
  db.close();

  return { path: outputPath, ayahCount: verses.length, translations: summary };
}

/** Reads the ayah table back out, for the aligner and for tests. */
export function loadAyahs(dbPath: string): { surah: number; ayah: number; textUthmani: string }[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(`SELECT surah, ayah, text_uthmani AS textUthmani FROM ayah ORDER BY surah, ayah`)
    .all() as { surah: number; ayah: number; textUthmani: string }[];
  db.close();
  return rows;
}
