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


# ---------------------------------------------------------------------------
# Phase 8 Task 3: executor real-drive path + dock/undock action dispatch +
# abort/kill-switch + command-aware motion gate. These construct the runner
# WITHOUT a SafetyState (the v8 signature: dry_run/motion_gate/run_action);
# the Phase-2 safety-based path above is preserved unchanged.
# ---------------------------------------------------------------------------
import threading  # noqa: E402,F401

from guidemate_msgs.choreography import TwistStep  # noqa: E402


def _real_runner(acks, published, sleep=lambda _s: None, motion_gate=None, run_action=None):
    return ChoreographyRunner(
        publish_ack=acks.append,
        dry_run=False,
        publish_twist=published.append,
        publish_hz=10.0,
        sleep=sleep,
        motion_gate=motion_gate,
        run_action=run_action,
    )


def _cmd_action(name):
    # Phase 4 (PINNED) adds "undock"/"dock" to _MOTION_NAMES. model_construct keeps
    # these unit tests runnable even if Phase 8 executes before that schema change lands.
    try:
        return Command(type="motion", name=name)
    except Exception:
        return Command.model_construct(
            cmd_id=f"test-{name}", type="motion", name=name, params={}, ts="t"
        )


def test_real_drive_publishes_at_rate_then_zeroes():
    acks, published = [], []
    # spin = one TwistStep; with publish_hz=10 a ~6.98s step -> ~70 publishes + 1 zero.
    _real_runner(acks, published).handle(Command(type="motion", name="spin"))
    assert [a.state for a in acks] == ["received", "running", "done"]
    assert acks[-1].simulated is False
    # last publish must be the zero-twist safety stop.
    assert published[-1] == TwistStep(0.0, 0.0, 0.0)
    assert len(published) > 10  # many in-motion publishes, not one-per-step


def test_abort_mid_step_zeroes_and_acks_failed():
    acks, published = [], []
    runner = _real_runner(acks, published)

    # Abort after the 3rd in-motion publish, from another thread, via the sleep hook.
    calls = {"n": 0}
    def sleeper(_s):
        calls["n"] += 1
        if calls["n"] == 3:
            runner.abort(reason="stopped")
    runner._sleep = sleeper

    runner.handle(Command(type="motion", name="circle"))
    assert [a.state for a in acks] == ["received", "running", "failed"]
    assert acks[-1].reason == "stopped"
    assert published[-1] == TwistStep(0.0, 0.0, 0.0)      # wheels zeroed on abort
    assert len(published) < 5                             # broke out early


def test_motion_gate_refusal_reason_propagates():
    acks, published = [], []
    runner = _real_runner(acks, published, motion_gate=lambda cmd: (False, "docked"))
    runner.handle(Command(type="emote", name="happy"))
    assert [a.state for a in acks] == ["received", "running", "failed"]
    assert acks[-1].reason == "docked"
    # Only the safety zero-twist may be published; no choreography motion.
    assert published == [TwistStep(0.0, 0.0, 0.0)]


def test_abort_does_not_persist_across_commands():
    acks, published = [], []
    runner = _real_runner(acks, published)
    runner.abort(reason="stopped")            # fire before any command
    runner.handle(Command(type="emote", name="yes"))
    # handle() clears the stale abort after 'running', so this command completes.
    assert acks[-1].state == "done"


def test_no_sink_when_not_dry_run_acks_failed():
    acks = []
    ChoreographyRunner(publish_ack=acks.append, dry_run=False, publish_twist=None).handle(
        Command(type="emote", name="happy")
    )
    assert [a.state for a in acks] == ["received", "running", "failed"]
    assert acks[-1].reason == "no cmd_vel sink"


# ---- dock/undock are Create 3 ROS ACTIONS, never twist choreographies ----
def test_undock_dry_run_logs_action_never_calls_client(caplog):
    import logging

    acks, calls = [], []
    runner = ChoreographyRunner(
        publish_ack=acks.append,
        dry_run=True,
        run_action=lambda name: (calls.append(name), (True, ""))[1],
    )
    with caplog.at_level(logging.INFO, logger="guide_mate_bridge.executor"):
        runner.handle(_cmd_action("undock"))
    assert [a.state for a in acks] == ["received", "running", "done"]
    assert acks[-1].simulated is True
    assert calls == []                      # dry-run NEVER touches the action client
    assert any(r.getMessage().startswith("DRY-RUN action undock") for r in caplog.records)


def test_undock_real_runs_action_not_twists():
    acks, published, calls = [], [], []
    runner = _real_runner(
        acks, published, run_action=lambda name: (calls.append(name), (True, ""))[1]
    )
    runner.handle(_cmd_action("undock"))
    assert calls == ["undock"]
    assert published == []                  # actions never publish cmd_vel
    assert acks[-1].state == "done" and acks[-1].simulated is False


def test_dock_action_failure_acks_failed():
    acks, published = [], []
    runner = _real_runner(acks, published, run_action=lambda name: (False, "dock server unavailable"))
    runner.handle(_cmd_action("dock"))
    assert acks[-1].state == "failed"
    assert acks[-1].reason == "dock server unavailable"


def test_action_without_client_acks_failed():
    acks, published = [], []
    runner = _real_runner(acks, published, run_action=None)
    runner.handle(_cmd_action("undock"))
    assert acks[-1].state == "failed"
    assert acks[-1].reason == "no action client"


def test_gate_consulted_for_actions_too():
    # Shadow lock is supreme: even undock is refused when the gate says motion_disabled.
    acks, published, calls = [], [], []
    runner = _real_runner(
        acks, published,
        motion_gate=lambda cmd: (False, "motion_disabled"),
        run_action=lambda name: (calls.append(name), (True, ""))[1],
    )
    runner.handle(_cmd_action("undock"))
    assert acks[-1].state == "failed" and acks[-1].reason == "motion_disabled"
    assert calls == []
    assert published == [TwistStep(0.0, 0.0, 0.0)]
