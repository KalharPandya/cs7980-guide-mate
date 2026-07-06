import logging

from guidemate_msgs.messages import Command

from guide_mate_bridge.executor import ChoreographyRunner
from guide_mate_bridge.safety import SafetyState


def _unlocked_state(docked=False):
    """A state with every gate open — only reachable in tests/sim, never on robot 468."""
    s = SafetyState(env_dry_run=False)
    s.apply_shadow({"dry_run": False, "motion_enabled": True})
    s.set_docked(docked)
    return s


def _runner(acks, safety=None):
    return ChoreographyRunner(publish_ack=acks.append, safety=safety or SafetyState())


def test_happy_path_ack_sequence_dry_run():
    acks = []
    _runner(acks).handle(Command(type="emote", name="happy"))
    assert [a.state for a in acks] == ["received", "running", "done"]
    # Phase-2 fix: ALL acks carry simulated + gates, not just the terminal one.
    for a in acks:
        assert a.simulated is True
        assert a.gates == {"docked": None, "motion_enabled": False, "dry_run": True}


def test_invalid_choreography_acks_failed():
    # Bypass Command validation to reach the executor's build() error path.
    cmd = Command.model_construct(
        cmd_id="x", type="emote", name="moonwalk", params={}, ts="t"
    )
    acks = []
    _runner(acks).handle(cmd)
    assert [a.state for a in acks] == ["received", "failed"]
    assert acks[-1].reason and "moonwalk" in acks[-1].reason


def test_dry_run_logs_twist_lines(caplog):
    acks = []
    with caplog.at_level(logging.INFO, logger="guide_mate_bridge.executor"):
        _runner(acks).handle(Command(type="motion", name="spin"))
    dry_lines = [r for r in caplog.records if r.getMessage().startswith("DRY-RUN twist")]
    assert len(dry_lines) == 1  # spin is a single step


def test_dry_run_never_publishes_twist():
    published = []
    runner = ChoreographyRunner(
        publish_ack=lambda a: None,
        safety=SafetyState(),
        publish_twist=published.append,
    )
    runner.handle(Command(type="emote", name="yes"))
    assert published == []


def test_not_dry_run_docked_refused():
    acks = []
    _runner(acks, _unlocked_state(docked=True)).handle(Command(type="motion", name="spin"))
    assert [a.state for a in acks] == ["received", "failed"]
    assert acks[-1].reason == "docked"
    assert acks[-1].simulated is False
    assert acks[-1].gates["docked"] is True


def test_not_dry_run_unknown_dock_refused_default_deny():
    s = SafetyState(env_dry_run=False)
    s.apply_shadow({"dry_run": False, "motion_enabled": True})
    # docked never reported -> None -> counts as docked (default-deny)
    acks = []
    _runner(acks, s).handle(Command(type="emote", name="happy"))
    assert acks[-1].state == "failed"
    assert acks[-1].reason == "docked"


def test_not_dry_run_motion_disabled_refused():
    s = SafetyState(env_dry_run=False)
    s.apply_shadow({"dry_run": False})  # motion_enabled stays False
    s.set_docked(False)
    acks = []
    _runner(acks, s).handle(Command(type="motion", name="circle"))
    assert [a.state for a in acks] == ["received", "failed"]
    assert acks[-1].reason == "motion_disabled"


def test_stop_always_accepted_even_when_fully_locked():
    s = SafetyState(env_dry_run=False)
    s.apply_shadow({"dry_run": False})  # motion disabled, dock unknown
    acks = []
    _runner(acks, s).handle(Command(type="stop", name="stop"))
    assert [a.state for a in acks] == ["received", "running", "done"]


def test_env_dry_run_wins_over_shadow():
    s = SafetyState(env_dry_run=True)
    s.apply_shadow({"dry_run": False, "motion_enabled": True})
    s.set_docked(True)  # docked would refuse if not dry-run — but env dry-run wins
    acks = []
    _runner(acks, s).handle(Command(type="emote", name="yes"))
    assert acks[-1].state == "done"
    assert acks[-1].simulated is True
    assert acks[-1].gates["dry_run"] is True
