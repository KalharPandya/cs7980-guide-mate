"""Config.from_env() registry defaults (Phase 8 Task 7 -- virtual-pet grant).

The sim (turtlebotsim) must be grantable out of the box alongside the physical
turtlebot468, without breaking the env override that pins a single robot.
"""
from guidemate_agent.config import Config


def test_default_registry_includes_virtual_pet(monkeypatch):
    monkeypatch.delenv("GUIDEMATE_ROBOTS", raising=False)
    cfg = Config.from_env()
    assert "turtlebot468" in cfg.robot_ids
    assert "turtlebotsim" in cfg.robot_ids     # virtual pet available out of the box


def test_env_override_still_wins(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ROBOTS", "turtlebot468")
    assert Config.from_env().robot_ids == ["turtlebot468"]


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
