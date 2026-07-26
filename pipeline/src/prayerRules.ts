/**
 * Which recordings are worth spending a Gemini call on.
 *
 * This file is the cheapest optimisation in the project, and it is domain
 * knowledge rather than engineering.
 *
 * In Dhuhr and Asr the imam recites **sirri** — silently. There is no audible
 * Qur'an in those recordings at all, so transcribing them buys an empty result
 * at full price. The channel posts them anyway (people listen for the adhan and
 * the atmosphere), and they are roughly 40% of the daily prayer uploads.
 *
 * Combined with skipping the adhaan videos, which contain no Qur'an by
 * definition, this removes about 70% of the channel's uploads before a single
 * token is spent.
 *
 * The rule is deliberately conservative: skip only what is certainly silent.
 * Where scholars differ (Kusuf) or where practice varies, analyse it — a
 * wasted call costs cents, a missing timeline costs a gap in the index.
 */

import type { CatalogEntry, Prayer } from "./types.js";

/** How the Qur'an is recited in this prayer. */
export type Audibility = "jahri" | "sirri" | "unknown";

const AUDIBILITY: Record<Prayer, Audibility> = {
  // Recited aloud — these are the ones worth analysing.
  fajr: "jahri",
  maghrib: "jahri",
  isha: "jahri",
  jumuah: "jahri",
  taraweeh: "jahri",
  tahajjud: "jahri",
  witr: "jahri",
  eid: "jahri",
  istisqa: "jahri",

  // Recited silently. Nothing to hear, nothing to transcribe.
  dhuhr: "sirri",
  asr: "sirri",

  // Janazah has no rukū' recitation and the Fatihah is usually silent, but
  // practice varies enough that it is not worth asserting.
  janazah: "unknown",
  // Scholars differ on the solar eclipse prayer; the lunar one is aloud.
  kusuf: "unknown",
  other: "unknown",
};

export function audibilityOf(prayer: Prayer | null): Audibility {
  if (!prayer) return "unknown";
  return AUDIBILITY[prayer] ?? "unknown";
}

export interface AnalysisDecision {
  analyze: boolean;
  /** Short machine-readable reason, surfaced in reports and in the site. */
  reason: "ok" | "adhaan" | "silent-recitation" | "unparsed-title";
}

/**
 * Decides whether a catalogue entry should be sent to Gemini.
 *
 * `unknown` audibility is analysed rather than skipped — see the note above.
 */
export function decideAnalysis(entry: CatalogEntry): AnalysisDecision {
  if (entry.isAdhaan) return { analyze: false, reason: "adhaan" };
  if (!entry.prayer) return { analyze: false, reason: "unparsed-title" };
  if (audibilityOf(entry.prayer) === "sirri") {
    return { analyze: false, reason: "silent-recitation" };
  }
  return { analyze: true, reason: "ok" };
}

/** Human-readable explanation, used on the website and in CLI output. */
export const REASON_LABELS: Record<AnalysisDecision["reason"], string> = {
  ok: "Analysed",
  adhaan: "Call to prayer — no Qur'an recited",
  "silent-recitation": "Silent recitation — nothing audible to transcribe",
  "unparsed-title": "Title not understood",
};

export function partition(entries: CatalogEntry[]): {
  analyzable: CatalogEntry[];
  skipped: { entry: CatalogEntry; reason: AnalysisDecision["reason"] }[];
} {
  const analyzable: CatalogEntry[] = [];
  const skipped: { entry: CatalogEntry; reason: AnalysisDecision["reason"] }[] = [];

  for (const entry of entries) {
    const decision = decideAnalysis(entry);
    if (decision.analyze) analyzable.push(entry);
    else skipped.push({ entry, reason: decision.reason });
  }
  return { analyzable, skipped };
}
