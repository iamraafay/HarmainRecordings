# Haramain Index

**What was recited at Masjid al-Haram and Masjid an-Nabawi — searchable by day, by surah, and by imam.**

The [Haramain Recordings](https://www.youtube.com/@Haramain_Recordings) channel publishes every prayer from both mosques, every day — around twenty videos daily, and 37,482 in the archive. The titles say who led and when. Nothing says what was recited.

This fills that gap. Gemini transcribes the Arabic it hears with timestamps; a deterministic aligner matches that transcript to the mushaf. The output is a static site where every verse links to the exact second on YouTube.

## Why the model never names a verse

The obvious design is to ask Gemini "which ayah is this." It is the wrong one.

A model asked to identify a verse answers confidently when it is wrong, and nothing downstream can catch it. This puts verse references next to sacred text, so "wrong but confident" is the one unacceptable failure. Gemini gets a strictly narrower job — *write down the Arabic you hear* — and identification happens in [`align.ts`](pipeline/src/align.ts), where it is deterministic, unit-tested, and carries a confidence score. Below threshold, the page shows "Recitation" and claims nothing.

The prompt says *"Do not identify the surah or ayah number."* That line is load-bearing.

## Keeping it current

Two GitHub Actions, no server:

| Workflow | Trigger | Does |
|---|---|---|
| [`sync.yml`](.github/workflows/sync.yml) | every 6 hours | new uploads → Gemini → aligner → commits transcripts and timelines |
| [`deploy.yml`](.github/workflows/deploy.yml) | on those commits | rebuilds the site → GitHub Pages |

Every six hours rather than daily because the channel's RSS feed only holds the fifteen most recent uploads and the channel posts about twenty a day — a daily job would miss some. Extra runs are free: `sync` skips anything that already has a timeline.

`--limit` in the sync workflow is a hard cost ceiling, not a convenience. Without it, a bug in the date filter could put thousands of videos through Gemini before anyone noticed.

Set two repository secrets under **Settings → Secrets and variables → Actions**:

- `YOUTUBE_API_KEY` — Data API v3, for the catalogue
- `GEMINI_API_KEY` — from [AI Studio](https://aistudio.google.com/apikey)

Then **Settings → Pages → Source: GitHub Actions**.

## What is committed, and why it matters

`pipeline/cache/` holds the Gemini transcripts, and **they are the most valuable thing in this repository.**

Transcription costs money; alignment is free. Keeping them separate means the aligner can be improved and the whole archive re-derived for nothing:

```bash
rm -rf pipeline/dist/timelines
npm run sync -- --days 99999    # re-aligns from cache, spends nothing
```

Everything else regenerates: the catalogue is 8 MB and changes daily, so it is rebuilt in CI rather than committed; the Quran database is rebuilt from public sources.

## Running it yourself

```bash
cd pipeline
npm install
cp .env.example .env            # add your two keys

npm run quran                   # build the Quran database
npm run catalog                 # index the channel — 20,000 videos (YouTube caps
                                #   playlist paging there; see CLAUDE.md)
npm run estimate 7              # what a week would cost, per model
npm run sync -- --days 7        # transcribe and align
npm run site                    # generate the site
npm test                        # 43 tests, ~2s
```

### Two thirds of the channel is skipped before anything is spent

Adhaan videos contain no Qur'an. **Dhuhr and Asr are recited silently** — there is nothing audible to transcribe. Together that is about 68% of uploads, removed by [`prayerRules.ts`](pipeline/src/prayerRules.ts) at zero cost.

### Choosing a model

`npm run compare 10` runs several models over the same videos and scores them without human judgement: a model that mishears produces segments the aligner cannot place, so **alignment coverage is a free proxy for transcription quality.**

Measured on a verified fixture (July 2026):

| | segments found | median timing error | beyond 3s | 90 days | full archive |
|---|---|---|---|---|---|
| `gemini-3.6-flash` | 48 of 49 | 1.0s | 10% | $42 | $533 |
| `gemini-3.5-flash-lite` | 30 of 49 | 1.0s | 20% | $10 | $124 |

Flash-Lite merges ayahs, so the aligner interpolates about a third of the timeline. For an index page that is invisible. For synced highlighting it is not. A reasonable split is Flash-Lite for the deep archive and 3.6 Flash for anything recent.

## Licensing

Recitations belong to [haramain.info](http://www.haramain.info). This links to their videos and hosts no audio. Worth contacting them before promoting it widely.

Verses are identified automatically and can be wrong. The site says so, on every page.
