/**
 * Aligner regression suite.
 *
 * The headline test runs real Gemini output for a real Maghrib salah against
 * the real mushaf and asserts the exact verse mapping. It is deliberately a
 * hard case: the two rak'ahs end on the *identical* ayah
 * ("فسبح باسم ربك العظيم" — 56:96 and 69:52) and both contain
 * "تنزيل من رب العالمين" (56:80 and 69:43). Nothing but the monotonic sequence
 * constraint can tell those apart.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { alignSegments, coverageOf, QuranIndex } from "../src/align.js";
import { normalizeArabic, sequenceSimilarity, words } from "../src/arabic.js";
import { loadAyahs } from "../src/quran.js";
import { parseTimestamp } from "../src/transcribe.js";
import type { TranscriptSegment } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, "..", "dist", "quran.sqlite");

const hasDb = existsSync(DB);
const describeWithDb = hasDb ? describe : describe.skip;

function loadIndex(): QuranIndex {
  return new QuranIndex(loadAyahs(DB));
}

/**
 * Builds a transcript from the mushaf itself — a perfect transcription of
 * surah `surah`, ayahs `from` to `to`.
 *
 * Better than hand-typing Arabic into a test: it cannot accidentally truncate a
 * long ayah into a fragment the aligner is right to reject, and it stays
 * correct if the database is rebuilt.
 */
function transcriptFromMushaf(
  index: QuranIndex,
  surah: number,
  from: number,
  to: number,
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (let ayah = from; ayah <= to; ayah++) {
    const position = index.position(surah, ayah);
    if (position === undefined) continue;
    const record = index.at(position)!;
    const offset = segments.length * 10;
    segments.push({ t0: offset, t1: offset + 9, arabic: record.textUthmani });
  }
  return segments;
}

function loadFixture(name: string): TranscriptSegment[] {
  const raw = JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8")) as {
    segments: { start: string; end: string; arabic: string }[];
  };
  return raw.segments.map((s) => ({
    t0: parseTimestamp(s.start)!,
    t1: parseTimestamp(s.end)!,
    arabic: s.arabic,
  }));
}

describe("normalizeArabic", () => {
  it("strips tashkeel and Uthmani orthography down to a shared skeleton", () => {
    // Uthmani (with superscript alef and wasla) vs how ASR typically writes it.
    expect(normalizeArabic("ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ")).toBe(normalizeArabic("الرحمن الرحيم"));
    expect(normalizeArabic("ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَـٰلَمِينَ")).toBe(
      normalizeArabic("الحمد لله رب العالمين"),
    );
  });

  it("unifies hamza carriers, ya and ta marbuta", () => {
    expect(normalizeArabic("أنعمت")).toBe(normalizeArabic("انعمت"));
    expect(normalizeArabic("إياك")).toBe(normalizeArabic("اياك"));
    expect(normalizeArabic("جنة")).toBe(normalizeArabic("جنه"));
    expect(normalizeArabic("علي")).toBe(normalizeArabic("على"));
  });

  it("is empty for text with no Arabic letters", () => {
    expect(normalizeArabic("١٢٣ ... !")).toBe("");
    expect(normalizeArabic("")).toBe("");
  });
});

describe("sequenceSimilarity", () => {
  it("is 1 for identical sequences and drops with edits", () => {
    expect(sequenceSimilarity(words("الحمد لله"), words("الحمد لله"))).toBe(1);
    expect(sequenceSimilarity(words("الحمد لله رب"), words("الحمد لله"))).toBeCloseTo(2 / 3, 5);
  });
});

describeWithDb("QuranIndex", () => {
  it("indexes the whole mushaf", () => {
    expect(loadIndex().size).toBe(6236);
  });

  it("finds an ayah from its rare words", () => {
    const index = loadIndex();
    const hits = index.candidates(words("فلا أقسم بمواقع النجوم"), 20);
    const positions = hits.map((p) => index.at(p)!);
    expect(positions.some((a) => a.surah === 56 && a.ayah === 75)).toBe(true);
  });
});

describeWithDb("alignSegments — real Maghrib salah (HcWru4_Soxs)", () => {
  const index = loadIndex();
  const aligned = alignSegments(loadFixture("HcWru4_Soxs.gemini.json"), index);
  const keys = aligned.map((s) => (s.surah === null ? null : `${s.surah}:${s.ayah}`));

  it("matches every segment", () => {
    expect(coverageOf(aligned)).toBe(1);
  });

  it("reads rak'ah 1 as Al-Fatihah then Al-Waqi'ah 75–96", () => {
    expect(keys.slice(0, 6)).toEqual(["1:2", "1:3", "1:4", "1:5", "1:6", "1:7"]);

    const waqiah = keys.slice(6, 28);
    const expected = Array.from({ length: 22 }, (_, i) => `56:${75 + i}`);
    expect(waqiah).toEqual(expected);
  });

  it("reads rak'ah 2 as Al-Fatihah then Al-Haqqah 38–52", () => {
    expect(keys.slice(28, 34)).toEqual(["1:2", "1:3", "1:4", "1:5", "1:6", "1:7"]);

    const haqqah = keys.slice(34);
    const expected = Array.from({ length: 15 }, (_, i) => `69:${38 + i}`);
    expect(haqqah).toEqual(expected);
  });

  it("distinguishes the two identical closing ayahs by position", () => {
    // "فسبح باسم ربك العظيم" is both 56:96 and 69:52. Only sequence tells them apart.
    expect(keys[27]).toBe("56:96");
    expect(keys[48]).toBe("69:52");
  });

  it("distinguishes the two identical 'تنزيل من رب العالمين' ayahs", () => {
    expect(keys[11]).toBe("56:80");
    expect(keys[39]).toBe("69:43");
  });

  it("keeps timestamps monotonic and non-overlapping", () => {
    for (let i = 1; i < aligned.length; i++) {
      expect(aligned[i]!.t0).toBeGreaterThanOrEqual(aligned[i - 1]!.t1 - 0.001);
      expect(aligned[i]!.t1).toBeGreaterThan(aligned[i]!.t0);
    }
  });

  it("is confident about what it matched", () => {
    const weakest = Math.min(...aligned.map((s) => s.conf));
    expect(weakest).toBeGreaterThan(0.7);
  });
});

describeWithDb("alignSegments — adversarial cases", () => {
  const index = loadIndex();

  it("walks the Ar-Rahman refrain forward instead of sticking on one occurrence", () => {
    // 55:12-55:16 alternating with the refrain at 13, 16.
    const transcript: TranscriptSegment[] = [
      { t0: 0, t1: 5, arabic: "والحب ذو العصف والريحان" }, // 55:12
      { t0: 5, t1: 10, arabic: "فبأي آلاء ربكما تكذبان" }, // 55:13
      { t0: 10, t1: 15, arabic: "خلق الإنسان من صلصال كالفخار" }, // 55:14
      { t0: 15, t1: 20, arabic: "وخلق الجان من مارج من نار" }, // 55:15
      { t0: 20, t1: 25, arabic: "فبأي آلاء ربكما تكذبان" }, // 55:16
    ];
    const keys = alignSegments(transcript, index).map((s) => `${s.surah}:${s.ayah}`);
    expect(keys).toEqual(["55:12", "55:13", "55:14", "55:15", "55:16"]);
  });

  it("tolerates ASR word errors", () => {
    // "المستقيم" misheard as "المستقيمي", one word dropped from 1:7.
    const transcript: TranscriptSegment[] = [
      { t0: 0, t1: 5, arabic: "اهدنا الصراط المستقيمي" },
      { t0: 5, t1: 12, arabic: "صراط الذين أنعمت عليهم غير المغضوب عليهم" },
    ];
    const keys = alignSegments(transcript, index).map((s) => `${s.surah}:${s.ayah}`);
    expect(keys).toEqual(["1:6", "1:7"]);
  });

  it("splits a segment that Gemini merged into several ayahs", () => {
    const transcript: TranscriptSegment[] = [
      { t0: 0, t1: 30, arabic: "قل هو الله أحد الله الصمد لم يلد ولم يولد ولم يكن له كفوا أحد" },
    ];
    const keys = alignSegments(transcript, index).map((s) => `${s.surah}:${s.ayah}`);
    expect(keys).toEqual(["112:1", "112:2", "112:3", "112:4"]);
  });

  it("refuses to guess on non-Quranic audio", () => {
    const transcript: TranscriptSegment[] = [
      { t0: 0, t1: 4, arabic: "السلام عليكم ورحمة الله وبركاته أيها الإخوة الكرام في هذا المسجد" },
    ];
    const result = alignSegments(transcript, index);
    expect(result[0]!.surah).toBeNull();
  });

  it("emits the standalone Basmalah without claiming an ayah", () => {
    const result = alignSegments([{ t0: 0, t1: 4, arabic: "بسم الله الرحمن الرحيم" }], index);
    expect(result[0]!.surah).toBeNull();
  });
});

describeWithDb("alignSegments — backward reconciliation", () => {
  const index = loadIndex();

  it("uses what follows to fix an ambiguous surah opening", () => {
    // 59:1 and 61:1 are identical, character for character. Only the ayahs
    // that follow can say which surah is being recited. Found in the wild:
    // Sheikh Shamsaan, Makkah Fajr, 26 Jul 2026 — he recited As-Saff, and the
    // forward-only pass called the opening 59:1.
    const transcript: TranscriptSegment[] = [
      { t0: 0, t1: 8, arabic: "سبح لله ما في السماوات وما في الأرض وهو العزيز الحكيم" },
      { t0: 8, t1: 16, arabic: "يا أيها الذين آمنوا لم تقولون ما لا تفعلون" },
      { t0: 16, t1: 24, arabic: "كبر مقتا عند الله أن تقولوا ما لا تفعلون" },
    ];
    const keys = alignSegments(transcript, index).map((s) => `${s.surah}:${s.ayah}`);
    expect(keys).toEqual(["61:1", "61:2", "61:3"]);
  });

  it("still reads Al-Hashr correctly when that is what follows", () => {
    // The control for the case above: same identical opening, but the passage
    // continues into Al-Hashr, so 59:1 must survive reconciliation.
    const keys = alignSegments(transcriptFromMushaf(index, 59, 1, 4), index).map(
      (s) => `${s.surah}:${s.ayah}`,
    );
    expect(keys).toEqual(["59:1", "59:2", "59:3", "59:4"]);
  });

  it("reads As-Saff from the mushaf text too", () => {
    const keys = alignSegments(transcriptFromMushaf(index, 61, 1, 5), index).map(
      (s) => `${s.surah}:${s.ayah}`,
    );
    expect(keys).toEqual(["61:1", "61:2", "61:3", "61:4", "61:5"]);
  });

  it("leaves a genuine jump between surahs alone", () => {
    // Al-Fatihah then a leap to Al-Waqi'ah is real, not a mistake to reconcile.
    const transcript: TranscriptSegment[] = [
      { t0: 0, t1: 6, arabic: "اهدنا الصراط المستقيم" },
      { t0: 6, t1: 20, arabic: "صراط الذين أنعمت عليهم غير المغضوب عليهم ولا الضالين" },
      { t0: 22, t1: 30, arabic: "فلا أقسم بمواقع النجوم" },
      { t0: 30, t1: 38, arabic: "وإنه لقسم لو تعلمون عظيم" },
    ];
    const keys = alignSegments(transcript, index).map((s) => `${s.surah}:${s.ayah}`);
    expect(keys).toEqual(["1:6", "1:7", "56:75", "56:76"]);
  });
});
