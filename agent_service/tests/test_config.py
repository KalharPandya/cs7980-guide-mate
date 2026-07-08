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
