/**
 * Arabic text normalisation for matching speech-recognition output against the
 * Uthmani mushaf.
 *
 * The two sides differ in ways that are meaningless for identification:
 * the mushaf carries full tashkeel plus Uthmani-specific orthography (small
 * alef, waqf marks, superscript letters), while ASR output carries little or
 * none and freely swaps hamza forms. Normalisation collapses both to a bare
 * consonantal skeleton so they can be compared.
 *
 * This is deliberately lossy. It is only ever used for comparison — the text
 * shown to the user is always the untouched Uthmani original.
 */

/** Tashkeel, Quranic annotation marks, and the superscript alef. */
const DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u08D3-\u08FF]/g;
/** Kashida / tatweel — pure typography. */
const TATWEEL = /\u0640/g;
/** Anything that is not an Arabic letter or a space. */
const NON_LETTERS = /[^\u0621-\u064A ]/g;

const LETTER_MAP: Record<string, string> = {
  // Hamza carriers -> bare alef. ASR is unreliable about which carrier it heard.
  "أ": "ا", // أ
  "إ": "ا", // إ
  "آ": "ا", // آ
  "ٱ": "ا", // ٱ wasla
  "ٲ": "ا",
  "ٳ": "ا",
  "ٵ": "ا",
  // Ya variants
  "ى": "ي", // ى -> ي
  "ئ": "ي", // ئ -> ي
  "ی": "ي", // Farsi ya
  // Waw variants
  "ؤ": "و", // ؤ -> و
  // Ta marbuta reads as ha when unvowelled
  "ة": "ه", // ة -> ه
  // Standalone hamza carries no consonantal weight once carriers are folded
  "ء": "",
  // Alef maksura variants used in Uthmani script
  "ے": "ي",
  "ٮ": "ب", // dotless beh
  "ٯ": "ق", // dotless qaf
};

/**
 * Reduces Arabic text to a comparable skeleton.
 *
 * The last step — deleting alef outright — looks aggressive and is the single
 * most important line here. Alef is precisely the letter whose spelling differs
 * between the Uthmani mushaf and the way anyone else writes Arabic, and it
 * differs in *both* directions, so no substitution rule can reconcile it:
 *
 *   ٱلْعَـٰلَمِينَ  (dagger alef)  vs  العالمين  (written alef)
 *   ٱلرَّحْمَـٰنِ  (dagger alef)  vs  الرحمن    (no alef at all)
 *
 * Promoting the dagger alef to a full alef fixes the first pair and breaks the
 * second; dropping it fixes the second and breaks the first. Removing alef from
 * both sides makes the comparison indifferent to the question. What is left is
 * still richly discriminating — Arabic carries meaning in its consonants — and
 * matching runs over whole ayahs, not single words, so the little ambiguity
 * this introduces is absorbed many times over.
 */
export function normalizeArabic(input: string): string {
  if (!input) return "";
  let s = input.normalize("NFC");
  s = s.replace(DIACRITICS, "").replace(TATWEEL, "");
  s = Array.from(s)
    .map((ch) => (ch in LETTER_MAP ? LETTER_MAP[ch]! : ch))
    .join("");
  s = s.replace(NON_LETTERS, " ");
  s = s.replace(/ا/g, ""); // alef — see above
  return s.replace(/\s+/g, " ").trim();
}

/** Normalised whitespace-delimited words. Empty input yields an empty array. */
export function words(input: string): string[] {
  const n = normalizeArabic(input);
  return n ? n.split(" ") : [];
}

/**
 * The Basmalah, normalised. Every surah but At-Tawbah opens with it and imams
 * recite it aloud or silently at unpredictable points, so the aligner needs to
 * recognise and discount it rather than let it drag matches toward Al-Fatihah.
 */
export const BASMALAH_NORMALIZED = normalizeArabic(
  "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ",
);

/** True when the text is nothing but the Basmalah. */
export function isBasmalahOnly(text: string): boolean {
  return normalizeArabic(text) === BASMALAH_NORMALIZED;
}

/**
 * Word-level Levenshtein distance. Word-level rather than character-level
 * because ASR errors are usually whole-word substitutions, and because ayahs
 * run long enough (Al-Baqarah 282 is ~1500 characters) that a character matrix
 * is needlessly expensive when run across many candidates.
 */
export function wordEditDistance(a: string[], b: string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** 1 = identical word sequences, 0 = nothing in common. */
export function sequenceSimilarity(a: string[], b: string[]): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - wordEditDistance(a, b) / longest;
}
