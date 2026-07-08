# Dog Agent POC — Phase 5 (Voice + UI polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add speech-to-speech voice chat with **order-independent emote-sync** to the dog agent — mic audio → Amazon Transcribe streaming → the normal chat pipeline → reply text released *together with* its synced physical/virtual emote and Polly neural audio — behind a polished, warm chat UI, plus an admin Health tab (last-10 commands, robot heartbeat, per-turn Bedrock latency, errors).

**Architecture:** Five new Phase-5-owned modules in `agent_service/guidemate_agent/` — `emote_sync.py` (the single, unit-tested release gate), `speech.py` (Transcribe streaming + Polly + a pure PCM resampler), `observability.py` (three thread-safe in-process ring buffers), `ws_chat.py` (the `/ws/chat/{session_id}` WebSocket that fuses transcript → agent → emote-sync → reply+audio), plus a rewritten static chat UI (`index.html` + `chat.css` + `chat.js`, pure CSS/inline SVG, no external assets). The WS layer publishes the emote *after* the agent picks it (the agent's own `send_emote` tool is neutered on this path by a `CaptureRegistry` so it never double-publishes), then gates the reply on the **order-independent** predicate "any ack reports `running` or `done`, else 2.0 s timeout" — mandatory because AWS IoT QoS1 delivers `received`/`running`/`done` **out of order** (verified: `received → done → running`). Physical vs. virtual routing and the Phase-4 session/robot binding are read through one pluggable seam, `app.state.robot_target_resolver`, so Phase 5 runs standalone (virtual-only) and lights up physical automatically once Phase 4 lands.

**Tech Stack:** Python 3.10, FastAPI WebSockets (Starlette), `amazon-transcribe` (async streaming SDK), boto3 Polly (neural voice `Justin`, mp3 + pcm), strands-agents (unchanged from Phase 0-1), pytest, Playwright + Chrome fake-mic, browser AudioWorklet.

## Global Constraints

Every task's requirements implicitly include this section (copied forward from the Phase 0-1 plan; the ones that change for Phase 5 are marked **[P5]**).

- **Python 3.10-compatible** on both machines — no 3.11+ syntax. `list[...]`/`dict[...]` generics are fine with `from __future__ import annotations`.
- **pydantic v2** (`>=2`); use `model_validate_json` / `model_dump_json` / `model_validate` / `model_dump` / `field_validator` / `model_validator`.
- **TDD**: write the failing test first, run it red, implement the minimum, run it green, then commit — every task.
- **Commit after every task** with a `Kalhar:` message prefix. **NEVER** add any Claude/AI/co-author line or `Co-Authored-By`. Do not push (the user pushes). **[P5] This plan is written by a parallel agent that shares the branch — DO NOT run any git write command while authoring; commits happen only at execution time.**
- **Never `pkill -f`** anything on the Pi (gotcha #6). This plan never touches the Pi.
- **Robot 468 stays docked and motion-locked**: the bridge stays in dry-run, the Device Shadow is not touched, no `cmd_vel` is ever published. Physical emotes on this path are dry-run (`simulated=true`) acks only.
- **No credentials or IoT endpoints committed** to the repo. The IoT data endpoint is discovered at runtime via `aws iot describe-endpoint --endpoint-type iot:Data-ATS`.
- **Every new AWS resource** is tagged `guidemate-poc` and documented in `docs/agent-poc/access-ground-truth.md`. (Phase 5 creates **no new AWS resources** — it only *calls* Transcribe + Polly, which the existing `guidemate-agent-role` AdministratorAccess already permits.)
- **Integration/live tests are env-gated** (`GUIDEMATE_INTEGRATION=1`, `GUIDEMATE_LIVE=1`) and skipped by default. **[P5]** the Playwright fake-robot e2e is additionally gated by `GUIDEMATE_FAKE_ROBOT=1`.
- **[P5] Emote-sync must be order-independent.** AWS IoT QoS1 does **not** preserve publish order (verified 2026-07-05: three acks arrived `received → done → running`). Any gate that waits specifically for `running` is a bug. The gate releases when **any** ack has state in `("running", "done")`, or after a 2.0 s timeout.
- **[P5] No external UI assets.** The chat UI is pure inline CSS + inline SVG + inline JS/AudioWorklet (mic needs a secure origin in production, but nothing is fetched cross-origin). No CDNs, fonts, or image files.

**Verified environment facts (do not re-derive):** AWS account `852373397000`, region `us-west-2`; creds via `credential_process` (identity `guidemate-agent-role`, AdministratorAccess); AWS CLI v2 at `~/.local/bin/aws`. Bedrock model id `us.anthropic.claude-sonnet-4-6`. Dev venv at `~/cs7980-guide-mate/.venv`. Google Chrome + a real display are installed for Playwright. Polly neural + Transcribe streaming are both in `us-west-2` and permitted by the current role.

**Pinned upstream interfaces (may not all be in code yet — they are the seams Phase 5 integrates against):**
- **Phase 2:** `RobotRegistry.send_command(robot_id, cmd, timeout_s=5.0, collect_all=False) -> list[Ack]` (returns on the terminal `done`/`failed` ack or `timeout_s`; `collect_all=True` keeps collecting until timeout). `Ack` gains a `.gates` dict and carries `simulated` on **all** states. `RobotRegistry.get_status(robot_id)` includes a heartbeat/last-status. Phase 0-1 already ships `send_command(robot_id, cmd, timeout_s=5.0)` and `get_status`; Phase 5 code calls them defensively so it works before *and* after Phase 2 widens the signature.
- **Phase 3:** `agent_service/guidemate_agent/admin.py` exposes an `APIRouter` named `router` and a FastAPI dependency `admin_required`; `agent_service/static/admin/` holds the admin tabs.
- **Phase 4:** `POST /api/chat` takes `{session_id, message}`; a session store with per-session robot binding; the chat page has intake + request-companion + polls `GET /api/session/{id}/state`. **Phase 4 must set `app.state.robot_target_resolver` (a `Callable[[str], Optional[str]]` mapping `session_id → bound physical robot_id or None`).** Phase 5 installs a virtual-only default resolver so it runs before Phase 4 lands.

---

## File Structure

```
cs7980-guide-mate/
├── agent_service/
│   ├── pyproject.toml                       # MODIFY (Task 1) — add amazon-transcribe dep
│   ├── guidemate_agent/
│   │   ├── emote_sync.py                     # NEW (Task 1) — order-independent gate
│   │   ├── speech.py                         # NEW (Task 2) — Transcribe + Polly + resampler
│   │   ├── observability.py                  # NEW (Task 3) — ring buffers
│   │   ├── ws_chat.py                        # NEW (Task 4) — /ws/chat/{session_id}
│   │   ├── app.py                            # MODIFY (Task 4) — wire WS + state
│   │   └── admin.py                          # MODIFY (Task 6) — add /api/health  [Phase 3 file]
│   ├── static/
│   │   ├── index.html                        # REWRITE (Task 5) — polished chat shell
│   │   ├── chat.css                          # NEW (Task 5)
│   │   ├── chat.js                           # NEW (Task 5) — WS + AudioWorklet mic
│   │   └── admin/health.js                   # NEW (Task 6) — Health tab  [Phase 3 dir]
│   └── tests/
│       ├── test_emote_sync.py                # NEW (Task 1)
│       ├── test_speech.py                    # NEW (Task 2)
│       ├── test_observability.py             # NEW (Task 3)
│       ├── test_ws_chat.py                   # NEW (Task 4)
│       ├── integration/
│       │   └── test_speech_loopback.py       # NEW (Task 7) — Polly→Transcribe (GUIDEMATE_LIVE=1)
│       └── e2e/
│           ├── __init__.py                   # NEW (Task 7)
│           └── test_voice_e2e.py             # NEW (Task 7) — Playwright fake-mic
```

**Dependency ordering:** Tasks 1–4 are Phase-5-owned and depend only on Phase 0-1 code that already exists — build them first, in order. Task 5 (UI) consumes the Phase-4 endpoints `GET /api/session/{id}/state` and the request-companion route; it degrades gracefully (virtual-only) if they 404, so it can be built now and fully verified after Phase 4. Task 6 modifies the Phase-3 `admin.py` + `static/admin/` — **it requires Phase 3 to have landed** (or you create a minimal `admin.py` stub, noted inline). Task 7's Playwright e2e requires Phase 4's session/intake page flow to reach the chat surface — **run its assertions after Phase 4 lands**; its loopback integration half is Phase-5-standalone.

---

## Task 1: Order-independent emote-sync gate + Transcribe dependency

**Files:**
- Modify: `agent_service/pyproject.toml` (add `amazon-transcribe`)
- Create: `agent_service/guidemate_agent/emote_sync.py`
- Test: `agent_service/tests/test_emote_sync.py`

**Interfaces:**
- Consumes: `Command`, `Ack` (Phase 0-1 `guidemate_msgs.messages`); `RobotRegistry.send_command` (Phase 0-1 / Phase 2).
- Produces:
  - `GATE_STATES = ("running", "done")`.
  - `gate_released(acks: list[Ack]) -> bool` — pure, order-independent: `True` iff **any** ack has `state` in `GATE_STATES`. `[]` → `False`.
  - `emote_sync(registry, robot_id: Optional[str], cmd: Command, timeout_s: float = 2.0) -> tuple[bool, list[Ack]]` — `robot_id is None` → virtual, returns `(True, [])` immediately (no publish). Otherwise publishes via `registry.send_command(robot_id, cmd, timeout_s=timeout_s)` (which returns on the terminal ack or the timeout — and because `done ∈ GATE_STATES` that terminal return already satisfies the gate in the common path; a lone late `running` is caught by the 2.0 s cap) and returns `(gate_released(acks), acks)`.

- [ ] **Step 1: Add the Transcribe streaming SDK dependency**

Edit `agent_service/pyproject.toml`, replacing the `dependencies` array with (adds one line — `amazon-transcribe`):
```toml
dependencies = [
    "fastapi",
    "uvicorn[standard]",
    "strands-agents",
    "awsiotsdk",
    "boto3",
    "amazon-transcribe",
    "guidemate-msgs",
]
```
Then install it into the dev venv:
```bash
cd ~/cs7980-guide-mate && .venv/bin/pip install amazon-transcribe
```
Expected: `amazon-transcribe` (and its `awscrt`/`aiofile` deps, already present) install cleanly.

- [ ] **Step 2: Write the failing test**

`agent_service/tests/test_emote_sync.py`:
```python
from guidemate_msgs.messages import Ack, Command

from guidemate_agent.emote_sync import GATE_STATES, emote_sync, gate_released


def _acks(*states):
    return [Ack(cmd_id="c1", state=s, simulated=True) for s in states]


def test_gate_states_are_running_and_done():
    assert GATE_STATES == ("running", "done")


def test_gate_not_released_on_empty():
    assert gate_released([]) is False


def test_gate_not_released_on_received_only():
    assert gate_released(_acks("received")) is False


def test_gate_released_on_running():
    assert gate_released(_acks("received", "running")) is True


def test_gate_released_when_done_arrives_before_running():
    # QoS1 out-of-order: done can land before running. Order must not matter.
    assert gate_released(_acks("received", "done", "running")) is True
    assert gate_released(_acks("done", "running")) is True


def test_gate_released_on_done_without_running():
    # received -> done, running never delivered. Still released.
    assert gate_released(_acks("received", "done")) is True


class _FakeRegistry:
    def __init__(self, acks):
        self._acks = acks
        self.published = []

    def send_command(self, robot_id, cmd, timeout_s=5.0, collect_all=False):
        self.published.append((robot_id, cmd.name, timeout_s))
        return list(self._acks)


def test_emote_sync_virtual_releases_immediately_without_publishing():
    reg = _FakeRegistry(_acks("received", "running", "done"))
    released, acks = emote_sync(reg, None, Command(type="emote", name="happy"))
    assert released is True
    assert acks == []
    assert reg.published == []  # virtual path never touches the robot


def test_emote_sync_physical_happy_path():
    reg = _FakeRegistry(_acks("received", "running", "done"))
    released, acks = emote_sync(reg, "turtlebot468", Command(type="emote", name="happy"))
    assert released is True
    assert [a.state for a in acks] == ["received", "running", "done"]
    assert reg.published == [("turtlebot468", "happy", 2.0)]


def test_emote_sync_timeout_fallback_returns_not_released():
    # Robot silent -> send_command times out with an empty list -> gate not released,
    # but we still return so the caller can release the reply anyway (2.0 s fallback).
    reg = _FakeRegistry([])
    released, acks = emote_sync(reg, "turtlebot468", Command(type="emote", name="no"))
    assert released is False
    assert acks == []
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_emote_sync.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_agent.emote_sync'`.

- [ ] **Step 4: Implement `emote_sync.py`**

`agent_service/guidemate_agent/emote_sync.py`:
```python
"""Order-independent emote-sync gate.

AWS IoT QoS1 does NOT preserve publish order — the received/running/done acks for
one command arrive in any order (verified: received -> done -> running). So the gate
that decides "may I release the reply text + audio now?" must be order-independent:
it releases as soon as ANY ack reports running or done. If neither shows up within the
timeout, the caller releases anyway (the 2.0 s fallback) so voice never hangs.
"""
from __future__ import annotations

from typing import Optional

from guidemate_msgs.messages import Ack, Command

GATE_STATES = ("running", "done")


def gate_released(acks: list[Ack]) -> bool:
    """True iff any ack reports the emote has started (running) or finished (done)."""
    return any(a.state in GATE_STATES for a in acks)


def emote_sync(
    registry,
    robot_id: Optional[str],
    cmd: Command,
    timeout_s: float = 2.0,
) -> tuple[bool, list[Ack]]:
    """Publish an emote and gate on the order-independent release predicate.

    robot_id is None  -> virtual session: no physical publish; released immediately.
    robot_id is set   -> physical session: publish via the registry and wait up to
                          timeout_s for a running/done ack (in any order).

    Returns (released, acks). released=False means the timeout fell through with no
    confirming ack — the caller still sends the reply (the 2.0 s fallback).
    """
    if robot_id is None:
        return True, []
    acks = registry.send_command(robot_id, cmd, timeout_s=timeout_s)
    return gate_released(acks), acks
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_emote_sync.py -q`
Expected: PASS (9 passed).

- [ ] **Step 6: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/pyproject.toml agent_service/guidemate_agent/emote_sync.py agent_service/tests/test_emote_sync.py
git commit -m "Kalhar: order-independent emote-sync gate + amazon-transcribe dep"
```

---

## Task 2: Speech backend — pure PCM resampler + Polly TTS + Transcribe streaming

**Files:**
- Create: `agent_service/guidemate_agent/speech.py`
- Test: `agent_service/tests/test_speech.py`

**Interfaces:**
- Consumes: `boto3` (Polly), `amazon-transcribe` (streaming STT), `wave` (stdlib).
- Produces:
  - `downsample_pcm16(pcm: bytes, in_rate: int, out_rate: int) -> bytes` — pure linear-interpolation resampler over signed 16-bit little-endian mono samples; `in_rate == out_rate` is a no-op; `out_rate > in_rate` raises `ValueError`; empty input → `b""`.
  - `pcm16_to_wav(pcm: bytes, sample_rate: int = 16000) -> bytes` — wraps mono 16-bit PCM in a WAV container.
  - `synthesize_mp3(text, voice_id="Justin", region="us-west-2", polly_client=None) -> bytes` — Polly neural mp3.
  - `synthesize_pcm16(text, voice_id="Justin", region="us-west-2", sample_rate=16000, polly_client=None) -> bytes` — Polly neural 16-bit PCM (for the fake-mic wav + loopback test).
  - `class TranscribeSession(region="us-west-2", sample_rate=16000, language_code="en-US")` with `async start()`, `async feed(pcm: bytes)`, `async finish() -> str` (returns the concatenated final transcript, lower-friendly).

- [ ] **Step 1: Verify the amazon-transcribe import surface in a REPL (do this before writing speech.py)**

Run:
```bash
cd ~/cs7980-guide-mate && .venv/bin/python - <<'PY'
from amazon_transcribe.client import TranscribeStreamingClient
from amazon_transcribe.handlers import TranscriptResultStreamHandler
from amazon_transcribe.model import TranscriptEvent
import inspect
print("client ok:", TranscribeStreamingClient is not None)
print("start_stream_transcription:",
      "start_stream_transcription" in dir(TranscribeStreamingClient))
print("handler base:", TranscriptResultStreamHandler.__name__)
PY
```
Expected: all three imports succeed and both prints are truthy. **Fallback:** if `from amazon_transcribe.model import TranscriptEvent` fails, drop that import (it is only used for a type hint below, which is optional). If `start_stream_transcription` is spelled differently, adjust the call in Step 5 to match the printed method name.

- [ ] **Step 2: Write the failing test**

`agent_service/tests/test_speech.py`:
```python
import array
import wave
import io

import pytest

from guidemate_agent.speech import (
    downsample_pcm16,
    pcm16_to_wav,
    synthesize_mp3,
    synthesize_pcm16,
)


def _tone(n_samples, value=1000):
    return array.array("h", [value] * n_samples).tobytes()


def test_downsample_noop_when_rates_equal():
    pcm = _tone(100)
    assert downsample_pcm16(pcm, 16000, 16000) == pcm


def test_downsample_rejects_upsampling():
    with pytest.raises(ValueError):
        downsample_pcm16(_tone(100), 16000, 48000)


def test_downsample_empty_input():
    assert downsample_pcm16(b"", 48000, 16000) == b""


def test_downsample_48k_to_16k_thirds_the_length():
    pcm = _tone(3000)  # 3000 samples @ 48k
    out = downsample_pcm16(pcm, 48000, 16000)
    n_out = len(out) // 2  # 2 bytes/sample
    assert abs(n_out - 1000) <= 1  # ~1/3


def test_downsample_constant_signal_stays_constant():
    out = downsample_pcm16(_tone(3000, value=1234), 48000, 16000)
    samples = array.array("h")
    samples.frombytes(out)
    assert all(abs(s - 1234) <= 1 for s in samples)


def test_pcm16_to_wav_is_readable_mono_16bit():
    pcm = _tone(800)
    wav = pcm16_to_wav(pcm, sample_rate=16000)
    with wave.open(io.BytesIO(wav), "rb") as r:
        assert r.getnchannels() == 1
        assert r.getsampwidth() == 2
        assert r.getframerate() == 16000
        assert r.getnframes() == 800


class _FakeAudioStream:
    def __init__(self, data):
        self._data = data

    def read(self):
        return self._data


class _FakePolly:
    def __init__(self):
        self.calls = []

    def synthesize_speech(self, **kwargs):
        self.calls.append(kwargs)
        return {"AudioStream": _FakeAudioStream(b"AUDIOBYTES")}


def test_synthesize_mp3_uses_neural_justin_mp3():
    polly = _FakePolly()
    out = synthesize_mp3("hello pup", polly_client=polly)
    assert out == b"AUDIOBYTES"
    kw = polly.calls[0]
    assert kw["OutputFormat"] == "mp3"
    assert kw["VoiceId"] == "Justin"
    assert kw["Engine"] == "neural"
    assert kw["Text"] == "hello pup"


def test_synthesize_pcm16_requests_pcm_16k():
    polly = _FakePolly()
    out = synthesize_pcm16("woof", polly_client=polly, sample_rate=16000)
    assert out == b"AUDIOBYTES"
    kw = polly.calls[0]
    assert kw["OutputFormat"] == "pcm"
    assert kw["SampleRate"] == "16000"
    assert kw["Engine"] == "neural"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_speech.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_agent.speech'`.

- [ ] **Step 4: Implement the pure/Polly parts of `speech.py`**

Create `agent_service/guidemate_agent/speech.py` with the resampler, WAV helper, and Polly calls (the Transcribe class is added in Step 5):
```python
"""Speech backend: Amazon Transcribe streaming (STT) + Polly neural (TTS) + a pure
16-bit-PCM linear resampler. Assumes signed 16-bit little-endian mono (host is x86)."""
from __future__ import annotations

import array
import io
import logging
import wave

import boto3

log = logging.getLogger(__name__)


def downsample_pcm16(pcm: bytes, in_rate: int, out_rate: int) -> bytes:
    """Linear-interpolation resampler for signed 16-bit LE mono PCM. Downsample only."""
    if in_rate == out_rate:
        return pcm
    if out_rate > in_rate:
        raise ValueError("downsample_pcm16 only lowers the sample rate")
    samples = array.array("h")
    samples.frombytes(pcm)
    n_in = len(samples)
    if n_in == 0:
        return b""
    n_out = max(1, int(round(n_in * out_rate / in_rate)))
    out = array.array("h", bytes(2 * n_out))
    ratio = (n_in - 1) / (n_out - 1) if n_out > 1 else 0.0
    for i in range(n_out):
        pos = i * ratio
        left = int(pos)
        frac = pos - left
        right = left + 1 if left + 1 < n_in else n_in - 1
        val = samples[left] * (1.0 - frac) + samples[right] * frac
        out[i] = int(round(val))
    return out.tobytes()


def pcm16_to_wav(pcm: bytes, sample_rate: int = 16000) -> bytes:
    """Wrap mono 16-bit PCM in a WAV container (used for the Chrome fake-mic file)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def synthesize_mp3(
    text: str,
    voice_id: str = "Justin",
    region: str = "us-west-2",
    polly_client=None,
) -> bytes:
    """Polly neural mp3 — 'Justin' is young/upbeat, our dog voice."""
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
) -> bytes:
    """Polly neural 16-bit PCM at sample_rate (for fake-mic wav + the loopback test)."""
    client = polly_client or boto3.client("polly", region_name=region)
    resp = client.synthesize_speech(
        Text=text,
        OutputFormat="pcm",
        VoiceId=voice_id,
        Engine="neural",
        SampleRate=str(sample_rate),
    )
    return resp["AudioStream"].read()
```

- [ ] **Step 5: Append the `TranscribeSession` class to `speech.py`**

Append to `agent_service/guidemate_agent/speech.py` (adjust the import/method names per the Step 1 REPL if they differed):
```python
import asyncio  # noqa: E402  (grouped with the streaming imports below)

from amazon_transcribe.client import TranscribeStreamingClient  # noqa: E402
from amazon_transcribe.handlers import TranscriptResultStreamHandler  # noqa: E402


class _CollectingHandler(TranscriptResultStreamHandler):
    """Accumulates only the FINAL (non-partial) transcript alternatives."""

    def __init__(self, output_stream):
        super().__init__(output_stream)
        self._finals: list[str] = []

    async def handle_transcript_event(self, transcript_event) -> None:
        for result in transcript_event.transcript.results:
            if result.is_partial:
                continue
            for alt in result.alternatives:
                if alt.transcript:
                    self._finals.append(alt.transcript)

    def transcript(self) -> str:
        return " ".join(self._finals).strip()


class TranscribeSession:
    """One streaming Transcribe turn: start() -> feed(pcm)* -> finish() -> text."""

    def __init__(
        self,
        region: str = "us-west-2",
        sample_rate: int = 16000,
        language_code: str = "en-US",
    ) -> None:
        self._region = region
        self._sample_rate = sample_rate
        self._language_code = language_code
        self._stream = None
        self._handler = None
        self._consume_task = None

    async def start(self) -> None:
        client = TranscribeStreamingClient(region=self._region)
        self._stream = await client.start_stream_transcription(
            language_code=self._language_code,
            media_sample_rate_hz=self._sample_rate,
            media_encoding="pcm",
        )
        self._handler = _CollectingHandler(self._stream.output_stream)
        self._consume_task = asyncio.create_task(self._handler.handle_events())

    async def feed(self, pcm: bytes) -> None:
        if self._stream is None:
            raise RuntimeError("TranscribeSession.feed before start()")
        await self._stream.input_stream.send_audio_event(audio_chunk=pcm)

    async def finish(self) -> str:
        if self._stream is None:
            return ""
        await self._stream.input_stream.end_stream()
        await self._consume_task
        return self._handler.transcript()
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_speech.py -q`
Expected: PASS (9 passed). `TranscribeSession` is import-only here (its live behavior is covered by the gated loopback test in Task 7).

- [ ] **Step 7: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/speech.py agent_service/tests/test_speech.py
git commit -m "Kalhar: speech backend - PCM resampler + Polly TTS + Transcribe streaming"
```

---

## Task 3: Observability ring buffers (commands, latency, errors)

**Files:**
- Create: `agent_service/guidemate_agent/observability.py`
- Test: `agent_service/tests/test_observability.py`

**Interfaces:**
- Consumes: `Ack` (Phase 0-1); `time`, `collections.deque`, `threading`.
- Produces: `class Observability(max_commands=10, max_latency=50, max_errors=50)` with:
  - `record_command(turn_id, robot_id, cmd_id, sent_monotonic: float, acks: list[Ack]) -> None` — stores states seen, the terminal ack's `.gates` (defensively via `model_dump().get("gates")` so it works before Phase 2 adds the field), `simulated`, and the round-trip `total_ms`.
  - `record_latency(turn_id, bedrock_ms: float, session_id) -> None`.
  - `record_error(where: str, message: str, turn_id=None) -> None`.
  - `snapshot() -> dict` with keys `commands` (newest-first, ≤ `max_commands`), `latencies`, `errors`.

- [ ] **Step 1: Write the failing test**

`agent_service/tests/test_observability.py`:
```python
import time

from guidemate_msgs.messages import Ack

from guidemate_agent.observability import Observability


def _acks(*states):
    return [Ack(cmd_id="c1", state=s, simulated=True) for s in states]


def test_record_command_captures_states_and_timing():
    obs = Observability()
    sent = time.monotonic() - 0.05
    obs.record_command("t1", "turtlebot468", "c1", sent, _acks("received", "running", "done"))
    cmds = obs.snapshot()["commands"]
    assert len(cmds) == 1
    rec = cmds[0]
    assert rec["robot_id"] == "turtlebot468"
    assert rec["cmd_id"] == "c1"
    assert rec["states"] == ["received", "running", "done"]
    assert rec["simulated"] is True
    assert rec["total_ms"] >= 40.0


def test_commands_ring_keeps_only_last_10_newest_first():
    obs = Observability(max_commands=10)
    for i in range(13):
        obs.record_command(f"t{i}", "r", f"c{i}", time.monotonic(), _acks("done"))
    cmds = obs.snapshot()["commands"]
    assert len(cmds) == 10
    assert cmds[0]["cmd_id"] == "c12"      # newest first
    assert cmds[-1]["cmd_id"] == "c3"      # c0,c1,c2 evicted


def test_record_latency_and_errors():
    obs = Observability()
    obs.record_latency("t1", 812.5, "sess-1")
    obs.record_error("tts", "polly blew up", turn_id="t1")
    snap = obs.snapshot()
    assert snap["latencies"][0]["bedrock_ms"] == 812.5
    assert snap["latencies"][0]["session_id"] == "sess-1"
    assert snap["errors"][0]["where"] == "tts"
    assert "polly" in snap["errors"][0]["message"]


def test_gates_key_present_and_defensive_on_phase01_ack():
    # Phase 0-1 Ack has no `gates` field. record_command must not crash and must
    # still emit a "gates" key (None) — it picks up the real dict once Phase 2 lands.
    obs = Observability()
    obs.record_command("t1", "r", "c1", time.monotonic(), _acks("received", "done"))
    rec = obs.snapshot()["commands"][0]
    assert "gates" in rec
    assert rec["gates"] is None


def test_gates_captured_when_ack_is_a_dict_with_gates():
    # A dict-shaped ack that carries gates (mirrors a Phase-2 Ack.model_dump()).
    obs = Observability()
    ack = {"cmd_id": "c1", "state": "done", "simulated": True,
           "gates": {"motion_enabled": False, "docked": True}}
    obs.record_command("t1", "r", "c1", time.monotonic(), [ack])
    rec = obs.snapshot()["commands"][0]
    assert rec["gates"] == {"motion_enabled": False, "docked": True}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_observability.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_agent.observability'`.

- [ ] **Step 3: Implement `observability.py`**

`agent_service/guidemate_agent/observability.py`:
```python
"""In-process observability ring buffers for the admin Health tab. No CloudWatch
dependency — these are log-derived, bounded deques readable via /admin/api/health."""
from __future__ import annotations

import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ack_field(ack, key, default=None):
    """Read a field off an Ack whether or not Phase 2 has added it yet."""
    if hasattr(ack, "model_dump"):
        return ack.model_dump().get(key, default)
    if isinstance(ack, dict):
        return ack.get(key, default)
    return getattr(ack, key, default)


class Observability:
    def __init__(self, max_commands: int = 10, max_latency: int = 50, max_errors: int = 50) -> None:
        self._lock = threading.Lock()
        self._commands: deque = deque(maxlen=max_commands)
        self._latencies: deque = deque(maxlen=max_latency)
        self._errors: deque = deque(maxlen=max_errors)

    def record_command(self, turn_id, robot_id, cmd_id, sent_monotonic: float, acks) -> None:
        elapsed_ms = round((time.monotonic() - sent_monotonic) * 1000.0, 1)
        gates = _ack_field(acks[-1], "gates") if acks else None
        rec = {
            "turn_id": turn_id,
            "robot_id": robot_id,
            "cmd_id": cmd_id,
            "ts": _now_iso(),
            "total_ms": elapsed_ms,
            "states": [_ack_field(a, "state") for a in acks],
            "gates": gates,
            "simulated": any(bool(_ack_field(a, "simulated")) for a in acks),
        }
        with self._lock:
            self._commands.appendleft(rec)

    def record_latency(self, turn_id, bedrock_ms: float, session_id: Optional[str]) -> None:
        with self._lock:
            self._latencies.appendleft({
                "turn_id": turn_id,
                "bedrock_ms": round(bedrock_ms, 1),
                "session_id": session_id,
                "ts": _now_iso(),
            })

    def record_error(self, where: str, message: str, turn_id: Optional[str] = None) -> None:
        with self._lock:
            self._errors.appendleft({
                "where": where,
                "message": str(message)[:500],
                "turn_id": turn_id,
                "ts": _now_iso(),
            })

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "commands": list(self._commands),
                "latencies": list(self._latencies),
                "errors": list(self._errors),
            }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_observability.py -q`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/observability.py agent_service/tests/test_observability.py
git commit -m "Kalhar: in-process observability ring buffers (commands/latency/errors)"
```

---

## Task 4: `/ws/chat/{session_id}` WebSocket — transcript → agent → emote-sync → reply+audio

**Files:**
- Create: `agent_service/guidemate_agent/ws_chat.py`
- Modify: `agent_service/guidemate_agent/app.py` (store config/observability/ws-agent/resolver on `app.state`; register the WS route)
- Test: `agent_service/tests/test_ws_chat.py`

**Interfaces:**
- Consumes: `emote_sync` (Task 1); `synthesize_mp3`, `TranscribeSession`, `downsample_pcm16` (Task 2); `Observability` (Task 3); `DogAgent`, `Command` (Phase 0-1); `Config` (Phase 0-1); `RobotRegistry` (Phase 0-1/Phase 2). **Seam:** `app.state.robot_target_resolver: Callable[[str], Optional[str]]` (Phase 4; virtual-only default installed here).
- Produces:
  - `class CaptureRegistry` — a registry stand-in whose `send_command(...)` returns one `Ack(state="done", simulated=True)` and **publishes nothing**. The WS-path `DogAgent` is backed by this so its `send_emote` tool reports success (keeping the reply text clean) without doing the physical publish — the WS layer owns the real publish + gate.
  - `def register(app: FastAPI) -> None` — attaches `@app.websocket("/ws/chat/{session_id}")`.
  - Wire protocol (server ← browser): text control frames `{"type":"start_audio","sample_rate":N}`, `{"type":"stop_audio"}`, `{"type":"text","message":str}`; binary frames = PCM chunks. Server → browser: `{"type":"transcript","text":...}` (voice only), then together `{"type":"reply","text","emote","gate_released","turn_id"}` + `{"type":"audio","format":"mp3","b64":...}`; `{"type":"error","message":...}` on failure.

- [ ] **Step 1: Write the failing test**

`agent_service/tests/test_ws_chat.py`:
```python
import base64

from fastapi import FastAPI
from fastapi.testclient import TestClient

import guidemate_agent.ws_chat as ws_chat
from guidemate_agent.observability import Observability


class _FakeAgent:
    """Stand-in for the WS-path DogAgent: picks 'happy', no Bedrock/MQTT."""

    def __init__(self):
        self.seen = []

    def chat(self, message, robot_id=None):
        self.seen.append((message, robot_id))
        return {"reply_text": "woof! happy to help", "emote": "happy",
                "robot": [], "turn_id": "turn-x"}


class _FakeRegistry:
    def __init__(self):
        self.published = []

    def send_command(self, robot_id, cmd, timeout_s=5.0, collect_all=False):
        from guidemate_msgs.messages import Ack
        self.published.append((robot_id, cmd.name))
        return [Ack(cmd_id=cmd.cmd_id, state="done", simulated=True)]

    def get_status(self, robot_id):
        return {"robot_id": robot_id, "presence": "online"}


def _app(monkeypatch, resolver):
    monkeypatch.setattr(ws_chat, "synthesize_mp3", lambda text, **kw: b"MP3BYTES")
    app = FastAPI()
    app.state.registry = _FakeRegistry()
    app.state.observability = Observability()
    app.state.ws_agent = _FakeAgent()
    app.state.robot_target_resolver = resolver

    class _Cfg:
        region = "us-west-2"
    app.state.config = _Cfg()
    ws_chat.register(app)
    return app


def test_text_message_virtual_session_returns_reply_and_audio(monkeypatch):
    app = _app(monkeypatch, resolver=lambda sid: None)  # virtual
    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/sess-1") as ws:
            ws.send_json({"type": "text", "message": "hi robert"})
            reply = ws.receive_json()
            audio = ws.receive_json()
    assert reply["type"] == "reply"
    assert reply["emote"] == "happy"
    assert reply["gate_released"] is True
    assert audio["type"] == "audio"
    assert base64.b64decode(audio["b64"]) == b"MP3BYTES"
    # Virtual session: the WS layer must NOT publish to the robot.
    assert app.state.registry.published == []


def test_text_message_physical_session_publishes_and_records(monkeypatch):
    app = _app(monkeypatch, resolver=lambda sid: "turtlebot468")  # physical
    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/sess-2") as ws:
            ws.send_json({"type": "text", "message": "sit"})
            reply = ws.receive_json()
            ws.receive_json()  # audio
    assert reply["gate_released"] is True
    assert app.state.registry.published == [("turtlebot468", "happy")]
    cmds = app.state.observability.snapshot()["commands"]
    assert cmds and cmds[0]["robot_id"] == "turtlebot468"
    lat = app.state.observability.snapshot()["latencies"]
    assert lat and lat[0]["turn_id"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_ws_chat.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_agent.ws_chat'`.

- [ ] **Step 3: Implement `ws_chat.py`**

`agent_service/guidemate_agent/ws_chat.py`:
```python
"""WebSocket chat: /ws/chat/{session_id}. Audio -> Transcribe -> agent -> emote-sync
-> reply + Polly audio, released together. Text messages use the same pipeline.

Emote ownership: the WS-path DogAgent is backed by CaptureRegistry so its send_emote
tool 'succeeds' virtually (reply text stays clean) but publishes NOTHING. The real
physical publish + the order-independent release gate live HERE, after the agent turn,
per the Phase-5 emote-sync decision.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import uuid
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from guidemate_msgs.messages import Ack, Command

from guidemate_agent.emote_sync import emote_sync
from guidemate_agent.speech import TranscribeSession, downsample_pcm16, synthesize_mp3

log = logging.getLogger(__name__)


class CaptureRegistry:
    """Registry stand-in for the WS-path agent: acks 'done' (simulated), never publishes."""

    def send_command(self, robot_id, cmd, timeout_s=5.0, collect_all=False) -> list[Ack]:
        return [Ack(cmd_id=cmd.cmd_id, state="done", simulated=True)]

    def get_status(self, robot_id) -> dict:
        return {"robot_id": robot_id, "presence": "unknown"}


def _physical_target(app: FastAPI, session_id: str) -> Optional[str]:
    """Resolve the physical robot bound to this session (Phase 4), or None (virtual)."""
    resolver = getattr(app.state, "robot_target_resolver", None)
    if resolver is None:
        return None
    try:
        return resolver(session_id)
    except Exception:  # noqa: BLE001 — a broken resolver must not break chat
        log.exception("robot_target_resolver raised; falling back to virtual")
        return None


async def _run_pipeline(ws: WebSocket, app: FastAPI, session_id: str, text: str) -> None:
    obs = getattr(app.state, "observability", None)
    agent = app.state.ws_agent
    registry = app.state.registry
    region = getattr(app.state.config, "region", "us-west-2")
    turn_id = str(uuid.uuid4())
    loop = asyncio.get_event_loop()

    try:
        target = _physical_target(app, session_id)
        t0 = time.monotonic()
        result = await loop.run_in_executor(None, lambda: agent.chat(text, robot_id=target))
        if obs is not None:
            obs.record_latency(turn_id, (time.monotonic() - t0) * 1000.0, session_id)

        emote = result.get("emote")
        released = True
        if emote:
            cmd = Command(type="emote", name=emote)
            sent = time.monotonic()
            released, acks = await loop.run_in_executor(
                None, lambda: emote_sync(registry, target, cmd, 2.0)
            )
            if obs is not None and target is not None:
                obs.record_command(turn_id, target, cmd.cmd_id, sent, acks)

        # Release reply text + audio TOGETHER, once the gate is satisfied (or timed out).
        await ws.send_json({
            "type": "reply",
            "text": result["reply_text"],
            "emote": emote,
            "gate_released": released,
            "turn_id": turn_id,
        })
        try:
            mp3 = await loop.run_in_executor(None, lambda: synthesize_mp3(result["reply_text"], region=region))
            await ws.send_json({
                "type": "audio",
                "format": "mp3",
                "b64": base64.b64encode(mp3).decode("ascii"),
            })
        except Exception as exc:  # noqa: BLE001 — audio is best-effort
            if obs is not None:
                obs.record_error("tts", str(exc), turn_id)
    except Exception as exc:  # noqa: BLE001 — never kill the socket on one bad turn
        log.exception("chat pipeline failed")
        if obs is not None:
            obs.record_error("pipeline", str(exc), turn_id)
        await ws.send_json({"type": "error", "message": "sorry, I got a little confused"})


def register(app: FastAPI) -> None:
    @app.websocket("/ws/chat/{session_id}")
    async def chat_ws(ws: WebSocket, session_id: str) -> None:  # noqa: WPS430
        await ws.accept()
        region = getattr(app.state.config, "region", "us-west-2")
        transcribe: Optional[TranscribeSession] = None
        declared_rate = 16000
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if msg.get("text") is not None:
                    data = json.loads(msg["text"])
                    mtype = data.get("type")
                    if mtype == "start_audio":
                        declared_rate = int(data.get("sample_rate", 16000))
                        transcribe = TranscribeSession(region=region, sample_rate=16000)
                        await transcribe.start()
                    elif mtype == "stop_audio":
                        text = await transcribe.finish() if transcribe else ""
                        transcribe = None
                        await ws.send_json({"type": "transcript", "text": text})
                        if text.strip():
                            await _run_pipeline(ws, app, session_id, text)
                    elif mtype == "text":
                        text = (data.get("message") or "").strip()
                        if text:
                            await _run_pipeline(ws, app, session_id, text)
                elif msg.get("bytes") is not None and transcribe is not None:
                    pcm = msg["bytes"]
                    if declared_rate != 16000:
                        pcm = downsample_pcm16(pcm, declared_rate, 16000)
                    await transcribe.feed(pcm)
        except WebSocketDisconnect:
            pass
        finally:
            if transcribe is not None:
                try:
                    await transcribe.finish()
                except Exception:  # noqa: BLE001
                    pass
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_ws_chat.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Wire the WS route + `app.state` in `app.py`**

Edit `agent_service/guidemate_agent/app.py`. Replace the imports block and the `lifespan` function so it stores `config`, `observability`, a WS-path agent (`ws_agent`), a virtual-only `robot_target_resolver` default, and registers the WS route.

Replace lines 12-16 (the import block) with:
```python
from guidemate_msgs.jsonlog import setup

from guidemate_agent.config import Config
from guidemate_agent.dog_agent import DogAgent
from guidemate_agent.mqtt_link import RobotRegistry
from guidemate_agent.observability import Observability
from guidemate_agent.ws_chat import CaptureRegistry, register as register_ws
```

Replace the `lifespan` function body (lines 26-44) with:
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    setup("agent-service")
    cfg = Config.from_env()
    registry = RobotRegistry(
        endpoint=cfg.iot_endpoint, region=cfg.region, robot_ids=cfg.robot_ids
    )
    try:
        registry.connect()
    except Exception:  # noqa: BLE001 — chat still works if robots are unreachable
        log.exception("registry connect failed — robots unreachable, chat still works")
    app.state.config = cfg
    app.state.registry = registry
    app.state.observability = Observability()
    app.state.agent = DogAgent(
        registry=registry, model_id=cfg.model_id, robot_ids=cfg.robot_ids, region=cfg.region
    )
    # WS-path agent: emote picked here, physical publish owned by ws_chat (CaptureRegistry).
    app.state.ws_agent = DogAgent(
        registry=CaptureRegistry(), model_id=cfg.model_id, robot_ids=cfg.robot_ids, region=cfg.region
    )
    # Phase 4 overrides this with a real session->robot resolver; default is virtual-only.
    if not hasattr(app.state, "robot_target_resolver"):
        app.state.robot_target_resolver = lambda session_id: None
    yield
```

Then add, immediately after `app = FastAPI(lifespan=lifespan)`:
```python
register_ws(app)
```

- [ ] **Step 6: Verify the app still imports + all Task-4 tests pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -c "import guidemate_agent.app" && .venv/bin/python -m pytest agent_service/tests/test_app.py agent_service/tests/test_ws_chat.py -q`
Expected: import succeeds; PASS (Task-4 tests + the existing Phase 0-1 app tests, all green).

- [ ] **Step 7: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/ws_chat.py agent_service/guidemate_agent/app.py agent_service/tests/test_ws_chat.py
git commit -m "Kalhar: /ws/chat WebSocket - voice+text pipeline with owned emote-sync"
```

---

## Task 5: Polished chat UI — avatar, bubbles, mic push-to-talk, status chip, banner

**Files:**
- Rewrite: `agent_service/static/index.html`
- Create: `agent_service/static/chat.css`, `agent_service/static/chat.js`

**Interfaces:**
- Consumes (server): `/ws/chat/{session_id}` (Task 4). **Phase-4 seams (degrade gracefully if 404):** `GET /api/session/{id}/state` (battery/dock/motion-lock/robot-connected/request status), `POST /api/session/{id}/request-companion`, and a `guidemate_session_id` in `localStorage` (Phase 4's intake mints it; Task 5 falls back to a random UUID so the page works standalone).
- Produces: a warm single-page chat with an inline-SVG dog avatar (CSS `wiggle`/`nod`/`shake` keyed to `happy`/`yes`/`no`), chat bubbles, a push-to-talk mic button with a live level meter, mp3 playback, a status chip, and a companion-request banner.

**Note on dependencies:** the WebSocket half works today (Task 4). The status chip + companion banner light up once Phase 4 serves `/api/session/{id}/state`; until then the poller quietly shows "virtual" defaults. Build now, re-verify the chip/banner after Phase 4.

- [ ] **Step 1: Write `static/index.html` (shell + inline SVG avatar)**

`agent_service/static/index.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Robert the Robot Dog</title>
  <link rel="stylesheet" href="/chat.css" />
</head>
<body>
  <main class="app">
    <header class="topbar">
      <div class="brand">
        <span class="paw">🐾</span>
        <h1>Robert</h1>
      </div>
      <div id="status-chip" class="chip chip-virtual" title="connection status">
        <span id="status-mode">virtual</span>
        <span id="status-detail">·</span>
      </div>
    </header>

    <section id="companion-banner" class="banner hidden" aria-live="polite">
      <span id="banner-text">Want a real robot companion?</span>
      <button id="request-companion" class="banner-btn" type="button">Request physical companion</button>
    </section>

    <section class="stage">
      <div id="avatar" class="avatar">
        <!-- Pure inline SVG dog. Emote classes on #avatar drive the CSS animations. -->
        <svg viewBox="0 0 120 120" width="140" height="140" aria-hidden="true">
          <g class="dog-body">
            <ellipse cx="60" cy="92" rx="34" ry="18" class="dog-shadow" />
            <path class="dog-ear ear-left" d="M34 40 q-14 6 -8 30 q10 -6 14 -18 z" />
            <path class="dog-ear ear-right" d="M86 40 q14 6 8 30 q-10 -6 -14 -18 z" />
            <circle cx="60" cy="56" r="30" class="dog-head" />
            <circle cx="50" cy="52" r="4.5" class="dog-eye" />
            <circle cx="70" cy="52" r="4.5" class="dog-eye" />
            <ellipse cx="60" cy="66" rx="7" ry="5" class="dog-snout" />
            <circle cx="60" cy="63" r="3.2" class="dog-nose" />
          </g>
        </svg>
      </div>
    </section>

    <section id="messages" class="messages" aria-live="polite"></section>

    <form id="chat-form" class="composer">
      <button id="mic" class="mic" type="button" aria-label="Push to talk">
        <span class="mic-glyph">🎙️</span>
        <span class="mic-level"><span id="mic-level-bar"></span></span>
      </button>
      <input id="message" class="text-input" autocomplete="off"
             placeholder="Say something to Robert…" />
      <button type="submit" class="send">Send</button>
    </form>
  </main>
  <audio id="player" hidden></audio>
  <script src="/chat.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `static/chat.css` (warm theme + emote animations)**

`agent_service/static/chat.css`:
```css
:root {
  --warm-bg: #fff7ef;
  --warm-card: #ffffff;
  --accent: #f28c38;
  --accent-soft: #ffe6cc;
  --ink: #3a2e26;
  --muted: #9a8b7d;
  --you: #ffedd8;
  --dog: #eef3ff;
  --ok: #46a758;
  --warn: #e5484d;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Segoe UI", system-ui, sans-serif;
  background: var(--warm-bg);
  color: var(--ink);
}
.app { max-width: 560px; margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; }
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; }
.brand { display: flex; align-items: center; gap: 8px; }
.brand h1 { margin: 0; font-size: 22px; letter-spacing: .5px; }
.paw { font-size: 22px; }
.chip {
  display: inline-flex; gap: 6px; align-items: center;
  padding: 5px 11px; border-radius: 999px; font-size: 12px; font-weight: 600;
  background: var(--accent-soft); color: var(--accent);
}
.chip-physical { background: #dff4e3; color: var(--ok); }
.chip-virtual { background: var(--accent-soft); color: var(--accent); }
.chip-locked { background: #fdecec; color: var(--warn); }
.banner {
  margin: 0 18px 8px; padding: 10px 14px; border-radius: 12px;
  background: var(--accent-soft); display: flex; align-items: center; justify-content: space-between; gap: 10px;
  font-size: 14px;
}
.banner.pending { background: #fff3cd; }
.banner.approved { background: #dff4e3; }
.banner.denied, .banner.aborted { background: #fdecec; }
.banner-btn {
  border: none; background: var(--accent); color: #fff; border-radius: 8px;
  padding: 6px 12px; font-weight: 600; cursor: pointer;
}
.banner-btn:disabled { opacity: .5; cursor: default; }
.hidden { display: none !important; }
.stage { display: flex; justify-content: center; padding: 8px 0 4px; }
.avatar { transform-origin: 50% 80%; }
.dog-shadow { fill: rgba(0,0,0,.06); }
.dog-head, .dog-ear { fill: #c9955f; }
.dog-snout { fill: #e8c39a; }
.dog-eye, .dog-nose { fill: #3a2e26; }
/* Emote animations */
@keyframes wiggle { 0%,100% { transform: rotate(0); } 25% { transform: rotate(-9deg); } 75% { transform: rotate(9deg); } }
@keyframes nod    { 0%,100% { transform: translateY(0); } 50% { transform: translateY(9px); } }
@keyframes shake  { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-8px); } 75% { transform: translateX(8px); } }
.avatar.emote-happy { animation: wiggle .45s ease-in-out 3; }
.avatar.emote-yes   { animation: nod .5s ease-in-out 2; }
.avatar.emote-no    { animation: shake .4s ease-in-out 3; }
.messages { flex: 1; overflow-y: auto; padding: 8px 18px 14px; display: flex; flex-direction: column; gap: 8px; }
.bubble { max-width: 78%; padding: 9px 13px; border-radius: 16px; font-size: 15px; line-height: 1.35; }
.bubble.you { align-self: flex-end; background: var(--you); border-bottom-right-radius: 5px; }
.bubble.dog { align-self: flex-start; background: var(--dog); border-bottom-left-radius: 5px; }
.bubble .emote-tag { display: block; margin-top: 3px; font-size: 11px; color: var(--muted); }
.composer { display: flex; gap: 8px; align-items: center; padding: 12px 18px calc(12px + env(safe-area-inset-bottom)); background: var(--warm-card); }
.text-input { flex: 1; border: 1px solid #e7d9c9; border-radius: 999px; padding: 11px 16px; font-size: 15px; outline: none; }
.text-input:focus { border-color: var(--accent); }
.send { border: none; background: var(--accent); color: #fff; border-radius: 999px; padding: 11px 18px; font-weight: 600; cursor: pointer; }
.mic { position: relative; border: none; background: var(--accent-soft); border-radius: 50%; width: 46px; height: 46px; cursor: pointer; display: grid; place-items: center; }
.mic.recording { background: var(--warn); }
.mic-glyph { font-size: 20px; }
.mic-level { position: absolute; bottom: -3px; left: 8px; right: 8px; height: 3px; background: rgba(0,0,0,.08); border-radius: 2px; overflow: hidden; }
#mic-level-bar { display: block; height: 100%; width: 0%; background: var(--accent); transition: width .07s linear; }
```

- [ ] **Step 3: Write `static/chat.js` (WebSocket + AudioWorklet mic + 16k downsample)**

`agent_service/static/chat.js`:
```javascript
(() => {
  "use strict";

  // --- session id (Phase 4 mints this at intake; standalone fallback = random UUID) ---
  let sessionId = localStorage.getItem("guidemate_session_id");
  if (!sessionId) {
    sessionId = (crypto.randomUUID ? crypto.randomUUID()
                : "sess-" + Math.random().toString(16).slice(2));
    localStorage.setItem("guidemate_session_id", sessionId);
  }

  const messages = document.getElementById("messages");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("message");
  const avatar = document.getElementById("avatar");
  const player = document.getElementById("player");
  const micBtn = document.getElementById("mic");
  const micBar = document.getElementById("mic-level-bar");
  const chip = document.getElementById("status-chip");
  const chipMode = document.getElementById("status-mode");
  const chipDetail = document.getElementById("status-detail");
  const banner = document.getElementById("companion-banner");
  const bannerText = document.getElementById("banner-text");
  const requestBtn = document.getElementById("request-companion");

  function addBubble(role, text, emote) {
    const div = document.createElement("div");
    div.className = "bubble " + (role === "you" ? "you" : "dog");
    div.textContent = text;
    if (emote) {
      const tag = document.createElement("span");
      tag.className = "emote-tag";
      tag.textContent = "emote: " + emote;
      div.appendChild(tag);
    }
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function playEmote(emote) {
    if (!emote) return;
    avatar.classList.remove("emote-happy", "emote-yes", "emote-no");
    void avatar.offsetWidth; // restart animation
    avatar.classList.add("emote-" + emote);
    setTimeout(() => avatar.classList.remove("emote-" + emote), 1600);
  }

  // --- WebSocket ---
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  let ws = null;
  function connect() {
    ws = new WebSocket(`${wsProto}://${location.host}/ws/chat/${sessionId}`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "transcript") {
        if (msg.text) addBubble("you", msg.text);
      } else if (msg.type === "reply") {
        addBubble("dog", msg.text, msg.emote);
        playEmote(msg.emote);
      } else if (msg.type === "audio") {
        const bytes = Uint8Array.from(atob(msg.b64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: "audio/mpeg" });
        player.src = URL.createObjectURL(blob);
        player.play().catch(() => {});
      } else if (msg.type === "error") {
        addBubble("dog", msg.message);
      }
    };
    ws.onclose = () => setTimeout(connect, 1500);
  }
  connect();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    addBubble("you", text);
    ws.send(JSON.stringify({ type: "text", message: text }));
    input.value = "";
  });

  // --- Push-to-talk mic: capture -> 16k Int16 PCM -> WS binary ---
  const TARGET_RATE = 16000;
  let audioCtx = null, micStream = null, workletNode = null, recording = false;

  function floatTo16kPCM(float32, inRate) {
    // Downsample (linear) then convert to signed 16-bit LE.
    let data = float32;
    if (inRate !== TARGET_RATE) {
      const ratio = inRate / TARGET_RATE;
      const outLen = Math.round(float32.length / ratio);
      data = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const left = Math.floor(pos);
        const right = Math.min(left + 1, float32.length - 1);
        const frac = pos - left;
        data[i] = float32[left] * (1 - frac) + float32[right] * frac;
      }
    }
    const pcm = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const s = Math.max(-1, Math.min(1, data[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm.buffer;
  }

  const workletCode = `
    class Grabber extends AudioWorkletProcessor {
      process(inputs) {
        const ch = inputs[0][0];
        if (ch) this.port.postMessage(ch.slice(0));
        return true;
      }
    }
    registerProcessor('grabber', Grabber);
  `;

  async function startRecording() {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_RATE });
    const inRate = audioCtx.sampleRate;
    const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
    await audioCtx.audioWorklet.addModule(blobUrl);
    const src = audioCtx.createMediaStreamSource(micStream);
    workletNode = new AudioWorkletNode(audioCtx, "grabber");
    workletNode.port.onmessage = (e) => {
      const frame = e.data; // Float32Array at inRate
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      micBar.style.width = Math.min(100, rms * 320).toFixed(0) + "%";
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(floatTo16kPCM(frame, inRate));
      }
    };
    src.connect(workletNode);
    // Worklet must be in the graph to run; a muted sink keeps it pulling.
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    workletNode.connect(mute).connect(audioCtx.destination);
    ws.send(JSON.stringify({ type: "start_audio", sample_rate: TARGET_RATE }));
    recording = true;
    micBtn.classList.add("recording");
  }

  async function stopRecording() {
    recording = false;
    micBtn.classList.remove("recording");
    micBar.style.width = "0%";
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop_audio" }));
    if (workletNode) workletNode.disconnect();
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    if (audioCtx) await audioCtx.close();
    audioCtx = micStream = workletNode = null;
  }

  function toggleMic() {
    if (recording) stopRecording();
    else startRecording().catch((err) => addBubble("dog", "mic error: " + err.message));
  }
  micBtn.addEventListener("click", toggleMic);

  // --- Status chip + companion banner (Phase 4 endpoints; graceful when absent) ---
  async function pollState() {
    try {
      const r = await fetch(`/api/session/${sessionId}/state`, { credentials: "same-origin" });
      if (!r.ok) throw new Error("no state");
      const s = await r.json();
      const physical = !!s.robot_connected;
      chip.className = "chip " + (s.motion_locked ? "chip-locked" : physical ? "chip-physical" : "chip-virtual");
      chipMode.textContent = physical ? "physical" : "virtual";
      const bits = [];
      if (s.battery != null) bits.push(Math.round(s.battery) + "%");
      if (s.docked != null) bits.push(s.docked ? "docked" : "undocked");
      if (s.motion_locked) bits.push("motion-locked");
      chipDetail.textContent = bits.length ? bits.join(" · ") : "·";
      renderBanner(s.request_status, physical);
    } catch (e) {
      chip.className = "chip chip-virtual";
      chipMode.textContent = "virtual";
      chipDetail.textContent = "·";
    }
  }

  function renderBanner(status, physical) {
    banner.classList.remove("pending", "approved", "denied", "aborted", "hidden");
    if (physical) {
      banner.classList.add("approved");
      bannerText.textContent = "Robert is with you 🐕 (physical)";
      requestBtn.disabled = true; requestBtn.textContent = "Connected";
    } else if (status === "pending") {
      banner.classList.add("pending");
      bannerText.textContent = "Request sent — waiting for an admin…";
      requestBtn.disabled = true; requestBtn.textContent = "Pending";
    } else if (status === "denied" || status === "aborted") {
      banner.classList.add(status);
      bannerText.textContent = status === "denied" ? "Request was declined." : "Session ended by admin.";
      requestBtn.disabled = false; requestBtn.textContent = "Request physical companion";
    } else {
      bannerText.textContent = "Want a real robot companion?";
      requestBtn.disabled = false; requestBtn.textContent = "Request physical companion";
    }
  }

  requestBtn.addEventListener("click", async () => {
    requestBtn.disabled = true;
    try {
      await fetch(`/api/session/${sessionId}/request-companion`, {
        method: "POST", credentials: "same-origin",
      });
    } catch (e) { /* Phase 4 endpoint may not exist yet */ }
    pollState();
  });

  pollState();
  setInterval(pollState, 4000);
})();
```

- [ ] **Step 4: Manually smoke-test the UI against the live WS (no Phase 4 needed)**

Run the service and open the page (virtual-only path is fully exercisable now):
```bash
cd ~/cs7980-guide-mate
export GUIDEMATE_IOT_ENDPOINT="$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)"
.venv/bin/python -m uvicorn guidemate_agent.app:app --app-dir agent_service --port 8080
```
Then in Chrome open `http://127.0.0.1:8080/`, type "do a happy wiggle", press Send.
Expected: a "You" bubble, then a "Robert" reply bubble with an `emote: happy` tag, the avatar wiggles, and mp3 audio plays. The status chip reads `virtual` (Phase 4 `/api/session/.../state` 404s → graceful default). Stop uvicorn with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/static/index.html agent_service/static/chat.css agent_service/static/chat.js
git commit -m "Kalhar: polished chat UI - avatar emotes, mic push-to-talk, status chip, banner"
```

---

## Task 6: Admin Health tab — last-10 commands, robot heartbeat, Bedrock latency, errors

**Files:**
- Modify: `agent_service/guidemate_agent/admin.py` (Phase 3 file — add the `/api/health` route)
- Create: `agent_service/static/admin/health.js`
- Test: extend `agent_service/tests/test_observability.py` is done; add `agent_service/tests/test_admin_health.py`

**Interfaces:**
- Consumes: `Observability.snapshot()` (Task 3); `RobotRegistry.get_status` (Phase 0-1/Phase 2 heartbeat); the Phase-3 `router` + `admin_required`.
- Produces: `GET /admin/api/health` (admin-only) → `{commands, latencies, errors, robots: [get_status per configured robot]}`; a Health tab that polls it.

**Dependency:** this task **requires Phase 3's `admin.py`** (an `APIRouter` `router` + `admin_required` dependency) and the `static/admin/` tab shell. If Phase 3 has not landed when you reach this task, create the minimal stub shown in Step 1a; otherwise skip 1a and only add the route in Step 1b.

- [ ] **Step 1a: (ONLY if Phase 3's `admin.py` does not exist yet) create a minimal admin router stub**

`agent_service/guidemate_agent/admin.py`:
```python
"""Admin router (Phase 3 owns the full version; this is the minimal stub Phase 5
needs for the Health tab if Phase 3 has not landed). Single shared password cookie."""
from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, Request

router = APIRouter(prefix="/admin")


def admin_required(request: Request) -> None:
    expected = os.environ.get("GUIDEMATE_ADMIN_PASSWORD", "")
    cookie = request.cookies.get("guidemate_admin", "")
    if not expected or cookie != expected:
        raise HTTPException(status_code=401, detail="admin auth required")
```
And ensure it is mounted — add to `agent_service/guidemate_agent/app.py` after `register_ws(app)`:
```python
from guidemate_agent.admin import router as admin_router  # noqa: E402
app.include_router(admin_router)
```
(When Phase 3 lands its richer `admin.py`, this route survives — see Step 1b, which only *adds* an endpoint.)

- [ ] **Step 1b: Write the failing test**

`agent_service/tests/test_admin_health.py`:
```python
import time

from fastapi.testclient import TestClient

import guidemate_agent.app as appmod
from guidemate_agent.observability import Observability
from guidemate_msgs.messages import Ack


def _client(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "s3cret")
    monkeypatch.setenv("GUIDEMATE_IOT_ENDPOINT", "invalid.example.com")

    def _boom(self):
        raise RuntimeError("no MQTT in unit test")

    monkeypatch.setattr(appmod.RobotRegistry, "connect", _boom)
    return TestClient(appmod.app)


def test_health_requires_admin_cookie(monkeypatch):
    with _client(monkeypatch) as client:
        resp = client.get("/admin/api/health")
        assert resp.status_code == 401


def test_health_returns_rings_and_robots(monkeypatch):
    with _client(monkeypatch) as client:
        # Seed the ring buffers on the running app instance.
        obs: Observability = appmod.app.state.observability
        obs.record_command("t1", "turtlebot468", "c1", time.monotonic(),
                           [Ack(cmd_id="c1", state="done", simulated=True)])
        obs.record_latency("t1", 700.0, "sess-1")
        client.cookies.set("guidemate_admin", "s3cret")
        resp = client.get("/admin/api/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["commands"][0]["robot_id"] == "turtlebot468"
        assert body["latencies"][0]["bedrock_ms"] == 700.0
        assert isinstance(body["robots"], list)
        assert body["robots"][0]["robot_id"] == "turtlebot468"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_admin_health.py -q`
Expected: FAIL — `GET /admin/api/health` returns 404 (route not defined yet).

- [ ] **Step 3: Add the `/api/health` route to `admin.py`**

Append to `agent_service/guidemate_agent/admin.py` (works with both the stub above and Phase 3's richer router — it only references `router` + `admin_required`):
```python
@router.get("/api/health")
def admin_health(request: Request, _=Depends(admin_required)) -> dict:
    app = request.app
    obs = getattr(app.state, "observability", None)
    snap = obs.snapshot() if obs is not None else {"commands": [], "latencies": [], "errors": []}
    cfg = getattr(app.state, "config", None)
    registry = getattr(app.state, "registry", None)
    robot_ids = list(cfg.robot_ids) if cfg is not None else []
    robots = []
    for rid in robot_ids:
        if registry is not None:
            try:
                robots.append(registry.get_status(rid))
            except Exception:  # noqa: BLE001
                robots.append({"robot_id": rid, "presence": "unknown"})
        else:
            robots.append({"robot_id": rid, "presence": "unknown"})
    snap["robots"] = robots
    return snap
```
If you used the Step 1a stub, add its imports (`Depends`, `Request`) — they are already imported in the stub. If Phase 3's `admin.py` did not import `Depends`, add `from fastapi import Depends` at the top.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_admin_health.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Write the Health tab front-end `static/admin/health.js`**

`agent_service/static/admin/health.js`:
```javascript
// Admin Health tab: polls /admin/api/health and renders the four panels.
// Self-mounting so it works whether Phase 3's admin shell pre-creates #tab-health
// or not: it finds (or creates) its container and a nav button labelled "Health".
(() => {
  "use strict";

  function ensurePanel() {
    let panel = document.getElementById("tab-health");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "tab-health";
      document.body.appendChild(panel);
    }
    return panel;
  }

  function fmtAge(iso) {
    if (!iso) return "—";
    const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    return secs < 90 ? secs + "s ago" : Math.round(secs / 60) + "m ago";
  }

  function render(panel, data) {
    const robots = (data.robots || []).map((r) => {
      const last = r.last_status || {};
      return `<tr><td>${r.robot_id}</td><td>${r.presence || "?"}</td>
        <td>${fmtAge(last.ts || last.heartbeat_ts)}</td>
        <td>${last.battery != null ? Math.round(last.battery) + "%" : "—"}</td></tr>`;
    }).join("");
    const cmds = (data.commands || []).map((c) =>
      `<tr><td>${c.cmd_id.slice(0, 8)}</td><td>${c.robot_id}</td>
        <td>${(c.states || []).join("→")}</td><td>${c.total_ms}ms</td>
        <td>${c.gates ? JSON.stringify(c.gates) : "—"}</td>
        <td>${c.simulated ? "sim" : "real"}</td></tr>`).join("");
    const lat = (data.latencies || []).slice(0, 10).map((l) =>
      `<tr><td>${(l.turn_id || "").slice(0, 8)}</td><td>${l.bedrock_ms}ms</td>
        <td>${l.session_id || "—"}</td></tr>`).join("");
    const errs = (data.errors || []).slice(0, 10).map((e) =>
      `<tr><td>${e.where}</td><td>${e.message}</td><td>${fmtAge(e.ts)}</td></tr>`).join("");

    panel.innerHTML = `
      <h2>Robot presence</h2>
      <table><thead><tr><th>robot</th><th>presence</th><th>last heartbeat</th><th>battery</th></tr></thead>
        <tbody>${robots || '<tr><td colspan="4">no robots</td></tr>'}</tbody></table>
      <h2>Last 10 commands</h2>
      <table><thead><tr><th>cmd</th><th>robot</th><th>acks</th><th>rtt</th><th>gates</th><th>mode</th></tr></thead>
        <tbody>${cmds || '<tr><td colspan="6">none yet</td></tr>'}</tbody></table>
      <h2>Bedrock latency (per turn)</h2>
      <table><thead><tr><th>turn</th><th>latency</th><th>session</th></tr></thead>
        <tbody>${lat || '<tr><td colspan="3">none yet</td></tr>'}</tbody></table>
      <h2>Errors</h2>
      <table><thead><tr><th>where</th><th>message</th><th>when</th></tr></thead>
        <tbody>${errs || '<tr><td colspan="3">none</td></tr>'}</tbody></table>`;
  }

  async function poll() {
    const panel = ensurePanel();
    try {
      const r = await fetch("/admin/api/health", { credentials: "same-origin" });
      if (!r.ok) { panel.textContent = "health unavailable (admin login required)"; return; }
      render(panel, await r.json());
    } catch (e) {
      panel.textContent = "health error: " + e.message;
    }
  }

  poll();
  setInterval(poll, 3000);
})();
```
Wire it into the Phase-3 admin page: add a nav button and include the script. In Phase 3's admin HTML (commonly `agent_service/static/admin/index.html`), add inside the tab nav:
```html
<button data-tab="health">Health</button>
```
and before `</body>`:
```html
<script src="/admin/static/health.js"></script>
```
If Phase 3 serves admin static from a different path than `/admin/static/`, adjust the `src` and the `fetch("/admin/api/health")` base to match Phase 3's mount. (The route path `/admin/api/health` is fixed by `router`'s `prefix="/admin"`.)

- [ ] **Step 6: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/admin.py agent_service/static/admin/health.js agent_service/tests/test_admin_health.py agent_service/guidemate_agent/app.py
git commit -m "Kalhar: admin Health tab - commands/heartbeat/Bedrock-latency/errors"
```

---

## Task 7: Live Polly↔Transcribe loopback + Playwright fake-mic e2e

**Files:**
- Create: `agent_service/tests/integration/test_speech_loopback.py`
- Create: `agent_service/tests/e2e/__init__.py`, `agent_service/tests/e2e/test_voice_e2e.py`

**Interfaces:**
- Consumes: `synthesize_pcm16`, `pcm16_to_wav`, `TranscribeSession` (Task 2); the running FastAPI app + `/ws/chat` (Task 4) + chat UI (Task 5).
- Produces: (a) a `GUIDEMATE_LIVE`-gated loopback proving Polly→Transcribe actually transcribes "wiggle"; (b) a `GUIDEMATE_FAKE_ROBOT`-gated Playwright test that drives the real page with a Chrome fake mic and asserts transcript + reply + synced emote + audio.

**Dependency:** the Playwright e2e reaches the chat surface directly at `/` (virtual path). Phase 4's intake screen may gate `/` behind a name/comfort form — if so, the test's `_reach_chat(page)` helper (Step 3) must click through intake first; a TODO marks that seam. The loopback half (Step 1) is fully Phase-5-standalone.

- [ ] **Step 1: Write the live Polly→Transcribe loopback test**

`agent_service/tests/integration/test_speech_loopback.py`:
```python
import asyncio

import pytest

from guidemate_agent.speech import TranscribeSession, synthesize_pcm16


@pytest.mark.live
def test_polly_to_transcribe_loopback():
    """Polly synthesizes 'do a happy wiggle' as 16k PCM, feed it through the Transcribe
    stream, and assert the transcript comes back containing 'wiggle'."""
    pcm = synthesize_pcm16("do a happy wiggle", sample_rate=16000)
    assert len(pcm) > 0

    async def _run() -> str:
        session = TranscribeSession(region="us-west-2", sample_rate=16000)
        await session.start()
        # Feed in ~100 ms chunks (3200 bytes = 1600 samples @ 16k) with small gaps,
        # so Transcribe treats it like a live stream.
        chunk = 3200
        for i in range(0, len(pcm), chunk):
            await session.feed(pcm[i:i + chunk])
            await asyncio.sleep(0.02)
        return await session.finish()

    transcript = asyncio.run(_run())
    assert "wiggle" in transcript.lower(), f"got: {transcript!r}"
```

- [ ] **Step 2: Run the loopback test (gated)**

Run: `cd ~/cs7980-guide-mate && GUIDEMATE_LIVE=1 .venv/bin/python -m pytest agent_service/tests/integration/test_speech_loopback.py -q`
Expected: PASS (1 passed) — a real Polly synth + real Transcribe stream round-trip whose transcript contains "wiggle". (Skipped by default without `GUIDEMATE_LIVE=1`.)

- [ ] **Step 3: Write the Playwright fake-mic e2e**

`agent_service/tests/e2e/__init__.py` — empty file.

`agent_service/tests/e2e/test_voice_e2e.py`:
```python
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

from guidemate_agent.speech import pcm16_to_wav, synthesize_pcm16

pytestmark = pytest.mark.skipif(
    os.environ.get("GUIDEMATE_FAKE_ROBOT") != "1",
    reason="set GUIDEMATE_FAKE_ROBOT=1 (and have Chrome + a display) to run",
)


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _make_fake_mic_wav() -> str:
    """Polly 'do a happy wiggle' -> 16k PCM -> WAV file for Chrome's fake audio capture."""
    pcm = synthesize_pcm16("do a happy wiggle", sample_rate=16000)
    wav = pcm16_to_wav(pcm, sample_rate=16000)
    path = os.path.join(tempfile.mkdtemp(), "fake-mic.wav")
    with open(path, "wb") as f:
        f.write(wav)
    return path


def _reach_chat(page):
    # TODO(Phase 4): if intake gates '/', fill name + comfort answer and submit here.
    page.wait_for_selector("#chat-form", timeout=10000)


def test_voice_in_transcript_reply_emote_audio():
    from playwright.sync_api import sync_playwright

    port = _free_port()
    endpoint = subprocess.check_output(
        ["aws", "iot", "describe-endpoint", "--endpoint-type", "iot:Data-ATS",
         "--query", "endpointAddress", "--output", "text"], text=True).strip()
    env = dict(os.environ)
    env["GUIDEMATE_IOT_ENDPOINT"] = endpoint
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "guidemate_agent.app:app",
         "--app-dir", "agent_service", "--port", str(port)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    wav = _make_fake_mic_wav()
    try:
        # Wait for /healthz.
        for _ in range(30):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1)
                break
            except Exception:  # noqa: BLE001
                time.sleep(1)

        with sync_playwright() as p:
            browser = p.chromium.launch(args=[
                "--use-fake-device-for-media-stream",
                "--use-fake-ui-for-media-stream",
                f"--use-file-for-fake-audio-capture={wav}",
                "--autoplay-policy=no-user-gesture-required",
            ])
            page = browser.new_page()
            page.goto(f"http://127.0.0.1:{port}/")
            _reach_chat(page)

            page.click("#mic")            # start recording (streams the wav)
            page.wait_for_timeout(3500)   # let the ~2 s clip play through
            page.click("#mic")            # stop -> triggers transcript + reply

            # Transcript bubble carries the spoken words.
            page.wait_for_selector("text=wiggle", timeout=15000)
            # A dog reply bubble with an emote tag appears.
            page.wait_for_selector(".bubble.dog .emote-tag", timeout=15000)
            # Audio element received a source (Polly reply).
            page.wait_for_function("document.getElementById('player').src.length > 0",
                                   timeout=15000)
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
```

- [ ] **Step 4: Run the e2e (gated; needs Chrome + a display + Phase 4 intake reachable)**

Run: `cd ~/cs7980-guide-mate && GUIDEMATE_FAKE_ROBOT=1 GUIDEMATE_LIVE=1 .venv/bin/python -m pytest agent_service/tests/e2e/test_voice_e2e.py -q`
Expected: PASS (1 passed) — the fake mic speaks "do a happy wiggle", the page shows a transcript containing "wiggle", a dog reply bubble with an emote tag, and the audio player gets a source. If Playwright's browser is missing, install once: `.venv/bin/python -m playwright install chromium`. If `/` is gated by Phase 4 intake, fill in `_reach_chat` per the TODO.

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/tests/integration/test_speech_loopback.py agent_service/tests/e2e/__init__.py agent_service/tests/e2e/test_voice_e2e.py
git commit -m "Kalhar: live Polly<->Transcribe loopback + Playwright fake-mic voice e2e"
```

---

## Phase 5 exit checklist (verify before declaring done)

- [ ] **Unit suite green:** `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests -q` — `test_emote_sync`, `test_speech`, `test_observability`, `test_ws_chat`, `test_admin_health` all pass; integration/live/e2e skipped by default.
- [ ] **Emote-sync order-independence proven** by `test_emote_sync.py` (`done`-before-`running`, `done`-without-`running`, and the empty-list 2.0 s timeout fallback all covered).
- [ ] **Voice loopback (live):** `GUIDEMATE_LIVE=1 pytest agent_service/tests/integration/test_speech_loopback.py` — Polly→Transcribe transcript contains "wiggle".
- [ ] **UI smoke (virtual):** uvicorn + browser — "do a happy wiggle" yields a reply bubble with `emote: happy`, the avatar wiggles, mp3 plays, chip shows `virtual`.
- [ ] **Playwright fake-mic e2e (after Phase 4 intake reachable):** `GUIDEMATE_FAKE_ROBOT=1 GUIDEMATE_LIVE=1 pytest agent_service/tests/e2e/test_voice_e2e.py` — speak → transcript → reply + synced emote + audio.
- [ ] **Admin Health tab:** with `GUIDEMATE_ADMIN_PASSWORD` set and the admin cookie present, `/admin/api/health` returns last-10 commands (with ack states, rtt, gates), robot presence/heartbeat, per-turn Bedrock latency, and errors; the Health tab renders them.
- [ ] **No motion, no new AWS resources, robot 468 untouched:** emotes are dry-run simulated acks only; the shadow is not modified; Phase 5 created zero AWS resources (only *calls* Transcribe/Polly).
- [ ] **Phase-4 seams documented:** the WS layer reads `app.state.robot_target_resolver` (virtual-only default installed in `app.py`); the UI reads `/api/session/{id}/state` + `/request-companion` and degrades gracefully. Phase 4 wires these; nothing else in Phase 5 depends on Phase 4 internals.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-05-dog-agent-phase-5.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
</content>
</invoke>
