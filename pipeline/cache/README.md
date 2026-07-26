# Transcripts

Raw Gemini output — the Arabic heard in each recording, with timestamps. One
file per video.

**These are committed on purpose, and they are the most valuable thing in the
repository.**

Transcription is the half of the pipeline that costs money. Alignment — turning
that Arabic into verse references — is deterministic and free. Keeping the two
separate means the aligner can be improved and the entire archive re-derived for
nothing:

```bash
rm -rf ../dist/timelines
npm run sync -- --days 99999   # re-aligns from cache, spends nothing
```

Lose this directory and you pay the full bill again. It is a few hundred
kilobytes. Keep it in git.
