# P5 Task 2 report — Speech backend (speech.py)

## Status: COMPLETE

## Deliverables
- `agent_service/guidemate_agent/speech.py` (NEW) — `downsample_pcm16` (pure linear
  resampler, downsample-only), `pcm16_to_wav`, `synthesize_mp3` / `synthesize_pcm16`
  (Polly neural, VoiceId=Justin, us-west-2), `TranscribeSession` (async
  start/feed/finish streaming STT via amazon-transcribe).
- `agent_service/tests/test_speech.py` (NEW) — 8 unit tests (pure fns + Polly via fake
  client) + 1 env-gated live loopback test.

## SDK verification (Step 1, done first)
`amazon-transcribe` installed into `.venv` (pulled `awscrt==0.26.1`). REPL confirmed:
- `TranscribeStreamingClient` imports; `start_stream_transcription` present (spelling matches brief).
- `TranscriptResultStreamHandler` imports; base class name correct.
- Optional `amazon_transcribe.model.TranscriptEvent` also imports (not needed — no type hint used).

## Tests
- Unit: `8 passed, 1 skipped` (live skipped without env gate).
- Full agent_service suite: `136 passed, 14 skipped` — no regressions.
- **Live loopback (GUIDEMATE_LIVE=1, real AWS): PASSED.** Polly synthesized
  "the quick brown fox jumps over the lazy dog" → Transcribe streaming recovered
  it verbatim ("The quick brown fox jumps over the lazy dog.").
  - Latency: Polly 0.60s, Transcribe stream 2.13s, total **2.73s**.

## Concerns
- pip flagged a dependency conflict: `awsiotsdk 1.30.0` wants `awscrt==0.34.1` but
  amazon-transcribe pinned `awscrt==0.26.1` (downgrade). Both imported fine in the
  venv here; if the bridge (awsiotsdk) shares this venv, verify IoT still connects.
- Imports placed at module top (clean) rather than the Step-5 mid-file noqa E402 form;
  behavior identical.
