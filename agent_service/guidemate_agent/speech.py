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
