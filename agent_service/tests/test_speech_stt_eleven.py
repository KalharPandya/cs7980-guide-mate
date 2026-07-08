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
