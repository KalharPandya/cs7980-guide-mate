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


def test_fake_robot_registry_status_and_acks():
    from guidemate_agent.fakes import FakeRobotRegistry

    reg = FakeRobotRegistry(["turtlebot468"])
    reg.connect()
    st = reg.get_status("turtlebot468")
    assert st["robot_id"] == "turtlebot468"
    assert st["presence"] == "online"
    from guidemate_msgs.messages import Command

    acks = reg.send_command("turtlebot468", Command(type="emote", name="happy"))
    assert [a.state for a in acks] == ["received", "running", "done"]
    assert acks[-1].simulated is True


def test_admin_ui_served_and_router_mounted(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_FAKE_ROBOT", "1")
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "secret")
    import importlib

    import guidemate_agent.app as appmod

    importlib.reload(appmod)
    try:
        with TestClient(appmod.app) as client:
            # admin static page
            page = client.get("/admin/")
            assert page.status_code == 200
            assert "Admin" in page.text
            # admin API mounted (401 without a cookie, NOT 404)
            assert client.get("/api/admin/flags").status_code == 401
    finally:
        monkeypatch.delenv("GUIDEMATE_FAKE_ROBOT", raising=False)
        monkeypatch.delenv("GUIDEMATE_ADMIN_PASSWORD", raising=False)
        importlib.reload(appmod)
