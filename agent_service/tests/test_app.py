from fastapi.testclient import TestClient

from guidemate_agent.config import Config
from guidemate_agent.dog_agent import PERSONA


def test_config_defaults(monkeypatch):
    for var in ("GUIDEMATE_ROBOTS", "GUIDEMATE_IOT_ENDPOINT", "GUIDEMATE_MODEL_ID", "AWS_REGION"):
        monkeypatch.delenv(var, raising=False)
    cfg = Config.from_env()
    assert cfg.robot_ids == ["turtlebot468"]
    assert cfg.model_id == "us.anthropic.claude-sonnet-4-6"
    assert cfg.region == "us-west-2"


def test_config_parses_multiple_robots(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ROBOTS", "turtlebot468, turtlebotsim")
    assert Config.from_env().robot_ids == ["turtlebot468", "turtlebotsim"]


def test_persona_mentions_robert_and_emote_rule():
    assert "Robert" in PERSONA
    assert "send_emote" in PERSONA


def _no_connect(monkeypatch):
    # Lifespan tolerates connect failure; force it to fail fast (no real DNS/MQTT).
    monkeypatch.setenv("GUIDEMATE_IOT_ENDPOINT", "invalid.example.com")
    import guidemate_agent.app as appmod

    def _boom(self):
        raise RuntimeError("no MQTT in unit test")

    monkeypatch.setattr(appmod.RobotRegistry, "connect", _boom)
    return appmod.app


def test_healthz(monkeypatch):
    app = _no_connect(monkeypatch)
    with TestClient(app) as client:
        resp = client.get("/healthz")
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}


def test_index_served(monkeypatch):
    app = _no_connect(monkeypatch)
    with TestClient(app) as client:
        resp = client.get("/")
        assert resp.status_code == 200
        assert "Robert" in resp.text
