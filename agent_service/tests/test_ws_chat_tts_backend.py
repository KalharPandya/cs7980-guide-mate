"""Task 5 wiring: ws_chat._tts_kwargs maps Config -> synthesize_mp3 backend kwargs.

Kept in its own file (not test_ws_chat.py) to avoid colliding with other work in
the shared tree. The STT factory branch is already covered by
test_speech_stt_eleven.py::test_factory_picks_backend."""
from types import SimpleNamespace

from guidemate_agent.ws_chat import _tts_kwargs


def test_tts_kwargs_defaults_to_polly():
    # An empty config (no attrs) must degrade to the Polly defaults, never raise.
    kw = _tts_kwargs(SimpleNamespace())
    assert kw == {"backend": "polly", "el_voice_id": "", "el_model": "eleven_flash_v2_5"}


def test_tts_kwargs_reads_elevenlabs_config():
    cfg = SimpleNamespace(
        tts_backend="elevenlabs",
        elevenlabs_voice_id="vBKc2FfBKJfcZNyEt1n6",
        elevenlabs_tts_model="eleven_flash_v2_5",
    )
    kw = _tts_kwargs(cfg)
    assert kw["backend"] == "elevenlabs"
    assert kw["el_voice_id"] == "vBKc2FfBKJfcZNyEt1n6"
    assert kw["el_model"] == "eleven_flash_v2_5"
