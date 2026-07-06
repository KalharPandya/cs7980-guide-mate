# Dog Agent POC — Phase 2 "Robot Truth" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the robot audible and safety-truthful — 30 s heartbeats (battery/dock/uptime/gates) on the status topic, Device Shadow reconcile with default-deny locking, refusal paths for blocked commands, graceful shutdown, and cloud tools (`run_motion`/`stop`/`get_status`) — proving spec no-motion checklist items **2, 4, 5** with the robot docked and motion-locked throughout.

**Architecture:** The bridge gains a thread-safe `SafetyState` (single source of gate truth: docked / motion_enabled / effective dry_run / max_speed) fed by two new layers: `ShadowSync` (classic shadow topics over the EXISTING `IotClient` mTLS connection — no extra SDK layer) and an optional `Telemetry` rclpy node (battery + dock, degrades to nulls). Every ack now carries `simulated` + a `gates` snapshot; a `HeartbeatPublisher` closes the "can't hear the robot" gap. The cloud `RobotRegistry` parses heartbeats/gates into per-robot state and `DogAgent` gains the three robot-truth tools. **No `cmd_vel` publisher exists in this phase** — `publish_twist` stays `None` (wired only in Phase 8 sim), so even `motion_enabled=true` cannot move anything.

**Tech Stack:** Python 3.10, pydantic v2, awsiotsdk (awscrt MQTT + classic shadow topics), rclpy (optional, Pi only; sensor_msgs / irobot_create_msgs), strands-agents, FastAPI, pytest.

## Global Constraints

Every task's requirements implicitly include this section (carried verbatim from the Phase 0-1 plan, plus Phase 2 specifics).

- **Python 3.10-compatible** on both machines — no 3.11+ syntax. `list[...]`/`dict[...]` generics are fine with `from __future__ import annotations`.
- **pydantic v2** (`>=2`); use `model_validate_json` / `model_dump_json` / `model_validate` / `model_dump`.
- **TDD**: write the failing test first, run it red, implement the minimum, run it green, then commit — every task.
- **Commit after every task** with a `Kalhar:` message prefix. **NEVER** add any Claude/AI/co-author line or `Co-Authored-By`. Do not push (the user pushes).
- **Never `pkill -f`** anything on the Pi (gotcha #6). This plan restarts only our own `guidemate-bridge.service` via systemctl.
- **Robot 468 stays docked and motion-locked.** The installer/unit keeps `GUIDEMATE_DRY_RUN=1` on the real robot. **SAFETY INVARIANT (this phase): the shadow can only make things STRICTER on the real robot** — the bridge's effective dry_run = (env `GUIDEMATE_DRY_RUN` truthy) **OR** (shadow `dry_run`), i.e. env=1 keeps dry-run regardless of what the shadow says. `motion_enabled` from the shadow is stored + enforced + reported, but no `cmd_vel` publisher exists in this phase, so even `motion_enabled=true` cannot move anything.
- **Shadow drill touches ONLY `desired.max_speed`** (0.15→0.10→0.15). **NEVER set `motion_enabled=true`** on robot 468's shadow — not in the drill, not anywhere.
- **No credentials or IoT endpoints committed.** Endpoint discovered at runtime via `aws iot describe-endpoint --endpoint-type iot:Data-ATS`.
- **On-Pi work over SSH is additive only** — never modify existing bringup, services, or configs; only `guidemate-bridge.service` (already ours) is touched.
- **Every new AWS resource** tagged `guidemate-poc` where supported and documented in `docs/agent-poc/access-ground-truth.md`. (This phase creates no new AWS resources — the existing `guidemate-robot-policy` already allows `$aws/things/Turtlebot-468/shadow/*`; verification results still get documented.)
- **Integration tests are env-gated** (`GUIDEMATE_INTEGRATION=1`) and skipped by default; the repo-root `conftest.py` already enforces this.
- Dev venv: repo-root `.venv` (already exists with all three packages editable). Run tests via `.venv/bin/python -m pytest`.

**Verified environment facts (do not re-derive):** AWS account `852373397000`, region `us-west-2`, identity `guidemate-agent-role` (admin) via `credential_process`, AWS CLI v2 at `~/.local/bin/aws`. SSH alias `guidemate` → Pi (`ubuntu`, passwordless sudo). Thing `Turtlebot-468`; its classic shadow exists with `desired = {motion_enabled: false, max_speed: 0.15, dry_run: true}`. `guidemate-robot-policy` (attached to the robot cert) allows `guidemate/turtlebot468/*` + `$aws/things/Turtlebot-468/shadow/*`. The dev cert's `guidemate-dev-policy` does **NOT** allow shadow topics — the bridge must tolerate shadow-topic denial (defaults locked) so the Phase-1 `devtest` integration test keeps passing. Phase 1 is deployed and green: bridge live on the Pi as `guidemate-bridge.service` (dry-run), slice check passed (~1.9 s round-trip). Known carried-forward finding: **AWS IoT QoS1 acks can arrive out of order** — `send_command` may return on `done` before `running` lands; the new `collect_all` option is groundwork for Phase 5.

---

## File Structure

```
shared/guidemate_msgs/guidemate_msgs/
│   └── messages.py                    # MODIFY (Task 1) — Ack.gates + Heartbeat model
├── tests/test_messages.py             # MODIFY (Task 1) — new schema tests
src/guide_mate_bridge/
├── guide_mate_bridge/
│   ├── __init__.py                    # MODIFY (Task 2) — BRIDGE_VERSION
│   ├── safety.py                      # NEW (Task 2) — SafetyState (gate truth)
│   ├── executor.py                    # MODIFY (Task 2) — refusals, gates, simulated on ALL acks
│   ├── bridge.py                      # MODIFY (Tasks 2,3,4) — safety wiring, shadow, SIGTERM, telemetry
│   ├── iot_client.py                  # MODIFY (Task 3) — publish delivery check + disconnect()
│   ├── shadow.py                      # NEW (Task 3) — ShadowSync (classic shadow reconcile)
│   └── telemetry.py                   # NEW (Task 4) — Telemetry (rclpy) + HeartbeatPublisher
├── tests/
│   ├── test_safety.py                 # NEW (Task 2)
│   ├── test_executor.py               # REWRITE (Task 2)
│   ├── test_bridge.py                 # MODIFY (Tasks 2,3)
│   ├── test_shadow.py                 # NEW (Task 3)
│   └── test_telemetry.py              # NEW (Task 4)
├── systemd/guidemate-bridge.service   # MODIFY (Task 6) — ROS env wrapper, new env vars
└── scripts/install_bridge_on_pi.sh    # MODIFY (Task 6) — render new tokens
agent_service/
├── guidemate_agent/
│   ├── mqtt_link.py                   # MODIFY (Task 5) — heartbeat/gates state, collect_all
│   └── dog_agent.py                   # MODIFY (Task 5) — run_motion/stop/get_status + persona
└── tests/
    ├── test_mqtt_link.py              # MODIFY (Task 5)
    ├── test_dog_agent.py              # MODIFY (Task 5)
    └── integration/test_robot_truth.py  # NEW (Task 6) — heartbeat + gates evidence vs real robot
docs/agent-poc/access-ground-truth.md  # MODIFY (Task 6) — Phase 2 verification results
```

---

## Task 1: Schema — `Ack.gates` + `Heartbeat` model

**Files:**
- Modify: `shared/guidemate_msgs/guidemate_msgs/messages.py`
- Test: `shared/guidemate_msgs/tests/test_messages.py` (append tests)

**Interfaces:**
- Consumes: existing `Ack`, `_utc_now_iso` in `messages.py`.
- Produces: `Ack` gains `gates: Optional[dict] = None` (snapshot like `{"docked": true, "motion_enabled": false, "dry_run": true}`; `None` on pre-Phase-2 acks). New model `Heartbeat(event: Literal["heartbeat"] = "heartbeat", robot_id: str, battery: Optional[float] = None, docked: Optional[bool] = None, uptime_s: float, gates: dict = {}, ts: str = <iso now>)`. Both sides (bridge Task 4, registry Task 5) rely on these exact field names.

- [ ] **Step 1: Write the failing tests**

Append to `shared/guidemate_msgs/tests/test_messages.py` (add `Heartbeat` to the existing `from guidemate_msgs.messages import (...)` block):

```python
def test_ack_gates_default_none_and_roundtrip():
    ack = Ack(cmd_id="a", state="done")
    assert ack.gates is None
    gates = {"docked": True, "motion_enabled": False, "dry_run": True}
    ack2 = Ack(cmd_id="a", state="failed", reason="docked", gates=gates)
    restored = Ack.model_validate_json(ack2.model_dump_json())
    assert restored.gates == gates


def test_heartbeat_defaults_and_roundtrip():
    hb = Heartbeat(
        robot_id="turtlebot468",
        uptime_s=12.5,
        gates={"docked": None, "motion_enabled": False, "dry_run": True},
    )
    assert hb.event == "heartbeat"
    assert hb.battery is None
    assert hb.docked is None
    assert hb.ts.endswith("+00:00")
    data = json.loads(hb.model_dump_json())
    assert data["event"] == "heartbeat"
    restored = Heartbeat.model_validate(data)
    assert restored == hb
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/cs7980/cs7980-guide-mate && .venv/bin/python -m pytest shared/guidemate_msgs/tests/test_messages.py -q`
Expected: FAIL — `ImportError: cannot import name 'Heartbeat'`.

- [ ] **Step 3: Implement the schema additions**

In `shared/guidemate_msgs/guidemate_msgs/messages.py`, replace the `Ack` class with:

```python
class Ack(BaseModel):
    cmd_id: str
    state: Literal["received", "running", "done", "failed"]
    reason: Optional[str] = None
    simulated: bool = False
    battery: Optional[float] = None
    # Gate snapshot at ack time, e.g. {"docked": true, "motion_enabled": false,
    # "dry_run": true}. None on acks from pre-Phase-2 bridges.
    gates: Optional[dict] = None
    ts: str = Field(default_factory=_utc_now_iso)
```

And add below `Ack` (before the topic helpers):

```python
class Heartbeat(BaseModel):
    """Periodic bridge liveness + robot truth: published to status_topic every 30 s."""

    event: Literal["heartbeat"] = "heartbeat"
    robot_id: str
    battery: Optional[float] = None      # Create 3 charge fraction 0..1; None if unreadable
    docked: Optional[bool] = None        # None = dock state unknown (telemetry not up)
    uptime_s: float
    gates: dict = Field(default_factory=dict)
    ts: str = Field(default_factory=_utc_now_iso)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/cs7980/cs7980-guide-mate && .venv/bin/python -m pytest shared/guidemate_msgs/tests/test_messages.py -q`
Expected: PASS (9 passed).

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980/cs7980-guide-mate
git add shared/guidemate_msgs/guidemate_msgs/messages.py shared/guidemate_msgs/tests/test_messages.py
git commit -m "Kalhar: schema - Ack.gates snapshot + Heartbeat model"
```

---

## Task 2: `SafetyState` + executor refusal paths (gates + simulated on ALL acks)

**Files:**
- Create: `src/guide_mate_bridge/guide_mate_bridge/safety.py`
- Modify: `src/guide_mate_bridge/guide_mate_bridge/__init__.py`, `src/guide_mate_bridge/guide_mate_bridge/executor.py`, `src/guide_mate_bridge/guide_mate_bridge/bridge.py` (constructor wiring only — `main()` keeps its Phase-1 shape until Task 3)
- Test: `src/guide_mate_bridge/tests/test_safety.py` (new), `src/guide_mate_bridge/tests/test_executor.py` (rewrite), `src/guide_mate_bridge/tests/test_bridge.py` (update `_bridge` helper)

**Interfaces:**
- Consumes: `Ack` with `gates` (Task 1); `build`, `MAX_LINEAR` from `guidemate_msgs.choreography`.
- Produces:
  - `class SafetyState(env_dry_run: bool = True)` — thread-safe. Defaults locked: `motion_enabled=False`, `max_speed=0.15`, shadow dry_run `True`, `docked=None` (unknown). Methods: `apply_shadow(desired: dict)` (applies `motion_enabled`/`max_speed`/`dry_run` keys; `max_speed` clamped to `[0.0, MAX_LINEAR]`; malformed values ignored), `set_docked(docked: Optional[bool])`, `gates() -> dict` (`{"docked": Optional[bool], "motion_enabled": bool, "dry_run": bool}` where `dry_run` is the EFFECTIVE value), property `effective_dry_run: bool` (= env OR shadow), property `max_speed: float`, `reported() -> dict` (shadow-reported keys: `motion_enabled`, `max_speed`, `dry_run` [effective]), `uptime_s() -> float`.
  - `ChoreographyRunner(publish_ack: Callable[[Ack], None], safety: SafetyState, publish_twist: Optional[Callable[[TwistStep], None]] = None)` — **signature change** (the `dry_run: bool` param is replaced by `safety`). `handle(cmd)`: every ack (received/running/done/failed) carries `simulated=<effective dry_run>` and `gates=<snapshot>` (fixes the Phase-1 final-review finding that only `done` carried `simulated`). Refusals when NOT effective-dry-run and `cmd.type in ("emote", "motion")`: docked (or dock unknown — default-deny) → `failed` reason `"docked"`; else not motion_enabled → `failed` reason `"motion_disabled"`. `"stop"` is always accepted. When effective-dry-run: executes simulated exactly as Phase 1 (DRY-RUN log lines, no sleep, never publishes twists).
  - `Bridge(client: IotClient, robot_id: str, safety: SafetyState)` — **signature change** (was `dry_run: bool = True`).
  - `BRIDGE_VERSION = "0.2.0"` in `guide_mate_bridge/__init__.py`.

- [ ] **Step 1: Write the failing SafetyState tests**

`src/guide_mate_bridge/tests/test_safety.py`:

```python
from guide_mate_bridge.safety import SafetyState


def test_defaults_locked():
    s = SafetyState()
    assert s.effective_dry_run is True
    assert s.max_speed == 0.15
    assert s.gates() == {"docked": None, "motion_enabled": False, "dry_run": True}


def test_apply_shadow_max_speed_clamped_to_hard_cap():
    s = SafetyState()
    s.apply_shadow({"max_speed": 5.0})
    assert s.max_speed == 0.15  # shadow can never loosen the hard cap
    s.apply_shadow({"max_speed": 0.10})
    assert s.max_speed == 0.10
    s.apply_shadow({"max_speed": "fast"})  # malformed -> ignored, keeps previous
    assert s.max_speed == 0.10
    s.apply_shadow({"max_speed": -1.0})
    assert s.max_speed == 0.0


def test_effective_dry_run_is_env_OR_shadow():
    env_on = SafetyState(env_dry_run=True)
    env_on.apply_shadow({"dry_run": False})
    assert env_on.effective_dry_run is True  # env=1 wins regardless of shadow

    env_off = SafetyState(env_dry_run=False)
    assert env_off.effective_dry_run is True  # shadow default still locks
    env_off.apply_shadow({"dry_run": False})
    assert env_off.effective_dry_run is False


def test_reported_uses_effective_dry_run():
    s = SafetyState(env_dry_run=True)
    s.apply_shadow({"dry_run": False, "motion_enabled": True, "max_speed": 0.10})
    rep = s.reported()
    assert rep == {"motion_enabled": True, "max_speed": 0.10, "dry_run": True}


def test_docked_and_uptime():
    s = SafetyState()
    s.set_docked(True)
    assert s.gates()["docked"] is True
    assert s.uptime_s() >= 0.0
```

- [ ] **Step 2: Rewrite the executor tests (refusals + gates + simulated-on-all-acks)**

Replace `src/guide_mate_bridge/tests/test_executor.py` entirely with:

```python
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ~/cs7980/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_safety.py src/guide_mate_bridge/tests/test_executor.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guide_mate_bridge.safety'`.

- [ ] **Step 4: Implement `safety.py` and bump `__init__.py`**

`src/guide_mate_bridge/guide_mate_bridge/safety.py`:

```python
"""Thread-safe safety gate truth — default-deny; the shadow can only tighten dry-run."""
from __future__ import annotations

import threading
import time
from typing import Optional

from guidemate_msgs.choreography import MAX_LINEAR


class SafetyState:
    """Single source of gate truth shared by executor, shadow sync, and telemetry.

    Defaults are LOCKED (motion_enabled=False, max_speed=MAX_LINEAR, dry_run=True,
    dock unknown). SAFETY INVARIANT: effective dry_run = env dry_run OR shadow
    dry_run — an env value of True can never be loosened by the shadow.
    """

    def __init__(self, env_dry_run: bool = True) -> None:
        self._lock = threading.Lock()
        self._env_dry_run = env_dry_run
        self._shadow_dry_run = True      # default-deny until the shadow says otherwise
        self._motion_enabled = False     # default-deny
        self._max_speed = MAX_LINEAR
        self._docked: Optional[bool] = None  # None = unknown (telemetry not reporting)
        self._started = time.monotonic()

    @property
    def effective_dry_run(self) -> bool:
        with self._lock:
            return self._env_dry_run or self._shadow_dry_run

    @property
    def max_speed(self) -> float:
        with self._lock:
            return self._max_speed

    def set_docked(self, docked: Optional[bool]) -> None:
        with self._lock:
            self._docked = docked

    def apply_shadow(self, desired: dict) -> None:
        """Apply desired shadow keys. Unknown keys ignored; malformed values ignored;
        max_speed clamped to [0.0, MAX_LINEAR] so the shadow can never exceed the cap."""
        with self._lock:
            if "motion_enabled" in desired:
                self._motion_enabled = bool(desired["motion_enabled"])
            if "max_speed" in desired:
                try:
                    self._max_speed = max(0.0, min(float(desired["max_speed"]), MAX_LINEAR))
                except (TypeError, ValueError):
                    pass  # malformed shadow value cannot change anything
            if "dry_run" in desired:
                self._shadow_dry_run = bool(desired["dry_run"])

    def gates(self) -> dict:
        """Snapshot for acks/heartbeats. dry_run here is the EFFECTIVE value."""
        with self._lock:
            return {
                "docked": self._docked,
                "motion_enabled": self._motion_enabled,
                "dry_run": self._env_dry_run or self._shadow_dry_run,
            }

    def reported(self) -> dict:
        """Shadow 'reported' payload: same keys as desired; dry_run is EFFECTIVE."""
        with self._lock:
            return {
                "motion_enabled": self._motion_enabled,
                "max_speed": self._max_speed,
                "dry_run": self._env_dry_run or self._shadow_dry_run,
            }

    def uptime_s(self) -> float:
        return time.monotonic() - self._started
```

Replace `src/guide_mate_bridge/guide_mate_bridge/__init__.py` with:

```python
"""Pi-side AWS IoT bridge (venv-managed, not colcon-built)."""

BRIDGE_VERSION = "0.2.0"
```

- [ ] **Step 5: Implement the executor changes**

Replace `src/guide_mate_bridge/guide_mate_bridge/executor.py` entirely with:

```python
"""Choreography executor — gate-aware. No cmd_vel publisher exists in Phase 2."""
from __future__ import annotations

import logging
from typing import Callable, Optional

from guidemate_msgs.choreography import TwistStep, build
from guidemate_msgs.jsonlog import log_extra
from guidemate_msgs.messages import Ack, Command

from guide_mate_bridge.safety import SafetyState

log = logging.getLogger(__name__)


class ChoreographyRunner:
    def __init__(
        self,
        publish_ack: Callable[[Ack], None],
        safety: SafetyState,
        publish_twist: Optional[Callable[[TwistStep], None]] = None,
    ) -> None:
        self._publish_ack = publish_ack
        self._safety = safety
        self._publish_twist = publish_twist

    def handle(self, cmd: Command) -> None:
        gates = self._safety.gates()
        dry = gates["dry_run"]

        def ack(state: str, reason: Optional[str] = None) -> None:
            # Every ack carries simulated + the gate snapshot (Phase-2 fix: previously
            # only the terminal 'done' ack carried simulated).
            self._publish_ack(
                Ack(cmd_id=cmd.cmd_id, state=state, reason=reason,
                    simulated=dry, gates=gates)
            )

        ack("received")

        if not dry and cmd.type in ("emote", "motion"):
            # Refusal paths (spec checklist item 4). Dock unknown counts as docked
            # (default-deny). "stop" is always accepted, so it skips this block.
            if gates["docked"] is not False:
                ack("failed", reason="docked")
                return
            if not gates["motion_enabled"]:
                ack("failed", reason="motion_disabled")
                return

        try:
            steps = build(cmd, max_speed=self._safety.max_speed)
        except ValueError as exc:
            ack("failed", reason=str(exc))
            return

        ack("running")
        for step in steps:
            if dry:
                log.info(
                    "DRY-RUN twist vx=%.3f wz=%.3f dur=%.2fs",
                    step.vx,
                    step.wz,
                    step.duration,
                    extra=log_extra(cmd_id=cmd.cmd_id),
                )
                continue
            # Real cmd_vel publishing arrives in Phase 8 (sim); publish_twist is
            # never wired in this phase — nothing can move.
            if self._publish_twist is not None:
                self._publish_twist(step)
        ack("done")
```

- [ ] **Step 6: Wire `SafetyState` through `Bridge` (constructor only)**

In `src/guide_mate_bridge/guide_mate_bridge/bridge.py`:

Add to the imports block:

```python
from guide_mate_bridge.safety import SafetyState
```

Replace the `Bridge.__init__` method with:

```python
    def __init__(self, client: IotClient, robot_id: str, safety: SafetyState) -> None:
        self._client = client
        self._robot_id = robot_id
        self._safety = safety
        self._seen = collections.deque(maxlen=256)
        self._seen_set: set[str] = set()
        # awscrt dispatches callbacks single-threaded per connection today, but that's
        # not a documented contract — guard the check-evict-insert sequence explicitly.
        self._dedupe_lock = threading.Lock()
        self._queue: "queue.Queue[Command]" = queue.Queue()
        self._runner = ChoreographyRunner(publish_ack=self._publish_ack, safety=safety)
        self._worker = threading.Thread(target=self._run, daemon=True)
```

In `main()`, replace the two lines

```python
    bridge = Bridge(client=client, robot_id=robot_id, dry_run=True)
    bridge.start()
```

with

```python
    safety = SafetyState(env_dry_run=True)  # main() already exited above if env != truthy
    bridge = Bridge(client=client, robot_id=robot_id, safety=safety)
    bridge.start()
```

(The Phase-1 `SystemExit` guard stays for now; Task 3 replaces it with the env-OR-shadow composition.)

- [ ] **Step 7: Update the bridge test helper**

In `src/guide_mate_bridge/tests/test_bridge.py`, add to the imports:

```python
from guide_mate_bridge.safety import SafetyState
```

and replace the `_bridge` helper with:

```python
def _bridge(robot_id="devtest"):
    fake = FakeConnection()
    client = IotClient(
        endpoint="x",
        cert_filepath="x",
        pri_key_filepath="x",
        client_id="guidemate-bridge-test",
        robot_id=robot_id,
        connection=fake,
    )
    safety = SafetyState(env_dry_run=True)
    return Bridge(client=client, robot_id=robot_id, safety=safety), fake
```

- [ ] **Step 8: Run the full bridge + shared suites to verify green**

Run: `cd ~/cs7980/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests shared/guidemate_msgs/tests -q`
Expected: PASS (all tests; the four rewritten executor tests plus five new refusal/gate tests plus five safety tests all green; existing bridge tests unchanged and green).

- [ ] **Step 9: Commit**

```bash
cd ~/cs7980/cs7980-guide-mate
git add src/guide_mate_bridge/guide_mate_bridge/safety.py \
  src/guide_mate_bridge/guide_mate_bridge/__init__.py \
  src/guide_mate_bridge/guide_mate_bridge/executor.py \
  src/guide_mate_bridge/guide_mate_bridge/bridge.py \
  src/guide_mate_bridge/tests/test_safety.py \
  src/guide_mate_bridge/tests/test_executor.py \
  src/guide_mate_bridge/tests/test_bridge.py
git commit -m "Kalhar: SafetyState + executor refusal paths, gates + simulated on all acks"
```

---

## Task 3: Shadow reconcile + IoT client delivery check + graceful SIGTERM

**Files:**
- Create: `src/guide_mate_bridge/guide_mate_bridge/shadow.py`
- Modify: `src/guide_mate_bridge/guide_mate_bridge/iot_client.py`, `src/guide_mate_bridge/guide_mate_bridge/bridge.py`
- Test: `src/guide_mate_bridge/tests/test_shadow.py` (new), `src/guide_mate_bridge/tests/test_bridge.py` (replace the dry-run-guard test with a graceful-shutdown test)

**Interfaces:**
- Consumes: `SafetyState` (Task 2 — `apply_shadow`, `reported()`, `uptime_s()`); `IotClient` (`subscribe(topic, cb)`, `publish(topic, payload_str)`); `BRIDGE_VERSION`.
- Produces:
  - `shadow_topic(thing_name: str, suffix: str) -> str` = `f"$aws/things/{thing_name}/shadow/{suffix}"`.
  - `class ShadowSync(client: IotClient, thing_name: str, safety: SafetyState, get_timeout_s: float = 5.0)`. `start()`: subscribe `get/accepted`, `get/rejected`, `update/delta`, `update/accepted`; publish empty `get`; on get-accepted apply `desired`; missing shadow / rejected / timeout / **subscribe denied** → DEFAULTS LOCKED (log a warning; on subscribe-denial skip the get/reported publishes entirely — AWS IoT drops the connection on unauthorized publish, and the dev cert has no shadow permissions). After reconcile, `publish_reported()`. Delta messages apply live + re-publish reported. `publish_reported()`: publishes `{"state": {"reported": {motion_enabled, max_speed, dry_run, bridge_version, uptime_s}}}` to `update`.
  - `IotClient.publish(topic, payload_str)` — now attaches a **non-blocking** delivery check (`add_done_callback` → warn-log on failure; never `future.result()` inside publish, since publish is called from awscrt callback threads — e.g. the delta handler — and blocking the event loop on its own puback would deadlock). New `IotClient.disconnect()`.
  - `bridge.main()` — Phase-1 `SystemExit` guard **replaced** by the env-OR-shadow composition: `SafetyState(env_dry_run=_truthy(env))`; env=0 logs a prominent warning and continues (nothing can move — no cmd_vel publisher exists). New env `GUIDEMATE_THING_NAME` (default `Turtlebot-468`). SIGTERM/SIGINT → module-level `_graceful_shutdown(client, shadow, robot_id, telemetry=None, heartbeat=None)`: publish `{"event": "offline", "robot_id": ..., "graceful": true}`, publish reported one last time, disconnect cleanly, stop rclpy (telemetry) — testable with fakes.

- [ ] **Step 1: Write the failing shadow tests**

`src/guide_mate_bridge/tests/test_shadow.py`:

```python
import json

from guide_mate_bridge.iot_client import IotClient
from guide_mate_bridge.safety import SafetyState
from guide_mate_bridge.shadow import ShadowSync, shadow_topic


class FakeFuture:
    def result(self, timeout=None):
        return None

    def add_done_callback(self, fn):
        fn(self)


class FakeConnection:
    """awscrt-shaped fake. Can auto-answer a shadow get, or reject subscribes."""

    def __init__(self, deny_subscribe=False):
        self.published = []          # list[(topic, payload_str)]
        self.subscriptions = {}      # topic -> wrapped callback
        self.deny_subscribe = deny_subscribe
        self.auto_get_response = None    # (suffix, payload_str) delivered on shadow get
        self.disconnected = False

    def connect(self):
        return FakeFuture()

    def disconnect(self):
        self.disconnected = True
        return FakeFuture()

    def subscribe(self, topic, qos, callback):
        if self.deny_subscribe:
            raise RuntimeError("SUBACK failure (policy denied)")
        self.subscriptions[topic] = callback
        return FakeFuture(), 1

    def publish(self, topic, payload, qos, **kwargs):
        text = payload.decode("utf-8") if isinstance(payload, (bytes, bytearray)) else payload
        self.published.append((topic, text))
        if topic.endswith("/shadow/get") and self.auto_get_response is not None:
            suffix, response = self.auto_get_response
            cb = self.subscriptions[topic + "/" + suffix]
            cb(topic=topic + "/" + suffix, payload=response.encode("utf-8"),
               dup=False, qos=1, retain=False)
        return FakeFuture(), 1

    def deliver(self, topic, payload_str):
        self.subscriptions[topic](topic=topic, payload=payload_str.encode("utf-8"),
                                  dup=False, qos=1, retain=False)


def _client(fake):
    return IotClient(
        endpoint="x", cert_filepath="x", pri_key_filepath="x",
        client_id="guidemate-bridge-test", robot_id="devtest", connection=fake,
    )


def _sync(fake, safety, timeout=0.05):
    return ShadowSync(client=_client(fake), thing_name="Turtlebot-468",
                      safety=safety, get_timeout_s=timeout)


def _reported_payloads(fake):
    topic = shadow_topic("Turtlebot-468", "update")
    return [json.loads(p)["state"]["reported"] for t, p in fake.published if t == topic]


def test_shadow_topic_helper():
    assert shadow_topic("Turtlebot-468", "get") == "$aws/things/Turtlebot-468/shadow/get"


def test_get_accepted_applies_desired_and_publishes_reported():
    fake = FakeConnection()
    fake.auto_get_response = ("accepted", json.dumps(
        {"state": {"desired": {"motion_enabled": False, "max_speed": 0.10,
                               "dry_run": True}}, "version": 7}))
    safety = SafetyState(env_dry_run=True)
    _sync(fake, safety, timeout=1.0).start()
    assert safety.max_speed == 0.10
    reported = _reported_payloads(fake)
    assert reported, "no reported state published"
    rep = reported[-1]
    assert rep["max_speed"] == 0.10
    assert rep["motion_enabled"] is False
    assert rep["dry_run"] is True
    assert "bridge_version" in rep and "uptime_s" in rep


def test_get_rejected_locks_defaults_and_still_reports():
    fake = FakeConnection()
    fake.auto_get_response = ("rejected", json.dumps(
        {"code": 404, "message": "No shadow exists with name"}))
    safety = SafetyState(env_dry_run=True)
    _sync(fake, safety, timeout=1.0).start()
    assert safety.gates() == {"docked": None, "motion_enabled": False, "dry_run": True}
    assert safety.max_speed == 0.15
    assert _reported_payloads(fake)  # bridge announces its (locked) state anyway


def test_get_timeout_locks_defaults():
    fake = FakeConnection()  # no auto response -> get goes unanswered
    safety = SafetyState(env_dry_run=True)
    _sync(fake, safety, timeout=0.05).start()
    assert safety.gates()["motion_enabled"] is False
    assert safety.effective_dry_run is True
    assert _reported_payloads(fake)


def test_delta_applies_live_and_republishes_reported():
    fake = FakeConnection()
    fake.auto_get_response = ("accepted", json.dumps({"state": {"desired": {}}}))
    safety = SafetyState(env_dry_run=True)
    _sync(fake, safety, timeout=1.0).start()
    before = len(_reported_payloads(fake))
    fake.deliver(shadow_topic("Turtlebot-468", "update/delta"),
                 json.dumps({"state": {"max_speed": 0.08}, "version": 9}))
    assert safety.max_speed == 0.08
    reported = _reported_payloads(fake)
    assert len(reported) == before + 1
    assert reported[-1]["max_speed"] == 0.08


def test_shadow_delta_cannot_loosen_env_dry_run():
    fake = FakeConnection()
    fake.auto_get_response = ("accepted", json.dumps({"state": {"desired": {}}}))
    safety = SafetyState(env_dry_run=True)
    _sync(fake, safety, timeout=1.0).start()
    fake.deliver(shadow_topic("Turtlebot-468", "update/delta"),
                 json.dumps({"state": {"dry_run": False, "motion_enabled": True}}))
    assert safety.effective_dry_run is True  # env=1 wins; STRICTER-only invariant


def test_subscribe_denied_locks_defaults_and_never_publishes_shadow_topics():
    # The dev cert has no shadow permissions; unauthorized publish would get the
    # connection dropped by AWS IoT — so on subscribe denial we must go silent.
    fake = FakeConnection(deny_subscribe=True)
    safety = SafetyState(env_dry_run=True)
    _sync(fake, safety, timeout=0.05).start()
    assert safety.gates()["motion_enabled"] is False
    assert fake.published == []  # no get, no reported — nothing touched shadow topics
```

- [ ] **Step 2: Write the failing graceful-shutdown test (and retire the Phase-1 guard test)**

In `src/guide_mate_bridge/tests/test_bridge.py`:

1. Update `FakeFuture` (the Task-3 `IotClient.publish` registers a done-callback on every publish):

```python
class FakeFuture:
    def result(self, timeout=None):
        return None

    def add_done_callback(self, fn):
        fn(self)
```

2. Add a `disconnected` flag to `FakeConnection.__init__` (`self.disconnected = False`) and replace its `disconnect` method with:

```python
    def disconnect(self):
        self.disconnected = True
        return FakeFuture()
```

3. **Delete** `test_main_refuses_without_dry_run` (Phase 2 replaces the hard guard with the env-OR-shadow composition — with no `cmd_vel` publisher in existence, env=0 merely hands dry-run control to the shadow, which also defaults locked). Remove `import pytest` and the `main` import if now unused.

4. Add:

```python
from guide_mate_bridge.bridge import _graceful_shutdown
from guide_mate_bridge.shadow import ShadowSync, shadow_topic


def test_graceful_shutdown_publishes_offline_then_reported_then_disconnects():
    bridge, fake = _bridge()
    safety = SafetyState(env_dry_run=True)
    shadow = ShadowSync(client=bridge._client, thing_name="Turtlebot-468",
                        safety=safety, get_timeout_s=0.05)
    # Simulate an already-reconciled shadow layer (subscriptions succeeded earlier).
    shadow._subscribed = True

    _graceful_shutdown(client=bridge._client, shadow=shadow, robot_id="devtest")

    offline = [json.loads(p) for t, p in fake.published if t == status_topic("devtest")]
    assert {"event": "offline", "robot_id": "devtest", "graceful": True} in offline
    assert any(t == shadow_topic("Turtlebot-468", "update") for t, _ in fake.published)
    assert fake.disconnected is True
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ~/cs7980/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_shadow.py src/guide_mate_bridge/tests/test_bridge.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guide_mate_bridge.shadow'`.

- [ ] **Step 4: Implement the `IotClient` changes**

In `src/guide_mate_bridge/guide_mate_bridge/iot_client.py`, replace the `publish` method with, and add `disconnect` after it:

```python
    def publish(self, topic: str, payload_str: str) -> None:
        future, _ = self._conn.publish(
            topic=topic,
            payload=payload_str.encode("utf-8"),
            qos=mqtt.QoS.AT_LEAST_ONCE,
        )

        # Non-blocking delivery check. NEVER call future.result() here: publish() is
        # invoked from awscrt callback threads (e.g. the shadow delta handler), and
        # blocking the event loop on its own puback would deadlock the connection.
        def _warn_on_failure(f) -> None:
            try:
                f.result()
            except Exception as exc:  # noqa: BLE001
                log.warning("publish to %s failed: %s", topic, exc)

        future.add_done_callback(_warn_on_failure)

    def disconnect(self) -> None:
        try:
            self._conn.disconnect().result()
        except Exception as exc:  # noqa: BLE001
            log.warning("disconnect failed: %s", exc)
```

- [ ] **Step 5: Implement `shadow.py`**

`src/guide_mate_bridge/guide_mate_bridge/shadow.py`:

```python
"""Classic Device Shadow reconcile over the existing IotClient connection.

Plain MQTT on the reserved $aws shadow topics — no extra SDK layer. Missing
shadow, rejected get, timeout, or denied subscription all leave the defaults
LOCKED (motion_enabled=False, max_speed=0.15, dry_run=True).
"""
from __future__ import annotations

import json
import logging
import threading

from guide_mate_bridge import BRIDGE_VERSION
from guide_mate_bridge.iot_client import IotClient
from guide_mate_bridge.safety import SafetyState

log = logging.getLogger(__name__)

_LOCKED_MSG = "DEFAULTS LOCKED (motion_enabled=False, max_speed=0.15, dry_run=True)"


def shadow_topic(thing_name: str, suffix: str) -> str:
    return f"$aws/things/{thing_name}/shadow/{suffix}"


class ShadowSync:
    def __init__(
        self,
        client: IotClient,
        thing_name: str,
        safety: SafetyState,
        get_timeout_s: float = 5.0,
    ) -> None:
        self._client = client
        self._thing = thing_name
        self._safety = safety
        self._get_timeout_s = get_timeout_s
        self._got = threading.Event()
        self._subscribed = False

    def start(self) -> None:
        try:
            self._client.subscribe(shadow_topic(self._thing, "get/accepted"), self._on_get_accepted)
            self._client.subscribe(shadow_topic(self._thing, "get/rejected"), self._on_get_rejected)
            self._client.subscribe(shadow_topic(self._thing, "update/delta"), self._on_delta)
            self._client.subscribe(shadow_topic(self._thing, "update/accepted"), self._on_update_accepted)
        except Exception as exc:  # noqa: BLE001 — e.g. policy-denied SUBACK (dev cert)
            # Do NOT publish to shadow topics after a denial: AWS IoT drops the whole
            # connection on an unauthorized publish, which would wedge the bridge.
            log.warning("shadow topics unavailable (%s) — %s", exc, _LOCKED_MSG)
            return
        self._subscribed = True
        self._client.publish(shadow_topic(self._thing, "get"), "")
        if not self._got.wait(self._get_timeout_s):
            log.warning("shadow get timed out — %s", _LOCKED_MSG)
        self.publish_reported()

    def _on_get_accepted(self, topic: str, payload: str) -> None:
        try:
            desired = json.loads(payload).get("state", {}).get("desired") or {}
        except json.JSONDecodeError:
            log.warning("unparseable shadow get/accepted — %s", _LOCKED_MSG)
            self._got.set()
            return
        self._safety.apply_shadow(desired)
        log.info("shadow reconciled: desired keys %s -> gates %s",
                 sorted(desired.keys()), self._safety.gates())
        self._got.set()

    def _on_get_rejected(self, topic: str, payload: str) -> None:
        log.warning("shadow get rejected (%s) — %s", payload, _LOCKED_MSG)
        self._got.set()

    def _on_delta(self, topic: str, payload: str) -> None:
        try:
            delta = json.loads(payload).get("state") or {}
        except json.JSONDecodeError:
            log.warning("unparseable shadow delta ignored")
            return
        self._safety.apply_shadow(delta)
        log.info("shadow delta applied: %s -> gates %s",
                 sorted(delta.keys()), self._safety.gates())
        self.publish_reported()

    def _on_update_accepted(self, topic: str, payload: str) -> None:
        log.debug("shadow update accepted")

    def publish_reported(self) -> None:
        if not self._subscribed:
            return  # never touch shadow topics if we couldn't subscribe (see start())
        reported = dict(self._safety.reported())
        reported["bridge_version"] = BRIDGE_VERSION
        reported["uptime_s"] = round(self._safety.uptime_s(), 1)
        self._client.publish(
            shadow_topic(self._thing, "update"),
            json.dumps({"state": {"reported": reported}}),
        )
```

- [ ] **Step 6: Implement the `bridge.py` main/shutdown changes**

In `src/guide_mate_bridge/guide_mate_bridge/bridge.py`:

Add to the imports block:

```python
import json
import signal

from guide_mate_bridge.shadow import ShadowSync
```

Then replace `main()` (keep the `Bridge` class from Task 2 as-is) and add `_graceful_shutdown` above it:

```python
def _graceful_shutdown(client, shadow, robot_id, telemetry=None, heartbeat=None) -> None:
    """SIGTERM path: offline(graceful) -> final reported -> disconnect -> stop rclpy."""
    if heartbeat is not None:
        heartbeat.stop()  # no more publishes racing the teardown
    client.publish(
        status_topic(robot_id),
        json.dumps({"event": "offline", "robot_id": robot_id, "graceful": True}),
    )
    shadow.publish_reported()
    client.disconnect()
    if telemetry is not None:
        telemetry.stop()


def main() -> None:
    setup("bridge")
    robot_id = os.environ.get("GUIDEMATE_ROBOT_ID", "turtlebot468")
    thing_name = os.environ.get("GUIDEMATE_THING_NAME", "Turtlebot-468")
    env_dry_run = _truthy(os.environ.get("GUIDEMATE_DRY_RUN", "1"))
    if not env_dry_run:
        log.warning(
            "env dry-run is OFF — effective dry-run now follows the shadow "
            "(which also defaults to locked). No cmd_vel publisher exists in "
            "this phase, so nothing can move either way."
        )
    endpoint = os.environ["GUIDEMATE_IOT_ENDPOINT"]
    cert = os.environ["GUIDEMATE_CERT"]
    key = os.environ["GUIDEMATE_KEY"]
    ca = os.environ.get("GUIDEMATE_CA")

    safety = SafetyState(env_dry_run=env_dry_run)
    client = IotClient(
        endpoint=endpoint,
        cert_filepath=cert,
        pri_key_filepath=key,
        client_id=f"guidemate-bridge-{robot_id}",
        robot_id=robot_id,
        ca_filepath=ca,
    )
    bridge = Bridge(client=client, robot_id=robot_id, safety=safety)
    bridge.start()
    shadow = ShadowSync(client=client, thing_name=thing_name, safety=safety)
    shadow.start()

    stop_event = threading.Event()

    def _on_signal(signum, frame):
        stop_event.set()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    log.info("bridge connected", extra=log_extra(robot_id=robot_id))
    stop_event.wait()
    log.info("shutting down gracefully", extra=log_extra(robot_id=robot_id))
    _graceful_shutdown(client=client, shadow=shadow, robot_id=robot_id)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd ~/cs7980/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests -q`
Expected: PASS (all bridge-package tests green, including the seven new shadow tests and the graceful-shutdown test; the Phase-1 dry-run-guard test is gone).

- [ ] **Step 8: Commit**

```bash
cd ~/cs7980/cs7980-guide-mate
git add src/guide_mate_bridge/guide_mate_bridge/shadow.py \
  src/guide_mate_bridge/guide_mate_bridge/iot_client.py \
  src/guide_mate_bridge/guide_mate_bridge/bridge.py \
  src/guide_mate_bridge/tests/test_shadow.py \
  src/guide_mate_bridge/tests/test_bridge.py
git commit -m "Kalhar: shadow reconcile (defaults locked) + publish delivery check + graceful SIGTERM"
```

---

## Task 4: Telemetry (rclpy battery + dock) and the 30 s heartbeat

**Files:**
- Create: `src/guide_mate_bridge/guide_mate_bridge/telemetry.py`
- Modify: `src/guide_mate_bridge/guide_mate_bridge/bridge.py` (wire telemetry + heartbeat into `main()`)
- Test: `src/guide_mate_bridge/tests/test_telemetry.py`

**Interfaces:**
- Consumes: `SafetyState` (`set_docked`, `gates()`, `uptime_s()`); `Heartbeat`, `status_topic` (Task 1); `IotClient.publish`.
- Produces:
  - `class Telemetry(safety: SafetyState, namespace: str, enabled: bool)` — `start() -> bool` (False + null readings when disabled or rclpy missing); `battery() -> Optional[float]`; `docked() -> Optional[bool]`; `stop()`. Dock updates also flow into `safety.set_docked(...)`. Module constants `BATTERY_TOPIC` / `DOCK_TOPIC` (relative names, resolved under the node namespace) — **fixed by the Step 1 probe**.
  - `class HeartbeatPublisher(client, robot_id: str, safety: SafetyState, telemetry: Telemetry, interval_s: float = 30.0)` — `start()` (publishes immediately, then every `interval_s`), `publish_once()`, `stop()`. Payload = `Heartbeat` model JSON on `status_topic(robot_id)`; also logs an INFO `"heartbeat"` line with battery/docked extras so `journalctl` is the empirical telemetry evidence (Task 6).

- [ ] **Step 1: Probe the battery/dock topics on the Pi (BEFORE coding the constants)**

Ad-hoc SSH shells may not cross-discover the Discovery-Server graph (CLAUDE.md gotcha #2 / the no-motion doc), so probe via a systemd-run oneshot, which runs in the same manager context as the boot services:

```bash
ssh guidemate "sudo systemd-run --wait --pipe --collect --uid=ubuntu bash -c \
  'source /opt/ros/humble/setup.bash && source /etc/turtlebot4/setup.bash && \
   export ROS_SUPER_CLIENT=True && timeout 20 ros2 topic list -t' 2>/dev/null" \
  | grep -Ei 'battery|dock'
```

Expected output (topic names to bake into `telemetry.py`):

```
/turtlebot468/battery_state [sensor_msgs/msg/BatteryState]
/turtlebot468/dock_status [irobot_create_msgs/msg/DockStatus]
```

**Fallback A** (if systemd-run shows nothing): ask the on-Pi Claude, which has the robot's own ROS context:

```bash
ssh guidemate 'cd ~/cs7980-guide-mate && ~/.local/bin/claude -p "Source /opt/ros/humble/setup.bash and /etc/turtlebot4/setup.bash, export ROS_SUPER_CLIENT=True, then run: ros2 topic list -t | grep -Ei \"battery|dock\". Report the exact topic names and message types. Read-only — do not start or kill anything."'
```

**Fallback B** (if the topics differ from the expected names, e.g. `/turtlebot468/dock` on older firmware): use the probed names in the `BATTERY_TOPIC`/`DOCK_TOPIC` constants in Step 4 (they are relative names — strip the `/turtlebot468/` namespace prefix).

**Fallback C** (if the graph is genuinely unreadable): proceed anyway — the design degrades to heartbeats with `battery`/`docked` = `null`, which still proves item 5's heartbeat half; document the limitation in Task 6.

Note: do NOT try `ros2 topic echo` here — 0 frames for ad-hoc subscribers is a known Discovery-Server behavior on this box (gotcha #2); data flow is verified empirically after deploy via the bridge's own journal (Task 6).

- [ ] **Step 2: Write the failing telemetry/heartbeat tests**

`src/guide_mate_bridge/tests/test_telemetry.py`:

```python
import json
import time

from guidemate_msgs.messages import status_topic

from guide_mate_bridge.safety import SafetyState
from guide_mate_bridge.telemetry import HeartbeatPublisher, Telemetry


class FakeClient:
    def __init__(self):
        self.published = []

    def publish(self, topic, payload_str):
        self.published.append((topic, payload_str))


def _telemetry(safety=None):
    return Telemetry(safety=safety or SafetyState(), namespace="turtlebot468",
                     enabled=False)


def test_disabled_telemetry_reports_unknowns():
    t = _telemetry()
    assert t.start() is False
    assert t.battery() is None
    assert t.docked() is None


def test_battery_callback_updates_reading():
    t = _telemetry()

    class Msg:
        percentage = 0.87

    t._on_battery(Msg())
    assert t.battery() == 0.87


def test_dock_callback_updates_reading_and_safety_gates():
    safety = SafetyState()
    t = _telemetry(safety)

    class Msg:
        is_docked = True

    t._on_dock(Msg())
    assert t.docked() is True
    assert safety.gates()["docked"] is True


def test_heartbeat_payload_shape():
    safety = SafetyState(env_dry_run=True)
    t = _telemetry(safety)
    client = FakeClient()
    hb = HeartbeatPublisher(client=client, robot_id="turtlebot468",
                            safety=safety, telemetry=t)
    hb.publish_once()
    topic, payload = client.published[0]
    assert topic == status_topic("turtlebot468")
    data = json.loads(payload)
    assert data["event"] == "heartbeat"
    assert data["robot_id"] == "turtlebot468"
    assert data["battery"] is None
    assert data["docked"] is None
    assert data["uptime_s"] >= 0
    assert data["gates"] == {"docked": None, "motion_enabled": False, "dry_run": True}


def test_heartbeat_loop_publishes_immediately_and_repeats_until_stop():
    safety = SafetyState()
    client = FakeClient()
    hb = HeartbeatPublisher(client=client, robot_id="turtlebot468",
                            safety=safety, telemetry=_telemetry(safety),
                            interval_s=0.05)
    hb.start()
    time.sleep(0.13)
    hb.stop()
    count = len(client.published)
    assert count >= 2  # immediate publish + at least one interval tick
    time.sleep(0.12)
    assert len(client.published) == count  # stopped means stopped
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ~/cs7980/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_telemetry.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guide_mate_bridge.telemetry'`.

- [ ] **Step 4: Implement `telemetry.py`**

`src/guide_mate_bridge/guide_mate_bridge/telemetry.py` (adjust the two topic constants if the Step 1 probe returned different names):

```python
"""Optional rclpy telemetry (battery + dock) and the 30 s heartbeat publisher.

The ROS layer is strictly optional: if GUIDEMATE_ROS is not truthy, rclpy is not
importable, or the graph is unreadable, heartbeats still flow with
battery/docked = null. rclpy is imported lazily so this module (and the whole
bridge) works on machines without ROS.
"""
from __future__ import annotations

import logging
import threading
from typing import Optional

from guidemate_msgs.jsonlog import log_extra
from guidemate_msgs.messages import Heartbeat, status_topic

from guide_mate_bridge.safety import SafetyState

log = logging.getLogger(__name__)

# Probed on the Pi via systemd-run oneshot (Task 4 Step 1):
#   /turtlebot468/battery_state [sensor_msgs/msg/BatteryState]
#   /turtlebot468/dock_status   [irobot_create_msgs/msg/DockStatus]
# Relative names — resolved under the node namespace (GUIDEMATE_ROS_NAMESPACE).
BATTERY_TOPIC = "battery_state"
DOCK_TOPIC = "dock_status"


class Telemetry:
    """Background rclpy node; degrades to None readings when ROS is off/unavailable."""

    def __init__(self, safety: SafetyState, namespace: str, enabled: bool) -> None:
        self._safety = safety
        self._namespace = namespace if namespace.startswith("/") else f"/{namespace}"
        self._enabled = enabled
        self._battery: Optional[float] = None
        self._docked: Optional[bool] = None
        self._lock = threading.Lock()
        self._ros_shutdown = None  # set to rclpy.shutdown once the node is up

    def start(self) -> bool:
        if not self._enabled:
            log.info("telemetry ROS layer disabled (GUIDEMATE_ROS not truthy)")
            return False
        try:
            import rclpy  # noqa: F401
        except ImportError:
            log.warning("rclpy not importable — heartbeats will carry battery/docked=null")
            return False
        threading.Thread(target=self._ros_main, daemon=True).start()
        return True

    def _ros_main(self) -> None:
        import rclpy
        from rclpy.qos import qos_profile_sensor_data
        from sensor_msgs.msg import BatteryState

        rclpy.init(args=None)
        node = rclpy.create_node("guidemate_bridge_telemetry", namespace=self._namespace)
        # Sensor-data QoS (BEST_EFFORT) matches both best-effort and reliable publishers.
        node.create_subscription(
            BatteryState, BATTERY_TOPIC, self._on_battery, qos_profile_sensor_data
        )
        try:
            from irobot_create_msgs.msg import DockStatus

            node.create_subscription(
                DockStatus, DOCK_TOPIC, self._on_dock, qos_profile_sensor_data
            )
        except ImportError:
            log.warning("irobot_create_msgs unavailable — dock state stays unknown")
        self._ros_shutdown = rclpy.shutdown
        log.info("telemetry ROS node up", extra=log_extra(namespace=self._namespace))
        try:
            rclpy.spin(node)
        except Exception:  # noqa: BLE001 — rclpy.shutdown() from stop() ends the spin
            pass

    def _on_battery(self, msg) -> None:
        with self._lock:
            self._battery = float(msg.percentage)

    def _on_dock(self, msg) -> None:
        docked = bool(msg.is_docked)
        with self._lock:
            self._docked = docked
        self._safety.set_docked(docked)

    def battery(self) -> Optional[float]:
        with self._lock:
            return self._battery

    def docked(self) -> Optional[bool]:
        with self._lock:
            return self._docked

    def stop(self) -> None:
        if self._ros_shutdown is not None:
            try:
                self._ros_shutdown()
            except Exception:  # noqa: BLE001
                pass


class HeartbeatPublisher:
    """Publishes a Heartbeat to status_topic immediately and then every interval_s."""

    def __init__(
        self,
        client,
        robot_id: str,
        safety: SafetyState,
        telemetry: Telemetry,
        interval_s: float = 30.0,
    ) -> None:
        self._client = client
        self._robot_id = robot_id
        self._safety = safety
        self._telemetry = telemetry
        self._interval_s = interval_s
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def publish_once(self) -> None:
        hb = Heartbeat(
            robot_id=self._robot_id,
            battery=self._telemetry.battery(),
            docked=self._telemetry.docked(),
            uptime_s=round(self._safety.uptime_s(), 1),
            gates=self._safety.gates(),
        )
        self._client.publish(status_topic(self._robot_id), hb.model_dump_json())
        # Journal evidence for on-Pi verification (log_extra drops None values).
        log.info(
            "heartbeat",
            extra=log_extra(
                robot_id=self._robot_id,
                battery=hb.battery,
                docked=hb.docked,
                uptime_s=hb.uptime_s,
            ),
        )

    def _loop(self) -> None:
        while True:
            try:
                self.publish_once()
            except Exception:  # noqa: BLE001 — the heartbeat thread must never die
                log.exception("heartbeat publish failed")
            if self._stop.wait(self._interval_s):
                return

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
```

- [ ] **Step 5: Wire telemetry + heartbeat into `main()`**

In `src/guide_mate_bridge/guide_mate_bridge/bridge.py`, add to the imports block:

```python
from guide_mate_bridge.telemetry import HeartbeatPublisher, Telemetry
```

and in `main()`, replace everything from `stop_event = threading.Event()` to the end of the function with:

```python
    telemetry = Telemetry(
        safety=safety,
        namespace=os.environ.get("GUIDEMATE_ROS_NAMESPACE", robot_id),
        enabled=_truthy(os.environ.get("GUIDEMATE_ROS", "0")),
    )
    telemetry.start()
    heartbeat = HeartbeatPublisher(
        client=client, robot_id=robot_id, safety=safety, telemetry=telemetry
    )
    heartbeat.start()

    stop_event = threading.Event()

    def _on_signal(signum, frame):
        stop_event.set()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    log.info("bridge connected", extra=log_extra(robot_id=robot_id))
    stop_event.wait()
    log.info("shutting down gracefully", extra=log_extra(robot_id=robot_id))
    _graceful_shutdown(
        client=client, shadow=shadow, robot_id=robot_id,
        telemetry=telemetry, heartbeat=heartbeat,
    )
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ~/cs7980/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests -q`
Expected: PASS (all bridge-package tests, including the five new telemetry/heartbeat tests).

- [ ] **Step 7: Commit**

```bash
cd ~/cs7980/cs7980-guide-mate
git add src/guide_mate_bridge/guide_mate_bridge/telemetry.py \
  src/guide_mate_bridge/guide_mate_bridge/bridge.py \
  src/guide_mate_bridge/tests/test_telemetry.py
git commit -m "Kalhar: optional rclpy telemetry (battery+dock) + 30s heartbeat publisher"
```

---

## Task 5: Cloud side — registry robot-truth state + DogAgent tools + persona

**Files:**
- Modify: `agent_service/guidemate_agent/mqtt_link.py`, `agent_service/guidemate_agent/dog_agent.py`
- Test: `agent_service/tests/test_mqtt_link.py` (append), `agent_service/tests/test_dog_agent.py` (append)

**Interfaces:**
- Consumes: `Heartbeat` field names (Task 1: `event`, `battery`, `docked`, `uptime_s`, `gates`); `Ack.gates`; refusal reason strings `"docked"` / `"motion_disabled"` (Task 2).
- Produces:
  - `RobotState` gains `last_heartbeat: Optional[dict] = None`. `_on_status` routes `event == "heartbeat"` into it (and sets `presence = "online"` — a heartbeat proves liveness).
  - `RobotRegistry.send_command(robot_id, cmd, timeout_s=5.0, collect_all=False)` — with `collect_all=True` it waits the FULL timeout and returns every ack collected (groundwork for Phase 5: QoS1 acks can arrive out of order, so `done` may land before `running`).
  - `RobotRegistry.get_status(robot_id) -> dict` with keys `robot_id`, `presence`, `last_ack`, `last_status`, `last_heartbeat`, `battery`, `docked`, `gates` (battery/docked/gates lifted from the latest heartbeat; `None`s when no heartbeat yet).
  - `DogAgent` gains `_motion_impl(name, target, captured)`, `_stop_impl(target, captured)`, `_status_impl(target)`, `_describe_acks(acks)`; `chat()` registers tools `send_emote`, `run_motion`, `stop`, `get_status`. `PERSONA` updated: motions only when the user asks for a trick by name; always mention when the robot reports being docked/locked.

- [ ] **Step 1: Write the failing registry tests**

Append to `agent_service/tests/test_mqtt_link.py`:

```python
def test_heartbeat_updates_robot_truth_and_presence():
    reg, fake = _registry()
    hb = {
        "event": "heartbeat", "robot_id": "turtlebot468", "battery": 0.92,
        "docked": True, "uptime_s": 42.0,
        "gates": {"docked": True, "motion_enabled": False, "dry_run": True},
        "ts": "t",
    }
    fake.status_cb(
        topic=status_topic("turtlebot468"),
        payload=json.dumps(hb).encode("utf-8"),
        dup=False, qos=1, retain=False,
    )
    status = reg.get_status("turtlebot468")
    assert status["presence"] == "online"  # a heartbeat proves liveness
    assert status["battery"] == 0.92
    assert status["docked"] is True
    assert status["gates"]["motion_enabled"] is False
    assert status["last_heartbeat"]["uptime_s"] == 42.0
    assert status["last_ack"] is None  # heartbeats are not acks


def test_get_status_robot_truth_keys_default_none():
    reg, _ = _registry()
    status = reg.get_status("turtlebot468")
    for key in ("last_heartbeat", "battery", "docked", "gates"):
        assert status[key] is None


def test_collect_all_waits_full_timeout_and_keeps_out_of_order_acks():
    reg, fake = _registry()
    cmd = Command(type="motion", name="spin")
    out = {}

    def worker():
        out["acks"] = reg.send_command("turtlebot468", cmd, timeout_s=0.5,
                                       collect_all=True)

    t = threading.Thread(target=worker)
    t.start()
    # QoS1 reordering: 'done' lands BEFORE 'running' — collect_all must not
    # return early on the terminal ack.
    fake.feed_status("turtlebot468", Ack(cmd_id=cmd.cmd_id, state="done", simulated=True))
    fake.feed_status("turtlebot468", Ack(cmd_id=cmd.cmd_id, state="running", simulated=True))
    t.join(timeout=2.0)
    assert sorted(a.state for a in out["acks"]) == ["done", "running"]
```

- [ ] **Step 2: Write the failing DogAgent tests**

Append to `agent_service/tests/test_dog_agent.py`:

```python
from guidemate_msgs.messages import Ack

from guidemate_agent.dog_agent import PERSONA


class ScriptedRegistry:
    """Registry stand-in returning a scripted ack list; records get_status calls."""

    def __init__(self, acks=None, status=None):
        self._acks = acks or []
        self._status = status or {"robot_id": "turtlebot468", "presence": "unknown"}
        self.sent = []

    def send_command(self, robot_id, cmd, timeout_s=5.0, collect_all=False):
        self.sent.append((robot_id, cmd))
        return list(self._acks)

    def get_status(self, robot_id):
        return dict(self._status)


def _agent(registry):
    return DogAgent(
        registry=registry,
        model_id="us.anthropic.claude-sonnet-4-6",
        robot_ids=["turtlebot468"],
    )


def _captured():
    return {"emote": None, "acks": []}


def test_motion_impl_refused_docked():
    acks = [Ack(cmd_id="c", state="received", simulated=False),
            Ack(cmd_id="c", state="failed", reason="docked", simulated=False,
                gates={"docked": True, "motion_enabled": True, "dry_run": False})]
    reg = ScriptedRegistry(acks=acks)
    captured = _captured()
    result = _agent(reg)._motion_impl("spin", target="turtlebot468", captured=captured)
    assert result == "the robot refused: it is docked"
    assert captured["acks"][-1]["reason"] == "docked"
    assert reg.sent[0][1].type == "motion"


def test_motion_impl_refused_motion_disabled():
    acks = [Ack(cmd_id="c", state="failed", reason="motion_disabled", simulated=False)]
    result = _agent(ScriptedRegistry(acks=acks))._motion_impl(
        "circle", target="turtlebot468", captured=_captured())
    assert result == "the robot refused: motion is disabled"


def test_motion_impl_simulated_done():
    acks = [Ack(cmd_id="c", state="done", simulated=True,
                gates={"docked": None, "motion_enabled": False, "dry_run": True})]
    result = _agent(ScriptedRegistry(acks=acks))._motion_impl(
        "spin", target="turtlebot468", captured=_captured())
    assert result == "delivered (simulated — dry-run, the robot stayed still)"


def test_motion_impl_unknown_trick_never_sent():
    reg = ScriptedRegistry()
    result = _agent(reg)._motion_impl("moonwalk", target="turtlebot468",
                                      captured=_captured())
    assert result == "unknown trick — I only know 'circle' and 'spin'"
    assert reg.sent == []  # invalid name rejected client-side, nothing published


def test_motion_impl_offline():
    result = _agent(ScriptedRegistry(acks=[]))._motion_impl(
        "spin", target="turtlebot468", captured=_captured())
    assert result == "robot did not respond — I'm probably napping offline"


def test_stop_impl_sends_stop_command():
    acks = [Ack(cmd_id="c", state="done", simulated=True)]
    reg = ScriptedRegistry(acks=acks)
    result = _agent(reg)._stop_impl(target="turtlebot468", captured=_captured())
    assert reg.sent[0][1].type == "stop"
    assert reg.sent[0][1].name == "stop"
    assert result == "delivered (simulated — dry-run, the robot stayed still)"


def test_status_impl_returns_registry_status_json():
    import json as _json
    status = {"robot_id": "turtlebot468", "presence": "online", "battery": 0.9,
              "docked": True, "gates": {"docked": True, "motion_enabled": False,
                                        "dry_run": True}}
    result = _agent(ScriptedRegistry(status=status))._status_impl("turtlebot468")
    assert _json.loads(result)["battery"] == 0.9


def test_persona_mentions_new_tools_and_docked_rule():
    assert "run_motion" in PERSONA
    assert "docked" in PERSONA
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ~/cs7980/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_mqtt_link.py agent_service/tests/test_dog_agent.py -q`
Expected: FAIL — the registry tests fail on missing `last_heartbeat`/`battery` keys and the `collect_all` kwarg; the agent tests fail with `AttributeError: 'DogAgent' object has no attribute '_motion_impl'`.

- [ ] **Step 4: Implement the registry changes**

In `agent_service/guidemate_agent/mqtt_link.py`:

Add `import time` to the imports block.

Replace `RobotState` with:

```python
@dataclass
class RobotState:
    robot_id: str
    presence: str = "unknown"          # online | offline | unknown
    last_status: Optional[dict] = None
    last_ack: Optional[dict] = None
    last_heartbeat: Optional[dict] = None
```

In `_on_status`, replace the block from `with self._lock:` through the `cmd_id`/`waiter` lines with:

```python
        with self._lock:
            state = self._robots.setdefault(robot_id, RobotState(robot_id=robot_id))
            event = data.get("event")
            if event in ("online", "offline"):
                state.presence = event
                state.last_status = data
                return
            if event == "heartbeat":
                state.presence = "online"  # a heartbeat proves liveness
                state.last_heartbeat = data
                state.last_status = data
                return
            state.last_ack = data
            state.last_status = data
            cmd_id = data.get("cmd_id")
            waiter = self._waiters.get(cmd_id) if cmd_id else None
```

Replace `send_command` with:

```python
    def send_command(
        self,
        robot_id: str,
        cmd: Command,
        timeout_s: float = 5.0,
        collect_all: bool = False,
    ) -> list[Ack]:
        """Publish a command and collect its acks.

        collect_all=False: return as soon as a terminal (done/failed) ack lands,
        or at timeout. collect_all=True: wait the FULL timeout and return every
        ack collected — AWS IoT QoS1 acks can arrive out of order ('done' before
        'running'), so early return can drop trailing acks (Phase-5 groundwork).
        """
        if self._conn is None:
            log.warning("send_command(%s) with no MQTT connection — robot unreachable", robot_id)
            return []
        event = threading.Event()
        acks: list[Ack] = []
        with self._lock:
            self._waiters[cmd.cmd_id] = (event, acks)
        try:
            self._conn.publish(
                topic=cmd_topic(robot_id),
                payload=cmd.model_dump_json().encode("utf-8"),
                qos=mqtt.QoS.AT_LEAST_ONCE,
            )
            if collect_all:
                time.sleep(timeout_s)
            else:
                event.wait(timeout_s)
        finally:
            with self._lock:
                self._waiters.pop(cmd.cmd_id, None)
        return list(acks)
```

Replace `get_status` with:

```python
    def get_status(self, robot_id: str) -> dict:
        with self._lock:
            state = self._robots.get(robot_id)
            if state is None:
                state = RobotState(robot_id=robot_id)
            hb = state.last_heartbeat or {}
            return {
                "robot_id": robot_id,
                "presence": state.presence,
                "last_ack": state.last_ack,
                "last_status": state.last_status,
                "last_heartbeat": state.last_heartbeat,
                "battery": hb.get("battery"),
                "docked": hb.get("docked"),
                "gates": hb.get("gates"),
            }
```

- [ ] **Step 5: Implement the DogAgent changes**

Replace `agent_service/guidemate_agent/dog_agent.py` entirely with:

```python
"""Robert the robot dog — Strands agent with emote + robot-truth tools."""
from __future__ import annotations

import json
import logging
import uuid
from typing import Optional

from pydantic import ValidationError
from strands import Agent, tool
from strands.models import BedrockModel

from guidemate_msgs.messages import Command

log = logging.getLogger(__name__)

PERSONA = (
    "You are Robert, the friendly robot dog of the CS7980 guide-mate project. "
    "You are playful and warm and speak in short, dog-like replies. "
    "You MUST call the send_emote tool exactly once per reply, with one of "
    "'happy', 'yes', or 'no' — pick the emote that matches your reply's mood. "
    "You also have run_motion (tricks: 'circle' or 'spin'), stop, and get_status "
    "tools. Use run_motion ONLY when the user asks for a trick by name. "
    "If the robot reports being docked or motion-locked (motion_enabled false), "
    "always mention that in your reply."
)

_OFFLINE = "robot did not respond — I'm probably napping offline"


class DogAgent:
    def __init__(
        self,
        registry,
        model_id: str,
        robot_ids: list[str],
        region: str = "us-west-2",
    ) -> None:
        self._registry = registry
        self._model_id = model_id
        self._robot_ids = robot_ids
        self._region = region

    @staticmethod
    def _describe_acks(acks) -> str:
        """Model-facing summary of a command's ack outcome."""
        if not acks:
            return _OFFLINE
        last = acks[-1]
        if last.state == "failed":
            if last.reason == "docked":
                return "the robot refused: it is docked"
            if last.reason == "motion_disabled":
                return "the robot refused: motion is disabled"
            return f"the robot refused: {last.reason}"
        if last.simulated:
            return "delivered (simulated — dry-run, the robot stayed still)"
        return "delivered"

    def _emote_impl(self, name: str, target: Optional[str], captured: dict) -> str:
        """Body of the send_emote tool, factored out so it's testable without Strands."""
        captured["emote"] = name
        if target is None:
            return _OFFLINE
        acks = self._registry.send_command(target, Command(type="emote", name=name))
        captured["acks"].extend(a.model_dump() for a in acks)
        if not acks:
            return _OFFLINE
        if acks[-1].simulated:
            return "emote delivered (simulated)"
        return "emote delivered"

    def _motion_impl(self, name: str, target: Optional[str], captured: dict) -> str:
        if target is None:
            return _OFFLINE
        try:
            cmd = Command(type="motion", name=name)
        except ValidationError:
            return "unknown trick — I only know 'circle' and 'spin'"
        acks = self._registry.send_command(target, cmd)
        captured["acks"].extend(a.model_dump() for a in acks)
        return self._describe_acks(acks)

    def _stop_impl(self, target: Optional[str], captured: dict) -> str:
        if target is None:
            return _OFFLINE
        acks = self._registry.send_command(target, Command(type="stop", name="stop"))
        captured["acks"].extend(a.model_dump() for a in acks)
        return self._describe_acks(acks)

    def _status_impl(self, target: Optional[str]) -> str:
        if target is None:
            return json.dumps({"presence": "unknown"})
        return json.dumps(self._registry.get_status(target), default=str)

    def chat(self, message: str, robot_id: Optional[str] = None) -> dict:
        turn_id = str(uuid.uuid4())
        target = robot_id or (self._robot_ids[0] if self._robot_ids else None)
        captured = {"emote": None, "acks": []}

        @tool
        def send_emote(name: str) -> str:
            """Play a physical emote on the dog. name is one of happy, yes, no."""
            return self._emote_impl(name, target, captured)

        @tool
        def run_motion(name: str) -> str:
            """Run a motion trick on the dog. name is one of: circle, spin."""
            return self._motion_impl(name, target, captured)

        @tool
        def stop() -> str:
            """Immediately stop the dog's current motion."""
            return self._stop_impl(target, captured)

        @tool
        def get_status() -> str:
            """Get the dog's live status: presence, battery, dock state, safety gates."""
            return self._status_impl(target)

        model = BedrockModel(model_id=self._model_id, region_name=self._region)
        agent = Agent(
            model=model,
            system_prompt=PERSONA,
            tools=[send_emote, run_motion, stop, get_status],
        )
        result = agent(message)
        return {
            "reply_text": str(result),
            "emote": captured["emote"],
            "robot": captured["acks"],
            "turn_id": turn_id,
        }
```

- [ ] **Step 6: Run the full default suite to verify green**

Run: `cd ~/cs7980/cs7980-guide-mate && .venv/bin/python -m pytest -q`
Expected: PASS — all unit tests green (including the pre-existing `test_emote_impl_*` tests, whose exact return strings and `captured` semantics are preserved); integration/live tests skipped.

- [ ] **Step 7: Commit**

```bash
cd ~/cs7980/cs7980-guide-mate
git add agent_service/guidemate_agent/mqtt_link.py \
  agent_service/guidemate_agent/dog_agent.py \
  agent_service/tests/test_mqtt_link.py \
  agent_service/tests/test_dog_agent.py
git commit -m "Kalhar: registry heartbeat/gates state + collect_all; DogAgent run_motion/stop/get_status"
```

---

## Task 6: Deploy + on-Pi verification (heartbeat, shadow drill, refusal evidence)

**Files:**
- Modify: `src/guide_mate_bridge/systemd/guidemate-bridge.service`, `src/guide_mate_bridge/scripts/install_bridge_on_pi.sh`
- Create: `agent_service/tests/integration/test_robot_truth.py`
- Modify: `docs/agent-poc/access-ground-truth.md` (append Phase 2 results)

**Interfaces:**
- Consumes: everything from Tasks 1–5, deployed to the Pi via the existing installer flow.
- Produces: the Phase 2 exit evidence — spec checklist items **2** (shadow `desired→reported` reconcile, survives restart), **4** (blocked-command refusal state visible in ack `gates` while dry-run), **5** (battery/dock/liveness via `/status` heartbeats).

- [ ] **Step 1: Update the systemd unit template (ROS env + new vars)**

Replace `src/guide_mate_bridge/systemd/guidemate-bridge.service` entirely with:

```ini
[Unit]
Description=GuideMate dog-agent bridge (dry-run, additive)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/cs7980-guide-mate
Environment=GUIDEMATE_ROBOT_ID=@ROBOT_ID@
Environment=GUIDEMATE_THING_NAME=@THING_NAME@
Environment=GUIDEMATE_DRY_RUN=1
Environment=GUIDEMATE_ROS=@ROS_ENABLED@
Environment=GUIDEMATE_IOT_ENDPOINT=@IOT_ENDPOINT@
Environment=GUIDEMATE_CERT=@CERT@
Environment=GUIDEMATE_KEY=@KEY@
Environment=GUIDEMATE_CA=@CA@
# The telemetry rclpy node needs the robot's ROS env (Humble + turtlebot4 Discovery
# Server config). ROS_SUPER_CLIENT=True so the node discovers the boot-service graph
# (/etc/turtlebot4/setup.bash sets it False for non-tty shells).
ExecStart=/bin/bash -c 'source /opt/ros/humble/setup.bash && source /etc/turtlebot4/setup.bash && export ROS_SUPER_CLIENT=True && exec /home/ubuntu/guidemate-venv/bin/python -m guide_mate_bridge.bridge'
Restart=on-failure
RestartSec=5
# Give the graceful SIGTERM path (offline event + final reported + disconnect) time.
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Update the installer to render the new tokens**

In `src/guide_mate_bridge/scripts/install_bridge_on_pi.sh`:

After the line `ROBOT_ID="${ROBOT_ID:-turtlebot468}"` add:

```bash
THING_NAME="${THING_NAME:-Turtlebot-468}"
ROS_ENABLED="${ROS_ENABLED:-1}"
```

Replace the `sed` block with:

```bash
sed -e "s#@ROBOT_ID@#${ROBOT_ID}#g" \
    -e "s#@THING_NAME@#${THING_NAME}#g" \
    -e "s#@ROS_ENABLED@#${ROS_ENABLED}#g" \
    -e "s#@IOT_ENDPOINT@#${ENDPOINT}#g" \
    -e "s#@CERT@#${CERT}#g" \
    -e "s#@KEY@#${KEY}#g" \
    -e "s#@CA@#${CA}#g" \
    "${UNIT_SRC}" \
  | ssh "${SSH_HOST}" "sudo tee /etc/systemd/system/guidemate-bridge.service >/dev/null"
```

And change the final log line to expect the new signals:

```bash
echo ">> Recent logs (expect 'bridge connected', 'shadow reconciled', heartbeat lines)"
ssh "${SSH_HOST}" "journalctl -u guidemate-bridge -n 40 --no-pager"
```

- [ ] **Step 3: Write the gated integration tests (heartbeat + refusal-gates evidence)**

`agent_service/tests/integration/test_robot_truth.py`:

```python
"""Phase 2 evidence vs the REAL robot 468 (docked, dry-run — zero motion).

Gated: set GUIDEMATE_INTEGRATION=1. Requires the Phase-2 bridge deployed and
running on the Pi (Task 6 Step 4).
"""
import subprocess
import time

import pytest

from guidemate_msgs.messages import Command

from guidemate_agent.mqtt_link import RobotRegistry


def _discover_endpoint() -> str:
    out = subprocess.check_output(
        ["aws", "iot", "describe-endpoint", "--endpoint-type", "iot:Data-ATS",
         "--query", "endpointAddress", "--output", "text"],
        text=True,
    )
    return out.strip()


@pytest.fixture(scope="module")
def registry():
    reg = RobotRegistry(
        endpoint=_discover_endpoint(), region="us-west-2",
        robot_ids=["turtlebot468"],
    )
    reg.connect()
    return reg


@pytest.mark.integration
def test_heartbeat_arrives_within_35s(registry):
    # Heartbeats are every 30 s (plus one immediately on bridge start).
    deadline = time.time() + 35.0
    status = {}
    while time.time() < deadline:
        status = registry.get_status("turtlebot468")
        if status.get("last_heartbeat"):
            break
        time.sleep(1.0)
    assert status.get("last_heartbeat"), "no heartbeat from turtlebot468 within 35 s"
    assert status["presence"] == "online"
    gates = status["gates"]
    assert gates["dry_run"] is True          # env=1 on the Pi — locked
    assert gates["motion_enabled"] is False  # shadow desired — locked
    # battery/docked are floats/bools when the rclpy layer sees the topics,
    # None under the documented Discovery-Server fallback — both are valid here;
    # the strong assertion lives in the journal check (Task 6 Step 5).
    assert "battery" in status and "docked" in status


@pytest.mark.integration
def test_motion_command_dry_run_ack_carries_gate_state(registry):
    # Spec item 4 evidence WITHOUT disabling dry-run on the real robot: the ack's
    # gates field shows exactly which locks would have refused the motion.
    cmd = Command(type="motion", name="spin")
    acks = registry.send_command("turtlebot468", cmd, timeout_s=10.0, collect_all=True)
    assert acks, "no acks — robot unreachable"
    states = {a.state for a in acks}
    assert "done" in states  # dry-run executes simulated (DRY-RUN twists in the journal)
    last = [a for a in acks if a.state == "done"][0]
    assert last.simulated is True
    assert last.gates is not None
    assert last.gates["dry_run"] is True
    assert last.gates["motion_enabled"] is False
    assert "docked" in last.gates  # True when telemetry sees the dock, None on fallback
```

- [ ] **Step 4: Redeploy the bridge to the Pi**

Run: `cd ~/cs7980/cs7980-guide-mate && git status --short`
Expected: clean (Tasks 1–5 committed — the installer deploys via `git pull` on the Pi, so everything must be committed. The branch must also be pushed for the Pi to pull it; if the coordinator's no-push rule is still in force, ask before pushing — deploy is blocked without it).

Then: `bash src/guide_mate_bridge/scripts/install_bridge_on_pi.sh`
Expected: ends with journal lines including `"msg": "bridge connected"`, `"msg": "shadow reconciled: desired keys ['dry_run', 'max_speed', 'motion_enabled'] -> gates {'docked': None, 'motion_enabled': False, 'dry_run': True}"`, `"msg": "telemetry ROS node up"` (or the documented rclpy fallback warning), and at least one `"msg": "heartbeat"` line.

- [ ] **Step 5: Verify telemetry empirically (journal shows battery values — or document the fallback)**

Wait ~60 s for a couple of heartbeats, then:

```bash
ssh guidemate "journalctl -u guidemate-bridge -n 60 --no-pager | grep '\"heartbeat\"'"
```

Expected (telemetry working): heartbeat JSON log lines carrying `"battery": 0.9...` and `"docked": true`.
**Fallback:** if the lines carry no battery/docked keys (log_extra drops Nones → the rclpy node isn't receiving; Discovery-Server cross-discovery failed even under systemd), this is the documented accepted degradation — heartbeats still prove liveness/uptime/gates. Record which outcome occurred in Step 8's doc update, plus the systemd-run probe results from Task 4 Step 1.

- [ ] **Step 6: Run the gated integration tests (items 4 + 5 evidence)**

Run: `cd ~/cs7980/cs7980-guide-mate && GUIDEMATE_INTEGRATION=1 .venv/bin/python -m pytest agent_service/tests/integration/test_robot_truth.py -q`
Expected: PASS (2 passed). Also confirm the Phase-1 round-trip still passes against the Phase-2 bridge (shadow-denial tolerance on the dev cert):
`GUIDEMATE_INTEGRATION=1 .venv/bin/python -m pytest agent_service/tests/integration/test_roundtrip.py -q`
Expected: PASS (1 passed).

- [ ] **Step 7: Shadow drill (item 2) — `desired.max_speed` ONLY, never `motion_enabled`**

```bash
# 1. Baseline: current desired + reported
aws iot-data get-thing-shadow --thing-name Turtlebot-468 /dev/stdout | python3 -m json.tool

# 2. Tighten desired.max_speed 0.15 -> 0.10 (STRICTER only; do NOT touch motion_enabled)
aws iot-data update-thing-shadow --thing-name Turtlebot-468 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"state":{"desired":{"max_speed":0.10}}}' /dev/stdout && echo

# 3. The delta handler should apply + re-report within seconds
sleep 5
aws iot-data get-thing-shadow --thing-name Turtlebot-468 /dev/stdout | python3 -m json.tool
```
Expected after step 3: `state.reported.max_speed == 0.10` (and `state.delta` is gone — desired and reported agree).

```bash
# 4. Restart survival: reported must re-converge from a cold start
ssh guidemate 'sudo systemctl restart guidemate-bridge'
sleep 20
aws iot-data get-thing-shadow --thing-name Turtlebot-468 /dev/stdout | python3 -m json.tool
```
Expected: `state.reported.max_speed` still `0.10`, fresh `uptime_s` near 0 — the bridge re-read desired on boot. Also verify the restart used the graceful path:

```bash
ssh guidemate "journalctl -u guidemate-bridge -n 200 --no-pager | grep 'shutting down gracefully'"
```
Expected: one match (from the SIGTERM systemctl sent).

```bash
# 5. Revert the drill
aws iot-data update-thing-shadow --thing-name Turtlebot-468 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"state":{"desired":{"max_speed":0.15}}}' /dev/stdout && echo
sleep 5
aws iot-data get-thing-shadow --thing-name Turtlebot-468 /dev/stdout | python3 -m json.tool
```
Expected: `state.reported.max_speed` back to `0.15`. Final check that the robot never budged: `ssh guidemate "journalctl -u guidemate-bridge --no-pager | grep -c 'DRY-RUN twist'"` returns a number (all executions simulated) and the shadow's `desired.motion_enabled` is still `false` in every get-thing-shadow output above.

- [ ] **Step 8: Document the Phase 2 verification in access-ground-truth.md**

Append to `docs/agent-poc/access-ground-truth.md` (below the Phase 0-1 dev-resources section), filling in the observed values from Steps 4–7:

```markdown
## Phase 2 "robot truth" verification (2026-07-05)
No new AWS resources (shadow + robot policy already existed). Evidence captured:
| Check | Result |
|---|---|
| Heartbeats on `guidemate/turtlebot468/status` | every 30 s: battery=<observed or null>, docked=<observed or null>, uptime, gates |
| Telemetry rclpy layer | <"battery/dock readable from the systemd bridge" OR "Discovery-Server fallback: battery/docked=null (probe results: ...)"> |
| Shadow drill (`desired.max_speed` 0.15→0.10→0.15) | reported followed both ways in <observed> s; `motion_enabled` untouched (false throughout) |
| Restart persistence | `systemctl restart` → graceful shutdown logged, reported re-converged to desired on boot |
| Refusal evidence (item 4, dry-run held) | motion ack `gates={docked: <observed>, motion_enabled: false, dry_run: true}`, `simulated=true` |
| Dev-cert bridge vs shadow topics | subscribe denied → defaults locked, no shadow publishes (Phase-1 devtest round-trip still green) |
```

- [ ] **Step 9: Run the full default suite one last time**

Run: `cd ~/cs7980/cs7980-guide-mate && .venv/bin/python -m pytest -q`
Expected: PASS; integration/live skipped without their env gates.

- [ ] **Step 10: Commit**

```bash
cd ~/cs7980/cs7980-guide-mate
git add src/guide_mate_bridge/systemd/guidemate-bridge.service \
  src/guide_mate_bridge/scripts/install_bridge_on_pi.sh \
  agent_service/tests/integration/test_robot_truth.py \
  docs/agent-poc/access-ground-truth.md
git commit -m "Kalhar: Pi redeploy with ROS env + robot-truth integration tests + shadow drill evidence"
```

---

## Phase 2 exit checklist (verify before declaring done)

- [ ] **Item 5 (telemetry):** battery/dock (or the documented null-fallback) visible via `/status` heartbeats every 30 s; `get_status` on the registry returns presence/battery/docked/gates; heartbeat integration test green.
- [ ] **Item 2 (shadow):** `desired.max_speed` drill reconciled `desired→reported` live (delta) and across a bridge restart; `motion_enabled` never touched, `false` throughout.
- [ ] **Item 4 (refusals):** unit tests prove `failed/"docked"` and `failed/"motion_disabled"` when not dry-run, `stop` always accepted; on the real robot the ack `gates` field shows the locked state with `simulated=true` (dry-run never disabled).
- [ ] Non-terminal acks carry `simulated` + `gates` (Phase-1 review fix landed).
- [ ] Graceful SIGTERM: offline(graceful) → final reported → disconnect (journal + unit test).
- [ ] Robot 468: docked the whole time, `GUIDEMATE_DRY_RUN=1` in the unit, zero `cmd_vel` publishers in the codebase, shadow `desired.motion_enabled` still `false`.
- [ ] Full default suite green; Phase-1 devtest round-trip still green.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-05-dog-agent-phase-2.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
