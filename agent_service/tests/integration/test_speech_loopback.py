"""Live Polly -> Transcribe loopback (gated ``GUIDEMATE_LIVE=1``).

This is a real-AWS speech round trip (Polly synth -> Amazon Transcribe
streaming), not an IoT round-trip (the ``integration`` marker's usual meaning)
and not a Bedrock model call (the ``live`` marker's usual meaning) -- but it
has the same "costs money / needs real creds, opt-in only" shape as the
``live`` marker's existing use, so it reuses that gate rather than inventing
a fourth marker. See ``pytest.ini`` for the marker registry (this file still
lives under ``tests/integration/`` per the Phase-5 Task-7 brief, but is
collected + skipped via the ``live`` marker/env-var, same as
``tests/test_speech.py::test_live_polly_to_transcribe_loopback`` -- that
pre-existing test used an ad hoc ``skipif`` rather than the marker; this one
follows the repo's marker convention instead and exercises a different
phrase ("wiggle", matching the ws-chat emote vocabulary) end to end.
"""
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
