# Notes for whoever picks this up

Written by the Claude session that built it, for the next one. Read this before changing `pipeline/src/align.ts` or `arabic.ts` — both contain decisions that look wrong and aren't.

## What this is

A searchable index of **what was recited in every prayer at Masjid al-Haram and Masjid an-Nabawi**, built from the [Haramain Recordings](https://www.youtube.com/@Haramain_Recordings) YouTube channel. Gemini transcribes the Arabic it hears with timestamps; a deterministic aligner matches that to the mushaf; a static site publishes it with every verse deep-linked to the second on YouTube.

**It started as an iOS app and pivoted.** The original plan was a split-screen player — video on top, synced translation below. Two things killed it:

1. **YouTube's terms forbid background playback**, and background listening is how most people consume this content. The app could not serve the primary usage pattern.
2. The **index** turned out to be the more valuable artifact and has no such constraint. Nobody knows what was recited in yesterday's Makkah Isha, because it's new every day and nobody labels it. That gap is real and nothing fills it.

**The app and its Swift port have been removed from the repository and its history**, along with a Firebase `GoogleService-Info.plist` that should never have been committed. If anyone resumes the idea, build against the published index rather than calling Gemini per device — that was the app's other problem, and it is now solved on the server side.

One decision from that era is still worth knowing: **no background audio, ever.** YouTube's terms forbid it and YouTubePlayerKit refuses by design. Don't spend a day designing around a mini-player before checking.

## The one decision not to undo

**Gemini transcribes. It never identifies verses.**

The tempting simplification is to ask "which ayah is this" and delete the aligner. Don't. A model asked to identify a verse answers confidently when it's wrong and nothing downstream can catch it. This puts verse references next to sacred text; "wrong but confident" is the one unacceptable failure. So Gemini gets a strictly narrower job — *write down the Arabic you hear* — and identification happens in code that is deterministic, tested, and carries a confidence score. Below threshold the page shows "Recitation" and claims nothing.

The prompt says *"Do not identify the surah or ayah number."* That line is load-bearing.

## Things that look like bugs and are not

**`Arabic.normalize` deletes every alef.** Alef is exactly the letter whose spelling differs between the Uthmani mushaf and how anyone else writes Arabic — and it differs in *both* directions:

```
ٱلْعَـٰلَمِينَ (dagger alef)  vs  العالمين (written alef)
ٱلرَّحْمَـٰنِ (dagger alef)  vs  الرحمن   (no alef at all)
```

Promoting the dagger alef fixes the first pair and breaks the second. Dropping it does the reverse. Deleting alef from both sides makes the comparison indifferent. Found the hard way — the first version promoted it and Al-Fatihah failed.

**The scoring window is `ayahLength + 1`, not proportional.** A proportional window (1.15×) quietly penalises short ayahs: for a two-word ayah it doubles the span, so a longer neighbour that swallows the prefix outscores the correct short one. This is why `112:2` was being skipped.

**`bestPrefixLength` runs only for the winning candidate.** Running it for all sixty would be correct and wasteful.

**Two passes, not one.** The forward pass biases toward following the previous match — that's what carries the 31 identical refrains in Ar-Rahman. But the *first* ayah of a passage has no previous match, and **59:1 and 61:1 are identical character for character**. Found in the wild: Sheikh Shamsaan recited As-Saff and the forward-only pass labelled the opening 59:1 while everything after came out 61:2, 61:3… `reconcileBackward` walks the timeline in reverse and lets what follows correct what precedes, switching only when the alternative explains the same audio at least as well — so genuine surah jumps survive. Tests cover the fix, an Al-Hashr control, and a genuine-jump control.

**Adhaan, Dhuhr and Asr are skipped before spending anything.** Adhaans contain no Qur'an. **Dhuhr and Asr are recited silently** — nothing audible to transcribe. That's ~68% of uploads removed for free, in `prayerRules.ts`. It's domain knowledge, not an optimisation to tune away.

## One implementation now

The aligner used to exist twice — TypeScript for the site, Swift for the app —
and the two were kept identical against the same fixture. The Swift port went
with the app. `pipeline/src/align.ts` is the only implementation.

That cost something real: the ports cross-checked each other, and a bug that
survived both was unlikely. What remains is the fixture, which is the stronger
half of that guarantee — `pipeline/test/fixtures/` holds raw Gemini output from
a validated recording, and the suite asserts against known-correct verses.

```bash
cd pipeline && npm test          # 43 tests, ~2s
```

## State as of handover

**Verified against reality.**

- **20,000 videos catalogued** — full channel history, 190 imams, 99% of titles parsed.
- **45 salah analysed** (last week of July 2026), 0 failures, ~$6.
- The aligner was validated on `HcWru4_Soxs` — 25 Jul 2026 Makkah Maghrib. Raw Gemini output kept verbatim at `pipeline/test/fixtures/`. All 49 segments correct. It's a deliberately hard case: both rak'ahs end on the **identical** ayah `فسبح باسم ربك العظيم` (56:96 and 69:52), and both contain `تنزيل من رب العالمين` (56:80 and 69:43).
- Timing measured against that fixture: `gemini-3.6-flash` finds 48 of 49 segments, median error 1.0s, 10% beyond 3s.

**Working end to end:** catalogue → filter → transcribe → align → site (1,234 pages), plus cost estimation and model comparison.

**Not done.**

- Repo is committed locally but **not pushed to GitHub**. Workflows are written but Pages isn't configured.
- **Batch API unimplemented** — a straight 50% saving on every bulk run. Highest-value quick win.
- Only 7 days of data. The 90-day and full-archive runs haven't happened.
- 7 of 44 recordings came in under 85% coverage and haven't been reviewed. Some are correct (a Jumu'ah khutbah is mostly sermon, not Qur'an — 50% coverage is right); some may be genuine misses.
- **The 90-day and full-archive backfills haven't run.** Only the first week exists.

## Environment

| | |
|---|---|
| Channel | `UC37tvO47bp_cKH1f4_VQCOA`, uploads playlist `UU37tvO47bp_cKH1f4_VQCOA` |
| Keys | `YOUTUBE_API_KEY`, `GEMINI_API_KEY` in `pipeline/.env`; repo secrets for CI |
| Model | `gemini-3.6-flash`. **The 2.5 line is retired for new accounts** — it still appears in `models.list` but `generateContent` returns 404 |
| Cost | ~$6/week ongoing · $42 for 90 days · ~$533 for the full archive |

**`pipeline/cache/` is committed on purpose and is the most valuable thing in the repo.** Transcription costs money; alignment is free. Improve the aligner and re-derive the whole archive for nothing:

```bash
rm -rf pipeline/dist/timelines && npm run sync -- --days 99999
```

Lose that directory and you pay the full bill again.

## Where to start

1. **Watch the first few automated runs.** The daily workflow is live; confirm it commits transcripts and deploys cleanly before trusting it unattended.
2. **Batch API.** Halves every future run. `src/transcribe.ts` is the only file that changes; the rest of the pipeline doesn't care how the transcript arrived.
3. **Review the 7 low-coverage recordings.** Decide which are khutbahs behaving correctly and which are misses. That tells you whether the review threshold is set right.
4. **Backfill**, once the daily run is proven. Flash-Lite for the deep archive, 3.6 Flash for anything recent — Lite merges ayahs so the aligner interpolates about a third of the timeline, which is invisible on an index page and unacceptable for synced highlighting.

## Traps

**Al-Fatihah repeats every rak'ah.** I wrote two separate metrics that broke on this — a positional agreement score that read 72% where the truth was 97%, and a timing comparison that matched rak'ah 1 against rak'ah 2 and reported 297-second errors. **Any metric keyed by verse must account for repeats.** Use occurrence counts or LCS, never raw position.

**Timestamp anchoring is model-dependent.** With a `start_offset`, 3.6-flash returns absolute video timestamps and 3.1-pro returns clip-relative ones. `anchorToAbsolute` detects which; it's tested against both but stay suspicious.

**`--limit` in the sync workflow is a cost ceiling, not a convenience.** Without it a bug in the date filter could put thousands of videos through Gemini before anyone noticed.

**No background audio, ever.** YouTube's terms forbid it and YouTubePlayerKit refuses by design. Don't spend a day trying — I nearly designed around a mini-player before checking.

## Tone of the thing

This publishes the Qur'an. Two habits follow: show nothing rather than guess, and keep the disclaimer visible. Verse identification is automatic and will sometimes be wrong; the site should never pretend otherwise. Low-confidence and partial matches are marked deliberately — don't tidy those away for visual cleanliness.

Good luck. The hard part — proving a model can hear Quranic recitation well enough to align it — is done and it works. What's left is ordinary.
