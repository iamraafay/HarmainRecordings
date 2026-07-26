/**
 * Aligns a timestamped Arabic transcript to the mushaf.
 *
 * This is the part of the pipeline that decides whether the app is trustworthy,
 * so it contains no model calls at all. Gemini's job is to hear the Arabic;
 * deciding *which ayah* that Arabic is belongs to deterministic code that can be
 * unit-tested, scored, and corrected without spending a token.
 *
 * Three ideas do most of the work:
 *
 *  1. **Inverted index over rare words.** Scoring a segment against all 6,236
 *     ayahs is wasteful; a handful of low-frequency words narrows it to a few
 *     dozen candidates first.
 *
 *  2. **Monotonic bias.** Recitation moves forward. Knowing the previous ayah
 *     makes the next one cheap to confirm, and — critically — it is the only
 *     thing that can disambiguate the 31 identical occurrences of
 *     "فبأي آلاء ربكما تكذبان" in Surah Ar-Rahman, or tell Al-Fatihah in rak'ah
 *     one from Al-Fatihah in rak'ah two.
 *
 *  3. **Splitting.** Gemini often returns several ayahs in one span. When a
 *     match explains only the head of a segment, the tail is re-aligned as its
 *     own segment with time divided in proportion to word count.
 */

import { normalizeArabic, sequenceSimilarity, words, BASMALAH_NORMALIZED } from "./arabic.js";
import { ALIGNER_VERSION, type TimelineSegment, type TranscriptSegment } from "./types.js";

export interface AyahRecord {
  surah: number;
  ayah: number;
  /** Original Uthmani text — never used for matching, only carried through. */
  textUthmani: string;
}

interface IndexedAyah extends AyahRecord {
  words: string[];
  normalized: string;
}

export interface AlignOptions {
  /** Below this combined score a segment is emitted with a null verse. */
  minConfidence: number;
  /** How many candidates from the inverted index to score in full. */
  candidateLimit: number;
  /** Score bonus applied to the ayah that follows the previous match. */
  continuityBonus: number;
  /** Minimum fraction of an ayah's words that must be covered to call it complete. */
  completeCoverage: number;
  /** Maximum recursive splits per input segment. */
  maxSplits: number;
}

export const DEFAULT_ALIGN_OPTIONS: AlignOptions = {
  minConfidence: 0.62,
  candidateLimit: 60,
  continuityBonus: 0.12,
  completeCoverage: 0.7,
  maxSplits: 6,
};

/**
 * Searchable index over the mushaf. Build once, reuse across every video.
 */
export class QuranIndex {
  readonly ayahs: IndexedAyah[];
  /** word -> ayah positions containing it */
  private readonly postings = new Map<string, number[]>();
  /** word -> inverse document frequency */
  private readonly idf = new Map<string, number>();
  private readonly byKey = new Map<string, number>();

  constructor(records: AyahRecord[]) {
    this.ayahs = records.map((r) => {
      const normalized = normalizeArabic(r.textUthmani);
      return { ...r, normalized, words: normalized ? normalized.split(" ") : [] };
    });

    this.ayahs.forEach((a, i) => {
      this.byKey.set(`${a.surah}:${a.ayah}`, i);
      for (const w of new Set(a.words)) {
        const list = this.postings.get(w);
        if (list) list.push(i);
        else this.postings.set(w, [i]);
      }
    });

    const total = this.ayahs.length;
    for (const [word, list] of this.postings) {
      this.idf.set(word, Math.log(total / list.length));
    }
  }

  get size(): number {
    return this.ayahs.length;
  }

  position(surah: number, ayah: number): number | undefined {
    return this.byKey.get(`${surah}:${ayah}`);
  }

  at(position: number): IndexedAyah | undefined {
    return this.ayahs[position];
  }

  /**
   * Candidate ayah positions for a query, ranked by summed IDF of shared words.
   * Common words (و، من، الله) contribute almost nothing, which is the point.
   */
  candidates(queryWords: string[], limit: number): number[] {
    const scores = new Map<number, number>();
    const unique = new Set(queryWords);

    // Rarest query words first, so the cheap discriminating evidence lands
    // before we start walking huge postings lists.
    const ranked = [...unique].sort(
      (a, b) => (this.idf.get(b) ?? 0) - (this.idf.get(a) ?? 0),
    );

    for (const w of ranked) {
      const postings = this.postings.get(w);
      if (!postings) continue;
      // A word present in more than a fifth of the mushaf discriminates nothing.
      if (postings.length > this.ayahs.length / 5) continue;
      const weight = this.idf.get(w) ?? 0;
      for (const pos of postings) {
        scores.set(pos, (scores.get(pos) ?? 0) + weight);
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([pos]) => pos);
  }
}

interface Scored {
  position: number;
  score: number;
  /** How many leading words of the query the ayah accounts for. */
  consumedWords: number;
  coverage: number;
}

/**
 * How many leading words of `query` this ayah actually accounts for.
 *
 * Tries every plausible prefix length and keeps the one that lines up best.
 * This runs only for the winning candidate — doing it for all sixty would be
 * wasteful — but getting it right matters: under-consuming leaves a fragment
 * that gets re-matched as a spurious extra segment, and over-consuming eats the
 * next ayah.
 */
function bestPrefixLength(query: string[], ayahWords: string[]): number {
  const ayahLength = ayahWords.length;
  const low = Math.max(1, Math.floor(ayahLength * 0.5));
  const high = Math.min(query.length, Math.ceil(ayahLength * 1.5) + 1);

  let bestLength = Math.min(query.length, ayahLength);
  let bestScore = -1;
  for (let length = low; length <= high; length++) {
    const similarity = sequenceSimilarity(query.slice(0, length), ayahWords);
    // Ties go to the longer prefix, so a trailing word the ayah does contain is
    // consumed rather than left behind.
    if (similarity >= bestScore) {
      bestScore = similarity;
      bestLength = length;
    }
  }

  // A tail too short to be an ayah on its own belongs to this match.
  if (query.length - bestLength <= 2) return query.length;
  return bestLength;
}

/**
 * Scores one ayah against a query.
 *
 * The query may be longer than the ayah (Gemini merged several) so the ayah is
 * compared against the matching-length prefix of the query, and `consumedWords`
 * reports how much of the query it explained.
 */
function score(query: string[], ayah: IndexedAyah): Scored & { position: number } {
  const ayahLength = ayah.words.length;
  if (ayahLength === 0 || query.length === 0) {
    return { position: -1, score: 0, consumedWords: 0, coverage: 0 };
  }

  // Compare the ayah against as many leading query words as the ayah itself
  // has, plus one word of slack. A proportional window (say 1.15x) looks more
  // forgiving but quietly penalises short ayahs: for a two-word ayah it doubles
  // the comparison span, so a longer neighbouring ayah that swallows the whole
  // prefix outscores the correct short one.
  const window = Math.min(query.length, ayahLength + 1);
  const prefix = query.slice(0, window);

  const seq = sequenceSimilarity(prefix, ayah.words);

  const ayahSet = new Set(ayah.words);
  let overlap = 0;
  for (const w of prefix) if (ayahSet.has(w)) overlap++;
  const coverage = overlap / ayahLength;
  const precision = overlap / prefix.length;

  // Sequence similarity is the honest signal; overlap terms keep partial
  // recitations and ASR word-drops from being thrown away entirely.
  const combined = 0.55 * seq + 0.25 * coverage + 0.2 * precision;

  // `consumedWords` here is only a placeholder for ranking; the winner's true
  // extent is computed once by `bestPrefixLength`.
  return {
    position: -1,
    score: combined,
    consumedWords: Math.min(query.length, ayahLength),
    coverage,
  };
}

function bestMatch(
  query: string[],
  index: QuranIndex,
  previous: number | null,
  opts: AlignOptions,
): Scored | null {
  const candidatePositions = new Set(index.candidates(query, opts.candidateLimit));

  // Always consider the neighbourhood of the previous match, even when the
  // inverted index missed it — this is what carries repeated refrains.
  if (previous !== null) {
    for (let d = 0; d <= 3; d++) {
      if (previous + d < index.size) candidatePositions.add(previous + d);
    }
  }
  if (candidatePositions.size === 0) return null;

  let best: Scored | null = null;
  for (const pos of candidatePositions) {
    const ayah = index.at(pos);
    if (!ayah) continue;
    const s = score(query, ayah);
    let adjusted = s.score;

    if (previous !== null) {
      if (pos === previous + 1) adjusted += opts.continuityBonus;
      else if (pos === previous) adjusted += opts.continuityBonus * 0.5; // imam repeated it
      else if (pos === previous + 2) adjusted += opts.continuityBonus * 0.4;
    }

    if (best === null || adjusted > best.score) {
      best = { position: pos, score: Math.min(adjusted, 1), consumedWords: s.consumedWords, coverage: s.coverage };
    }
  }
  return best;
}

/**
 * Aligns a full transcript. Input segments must be in chronological order;
 * output is one entry per identified ayah, with unmatched spans preserved as
 * null-verse segments rather than dropped, so the app can show "recitation"
 * without making a claim it cannot support.
 */
export function alignSegments(
  transcript: TranscriptSegment[],
  index: QuranIndex,
  options: Partial<AlignOptions> = {},
): TimelineSegment[] {
  const opts = { ...DEFAULT_ALIGN_OPTIONS, ...options };
  const out: Emitted[] = [];
  let previous: number | null = null;

  for (const segment of transcript) {
    let queryWords = words(segment.arabic);
    let t0 = segment.t0;
    const t1 = segment.t1;
    let splits = 0;

    // Bare Basmalah: real, but not an ayah of the surah being opened (except
    // in Al-Fatihah). Emitting it as a null-verse span keeps the timeline
    // honest and stops it from anchoring the sequence to 1:1.
    if (normalizeArabic(segment.arabic) === BASMALAH_NORMALIZED) {
      out.push({ t0, t1, surah: null, ayah: null, conf: 0, position: null, words: [] });
      continue;
    }

    while (queryWords.length > 0 && splits <= opts.maxSplits) {
      const match = bestMatch(queryWords, index, previous, opts);
      const totalWords = queryWords.length;

      if (!match || match.score < opts.minConfidence) {
        out.push({ t0, t1, surah: null, ayah: null, conf: match ? round(match.score) : 0, position: null, words: [] });
        break;
      }

      const ayah = index.at(match.position)!;
      const consumed = bestPrefixLength(queryWords, ayah.words);
      const fraction = consumed / totalWords;
      const splitTime = splits === 0 && fraction >= 0.999 ? t1 : t0 + (t1 - t0) * fraction;

      const entry: TimelineSegment = {
        t0: round(t0),
        t1: round(Math.min(splitTime, t1)),
        surah: ayah.surah,
        ayah: ayah.ayah,
        conf: round(match.score),
      };
      if (match.coverage < opts.completeCoverage) entry.partial = true;
      out.push({ ...entry, position: match.position, words: queryWords.slice(0, consumed) });

      previous = match.position;
      queryWords = queryWords.slice(consumed);
      t0 = Math.min(splitTime, t1);
      splits++;

      // Nothing meaningful left, or the remaining time is too small to show.
      if (queryWords.length === 0 || t1 - t0 < 0.2) break;
    }
  }

  reconcileBackward(out, index, opts);
  return mergeAdjacentDuplicates(out.map(({ position, words, ...segment }) => segment));
}

/** A matched segment plus the evidence behind it, kept only inside the aligner. */
interface Emitted extends TimelineSegment {
  /** Index into the mushaf, or null when unmatched. */
  position: number | null;
  /** The transcript words this match consumed, for rescoring. */
  words: string[];
}

/**
 * Second pass: let what came *next* correct what came before.
 *
 * The forward pass biases each match toward following the previous one, which
 * is what carries repeated refrains. But the *first* ayah of a passage has no
 * previous match to lean on, and several surahs open with text that is
 * identical to another surah's opening — 59:1 and 61:1 are the same string,
 * character for character. Nothing in the audio can separate them.
 *
 * Discovered on a real recording: Sheikh Shamsaan recited Surah As-Saff, and
 * the forward pass labelled the opening 59:1 while every following ayah came
 * out as 61:2, 61:3, 61:4… The sequence itself says which reading is right.
 *
 * So walk backwards, and wherever a segment does not immediately precede the
 * one after it, test the ayah that *would*. Switch only when that alternative
 * explains the same audio at least as well — so a genuine jump between surahs,
 * where the alternative scores far worse, is left alone.
 */
function reconcileBackward(emitted: Emitted[], index: QuranIndex, opts: AlignOptions): void {
  for (let i = emitted.length - 2; i >= 0; i--) {
    const current = emitted[i]!;
    const next = emitted[i + 1]!;
    if (current.position === null || next.position === null) continue;
    // Already consecutive, or a deliberate repeat: nothing to fix.
    if (current.position === next.position - 1 || current.position === next.position) continue;

    const candidatePosition = next.position - 1;
    if (candidatePosition < 0) continue;
    const candidate = index.at(candidatePosition);
    if (!candidate || current.words.length === 0) continue;

    const rescored = score(current.words, candidate);
    // `>= current.conf - epsilon` rather than `>` — for identical openings the
    // two scores are exactly equal, and the sequence is the tie-breaker.
    if (rescored.score + 0.02 >= current.conf && rescored.score >= opts.minConfidence) {
      current.position = candidatePosition;
      current.surah = candidate.surah;
      current.ayah = candidate.ayah;
      current.conf = round(rescored.score);
    }
  }
}

/**
 * Collapses consecutive entries for the same ayah, which happens when a long
 * ayah arrives across two transcript spans.
 */
function mergeAdjacentDuplicates(segments: TimelineSegment[]): TimelineSegment[] {
  const out: TimelineSegment[] = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.surah !== null &&
      prev.surah === s.surah &&
      prev.ayah === s.ayah &&
      s.t0 - prev.t1 < 1.0
    ) {
      prev.t1 = s.t1;
      prev.conf = round(Math.max(prev.conf, s.conf));
      if (!s.partial) delete prev.partial;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Fraction of segments that carry a verse. The headline quality number. */
export function coverageOf(segments: TimelineSegment[]): number {
  if (segments.length === 0) return 0;
  const matched = segments.filter((s) => s.surah !== null).length;
  return Math.round((matched / segments.length) * 1000) / 1000;
}

export { ALIGNER_VERSION };
