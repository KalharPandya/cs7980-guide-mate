# ElevenLabs Voice Backend — Design Spec

**Date:** 2026-07-08
**Status:** approved design — ready for implementation plan
**Component:** `agent_service` (Moses dog-agent / Campus Concierge)
**Author:** Kalhar Pandya

## TL;DR
Give Moses a better voice by adding **ElevenLabs** as an env-gated backend for both
**Text-to-Speech** (replaces Amazon Polly) and **real-time Speech-to-Text** (replaces
Amazon Transcribe streaming), behind the existing `agent_service/guidemate_agent/speech.py`
seams. AWS stays the **default** so nothing regresses. The change is **backend-only**: the
WebSocket contract (`/ws/chat/{session_id}`) is preserved byte-for-byte, so the concierge
frontend (`static/chat.js` — push-to-talk mic + "Sound on" playback + emote-sync) needs
**zero changes**. Users simply hear an ElevenLabs voice instead of Polly.

## Goal / Non-goals

**Goals**
- Higher-quality, more characterful voice for the Moses persona (a dog companion voice).
- Lower latency via `eleven_flash_v2_5` (~75 ms) with optional streaming.
- Single, clean opt-in switch; AWS remains the safe default.
- No frontend changes; no change to the emote-sync release gate, KB citations, session
  persistence, observability, or motion safety architecture.

**Non-goals (this pass)**
- ElevenLabs Conversational AI / ElevenAgents (barge-in, full-duplex). Rejected: it would
  dismantle the `ws_chat` emote-sync gate that couples reply text + audio + physical emote
  ack — the POC's core contribution. Revisit only if real-time spoken conversation becomes a
  headline requirement.
- Avatar viseme lip-sync from ElevenLabs (that path lives only in the separate `avatar_poc`;
  the dog path ships plain mp3 and has no viseme dependency).
- Custom voice design / voice cloning for Moses (nice-to-have follow-up).

## Why Option 2 (chosen)
Three options were weighed (see conversation of 2026-07-08):
1. **TTS-only drop-in** — smallest, but leaves STT on Transcribe.
2. **TTS + STT (chosen)** — single-vendor voice stack; keeps *our* orchestration
   (`ws_chat.py` + Bedrock `DogAgent`) intact; both endpoints already have clean seams.
3. **Full ElevenAgents** — rejected (see Non-goals); highest effort, attacks the emote-sync
   architecture, moves the turn loop into an un-unit-testable third-party runtime.

Option 2 preserves everything the POC exists to prove (physical/virtual companion lock,
emote-sync release gate, KB-grounded persona, motion default-deny) while swapping only the
two audio "codecs."

## Current code — the seams we build on

| Concern | Location | Contract to preserve |
|---|---|---|
| TTS | `speech.py` `synthesize_mp3(text, voice_id, region, polly_client=None) -> bytes` | returns raw mp3 bytes |
| TTS (PCM) | `speech.py` `synthesize_pcm16(...) -> bytes` | raw 16-bit LE mono PCM |
| STT | `speech.py` `TranscribeSession`: `start() -> feed(pcm)* -> finish() -> str` | final transcript text |
| TTS call site | `ws_chat.py:163` `synthesize_mp3(reply_text, region=region)` → `{"type":"audio","format":"mp3","b64":...}` | one call site |
| STT wiring | `ws_chat.py` `start_audio`/binary-PCM/`stop_audio` → `TranscribeSession` → `{"type":"transcript","text":...}` | one construction site |
| Pure helpers | `speech.py` `downsample_pcm16`, `pcm16_to_wav` | unchanged |
| Frontend | `static/chat.js` push-to-talk (16 kHz Int16 PCM), `audio` mp3 playback, "Sound on" | **unchanged** |

**Backend-only guarantee:** the frontend sends `{type:"start_audio",sample_rate}` + binary
16 kHz PCM + `{type:"stop_audio"}` and plays back the `{type:"audio",format:"mp3",b64}` frame.
As long as STT still consumes 16 kHz mono PCM and TTS still returns mp3 bytes, `chat.js` is
untouched. Both ElevenLabs endpoints meet this (verified against the SDK — see below).

## ElevenLabs API facts (verified 2026-07-08 via SDK docs / context7)

**TTS** — `elevenlabs` Python SDK:
```python
from elevenlabs import ElevenLabs
client = ElevenLabs(api_key=...)
audio_iter = client.text_to_speech.convert(     # or .stream(...) — same params
    voice_id=..., text=..., model_id="eleven_flash_v2_5",
    output_format="mp3_44100_128",              # or "pcm_16000" for raw PCM
    optimize_streaming_latency=0,               # 0..4
)
mp3_bytes = b"".join(audio_iter)                # Iterator[bytes] -> bytes
```
- `output_format` is `codec_sample_rate_bitrate`: `mp3_44100_128` (playback), `pcm_16000`
  (loopback/fake-mic path, matches Polly PCM at 16 kHz).
- `eleven_flash_v2_5`: ~75 ms, 32 languages, ~50% lower cost. Default TTS model.

**STT (real-time)** — Scribe v2 realtime WebSocket, in `elevenlabs.realtime`:
- Connect with `model_id="scribe_v2_realtime"`, `audio_format=AudioFormat.PCM_16000`,
  `sample_rate=16000` — **exactly our Transcribe input format**.
- Send `input_audio_chunk` messages: base64-encoded PCM, `commit` flag.
- Events: `partial_transcript`, `committed_transcript`,
  `committed_transcript_with_timestamps`, plus error events (`auth_error`,
  `quota_exceeded`, `rate_limited`, ...). `committed_transcript` == our current "final only"
  collection (the existing handler drops partials).

> Note: exact realtime method/param names must be pinned against the *installed* SDK version
> during implementation (the realtime surface is newer than the stable TTS surface). The
> enum + message shapes above are from the SDK source (`realtime/scribe.py`,
> `realtime/connection.py`).

## Design

### 1. Config (`config.py`)
Add fields to `Config` + `from_env()`, all env-overridable, AWS-default:
- `tts_backend: str = "polly"` ← `GUIDEMATE_TTS_BACKEND` ∈ {`polly`,`elevenlabs`}
- `stt_backend: str = "transcribe"` ← `GUIDEMATE_STT_BACKEND` ∈ {`transcribe`,`elevenlabs`}
- `elevenlabs_api_key: str = ""` ← `ELEVENLABS_API_KEY`
- `elevenlabs_voice_id: str = ""` ← `ELEVENLABS_VOICE_ID`
- `elevenlabs_tts_model: str = "eleven_flash_v2_5"` ← `GUIDEMATE_ELEVENLABS_TTS_MODEL`
- `elevenlabs_stt_model: str = "scribe_v2_realtime"` ← `GUIDEMATE_ELEVENLABS_STT_MODEL`

**Startup fail-safe:** if a backend is set to `elevenlabs` but `elevenlabs_api_key` is empty,
log a warning and fall back to the AWS backend for that direction. The demo can never break
because a key is missing.

### 2. TTS (`speech.py`)
Keep `synthesize_mp3()` / `synthesize_pcm16()` signatures and `-> bytes` contract; dispatch
internally on backend:
- `elevenlabs` → `b"".join(client.text_to_speech.convert(voice_id, text, model_id,
  output_format))` with `mp3_44100_128` (mp3) / `pcm_16000` (pcm).
- else → existing Polly path.
- Add an injectable `el_client=None` param (mirrors the existing `polly_client=None`) for
  tests.
- **Per-call fallback:** on any ElevenLabs error, log and fall back to Polly for that call.
  (`ws_chat` already treats the `audio` frame as best-effort, so a total TTS failure is
  non-fatal to the turn.)

`ws_chat.py:163` is **unchanged** — backend is read from config, not the call.

### 3. STT (`speech.py` + one line in `ws_chat.py`)
Add `ElevenLabsTranscribeSession` implementing the **same** interface as `TranscribeSession`:
- `start()` — open the Scribe realtime WebSocket; start a consumer task that accumulates
  `committed_transcript` text (mirrors `_CollectingHandler` keeping only finals).
- `feed(pcm)` — send `input_audio_chunk` (base64 of the 16 kHz PCM), `commit=False`.
- `finish()` — send a final commit, await the consumer, return the joined committed text;
  return `""` on any error (matches the current safe-teardown behavior).

Add a factory `make_transcribe_session(config, region, sample_rate=16000)` returning the
right class. In `ws_chat.py`, replace the single `TranscribeSession(region=region,
sample_rate=16000)` construction with the factory call (**one line**). `downsample_pcm16`
still runs on inbound frames first (both backends want 16 kHz mono PCM).

**STT fallback:** if the ElevenLabs WebSocket fails to connect, fall back to
`TranscribeSession`. A mid-stream error degrades to `finish() -> ""` (same as today).

### 4. Voice
Configure `ELEVENLABS_VOICE_ID` with a chosen library voice suited to the Moses persona
(young / upbeat, echoing today's Polly "Justin"). Custom voice design is a follow-up.

### 5. Secrets & dependencies
- `ELEVENLABS_API_KEY` supplied via env / AWS Secrets Manager. **Never committed** (matches
  the repo's no-credentials rule). It is the one non-AWS secret this feature introduces.
- Add `elevenlabs` to `agent_service/pyproject.toml` `dependencies`.
  **Dependency-conflict check (required):** `amazon-transcribe` is already installed
  `--no-deps` because it hard-pins `awscrt~=0.26.1` (conflicts with `awsiotsdk`'s awscrt
  0.34.x). Before adding `elevenlabs`, verify its transitive deps (httpx / pydantic /
  websockets) resolve cleanly against the existing stack; if a hard pin conflicts, install
  `elevenlabs` the same `--no-deps` way (document in `Dockerfile` + README, as done for
  `amazon-transcribe`).

## Testing
Mirror the existing `agent_service/tests/` patterns; **no network in CI**.
- `test_speech.py` — mocked `el_client`: backend switch honored; `synthesize_mp3`/`pcm16`
  join chunk bytes correctly; missing-key → Polly fallback; per-call error → Polly fallback.
- STT unit — a fake realtime connection emitting `partial_transcript` + `committed_transcript`
  events; assert `finish()` returns committed-only joined text; connect failure → Transcribe
  fallback.
- `test_speech_loopback.py` — parametrize by backend; ElevenLabs `pcm_16000` path.
- `test_voice_e2e.py` — keep AWS as the default assertion; add an ElevenLabs variant
  `pytest.mark.skipif(no ELEVENLABS_API_KEY)` so it only runs when a key is present.
- Manual contract test (not in CI): one real `convert()` + one real realtime STT turn against
  the live API, run locally with a key.

## Rollout / demo toggle
- Ship with AWS default (no behavior change on deploy).
- Flip to ElevenLabs per environment: `GUIDEMATE_TTS_BACKEND=elevenlabs`,
  `GUIDEMATE_STT_BACKEND=elevenlabs`, `ELEVENLABS_API_KEY=...`, `ELEVENLABS_VOICE_ID=...`.
- Can enable TTS first (bigger perceived win) and STT second — the two backends are
  independent switches.

## Risks / open questions
- **Realtime SDK surface** is newer; pin exact method names to the installed version during
  implementation (fall back to raw `websockets` against the documented message schema if the
  SDK helper is unstable).
- **Dependency conflict** with the awscrt-pinned stack (see §5) — verify early.
- **Latency of TTS-as-one-blob:** current path synthesizes the whole mp3 before sending the
  `audio` frame. Streaming TTS (`.stream()` + chunked `audio` frames) is a possible follow-up
  but would change the WS contract, so it's **out of scope** here (kept backend-only).
- **Cost:** credit-based billing (1 credit/char TTS; STT per second). Flash v2.5 halves TTS
  cost. Monitor via existing observability.

## Acceptance criteria
- With AWS defaults, all existing tests pass and behavior is identical (no regression).
- With `*_BACKEND=elevenlabs` + a key, a text turn returns an ElevenLabs-voiced `audio` mp3
  frame that `chat.js` plays, and a mic turn transcribes via Scribe and drives a normal turn.
- Missing/invalid key or a runtime ElevenLabs error transparently falls back to AWS; the turn
  still completes (reply text always; audio best-effort).
- `chat.js` and the WS message contract are unchanged.
- The emote-sync release gate, KB citations, session persistence, and motion safety are
  untouched.
