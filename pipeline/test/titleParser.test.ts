import { describe, expect, it } from "vitest";
import { parseTitle } from "../src/titleParser.js";
import { parseIsoDuration, parseRssFeed } from "../src/catalog.js";
import { parseTimestamp, planWindows, anchorToAbsolute, dedupeOverlap } from "../src/transcribe.js";

describe("parseTitle — the channel's canonical format", () => {
  it("reads a standard salah title", () => {
    expect(parseTitle("25th Jul 2026 Makkah 'Isha Sheikh Baleelah")).toMatchObject({
      date: "2026-07-25",
      mosque: "makkah",
      prayer: "isha",
      isAdhaan: false,
      sheikh: "Baleelah",
      leftovers: [],
    });
  });

  it("reads an adhaan title and flags it", () => {
    const parsed = parseTitle("25th Jul 2026 Madeenah Maghrib Adhaan Sheikh 'Abdul Rahmaan Khashugji");
    expect(parsed).toMatchObject({
      date: "2026-07-25",
      mosque: "madeenah",
      prayer: "maghrib",
      isAdhaan: true,
      sheikh: "'Abdul Rahmaan Khashugji",
      leftovers: [],
    });
  });

  it("handles multi-word sheikh names", () => {
    expect(parseTitle("25th Jul 2026 Makkah Dhuhr Adhaan Sheikh Sami Rayes").sheikh).toBe("Sami Rayes");
    expect(parseTitle("25th Jul 2026 Madeenah 'Asr Adhaan Sheikh Saami Dewli").sheikh).toBe("Saami Dewli");
  });

  it("gives aliases of the same name a comparable key", () => {
    expect(parseTitle("1st Jan 2020 Makkah Fajr Sheikh Mu'ayqali").sheikhKey).toBe(
      parseTitle("1st Jan 2020 Makkah Fajr Sheikh Muayqali").sheikhKey,
    );
  });
});

describe("parseTitle — a decade of drift", () => {
  it("accepts Madinah/Madeenah/Medina spellings", () => {
    for (const spelling of ["Madeenah", "Madinah", "Madina", "Medina"]) {
      expect(parseTitle(`3rd Mar 2015 ${spelling} Fajr Sheikh Qaasim`).mosque).toBe("madeenah");
    }
  });

  it("accepts prayer-name variants", () => {
    expect(parseTitle("3rd Mar 2015 Makkah Zuhr Sheikh X").prayer).toBe("dhuhr");
    expect(parseTitle("3rd Mar 2015 Makkah Magrib Sheikh X").prayer).toBe("maghrib");
    expect(parseTitle("3rd Mar 2015 Makkah Ishaa Sheikh X").prayer).toBe("isha");
    expect(parseTitle("3rd Mar 2015 Makkah Tarawih Sheikh X").prayer).toBe("taraweeh");
    expect(parseTitle("3rd Mar 2015 Makkah Qiyam Sheikh X").prayer).toBe("tahajjud");
  });

  it("reads two-digit years from the older uploads", () => {
    expect(parseTitle("11th Jan 10 Makkah Fajr").date).toBe("2010-01-11");
  });

  it("reads titles with no ordinal suffix", () => {
    expect(parseTitle("6 Sept 2008 Madinah Maghrib Sheikh Hudhaify").date).toBe("2008-09-06");
  });

  it("survives an unusual prayer without inventing a date", () => {
    const parsed = parseTitle("11th jan 10 Makkah Istasqa");
    expect(parsed.prayer).toBe("istisqa");
    expect(parsed.date).toBe("2010-01-11");
  });

  it("absorbs filler words instead of reporting them as leftovers", () => {
    const parsed = parseTitle("6th Sept 2008 Makkah Maghrib led by Sheikh Sudais");
    expect(parsed.sheikh).toBe("Sudais");
    expect(parsed.leftovers).toEqual([]);
  });

  it("refuses to guess a year it cannot believe", () => {
    // A real title on the channel's archive: "8th Jan 1010 Madinah Fajr".
    const parsed = parseTitle("8th Jan 1010 Madinah Fajr");
    expect(parsed.date).toBeNull();
    expect(parsed.mosque).toBe("madeenah");
    expect(parsed.leftovers).toContain("1010");
  });

  it("never throws, and surfaces what it did not understand", () => {
    const parsed = parseTitle("Hajj 1438 In Pictures | Haramain Recordings");
    expect(parsed.confidence).toBeLessThan(0.6);
    expect(parsed.leftovers.length).toBeGreaterThan(0);
  });

  it("handles an empty title", () => {
    expect(parseTitle("").confidence).toBe(0);
  });
});

describe("parseIsoDuration", () => {
  it("reads YouTube durations", () => {
    expect(parseIsoDuration("PT8M49S")).toBe(529);
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("nonsense")).toBeNull();
  });
});

describe("parseRssFeed", () => {
  it("extracts entries and decodes entities", () => {
    const xml = `<feed><entry>
      <yt:videoId>abc123</yt:videoId>
      <media:title>25th Jul 2026 Makkah &#39;Isha Sheikh Baleelah</media:title>
      <published>2026-07-25T18:00:00+00:00</published>
    </entry></feed>`;
    const [entry] = parseRssFeed(xml);
    expect(entry).toMatchObject({
      videoId: "abc123",
      title: "25th Jul 2026 Makkah 'Isha Sheikh Baleelah",
    });
  });
});

describe("transcription helpers", () => {
  it("parses MM:SS and HH:MM:SS timestamps", () => {
    expect(parseTimestamp("01:13")).toBe(73);
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(parseTimestamp("45")).toBe(45);
    expect(parseTimestamp("abc")).toBeNull();
  });

  it("keeps a short video in one window", () => {
    expect(planWindows(529)).toEqual([{ start: 0, end: 529 }]);
  });

  it("overlaps windows for a long video", () => {
    const windows = planWindows(1500, 600, 20);
    expect(windows[0]).toEqual({ start: 0, end: 600 });
    expect(windows[1]!.start).toBe(580);
    expect(windows.at(-1)!.end).toBe(1500);
  });

  it("re-anchors clip-relative timestamps to absolute video time", () => {
    const shifted = anchorToAbsolute([{ t0: 5, t1: 10, arabic: "x" }], { start: 600, end: 1200 });
    expect(shifted[0]).toMatchObject({ t0: 605, t1: 610 });
  });

  it("leaves already-absolute timestamps alone", () => {
    const same = anchorToAbsolute([{ t0: 605, t1: 1150, arabic: "x" }], { start: 600, end: 1200 });
    expect(same[0]).toMatchObject({ t0: 605, t1: 1150 });
  });

  it("drops a segment repeated across a window overlap", () => {
    const deduped = dedupeOverlap([
      { t0: 0, t1: 10, arabic: "الحمد لله" },
      { t0: 8, t1: 18, arabic: "الحمد لله" },
      { t0: 20, t1: 30, arabic: "رب العالمين" },
    ]);
    expect(deduped).toHaveLength(2);
  });
});
