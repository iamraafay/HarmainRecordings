/**
 * Parses the Haramain Recordings channel's video titles into structured metadata.
 *
 * The canonical shape is:
 *     25th Jul 2026 Makkah 'Isha Sheikh Baleelah
 *     25th Jul 2026 Madeenah Maghrib Adhaan Sheikh 'Abdul Rahmaan Khashugji
 *
 * but a decade of uploads means spelling drift, missing years, transliteration
 * variants and the occasional typo. So this is a tolerant token scanner rather
 * than one brittle regex: each recogniser consumes the tokens it understands and
 * whatever is left over gets reported, never silently dropped.
 */

import type { Mosque, ParsedTitle, Prayer } from "./types.js";

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const MOSQUES: Record<string, Mosque> = {
  makkah: "makkah", mecca: "makkah", makka: "makkah", makkha: "makkah",
  haram: "makkah", masjidalharam: "makkah",
  madeenah: "madeenah", madinah: "madeenah", madina: "madeenah",
  medina: "madeenah", medinah: "madeenah", madeena: "madeenah",
  nabawi: "madeenah", masjidannabawi: "madeenah",
};

/**
 * Prayer keywords. Order matters only in that longer/compound forms are matched
 * before their substrings by the two-token pass below.
 */
const PRAYERS: Record<string, Prayer> = {
  fajr: "fajr", fajir: "fajr", subh: "fajr",
  dhuhr: "dhuhr", duhr: "dhuhr", zuhr: "dhuhr", zuhur: "dhuhr", dhuhur: "dhuhr",
  asr: "asr", assr: "asr",
  maghrib: "maghrib", magrib: "maghrib", maghreb: "maghrib",
  isha: "isha", ishaa: "isha", esha: "isha",
  jumuah: "jumuah", jumah: "jumuah", jumma: "jumuah", juma: "jumuah",
  friday: "jumuah", khutbah: "jumuah", khutba: "jumuah",
  taraweeh: "taraweeh", tarawih: "taraweeh", taraweh: "taraweeh", taraaweeh: "taraweeh",
  tahajjud: "tahajjud", tahajud: "tahajjud", qiyam: "tahajjud", qiyaam: "tahajjud",
  witr: "witr",
  eid: "eid", eidul: "eid",
  janazah: "janazah", janaza: "janazah", funeral: "janazah",
  istisqa: "istisqa", istasqa: "istisqa", istisqaa: "istisqa",
  kusuf: "kusuf", khusuf: "kusuf", eclipse: "kusuf",
};

const ADHAAN = new Set(["adhaan", "adhan", "athan", "azan", "adzan", "ادان"]);
const HONORIFICS = new Set(["sheikh", "shaykh", "shaikh", "sh", "shk", "imam", "imaam"]);

/** Tokens that carry no meaning and should not count as leftovers. */
const NOISE = new Set(["led", "by", "the", "at", "from", "with", "and", "of", "in", "prayer", "salah", "salaah", "salat", "salaat"]);

/**
 * Strips transliteration punctuation so `'Isha`, `Jumu'ah` and `Mu'ayqali`
 * reduce to comparable keys. Keeps letters and digits only.
 */
export function fold(token: string): string {
  return token
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** `25th` -> 25, `3rd` -> 3, `7` -> 7. Returns null if the token is not a day. */
function asDay(token: string): number | null {
  const m = /^(\d{1,2})(st|nd|rd|th)?$/i.exec(token.replace(/[^\dA-Za-z]/g, ""));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 31 ? n : null;
}

/** Accepts 4-digit years in a sane range, plus 2-digit shorthand (`10` -> 2010). */
function asYear(token: string, hasOrdinalContext: boolean): number | null {
  const raw = token.replace(/\D/g, "");
  if (raw.length === 4) {
    const n = Number(raw);
    return n >= 1990 && n <= 2100 ? n : null;
  }
  if (raw.length === 2 && hasOrdinalContext) {
    const n = Number(raw);
    // Channel started in the 2000s; a bare 2-digit year is always 20xx.
    return 2000 + n;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

interface DateHit {
  iso: string;
  /** Indices of the tokens consumed. */
  consumed: number[];
}

/**
 * Finds `<day> <month> [year]` anywhere in the token stream. The year is
 * optional because a handful of older uploads omit it; those come back with a
 * null date rather than a guessed one.
 */
function findDate(tokens: string[]): DateHit | null {
  for (let i = 0; i < tokens.length - 1; i++) {
    const day = asDay(tokens[i]!);
    if (day === null) continue;

    const month = MONTHS[fold(tokens[i + 1]!)];
    if (month === undefined) continue;

    const yearToken = tokens[i + 2];
    const year = yearToken ? asYear(yearToken, true) : null;
    // day+month with no usable year (missing, or a typo like "1010"): keep
    // scanning rather than guessing — the tokens surface in `leftovers`.
    if (year === null) continue;

    return {
      iso: `${year}-${pad(month)}-${pad(day)}`,
      consumed: [i, i + 1, i + 2],
    };
  }
  return null;
}

/**
 * How far a title's date may run *ahead* of the upload date before we stop
 * believing it.
 *
 * Zero would be defensible — across 17,368 dated titles not one legitimate
 * entry is dated after its own upload. One day of slack is kept for the
 * genuinely awkward case: a Tahajjud recorded after midnight Makkah time
 * (UTC+3) can carry a local date that is a day ahead of the UTC timestamp
 * YouTube stamps on it.
 */
export const UPLOAD_SLACK_DAYS = 1;

const DAY_MS = 86_400_000;

/**
 * Cross-checks a title's date against the date YouTube says the video was
 * uploaded, and rejects the title when it claims a date it cannot have.
 *
 * The channel titles carry the date, and the parser believes them — which is
 * right until someone types the wrong year. Two live examples:
 *
 *     "3rd Jul 2035 Madeenah 'Asr Sheikh Budayr"        uploaded 2025-07-03
 *     "9th May 2029 Madeenah Jumu'ah Adhaan …"          uploaded 2025-05-09
 *
 * Neither is malformed, so neither reached `unparsed.json`; both parsed with
 * full confidence and sorted to the top of every by-date view, pushing real
 * days off the front page.
 *
 * The test is not a tuned tolerance, it is a fact about recordings: **a prayer
 * cannot be uploaded before it is prayed.** So a title dated *after* its own
 * upload is impossible and the upload date wins. The reverse — a title dated
 * before its upload — is an ordinary late upload and is left alone. Measured
 * across the catalogue: 212 videos uploaded the next day, 8 uploaded up to five
 * days later, and every single entry dated ahead of its upload was a typo.
 *
 * Deliberately asymmetric. A symmetric window would either reject those late
 * uploads or fail to catch "7th Feb 2024" on a video uploaded 7 Jan 2024.
 *
 * Note this cannot catch a typo that lands in the *past* — a title reading 2015
 * instead of 2025 is equally wrong and entirely plausible to the check. Those
 * are invisible today; nothing in the data distinguishes them from an archival
 * re-upload.
 */
export function reconcileDateWithUpload(
  titleDate: string | null,
  publishedAt: string,
  slackDays = UPLOAD_SLACK_DAYS,
): { date: string | null; corrected: boolean } {
  const uploadDate = publishedAt.slice(0, 10);
  if (!titleDate || !/^\d{4}-\d{2}-\d{2}$/.test(uploadDate)) {
    return { date: titleDate, corrected: false };
  }

  const titleMs = Date.parse(`${titleDate}T00:00:00Z`);
  const uploadMs = Date.parse(`${uploadDate}T00:00:00Z`);
  if (!Number.isFinite(titleMs) || !Number.isFinite(uploadMs)) {
    return { date: titleDate, corrected: false };
  }

  const daysAhead = (titleMs - uploadMs) / DAY_MS;
  if (daysAhead <= slackDays) return { date: titleDate, corrected: false };

  return { date: uploadDate, corrected: true };
}

/**
 * Parses one raw title. Never throws: an unrecognisable title comes back with
 * null fields, confidence 0 and every token in `leftovers`.
 *
 * The date here is whatever the title claims. It is only as good as the person
 * who typed it — see `reconcileDateWithUpload`, which the catalogue applies
 * once the upload timestamp is known.
 */
export function parseTitle(rawTitle: string): ParsedTitle {
  const title = rawTitle.replace(/[‘’ʻʼ`]/g, "'").replace(/\s+/g, " ").trim();
  const tokens = title.split(" ").filter(Boolean);
  const consumed = new Set<number>();

  const dateHit = findDate(tokens);
  if (dateHit) dateHit.consumed.forEach((i) => consumed.add(i));

  let mosque: Mosque | null = null;
  let prayer: Prayer | null = null;
  let isAdhaan = false;
  let honorificIndex = -1;

  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const key = fold(tokens[i]!);
    if (!key) { consumed.add(i); continue; }

    if (mosque === null && MOSQUES[key]) {
      mosque = MOSQUES[key]!;
      consumed.add(i);
      continue;
    }
    if (ADHAAN.has(key)) {
      isAdhaan = true;
      consumed.add(i);
      continue;
    }
    if (prayer === null && PRAYERS[key]) {
      prayer = PRAYERS[key]!;
      consumed.add(i);
      continue;
    }
    // "Eid ul Fitr" / "Eid al Adha" — absorb the qualifier so it is not a leftover.
    if (prayer === "eid" && (key === "ul" || key === "al" || key === "fitr" || key === "adha")) {
      consumed.add(i);
      continue;
    }
    if (honorificIndex === -1 && HONORIFICS.has(key)) {
      honorificIndex = i;
      consumed.add(i);
      continue;
    }
  }

  // Everything after the honorific is the name. Titles put it last, and names
  // are multi-token often enough ("'Abdul Rahmaan Khashugji") that a greedy
  // tail is more reliable than trying to bound it.
  let sheikh: string | null = null;
  if (honorificIndex !== -1) {
    const nameTokens: string[] = [];
    for (let i = honorificIndex + 1; i < tokens.length; i++) {
      if (consumed.has(i)) continue;
      nameTokens.push(tokens[i]!);
      consumed.add(i);
    }
    const joined = nameTokens.join(" ").trim();
    if (joined) sheikh = joined;
  }

  const leftovers = tokens.filter((t, i) => !consumed.has(i) && !NOISE.has(fold(t)) && fold(t) !== "");

  // Weighted so that a title missing only the sheikh still parses cleanly,
  // while one missing the prayer (the thing the app groups by) does not.
  const confidence =
    (dateHit ? 0.3 : 0) +
    (mosque ? 0.25 : 0) +
    (prayer || isAdhaan ? 0.3 : 0) +
    (sheikh ? 0.15 : 0);

  return {
    date: dateHit?.iso ?? null,
    mosque,
    prayer,
    isAdhaan,
    sheikh,
    sheikhKey: sheikh ? fold(sheikh) : null,
    confidence: Math.round(confidence * 100) / 100,
    leftovers,
  };
}
