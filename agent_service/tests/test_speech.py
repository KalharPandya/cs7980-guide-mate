import array
import asyncio
import io
import os
import time
import wave

import pytest

from guidemate_agent.speech import (
    TranscribeSession,
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


@pytest.mark.skipif(
    os.environ.get("GUIDEMATE_LIVE") != "1",
    reason="live AWS loopback: set GUIDEMATE_LIVE=1",
)
def test_live_polly_to_transcribe_loopback():
    """Polly synthesize -> Transcribe streaming -> assert recognized text.

    Real AWS round trip. Records end-to-end latency.
    """
    phrase = "the quick brown fox jumps over the lazy dog"
    sample_rate = 16000

    t0 = time.monotonic()
    pcm = synthesize_pcm16(phrase, sample_rate=sample_rate)
    t_polly = time.monotonic()
    assert len(pcm) > 0

    async def _run():
        session = TranscribeSession(sample_rate=sample_rate)
        await session.start()
        chunk = sample_rate * 2 // 10  # ~100 ms of 16-bit PCM
        for off in range(0, len(pcm), chunk):
            await session.feed(pcm[off:off + chunk])
            await asyncio.sleep(0.01)
        return await session.finish()

    transcript = asyncio.run(_run())
    t_end = time.monotonic()

    print(
        f"\n[live] polly={t_polly - t0:.2f}s transcribe={t_end - t_polly:.2f}s "
        f"total={t_end - t0:.2f}s transcript={transcript!r}"
    )
    low = transcript.lower()
    # Transcribe should recover the salient content words.
    assert "fox" in low
    assert "dog" in low
