# ElevenLabs Voice Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ElevenLabs as an env-gated backend for Moses's Text-to-Speech (replacing Amazon Polly) and real-time Speech-to-Text (replacing Amazon Transcribe), keeping AWS as the default and the WebSocket contract byte-identical so the frontend is untouched.

**Architecture:** All changes live in `agent_service`. `speech.py` gains backend dispatch behind its existing `synthesize_mp3`/`synthesize_pcm16` functions and a new `ElevenLabsTranscribeSession` that implements the same `start()/feed()/finish()` contract as `TranscribeSession`, selected by a `make_transcribe_session()` factory. `config.py` carries the switches; `app.py` builds a shared ElevenLabs client at startup (or `None`); `ws_chat.py` passes config-driven backend choices into the two seams. No frontend change.

**Tech Stack:** Python 3.10+, FastAPI, `elevenlabs` Python SDK (TTS `text_to_speech.convert`, realtime Scribe STT), pytest.

**Spec:** `docs/superpowers/specs/2026-07-08-elevenlabs-voice-backend-design.md`

---

## File Structure

- **Modify** `agent_service/pyproject.toml` — add `elevenlabs` dependency.
- **Modify** `agent_service/guidemate_agent/config.py` — add TTS/STT backend + ElevenLabs fields to `Config` and `from_env()`.
- **Modify** `agent_service/guidemate_agent/speech.py` — ElevenLabs TTS dispatch in `synthesize_mp3`/`synthesize_pcm16`; new `ElevenLabsTranscribeSession`; new `make_transcribe_session()` factory; small `_eleven_client()` helper.
- **Modify** `agent_service/guidemate_agent/app.py` — build `app.state.el_client` (or `None`) at startup + a startup fail-safe log.
- **Modify** `agent_service/guidemate_agent/ws_chat.py` — TTS call + STT construction read backend/voice/model/client from config.
- **Modify** `agent_service/tests/test_speech.py` — unit tests for ElevenLabs TTS dispatch + fallback.
- **Create** `agent_service/tests/test_speech_stt_eleven.py` — unit tests for `ElevenLabsTranscribeSession` + `make_transcribe_session`.
- **Modify** `agent_service/tests/test_config.py` — assert new config defaults + env overrides.
- **Modify** `agent_service/tests/integration/test_speech_loopback.py` — add a `live` ElevenLabs loopback variant.
- **Modify** `docs/agent-poc/` note + `CLAUDE.md` bring-up env vars (docs only).

---

## Task 1: Add the ElevenLabs dependency (and verify no awscrt conflict)

**Files:**
- Modify: `agent_service/pyproject.toml:6-22`

- [ ] **Step 1: Add the dependency**

In `agent_service/pyproject.toml`, add `"elevenlabs"` to the `dependencies` list (after `"boto3"`):

```toml
dependencies = [
    "fastapi",
    "uvicorn[standard]",
    "strands-agents",
    "awsiotsdk",
    "boto3",
    "elevenlabs",
    # amazon-transcribe is deliberately NOT listed here: ... (existing comment unchanged)
```

- [ ] **Step 2: Install and verify the resolve does not downgrade awscrt**

Run (from repo root, in the agent_service venv):

```bash
pip install elevenlabs
pip show awscrt awsiotsdk | grep -E "Name|Version"
```

Expected: `elevenlabs` installs; `awscrt` stays on the 0.34.x line and `awsiotsdk` is unchanged.
**If** pip reports a conflict or downgrades `awscrt`: install ElevenLabs isolated instead — remove it from `dependencies`, and in `agent_service/Dockerfile` install it after the package with `pip install --no-deps elevenlabs` plus its runtime deps (`httpx`, `pydantic`, `websockets`), mirroring the documented `amazon-transcribe --no-deps` approach. Note the decision in a one-line comment next to the dependency.

- [ ] **Step 3: Import smoke check**

Run:

```bash
python -c "from elevenlabs import ElevenLabs; from elevenlabs.realtime.scribe import AudioFormat; print('ok', AudioFormat.PCM_16000)"
```

Expected: `ok AudioFormat.PCM_16000`.
**If** `elevenlabs.realtime.scribe` import path differs on the installed version: run `python -c "import elevenlabs, pkgutil; print([m.name for m in pkgutil.iter_modules(elevenlabs.__path__)])"` and record the actual realtime module path — Task 4's adapter uses it.

- [ ] **Step 4: Commit**

```bash
git add agent_service/pyproject.toml
git commit -m "Kalhar: add elevenlabs dependency to agent_service"
```

---

## Task 2: Config switches for the voice backends

**Files:**
- Modify: `agent_service/guidemate_agent/config.py:20-52`
- Test: `agent_service/tests/test_config.py`

- [ ] **Step 1: Write the failing test**

Add to `agent_service/tests/test_config.py`:

```python
def test_speech_backends_default_to_aws(monkeypatch):
    for k in ("GUIDEMATE_TTS_BACKEND", "GUIDEMATE_STT_BACKEND",
              "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"):
        monkeypatch.delenv(k, raising=False)
    from guidemate_agent.config import Config
    cfg = Config.from_env()
    assert cfg.tts_backend == "polly"
    assert cfg.stt_backend == "transcribe"
    assert cfg.elevenlabs_api_key == ""
    assert cfg.elevenlabs_tts_model == "eleven_flash_v2_5"
    assert cfg.elevenlabs_stt_model == "scribe_v2_realtime"


def test_speech_backends_env_override(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_TTS_BACKEND", "elevenlabs")
    monkeypatch.setenv("GUIDEMATE_STT_BACKEND", "elevenlabs")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "sk-test")
    monkeypatch.setenv("ELEVENLABS_VOICE_ID", "voiceXYZ")
    from guidemate_agent.config import Config
    cfg = Config.from_env()
    assert cfg.tts_backend == "elevenlabs"
    assert cfg.stt_backend == "elevenlabs"
    assert cfg.elevenlabs_api_key == "sk-test"
    assert cfg.elevenlabs_voice_id == "voiceXYZ"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pytest agent_service/tests/test_config.py -q`
Expected: FAIL — `Config` has no attribute `tts_backend`.

- [ ] **Step 3: Add the fields**

In `agent_service/guidemate_agent/config.py`, add to the `Config` dataclass (after `thing_names`):

```python
    tts_backend: str = "polly"
    stt_backend: str = "transcribe"
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = ""
    elevenlabs_tts_model: str = "eleven_flash_v2_5"
    elevenlabs_stt_model: str = "scribe_v2_realtime"
```

And in `from_env()`, add to the `cls(...)` call:

```python
            tts_backend=os.environ.get("GUIDEMATE_TTS_BACKEND", "polly"),
            stt_backend=os.environ.get("GUIDEMATE_STT_BACKEND", "transcribe"),
            elevenlabs_api_key=os.environ.get("ELEVENLABS_API_KEY", ""),
            elevenlabs_voice_id=os.environ.get("ELEVENLABS_VOICE_ID", ""),
            elevenlabs_tts_model=os.environ.get(
                "GUIDEMATE_ELEVENLABS_TTS_MODEL", "eleven_flash_v2_5"
            ),
            elevenlabs_stt_model=os.environ.get(
                "GUIDEMATE_ELEVENLABS_STT_MODEL", "scribe_v2_realtime"
            ),
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pytest agent_service/tests/test_config.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent_service/guidemate_agent/config.py agent_service/tests/test_config.py
git commit -m "Kalhar: add ElevenLabs voice backend switches to Config"
```

---

## Task 3: ElevenLabs Text-to-Speech dispatch

**Files:**
- Modify: `agent_service/guidemate_agent/speech.py:53-83`
- Test: `agent_service/tests/test_speech.py`

- [ ] **Step 1: Write the failing tests**

Add to `agent_service/tests/test_speech.py` (below the existing `_FakePolly`):

```python
class _FakeElevenTTS:
    """Stand-in for elevenlabs.ElevenLabs: records convert() kwargs, yields byte chunks."""

    def __init__(self, chunks=(b"EL", b"AUDIO"), raise_exc=None):
        self._chunks = chunks
        self._raise = raise_exc
        self.calls = []
        self.text_to_speech = self

    def convert(self, **kwargs):
        self.calls.append(kwargs)
        if self._raise:
            raise self._raise
        return iter(self._chunks)


def test_synthesize_mp3_elevenlabs_joins_chunks():
    el = _FakeElevenTTS(chunks=(b"EL", b"AUDIO"))
    out = synthesize_mp3(
        "hello pup", backend="elevenlabs", el_client=el,
        el_voice_id="voiceXYZ", el_model="eleven_flash_v2_5",
    )
    assert out == b"ELAUDIO"
    kw = el.calls[0]
    assert kw["voice_id"] == "voiceXYZ"
    assert kw["text"] == "hello pup"
    assert kw["model_id"] == "eleven_flash_v2_5"
    assert kw["output_format"] == "mp3_44100_128"


def test_synthesize_pcm16_elevenlabs_requests_pcm_16000():
    el = _FakeElevenTTS(chunks=(b"PCM", b"DATA"))
    out = synthesize_pcm16(
        "woof", backend="elevenlabs", el_client=el, el_voice_id="voiceXYZ",
    )
    assert out == b"PCMDATA"
    assert el.calls[0]["output_format"] == "pcm_16000"


def test_synthesize_mp3_falls_back_to_polly_on_eleven_error():
    el = _FakeElevenTTS(raise_exc=RuntimeError("boom"))
    polly = _FakePolly()
    out = synthesize_mp3(
        "hello", backend="elevenlabs", el_client=el, polly_client=polly,
    )
    assert out == b"AUDIOBYTES"          # came from Polly fallback
    assert el.calls and polly.calls      # tried EL, then fell back


def test_synthesize_mp3_elevenlabs_without_client_falls_back_to_polly():
    polly = _FakePolly()
    out = synthesize_mp3("hi", backend="elevenlabs", el_client=None, polly_client=polly)
    assert out == b"AUDIOBYTES"
```

- [ ] **Step 2: Run to verify they fail**

Run: `pytest agent_service/tests/test_speech.py -q -k eleven`
Expected: FAIL — `synthesize_mp3()` got an unexpected keyword argument `backend`.

- [ ] **Step 3: Implement the dispatch**

In `agent_service/guidemate_agent/speech.py`, replace `synthesize_mp3` and `synthesize_pcm16` with backend-aware versions (keep the Polly bodies intact as the fallback path):

```python
def _eleven_convert(text, output_format, el_client, voice_id, model_id):
    """Collect an ElevenLabs text_to_speech.convert() byte-iterator into bytes."""
    kwargs = dict(voice_id=voice_id, text=text, output_format=output_format)
    if model_id:
        kwargs["model_id"] = model_id
    return b"".join(el_client.text_to_speech.convert(**kwargs))


def synthesize_mp3(
    text: str,
    voice_id: str = "Justin",
    region: str = "us-west-2",
    polly_client=None,
    backend: str = "polly",
    el_client=None,
    el_voice_id: str = "",
    el_model: str = "eleven_flash_v2_5",
) -> bytes:
    """Neural mp3 for the dog voice. backend='elevenlabs' uses ElevenLabs (with a
    Polly fallback on any error / missing client); otherwise Polly 'Justin'."""
    if backend == "elevenlabs" and el_client is not None:
        try:
            return _eleven_convert(text, "mp3_44100_128", el_client, el_voice_id, el_model)
        except Exception:  # noqa: BLE001 — never fail the turn; fall back to Polly
            log.exception("elevenlabs mp3 synthesis failed; falling back to polly")
    client = polly_client or boto3.client("polly", region_name=region)
    resp = client.synthesize_speech(
        Text=text, OutputFormat="mp3", VoiceId=voice_id, Engine="neural"
    )
    return resp["AudioStream"].read()


def synthesize_pcm16(
    text: str,
    voice_id: str = "Justin",
    region: str = "us-west-2",
    sample_rate: int = 16000,
    polly_client=None,
    backend: str = "polly",
    el_client=None,
    el_voice_id: str = "",
    el_model: str = "eleven_flash_v2_5",
) -> bytes:
    """16-bit PCM at sample_rate. backend='elevenlabs' uses ElevenLabs pcm_16000
    (Polly fallback on error / missing client); otherwise Polly neural PCM."""
    if backend == "elevenlabs" and el_client is not None and sample_rate == 16000:
        try:
            return _eleven_convert(text, "pcm_16000", el_client, el_voice_id, el_model)
        except Exception:  # noqa: BLE001 — fall back to Polly
            log.exception("elevenlabs pcm synthesis failed; falling back to polly")
    client = polly_client or boto3.client("polly", region_name=region)
    resp = client.synthesize_speech(
        Text=text, OutputFormat="pcm", VoiceId=voice_id, Engine="neural",
        SampleRate=str(sample_rate),
    )
    return resp["AudioStream"].read()
```

- [ ] **Step 4: Run all speech unit tests**

Run: `pytest agent_service/tests/test_speech.py -q`
Expected: PASS — the four new `eleven` tests pass AND the two pre-existing Polly tests (`test_synthesize_mp3_uses_neural_justin_mp3`, `test_synthesize_pcm16_requests_pcm_16k`) still pass (they pass `polly_client=` and default `backend="polly"`).

- [ ] **Step 5: Commit**

```bash
git add agent_service/guidemate_agent/speech.py agent_service/tests/test_speech.py
git commit -m "Kalhar: ElevenLabs TTS dispatch with Polly fallback"
```

---

## Task 4: ElevenLabs real-time STT session + factory

**Files:**
- Modify: `agent_service/guidemate_agent/speech.py` (append new class + factory)
- Test: `agent_service/tests/test_speech_stt_eleven.py` (create)

**Design note:** `ElevenLabsTranscribeSession` depends on an injectable async `connect_fn` returning a small connection object so it is unit-testable without the SDK. The connection protocol is: `await conn.send_audio(b64: str)`, `async for evt in conn.events()` yielding dicts `{"type": ..., "text": ...}`, `await conn.commit()`, `await conn.close()`. The real `connect_fn` (Task 4b) adapts the installed SDK.

- [ ] **Step 1: Write the failing test**

Create `agent_service/tests/test_speech_stt_eleven.py`:

```python
import asyncio

from guidemate_agent.speech import (
    ElevenLabsTranscribeSession,
    TranscribeSession,
    make_transcribe_session,
)


class _FakeConn:
    """In-memory Scribe realtime connection: records audio, replays queued events."""

    def __init__(self, events):
        self._events = events
        self.sent = []
        self.committed = False
        self.closed = False

    async def send_audio(self, b64):
        self.sent.append(b64)

    async def events(self):
        for evt in self._events:
            yield evt

    async def commit(self):
        self.committed = True

    async def close(self):
        self.closed = True


def test_eleven_stt_collects_committed_only():
    events = [
        {"type": "partial_transcript", "text": "do a"},
        {"type": "committed_transcript", "text": "do a happy"},
        {"type": "partial_transcript", "text": "do a happy wig"},
        {"type": "committed_transcript", "text": "wiggle"},
    ]
    conn = _FakeConn(events)

    async def _connect(model_id, sample_rate):
        return conn

    async def _run():
        s = ElevenLabsTranscribeSession(connect_fn=_connect, sample_rate=16000)
        await s.start()
        await s.feed(b"\x01\x00" * 800)
        return await s.finish()

    text = asyncio.run(_run())
    assert text == "do a happy wiggle"   # committed frames joined, partials dropped
    assert conn.sent and conn.committed and conn.closed


def test_eleven_stt_finish_returns_empty_on_error():
    async def _connect(model_id, sample_rate):
        raise RuntimeError("ws down")

    async def _run():
        s = ElevenLabsTranscribeSession(connect_fn=_connect, sample_rate=16000)
        await s.start()          # connect fails internally, must not raise
        return await s.finish()

    assert asyncio.run(_run()) == ""


def test_factory_picks_backend():
    assert isinstance(
        make_transcribe_session(backend="transcribe", region="us-west-2"),
        TranscribeSession,
    )
    assert isinstance(
        make_transcribe_session(
            backend="elevenlabs", region="us-west-2", api_key="sk-test",
        ),
        ElevenLabsTranscribeSession,
    )
    # Missing key => safe fallback to Transcribe
    assert isinstance(
        make_transcribe_session(backend="elevenlabs", region="us-west-2", api_key=""),
        TranscribeSession,
    )
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest agent_service/tests/test_speech_stt_eleven.py -q`
Expected: FAIL — cannot import `ElevenLabsTranscribeSession` / `make_transcribe_session`.

- [ ] **Step 3: Implement the session + factory**

Append to `agent_service/guidemate_agent/speech.py`:

```python
class ElevenLabsTranscribeSession:
    """Scribe realtime STT with the SAME contract as TranscribeSession:
    start() -> feed(pcm)* -> finish() -> str. Collects committed_transcript text
    only (mirrors _CollectingHandler). Any error degrades finish() to ''."""

    def __init__(
        self,
        connect_fn,
        sample_rate: int = 16000,
        model_id: str = "scribe_v2_realtime",
    ) -> None:
        self._connect_fn = connect_fn
        self._sample_rate = sample_rate
        self._model_id = model_id
        self._conn = None
        self._finals: list[str] = []
        self._consume_task = None

    async def _consume(self) -> None:
        try:
            async for evt in self._conn.events():
                if evt.get("type") == "committed_transcript":
                    text = evt.get("text")
                    if text:
                        self._finals.append(text)
        except Exception:  # noqa: BLE001 — a stream error just ends collection
            log.exception("elevenlabs stt consume failed")

    async def start(self) -> None:
        try:
            self._conn = await self._connect_fn(self._model_id, self._sample_rate)
            self._consume_task = asyncio.create_task(self._consume())
        except Exception:  # noqa: BLE001 — connect failure -> finish() returns ''
            log.exception("elevenlabs stt connect failed")
            self._conn = None

    async def feed(self, pcm: bytes) -> None:
        if self._conn is None:
            return
        import base64
        await self._conn.send_audio(base64.b64encode(pcm).decode("ascii"))

    async def finish(self) -> str:
        if self._conn is None:
            return ""
        try:
            await self._conn.commit()
            if self._consume_task is not None:
                await self._consume_task
            return " ".join(self._finals).strip()
        except Exception:  # noqa: BLE001 — teardown is best-effort
            log.exception("elevenlabs stt finish failed")
            return ""
        finally:
            try:
                await self._conn.close()
            except Exception:  # noqa: BLE001
                pass


def make_transcribe_session(
    backend: str = "transcribe",
    region: str = "us-west-2",
    sample_rate: int = 16000,
    language_code: str = "en-US",
    api_key: str = "",
    model_id: str = "scribe_v2_realtime",
):
    """Return the STT session for the configured backend. ElevenLabs requires an
    api_key; without one it safely falls back to Amazon Transcribe."""
    if backend == "elevenlabs" and api_key:
        connect_fn = _eleven_scribe_connect(api_key)
        return ElevenLabsTranscribeSession(
            connect_fn=connect_fn, sample_rate=sample_rate, model_id=model_id,
        )
    return TranscribeSession(
        region=region, sample_rate=sample_rate, language_code=language_code,
    )
```

- [ ] **Step 4: Run to verify the session + factory tests pass**

Run: `pytest agent_service/tests/test_speech_stt_eleven.py -q`
Expected: FAIL only on `_eleven_scribe_connect` being undefined (referenced by the factory but not yet implemented). If the two `ElevenLabsTranscribeSession` tests and the `transcribe`/missing-key factory branches pass, proceed to Step 5 to add the real adapter.

- [ ] **Step 5: Implement the real Scribe adapter (`_eleven_scribe_connect`)**

Append to `speech.py`. This is the ONE place tied to the SDK's realtime surface — pin it to the version installed in Task 1 (adjust import path / method names to what `AudioFormat`/`connect` actually expose; the shape below matches `elevenlabs.realtime`):

```python
def _eleven_scribe_connect(api_key: str):
    """Build an async connect_fn that opens a Scribe v2 realtime websocket and
    adapts it to the {send_audio, events, commit, close} protocol used above."""
    async def _connect(model_id: str, sample_rate: int):
        from elevenlabs import ElevenLabs
        from elevenlabs.realtime.scribe import AudioFormat

        client = ElevenLabs(api_key=api_key)
        raw = await client.speech_to_text.realtime.connect({
            "model_id": model_id,
            "audio_format": AudioFormat.PCM_16000,
            "sample_rate": sample_rate,
        })

        class _Adapter:
            async def send_audio(self, b64):
                await raw.send({
                    "message_type": "input_audio_chunk",
                    "audio_base_64": b64,
                    "commit": False,
                    "sample_rate": sample_rate,
                })

            async def events(self):
                async for msg in raw:
                    yield {"type": msg.get("type") or msg.get("message_type"),
                           "text": msg.get("text") or msg.get("transcript")}

            async def commit(self):
                await raw.send({"message_type": "input_audio_chunk",
                                "audio_base_64": "", "commit": True,
                                "sample_rate": sample_rate})

            async def close(self):
                await raw.close()

        return _Adapter()

    return _connect
```

> If the installed SDK's realtime helper differs (method names, sync vs async, event field names), keep the `_Adapter` protocol identical and adjust only its bodies; as a last resort implement `_connect` with the raw `websockets` client against the documented message schema (`input_audio_chunk` / `committed_transcript`). The unit tests in this task do NOT exercise `_eleven_scribe_connect` (they inject a fake `connect_fn`); it is validated by the live loopback in Task 6.

- [ ] **Step 6: Run the STT tests again**

Run: `pytest agent_service/tests/test_speech_stt_eleven.py -q`
Expected: PASS (all four; `_eleven_scribe_connect` now importable/defined).

- [ ] **Step 7: Commit**

```bash
git add agent_service/guidemate_agent/speech.py agent_service/tests/test_speech_stt_eleven.py
git commit -m "Kalhar: ElevenLabs realtime STT session + backend factory"
```

---

## Task 5: Wire ws_chat + app startup to the configured backends

**Files:**
- Modify: `agent_service/guidemate_agent/app.py:83-89` (build shared client) and lifespan
- Modify: `agent_service/guidemate_agent/ws_chat.py:36, 109-171, 205-213`
- Test: `agent_service/tests/test_ws_chat.py`

- [ ] **Step 1: Write a failing test that the WS TTS path honors the ElevenLabs backend**

Add to `agent_service/tests/test_ws_chat.py` (follow the module's existing app/monkeypatch style; if the module builds its app via a helper, reuse it — this test sets `app.state.config` to an elevenlabs config and asserts `synthesize_mp3` is called with `backend="elevenlabs"`). Minimal, seam-focused version:

```python
import guidemate_agent.ws_chat as ws_chat


def test_ws_pipeline_uses_configured_tts_backend(monkeypatch):
    seen = {}

    def fake_synth(text, **kwargs):
        seen.update(kwargs)
        seen["text"] = text
        return b"MP3"

    monkeypatch.setattr(ws_chat, "synthesize_mp3", fake_synth)

    backend = ws_chat._tts_kwargs(_FakeConfigEleven())   # helper under test
    assert backend["backend"] == "elevenlabs"
    assert backend["el_voice_id"] == "voiceXYZ"
    assert backend["el_model"] == "eleven_flash_v2_5"
```

Where `_FakeConfigEleven` is a tiny stub defined in the test:

```python
class _FakeConfigEleven:
    tts_backend = "elevenlabs"
    stt_backend = "elevenlabs"
    elevenlabs_voice_id = "voiceXYZ"
    elevenlabs_tts_model = "eleven_flash_v2_5"
    elevenlabs_stt_model = "scribe_v2_realtime"
    elevenlabs_api_key = "sk-test"
    region = "us-west-2"
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest agent_service/tests/test_ws_chat.py -q -k tts_backend`
Expected: FAIL — `ws_chat` has no `_tts_kwargs`.

- [ ] **Step 3: Add the config→kwargs helpers and use them**

In `agent_service/guidemate_agent/ws_chat.py`:

Update the import (line 36) to also pull `make_transcribe_session`:

```python
from guidemate_agent.speech import (
    TranscribeSession, downsample_pcm16, make_transcribe_session, synthesize_mp3,
)
```

Add near the top of the module (after `GATE_TIMEOUT_S`):

```python
def _tts_kwargs(config) -> dict:
    """Backend kwargs for synthesize_mp3 derived from Config (defaults = Polly)."""
    return {
        "backend": getattr(config, "tts_backend", "polly"),
        "el_voice_id": getattr(config, "elevenlabs_voice_id", ""),
        "el_model": getattr(config, "elevenlabs_tts_model", "eleven_flash_v2_5"),
    }
```

In `_run_pipeline`, change the TTS call (currently `ws_chat.py:163-165`) to pass the client + backend kwargs:

```python
            mp3 = await loop.run_in_executor(
                None,
                lambda: synthesize_mp3(
                    result["reply_text"], region=region,
                    el_client=getattr(app.state, "el_client", None),
                    **_tts_kwargs(app.state.config),
                ),
            )
```

In `chat_ws`, replace the `TranscribeSession(...)` construction (currently `ws_chat.py:212`) with the factory:

```python
                            cfg = app.state.config
                            transcribe = make_transcribe_session(
                                backend=getattr(cfg, "stt_backend", "transcribe"),
                                region=region, sample_rate=16000,
                                api_key=getattr(cfg, "elevenlabs_api_key", ""),
                                model_id=getattr(cfg, "elevenlabs_stt_model",
                                                 "scribe_v2_realtime"),
                            )
```

> `TranscribeSession` stays imported (the factory returns it for the default path and tests still import it directly).

- [ ] **Step 4: Build the shared ElevenLabs client at startup**

In `agent_service/guidemate_agent/app.py` lifespan, after `app.state.config = cfg` (around line 72), add:

```python
    # Shared ElevenLabs client (built once) when TTS uses it; None otherwise.
    # A configured-but-keyless backend logs a warning and leaves the AWS default
    # in force (speech.py falls back when el_client is None), so the demo can't
    # break on a missing key.
    app.state.el_client = None
    if cfg.tts_backend == "elevenlabs" or cfg.stt_backend == "elevenlabs":
        if cfg.elevenlabs_api_key:
            try:
                from elevenlabs import ElevenLabs
                app.state.el_client = ElevenLabs(api_key=cfg.elevenlabs_api_key)
            except Exception:  # noqa: BLE001 — never block startup on the SDK
                log.exception("ElevenLabs client init failed; using AWS voice")
        else:
            log.warning(
                "voice backend set to elevenlabs but ELEVENLABS_API_KEY is empty; "
                "falling back to AWS (Polly/Transcribe)"
            )
```

- [ ] **Step 5: Run the ws_chat + full agent_service suite (AWS default = no regression)**

Run:

```bash
pytest agent_service/tests/test_ws_chat.py -q
PYTHONUTF8=1 pytest agent_service/tests -q -m "not live and not e2e and not integration"
```

Expected: PASS — the new backend test passes and the existing suite is green with AWS defaults (no `el_client`, `backend="polly"`).

- [ ] **Step 6: Commit**

```bash
git add agent_service/guidemate_agent/app.py agent_service/guidemate_agent/ws_chat.py agent_service/tests/test_ws_chat.py
git commit -m "Kalhar: drive ws_chat TTS/STT from configured voice backend"
```

---

## Task 6: Live loopback variant for the ElevenLabs path (opt-in, gated)

**Files:**
- Modify: `agent_service/tests/integration/test_speech_loopback.py`

- [ ] **Step 1: Add a gated ElevenLabs loopback test**

Append to `agent_service/tests/integration/test_speech_loopback.py`:

```python
import os


@pytest.mark.live
@pytest.mark.skipif(
    not os.environ.get("ELEVENLABS_API_KEY"),
    reason="needs ELEVENLABS_API_KEY for the live ElevenLabs loopback",
)
def test_elevenlabs_tts_to_transcribe_loopback():
    """ElevenLabs synthesizes 16k PCM -> Amazon Transcribe -> assert 'wiggle'.
    Uses Transcribe for the STT half so this validates the real ElevenLabs TTS
    convert() path end to end without depending on the newer Scribe surface."""
    from elevenlabs import ElevenLabs
    from guidemate_agent.speech import synthesize_pcm16

    el = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])
    voice_id = os.environ.get("ELEVENLABS_VOICE_ID", "")
    pcm = synthesize_pcm16(
        "do a happy wiggle", backend="elevenlabs", el_client=el, el_voice_id=voice_id,
    )
    assert len(pcm) > 0

    async def _run() -> str:
        session = TranscribeSession(region="us-west-2", sample_rate=16000)
        await session.start()
        chunk = 3200
        for i in range(0, len(pcm), chunk):
            await session.feed(pcm[i:i + chunk])
            await asyncio.sleep(0.02)
        return await session.finish()

    transcript = asyncio.run(_run())
    assert "wiggle" in transcript.lower(), f"got: {transcript!r}"
```

- [ ] **Step 2: Verify it is collected but skipped without a key**

Run: `pytest agent_service/tests/integration/test_speech_loopback.py -q`
Expected: the new test shows as SKIPPED (no `ELEVENLABS_API_KEY` in the default env); the existing Polly loopback also skips under the `live` gate.

- [ ] **Step 3: (Manual, with a key) run the live loopback**

Run: `ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... pytest agent_service/tests/integration/test_speech_loopback.py -q -m live -k elevenlabs`
Expected: PASS — the transcript contains "wiggle". Record the observed TTS latency in the PR description.

- [ ] **Step 4: Commit**

```bash
git add agent_service/tests/integration/test_speech_loopback.py
git commit -m "Kalhar: gated live ElevenLabs TTS loopback test"
```

---

## Task 7: Docs — env vars + bring-up

**Files:**
- Modify: `CLAUDE.md` (agent-poc bring-up section) or `docs/agent-poc/` note
- Modify: `agent_service/README` (if present) / `agent_service/Dockerfile` (only if Task 1 used `--no-deps`)

- [ ] **Step 1: Document the switch**

Add a short block (matching the repo's docs style) listing the env vars and the fail-safe default:

```
# ElevenLabs voice (optional; AWS Polly/Transcribe is the default)
GUIDEMATE_TTS_BACKEND=elevenlabs
GUIDEMATE_STT_BACKEND=elevenlabs
ELEVENLABS_API_KEY=...            # never commit; env / Secrets Manager only
ELEVENLABS_VOICE_ID=...           # the Moses dog voice
# Missing key or any ElevenLabs error transparently falls back to AWS.
```

If Task 1 resolved a dependency conflict via `--no-deps`, mirror the existing `amazon-transcribe` note in `agent_service/Dockerfile` + README.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md agent_service/Dockerfile agent_service/README* docs/agent-poc 2>/dev/null; git commit -m "Kalhar: document ElevenLabs voice backend env switches"
```

---

## Self-Review

**Spec coverage:**
- Config switches (spec §1) → Task 2. ✓
- TTS dispatch + fallback (spec §2) → Task 3. ✓
- Real-time STT + factory + one-line ws_chat swap (spec §3) → Tasks 4, 5. ✓
- Startup fail-safe / shared client (spec §1 fail-safe) → Task 5 Step 4. ✓
- Voice selection (spec §4) → `ELEVENLABS_VOICE_ID` threaded in Tasks 2/3/5/7. ✓
- Secrets & deps + dependency-conflict check (spec §5) → Task 1 + Task 7. ✓
- Testing (spec §7) → Tasks 3, 4, 5, 6 (unit + gated live; e2e stays AWS-default). ✓
- Backend-only / WS contract unchanged (spec TL;DR) → no frontend task; Task 5 keeps `{type:"audio",format:"mp3"}` + `{type:"transcript"}`. ✓
- Rollout toggle (spec §rollout) → Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. The one SDK-version-dependent spot (`_eleven_scribe_connect`, Task 4 Step 5) is explicitly flagged with a concrete fallback and is not covered by unit tests by design (injected fake), so no placeholder leaks into a test assertion.

**Type consistency:** `synthesize_mp3`/`synthesize_pcm16` gain identical `backend`/`el_client`/`el_voice_id`/`el_model` params across Tasks 3 and 5. `ElevenLabsTranscribeSession` exposes `start`/`feed`/`finish` matching `TranscribeSession` (Task 4) and is constructed only via `make_transcribe_session` in ws_chat (Task 5). The connection protocol (`send_audio`/`events`/`commit`/`close`) is identical between the `_FakeConn` test (Task 4 Step 1) and the `_Adapter` real impl (Task 4 Step 5). Config field names in Task 2 match their reads in Tasks 5 and the `_FakeConfigEleven` stub. ✓
