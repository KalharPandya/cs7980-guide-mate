"""Speech backend: Amazon Transcribe streaming (STT) + Polly neural (TTS) + a pure
16-bit-PCM linear resampler. Assumes signed 16-bit little-endian mono (host is x86)."""
from __future__ import annotations

import array
import asyncio
import io
import logging
import wave

import boto3
from amazon_transcribe.client import TranscribeStreamingClient
from amazon_transcribe.handlers import TranscriptResultStreamHandler

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
    if backend == "elevenlabs" and el_client is not None:
        if sample_rate != 16000:
            log.debug(
                "elevenlabs pcm supports only 16000 Hz; using polly for %d Hz", sample_rate
            )
        else:
            try:
                return _eleven_convert(text, "pcm_16000", el_client, el_voice_id, el_model)
            except Exception:  # noqa: BLE001 — fall back to Polly
                log.exception("elevenlabs pcm synthesis failed; falling back to polly")
    client = polly_client or boto3.client("polly", region_name=region)
    resp = client.synthesize_speech(
        Text=text,
        OutputFormat="pcm",
        VoiceId=voice_id,
        Engine="neural",
        SampleRate=str(sample_rate),
    )
    return resp["AudioStream"].read()


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


def _eleven_scribe_connect(api_key: str):
    """Build an async connect_fn that opens a Scribe v2 realtime websocket and
    adapts it to the {send_audio, events, commit, close} protocol used above.

    SDK surface (verified 2026-07-08, elevenlabs package on this venv):
    - ScribeRealtime.connect(options: RealtimeAudioOptions) -> RealtimeConnection
    - RealtimeAudioOptions is a TypedDict (bases: dict); required keys:
        model_id, audio_format (AudioFormat enum), sample_rate (int)
    - RealtimeConnection is callback-based (.on(event_str, callable)),
        NOT async-iterable; .send({"audio_base_64": b64}), .commit(), .close() are
        all async methods. Events arrive via _start_message_handler background task.
    - To bridge callback-style to the async-generator protocol expected by _consume(),
      we queue events into an asyncio.Queue and drain it via an async generator.
    - Event data key for transcript text is "text" (the SDK docstring says
        "transcript", but the live server sends "text" — verified against the API
        2026-07-08); message_type values are "committed_transcript" / "partial_transcript".
    - Live-validated 2026-07-08: "do a happy wiggle" -> committed "Do a happy wiggle."
    """
    async def _connect(model_id: str, sample_rate: int):
        from elevenlabs import ElevenLabs
        from elevenlabs.realtime.scribe import AudioFormat, CommitStrategy, RealtimeAudioOptions

        client = ElevenLabs(api_key=api_key)

        options: RealtimeAudioOptions = {
            "model_id": model_id,
            "audio_format": AudioFormat.PCM_16000,
            "sample_rate": sample_rate,
            "commit_strategy": CommitStrategy.MANUAL,
        }
        raw = await client.speech_to_text.realtime.connect(options)

        # Bridge callback-based event system to async-generator protocol.
        _queue: asyncio.Queue = asyncio.Queue()
        _SENTINEL = object()

        def _on_partial(data):
            _queue.put_nowait({
                "type": "partial_transcript",
                "text": data.get("text") or data.get("transcript", ""),
            })

        def _on_committed(data):
            _queue.put_nowait({
                "type": "committed_transcript",
                "text": data.get("text") or data.get("transcript", ""),
            })

        def _on_close():
            _queue.put_nowait(_SENTINEL)

        def _on_error(data):
            log.warning("elevenlabs scribe error: %s", data)
            _queue.put_nowait(_SENTINEL)

        raw.on("partial_transcript", _on_partial)
        raw.on("committed_transcript", _on_committed)
        raw.on("close", _on_close)
        raw.on("error", _on_error)

        class _Adapter:
            async def send_audio(self, b64: str) -> None:
                # RealtimeConnection.send() wraps the message internally.
                await raw.send({"audio_base_64": b64})

            async def events(self):
                while True:
                    item = await _queue.get()
                    if item is _SENTINEL:
                        return
                    yield item

            async def commit(self) -> None:
                await raw.commit()

            async def close(self) -> None:
                await raw.close()

        return _Adapter()

    return _connect
