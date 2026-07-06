# Dog Agent POC — Phase 6 (Autonomy + Maps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Robert a life of his own — robot events (low battery, going offline) and a daily scheduled job make the dog take an agent turn *without a user message* on a dedicated `system-autonomy` session, and add a read-only admin **Maps** tab that renders the robot's last-saved SLAM map uploaded from the Pi to S3.

**Architecture:** A pure, unit-tested debounce rule engine (`autonomy.py`) sits behind an `EventEngine` that the FastAPI `lifespan` registers as a callback on `RobotRegistry` (new `on_event` hook) and drives from an APScheduler cron job. Firing a rule calls the existing `DogAgent.chat(...)` with `system_event=` and `allow_motion=False` (motion tools excluded from autonomy turns — safety), persisting the turn to the `guidemate-messages` table under `session_id="system-autonomy"` so it shows in the admin Sessions tab. Maps are operator-uploaded from this box by `scripts/upload_map_from_pi.sh` (SSH probe → Pillow `pgm`→`png` → new `guidemate-maps-852373397000` bucket); the admin Maps tab streams the PNG back through the service (boto3, same-origin — CSP-safe).

**Tech Stack:** Python 3.10, pydantic v2, FastAPI, APScheduler (`apscheduler`), Pillow (`pillow`), boto3/S3, awscrt MQTT (existing `RobotRegistry`), pytest, Playwright.

## Global Constraints

Every task's requirements implicitly include this section. **Copied forward verbatim from the Phase 0 & 1 plan; the pinned prior-phase interfaces below are Phase-6-specific.**

- **Python 3.10-compatible** on both machines — no 3.11+ syntax (no `X | Y` in `isinstance`, no `tomllib`, etc.). `list[...]`/`dict[...]` generics are fine (they work at 3.10 with `from __future__ import annotations`).
- **pydantic v2** (`>=2`); use `model_validate_json` / `model_dump_json` / `model_validate` / `model_dump` / `field_validator` / `model_validator`.
- **TDD**: write the failing test first, run it red, implement the minimum, run it green, then commit — every task.
- **Commit after every task** with a `Kalhar:` message prefix. **NEVER** add any Claude/AI/co-author line or `Co-Authored-By`. Do not push (the user pushes).
- **Never `pkill -f`** anything on the Pi (gotcha #6 — it self-matches the shell). Kill by PID or `ps comm` if ever needed; this plan never kills.
- **Robot 468 stays docked and motion-locked**: this phase never publishes `cmd_vel` and never touches the Device Shadow. Autonomy turns are motion-tool-free by construction (`allow_motion=False`); the map upload is a read-only SSH `scp`.
- **No credentials or IoT endpoints committed** to the repo. The IoT data endpoint is always discovered at runtime via `aws iot describe-endpoint --endpoint-type iot:Data-ATS`. Cert/key files stay out of git.
- **On-Pi work over SSH is additive only** — never modify existing bringup, services, or configs. The map upload script only *reads* files off the Pi via `scp`; it writes nothing on the Pi.
- **Every new AWS resource** is tagged `project=guidemate-poc` where the API supports tags and documented in `docs/agent-poc/access-ground-truth.md`.
- **Integration/live tests are env-gated** (`GUIDEMATE_INTEGRATION=1`, `GUIDEMATE_LIVE=1`, `GUIDEMATE_E2E=1`) and skipped by default.

**Verified environment facts (do not re-derive):** AWS account `852373397000`, region `us-west-2`; creds work via `credential_process` (identity `guidemate-agent-role`, AdministratorAccess); AWS CLI v2 at `~/.local/bin/aws`. Bedrock model id `us.anthropic.claude-sonnet-4-6`. SSH alias `guidemate` → Pi (`ubuntu`, passwordless sudo). Dev venv at `~/cs7980-guide-mate/.venv`.

### Consumed from prior phases (pinned interfaces — assume these exist; this phase builds on them)

- **Phase 2** (`agent_service/guidemate_agent/mqtt_link.py`, `shared/guidemate_msgs/guidemate_msgs/messages.py`):
  - `RobotRegistry` (already in the repo) with `connect()`, `send_command(...)`, `get_status(robot_id) -> dict`, and a private `_on_status(topic, payload, dup, qos, retain, **kwargs)` that parses **online/offline events** and per-robot state. Phase 2 additionally parses a **`Heartbeat`** message (published to the status topic every 30 s). `Heartbeat` is a pydantic model in `guidemate_msgs.messages` with fields `robot_id: str`, `battery: float` (0.0–1.0), `docked: bool`, `uptime_s: float`, `gates: dict`, `ts: str`. A heartbeat arrives on the status stream as a JSON dict carrying a top-level `battery` float; an offline event arrives as `{"event": "offline", "robot_id": ...}`. **Task 2 adds the `on_event` callback hook to `RobotRegistry`** — that is this phase's integration point.
- **Phase 3** (`agent_service/guidemate_agent/store.py`, `agent_service/guidemate_agent/admin.py`, `agent_service/static/admin.html`):
  - `store.py`: `class Store` wrapping the DynamoDB tables `guidemate-config` / `guidemate-sessions` / `guidemate-messages`. This phase consumes `Store.ensure_session(session_id: str, name: str) -> None` (idempotent create; used so `system-autonomy` shows in the Sessions tab) and, in the env-gated integration test only, `Store.list_messages(session_id: str) -> list[dict]`.
  - `admin.py`: `router = APIRouter()` mounted by `app.py` under prefix `/api/admin`, plus a FastAPI dependency `admin_required` (validates the signed HttpOnly session cookie) and a login route `POST /api/admin/login` taking form field `password` (compared against env `GUIDEMATE_ADMIN_PASSWORD`). This phase **adds routes to this router**.
  - `static/admin.html`: a tabbed admin UI. Tabs are `<section class="tab-panel" id="tab-...">` toggled by nav buttons; a `showTab(name)` JS helper un-hides the panel. This phase **adds a Maps tab** to that markup.
- **Phase 4** (`agent_service/guidemate_agent/dog_agent.py`, `agent_service/guidemate_agent/app.py`):
  - `DogAgent.chat(message: Optional[str], session_id: str, robot_id: Optional[str] = None, system_event: Optional[str] = None, allow_motion: bool = True) -> dict`. When `message is None and system_event` is set, the agent takes a turn driven by the system event (no user message) and **persists the resulting messages to `guidemate-messages` under `session_id`**. When `allow_motion=False`, motion tools (`run_motion`, `stop`) are omitted from the model's tool list; `send_emote` remains subject to the Phase 3 feature flags.
  - `app.py` `lifespan` sets `app.state.registry` (a `RobotRegistry`), `app.state.agent` (a `DogAgent`), `app.state.store` (a `Store`), and reads a `Config` (see `config.py`: `cfg.robot_ids`, `cfg.region`, `cfg.iot_endpoint`, `cfg.model_id`). This phase **extends `lifespan`** additively.

---

## File Structure

```
cs7980-guide-mate/
├── agent_service/
│   ├── pyproject.toml                         # MODIFY (Task 3, Task 4) — add apscheduler, pillow
│   ├── guidemate_agent/
│   │   ├── autonomy.py                         # NEW (Task 1 debounce+rules, Task 2 EventEngine)
│   │   ├── maps.py                             # NEW (Task 4 conversion + keys, Task 5 fetch)
│   │   ├── mqtt_link.py                        # MODIFY (Task 2) — add on_event hook + dispatch
│   │   ├── admin.py                            # MODIFY (Task 3 synthetic-event, Task 5 map routes) [Phase 3 file]
│   │   └── app.py                              # MODIFY (Task 3 engine+scheduler, Task 5 s3) [Phase 4 file]
│   ├── static/admin.html                       # MODIFY (Task 5) — Maps tab [Phase 3 file]
│   └── tests/
│       ├── test_autonomy.py                     # NEW (Task 1 debounce, Task 2 EventEngine)
│       ├── test_mqtt_link.py                     # MODIFY (Task 2) — on_event dispatch test [Phase 0/2 file]
│       ├── test_maps.py                          # NEW (Task 4 conversion, Task 5 fetch+endpoint)
│       ├── test_admin_autonomy.py                # NEW (Task 3) — synthetic-event endpoint + wiring
│       ├── integration/
│       │   └── test_autonomy_roundtrip.py        # NEW (Task 3) — gated: synthetic event -> message in DynamoDB
│       └── e2e/
│           └── test_admin_maps.py                # NEW (Task 5) — Playwright, gated GUIDEMATE_E2E=1
├── scripts/
│   └── upload_map_from_pi.sh                     # NEW (Task 4) — operator-run map uploader
└── docs/agent-poc/access-ground-truth.md         # MODIFY (Task 4) — record the new bucket
```

---

## Task 1: Autonomy rules — low-battery debounce (pure logic)

**Files:**
- Create: `agent_service/guidemate_agent/autonomy.py`
- Test: `agent_service/tests/test_autonomy.py`

**Interfaces:**
- Consumes: nothing (pure logic).
- Produces:
  - `class LowBatteryDebouncer(fire_below: float = 0.15, reset_above: float = 0.25)` with `update(battery: float) -> bool` — returns `True` **exactly on the transition** where battery first drops below `fire_below` while armed; then stays disarmed (returns `False`) until battery recovers **above** `reset_above`, which re-arms it. One instance per robot.
  - Module constants `FIRE_BELOW = 0.15`, `RESET_ABOVE = 0.25`, `AUTONOMY_SESSION_ID = "system-autonomy"`, `AUTONOMY_SESSION_NAME = "System (autonomy)"`.
  - `RULES` — the rule set expressed as **data** (a tuple of dicts), consumed by the `EventEngine` in Task 2:
    ```python
    (
        {"name": "low_battery", "kind": "threshold", "field": "battery",
         "fire_below": FIRE_BELOW, "reset_above": RESET_ABOVE},
        {"name": "robot_offline", "kind": "event", "event": "offline"},
    )
    ```

- [ ] **Step 1: Write the failing test**

`agent_service/tests/test_autonomy.py`:
```python
from guidemate_agent.autonomy import (
    AUTONOMY_SESSION_ID,
    FIRE_BELOW,
    RESET_ABOVE,
    RULES,
    LowBatteryDebouncer,
)


def test_constants():
    assert FIRE_BELOW == 0.15
    assert RESET_ABOVE == 0.25
    assert AUTONOMY_SESSION_ID == "system-autonomy"


def test_rules_are_data_with_expected_names():
    names = {rule["name"] for rule in RULES}
    assert names == {"low_battery", "robot_offline"}


def test_fires_once_on_crossing_below():
    d = LowBatteryDebouncer()
    assert d.update(0.30) is False   # armed, above threshold -> nothing
    assert d.update(0.12) is True    # crosses below -> fire
    assert d.update(0.10) is False   # still low, already fired -> no repeat
    assert d.update(0.14) is False   # still below -> no repeat


def test_rearms_only_after_recovery_above_reset():
    d = LowBatteryDebouncer()
    assert d.update(0.12) is True    # fire
    assert d.update(0.20) is False   # above fire_below but NOT above reset_above -> stay disarmed
    assert d.update(0.12) is False   # dipped again while disarmed -> no fire
    assert d.update(0.30) is False   # recovers above reset_above -> re-arm (no fire on the way up)
    assert d.update(0.12) is True    # next crossing fires again


def test_exactly_at_boundaries():
    d = LowBatteryDebouncer()
    assert d.update(0.15) is False   # not strictly below fire_below
    assert d.update(0.149) is True   # strictly below -> fire
    assert d.update(0.25) is False   # not strictly above reset_above -> stay disarmed
    assert d.update(0.2501) is False # re-arms, no fire on recovery
    assert d.update(0.149) is True   # fires again
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_autonomy.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_agent.autonomy'`.

- [ ] **Step 3: Implement `autonomy.py` (debounce + rule data only)**

`agent_service/guidemate_agent/autonomy.py`:
```python
"""Autonomy: data-driven rules + a debounced low-battery detector.

Phase 6, part 1 — pure logic only (no agent/registry coupling; that arrives in the
EventEngine below in Task 2). Rules are DATA, not code.
"""
from __future__ import annotations

FIRE_BELOW = 0.15
RESET_ABOVE = 0.25
AUTONOMY_SESSION_ID = "system-autonomy"
AUTONOMY_SESSION_NAME = "System (autonomy)"

# Rules expressed as data so thresholds/events are tunable without touching dispatch code.
RULES = (
    {
        "name": "low_battery",
        "kind": "threshold",
        "field": "battery",
        "fire_below": FIRE_BELOW,
        "reset_above": RESET_ABOVE,
    },
    {
        "name": "robot_offline",
        "kind": "event",
        "event": "offline",
    },
)


class LowBatteryDebouncer:
    """Fire once per crossing below `fire_below`; re-arm only after recovery above `reset_above`."""

    def __init__(self, fire_below: float = FIRE_BELOW, reset_above: float = RESET_ABOVE) -> None:
        self._fire_below = fire_below
        self._reset_above = reset_above
        self._armed = True

    def update(self, battery: float) -> bool:
        if self._armed and battery < self._fire_below:
            self._armed = False
            return True
        if not self._armed and battery > self._reset_above:
            self._armed = True
        return False
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_autonomy.py -q`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/autonomy.py agent_service/tests/test_autonomy.py
git commit -m "Kalhar: autonomy low-battery debounce + data-driven rule set"
```

---

## Task 2: EventEngine dispatch + RobotRegistry `on_event` hook

**Files:**
- Modify: `agent_service/guidemate_agent/autonomy.py` (add `EventEngine`)
- Modify: `agent_service/guidemate_agent/mqtt_link.py` (add `on_event` registration + dispatch)
- Test: `agent_service/tests/test_autonomy.py` (add EventEngine tests), `agent_service/tests/test_mqtt_link.py` (add dispatch test)

**Interfaces:**
- Consumes: `LowBatteryDebouncer`, `AUTONOMY_SESSION_ID`, `AUTONOMY_SESSION_NAME`, `FIRE_BELOW`, `RESET_ABOVE` (Task 1); Phase 3 `Store.ensure_session`; Phase 4 `DogAgent.chat(message=None, session_id=..., robot_id=..., system_event=..., allow_motion=False)`.
- Produces:
  - `class EventEngine(agent, store, default_robot_id: Optional[str], session_id: str = AUTONOMY_SESSION_ID, fire_below: float = FIRE_BELOW, reset_above: float = RESET_ABOVE)`. Public attrs `session_id`, `default_robot_id`.
    - `on_status_event(event: dict) -> Optional[str]` — the callback registered on `RobotRegistry`. `event` is `{"robot_id": str, "data": dict}`. Returns the name of the rule that fired (`"low_battery"` / `"robot_offline"`) or `None`.
    - `morning_stretch() -> str` — the APScheduler job body; fires a `"morning_stretch"` turn on the default robot. Returns `"morning_stretch"`.
  - `RobotRegistry.on_event(callback: Callable[[dict], None]) -> None` — register a callback invoked once per parsed status message with `{"robot_id": str, "data": dict}` (dispatch failures are logged, never raised).

- [ ] **Step 1: Write the failing EventEngine tests**

Append to `agent_service/tests/test_autonomy.py`:
```python
from guidemate_agent.autonomy import AUTONOMY_SESSION_NAME, EventEngine


class FakeAgent:
    def __init__(self):
        self.calls = []

    def chat(self, message=None, session_id=None, robot_id=None,
             system_event=None, allow_motion=True):
        self.calls.append(
            {
                "message": message,
                "session_id": session_id,
                "robot_id": robot_id,
                "system_event": system_event,
                "allow_motion": allow_motion,
            }
        )
        return {"reply_text": "woof", "emote": "happy"}


class FakeStore:
    def __init__(self):
        self.ensured = []

    def ensure_session(self, session_id, name):
        self.ensured.append((session_id, name))


def _engine():
    agent, store = FakeAgent(), FakeStore()
    return EventEngine(agent=agent, store=store, default_robot_id="turtlebot468"), agent, store


def test_low_battery_event_fires_motion_free_turn():
    engine, agent, store = _engine()
    fired = engine.on_status_event({"robot_id": "turtlebot468", "data": {"battery": 0.12}})
    assert fired == "low_battery"
    assert len(agent.calls) == 1
    call = agent.calls[0]
    assert call["message"] is None
    assert call["session_id"] == "system-autonomy"
    assert call["robot_id"] == "turtlebot468"
    assert call["allow_motion"] is False           # motion tools excluded from autonomy turns
    assert "battery" in call["system_event"].lower()
    assert store.ensured == [("system-autonomy", AUTONOMY_SESSION_NAME)]


def test_low_battery_debounced_across_heartbeats():
    engine, agent, _ = _engine()
    engine.on_status_event({"robot_id": "turtlebot468", "data": {"battery": 0.12}})
    engine.on_status_event({"robot_id": "turtlebot468", "data": {"battery": 0.11}})  # still low
    assert len(agent.calls) == 1  # only the crossing fired


def test_low_battery_is_per_robot():
    engine, agent, _ = _engine()
    engine.on_status_event({"robot_id": "turtlebot468", "data": {"battery": 0.12}})
    engine.on_status_event({"robot_id": "turtlebotsim", "data": {"battery": 0.12}})
    assert {c["robot_id"] for c in agent.calls} == {"turtlebot468", "turtlebotsim"}


def test_offline_event_fires():
    engine, agent, _ = _engine()
    fired = engine.on_status_event(
        {"robot_id": "turtlebot468", "data": {"event": "offline", "robot_id": "turtlebot468"}}
    )
    assert fired == "robot_offline"
    assert "offline" in agent.calls[0]["system_event"].lower()
    assert agent.calls[0]["allow_motion"] is False


def test_heartbeat_without_battery_does_nothing():
    engine, agent, _ = _engine()
    fired = engine.on_status_event({"robot_id": "turtlebot468", "data": {"docked": True}})
    assert fired is None
    assert agent.calls == []


def test_online_event_is_not_a_rule():
    engine, agent, _ = _engine()
    fired = engine.on_status_event(
        {"robot_id": "turtlebot468", "data": {"event": "online", "robot_id": "turtlebot468"}}
    )
    assert fired is None
    assert agent.calls == []


def test_morning_stretch_fires_motion_free_emote_turn():
    engine, agent, _ = _engine()
    assert engine.morning_stretch() == "morning_stretch"
    assert agent.calls[0]["allow_motion"] is False
    assert agent.calls[0]["session_id"] == "system-autonomy"
    assert "stretch" in agent.calls[0]["system_event"].lower()


def test_engine_survives_agent_exception():
    class BoomAgent(FakeAgent):
        def chat(self, **kwargs):
            raise RuntimeError("bedrock down")

    engine = EventEngine(agent=BoomAgent(), store=FakeStore(), default_robot_id="turtlebot468")
    # A firing rule must not propagate the agent error to the MQTT callback thread.
    assert engine.on_status_event({"robot_id": "turtlebot468", "data": {"battery": 0.12}}) == "low_battery"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_autonomy.py -q`
Expected: FAIL — `ImportError: cannot import name 'EventEngine'`.

- [ ] **Step 3: Implement `EventEngine` in `autonomy.py`**

Append to `agent_service/guidemate_agent/autonomy.py` (add the imports at the top of the file with the other imports):
```python
import logging
from typing import Optional

log = logging.getLogger(__name__)
```

Then append the class:
```python
class EventEngine:
    """Turns robot status events + scheduled jobs into unprompted, motion-free agent turns."""

    def __init__(
        self,
        agent,
        store,
        default_robot_id: Optional[str],
        session_id: str = AUTONOMY_SESSION_ID,
        fire_below: float = FIRE_BELOW,
        reset_above: float = RESET_ABOVE,
    ) -> None:
        self._agent = agent
        self._store = store
        self.default_robot_id = default_robot_id
        self.session_id = session_id
        self._fire_below = fire_below
        self._reset_above = reset_above
        self._debouncers: dict[str, LowBatteryDebouncer] = {}

    def _debouncer(self, robot_id: str) -> LowBatteryDebouncer:
        return self._debouncers.setdefault(
            robot_id, LowBatteryDebouncer(self._fire_below, self._reset_above)
        )

    def on_status_event(self, event: dict) -> Optional[str]:
        robot_id = event.get("robot_id") or self.default_robot_id or "?"
        data = event.get("data") or {}

        if data.get("event") == "offline":
            self._fire(
                "robot_offline",
                robot_id,
                f"Robot {robot_id} just went offline — it dropped its connection.",
            )
            return "robot_offline"

        battery = data.get("battery")
        if isinstance(battery, (int, float)) and self._debouncer(robot_id).update(float(battery)):
            self._fire(
                "low_battery",
                robot_id,
                f"Robot {robot_id}'s battery is low ({float(battery) * 100:.0f}%). "
                "It should return to its dock soon.",
            )
            return "low_battery"
        return None

    def morning_stretch(self) -> str:
        robot_id = self.default_robot_id or "?"
        self._fire(
            "morning_stretch",
            robot_id,
            "Good morning! It's time for your daily morning stretch — "
            "greet everyone warmly and do a happy wiggle emote.",
        )
        return "morning_stretch"

    def _fire(self, rule_name: str, robot_id: str, system_event: str) -> None:
        log.info(
            "autonomy rule fired: %s (robot=%s)",
            rule_name,
            robot_id,
            extra={"robot_id": robot_id, "session_id": self.session_id, "rule": rule_name},
        )
        try:
            # Idempotent — keeps the system session visible in the admin Sessions tab.
            self._store.ensure_session(self.session_id, AUTONOMY_SESSION_NAME)
            # Motion tools are excluded from autonomy turns (allow_motion=False) — safety.
            self._agent.chat(
                message=None,
                session_id=self.session_id,
                robot_id=robot_id,
                system_event=system_event,
                allow_motion=False,
            )
        except Exception:  # noqa: BLE001 — must never break the MQTT callback thread / scheduler
            log.exception("autonomy turn failed for rule %s", rule_name)
```

- [ ] **Step 4: Add the `on_event` hook to `RobotRegistry`**

In `agent_service/guidemate_agent/mqtt_link.py`, add `Callable` to the typing import:
```python
from typing import Callable, Optional
```

In `RobotRegistry.__init__`, after `self._conn = connection`, add:
```python
        self._event_callbacks: list[Callable[[dict], None]] = []
```

Add the registration + dispatch methods (place `on_event` right after `__init__`, and `_dispatch_event` anywhere in the class):
```python
    def on_event(self, callback: Callable[[dict], None]) -> None:
        """Register a callback fired once per parsed status message: {"robot_id", "data"}."""
        with self._lock:
            self._event_callbacks.append(callback)

    def _dispatch_event(self, event: dict) -> None:
        with self._lock:
            callbacks = list(self._event_callbacks)
        for cb in callbacks:
            try:
                cb(event)
            except Exception:  # noqa: BLE001 — one bad callback must not stall the MQTT thread
                log.exception("on_event callback failed")
```

In `_on_status`, immediately after `robot_id` is computed (right after the line
`robot_id = parts[1] if len(parts) >= 2 else "?"`), insert the dispatch so it runs for
**every** status message (heartbeats, presence events, and acks alike):
```python
        self._dispatch_event({"robot_id": robot_id, "data": data})
```

- [ ] **Step 5: Add the registry dispatch test**

Append to `agent_service/tests/test_mqtt_link.py`:
```python
def test_on_event_callback_receives_parsed_status():
    reg, fake = _registry()
    seen = []
    reg.on_event(seen.append)
    fake.status_cb(
        topic=status_topic("turtlebot468"),
        payload=b'{"battery": 0.12, "docked": true}',
        dup=False,
        qos=1,
        retain=False,
    )
    assert seen == [{"robot_id": "turtlebot468", "data": {"battery": 0.12, "docked": True}}]


def test_on_event_callback_error_is_swallowed():
    reg, fake = _registry()

    def boom(event):
        raise RuntimeError("callback boom")

    reg.on_event(boom)
    # Must not raise out of the MQTT status callback.
    fake.status_cb(
        topic=status_topic("turtlebot468"),
        payload=b'{"event": "offline", "robot_id": "turtlebot468"}',
        dup=False,
        qos=1,
        retain=False,
    )
```

Note: `_registry()`, `status_topic`, and the `FakeConnection` whose `status_cb` this test drives are already defined in `test_mqtt_link.py` (Phase 0/2). If `FakeConnection` does not retain `status_cb`, confirm its `subscribe` stores the callback (it does in the Phase 0 fixture).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_autonomy.py agent_service/tests/test_mqtt_link.py -q`
Expected: PASS (all autonomy + mqtt_link tests green).

- [ ] **Step 7: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/autonomy.py agent_service/guidemate_agent/mqtt_link.py \
  agent_service/tests/test_autonomy.py agent_service/tests/test_mqtt_link.py
git commit -m "Kalhar: EventEngine dispatch + RobotRegistry on_event hook"
```

---

## Task 3: Wire EventEngine + APScheduler into `lifespan`, add synthetic-event endpoint

**Files:**
- Modify: `agent_service/pyproject.toml` (add `apscheduler` dep)
- Modify: `agent_service/guidemate_agent/app.py` (wire engine + scheduler into `lifespan`)
- Modify: `agent_service/guidemate_agent/admin.py` (add `POST /api/admin/synthetic-event`) [Phase 3 file]
- Test: `agent_service/tests/test_admin_autonomy.py` (endpoint + wiring, not gated)
- Test: `agent_service/tests/integration/test_autonomy_roundtrip.py` (gated: real turn recorded in DynamoDB)

**Interfaces:**
- Consumes: `EventEngine` (Task 2); Phase 3 `admin.py` `router` + `admin_required`; Phase 4 `app.py` `lifespan` (`app.state.agent`, `app.state.store`, `Config`).
- Produces:
  - `app.state.engine: EventEngine`, registered as `registry.on_event(engine.on_status_event)` and driven by an APScheduler `BackgroundScheduler` cron job (daily 09:00 local) calling `engine.morning_stretch`. Scheduler stored as `app.state.scheduler` and shut down on lifespan exit.
  - Admin route `POST /api/admin/synthetic-event` accepting `{"type": "low_battery"|"robot_offline", "battery": float|null, "robot_id": str|null}` → injects a synthetic status through `engine.on_status_event(...)` (the same path a real heartbeat/offline takes) → returns `{"fired": <rule name or null>, "session_id": <session id>}`. **This is checklist item 6's evidence — no robot change needed.**

- [ ] **Step 1: Add the `apscheduler` dependency**

In `agent_service/pyproject.toml`, add `"apscheduler"` to the `dependencies` list:
```toml
dependencies = [
    "fastapi",
    "uvicorn[standard]",
    "strands-agents",
    "awsiotsdk",
    "boto3",
    "apscheduler",
    "guidemate-msgs",
]
```
Then reinstall so the venv picks it up:
```bash
cd ~/cs7980-guide-mate && .venv/bin/pip install -e agent_service apscheduler
```
Expected: `apscheduler` installed; editable `guidemate-agent` unchanged.

- [ ] **Step 2: Write the failing endpoint/wiring test**

`agent_service/tests/test_admin_autonomy.py`:
```python
"""Synthetic-event admin endpoint + engine wiring (no AWS, no Bedrock)."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from guidemate_agent.admin import router
from guidemate_agent.autonomy import EventEngine


class FakeAgent:
    def __init__(self):
        self.calls = []

    def chat(self, message=None, session_id=None, robot_id=None,
             system_event=None, allow_motion=True):
        self.calls.append({"robot_id": robot_id, "allow_motion": allow_motion})
        return {"reply_text": "woof"}


class FakeStore:
    def ensure_session(self, session_id, name):
        pass


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(router, prefix="/api/admin")
    agent = FakeAgent()
    app.state.agent = agent
    app.state.engine = EventEngine(agent=agent, store=FakeStore(), default_robot_id="turtlebot468")
    with TestClient(app) as c:
        c.app_agent = agent  # stash for assertions
        yield c


def _login(client):
    # Phase 3 admin auth: form login sets the signed session cookie on the client jar.
    import os
    client.post("/api/admin/login", data={"password": os.environ.get("GUIDEMATE_ADMIN_PASSWORD", "test-admin-pw")})


def test_synthetic_low_battery_fires_rule(client, monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "test-admin-pw")
    _login(client)
    res = client.post("/api/admin/synthetic-event", json={"type": "low_battery", "battery": 0.12})
    assert res.status_code == 200
    body = res.json()
    assert body["fired"] == "low_battery"
    assert body["session_id"] == "system-autonomy"
    assert client.app_agent.calls[-1]["allow_motion"] is False


def test_synthetic_offline_fires_rule(client, monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "test-admin-pw")
    _login(client)
    res = client.post("/api/admin/synthetic-event", json={"type": "robot_offline"})
    assert res.json()["fired"] == "robot_offline"


def test_synthetic_unknown_type_is_400(client, monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "test-admin-pw")
    _login(client)
    res = client.post("/api/admin/synthetic-event", json={"type": "nonsense"})
    assert res.status_code == 400


def test_synthetic_event_requires_admin(client):
    # No login -> admin_required rejects.
    res = client.post("/api/admin/synthetic-event", json={"type": "low_battery", "battery": 0.12})
    assert res.status_code in (401, 403)
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_admin_autonomy.py -q`
Expected: FAIL — the `/api/admin/synthetic-event` route does not exist yet (404), so `test_synthetic_low_battery_fires_rule` fails on status code.

- [ ] **Step 4: Add the synthetic-event route to `admin.py`**

At the top of `agent_service/guidemate_agent/admin.py`, ensure these imports are present (add any missing):
```python
from typing import Optional

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel
```

Add the request model and route (append to the module; `router` and `admin_required` already exist from Phase 3):
```python
class SyntheticEvent(BaseModel):
    type: str
    battery: Optional[float] = None
    robot_id: Optional[str] = None


@router.post("/synthetic-event")
def synthetic_event(payload: SyntheticEvent, request: Request, _=Depends(admin_required)) -> dict:
    """Inject a fake robot status through the real autonomy path (checklist item 6)."""
    engine = request.app.state.engine
    robot_id = payload.robot_id or engine.default_robot_id or "turtlebot468"
    if payload.type == "low_battery":
        data = {"battery": payload.battery if payload.battery is not None else 0.10}
    elif payload.type == "robot_offline":
        data = {"event": "offline", "robot_id": robot_id}
    else:
        raise HTTPException(status_code=400, detail=f"unknown synthetic event type {payload.type!r}")
    fired = engine.on_status_event({"robot_id": robot_id, "data": data})
    return {"fired": fired, "session_id": engine.session_id}
```

- [ ] **Step 5: Wire the engine + scheduler into `lifespan`**

In `agent_service/guidemate_agent/app.py`, add imports near the top:
```python
from apscheduler.schedulers.background import BackgroundScheduler

from guidemate_agent.autonomy import EventEngine
```

Inside `lifespan`, **after** `app.state.registry`, `app.state.agent`, and `app.state.store` are set (Phase 4 sets these), and **before** `yield`, add:
```python
    default_robot_id = cfg.robot_ids[0] if cfg.robot_ids else None
    engine = EventEngine(
        agent=app.state.agent,
        store=app.state.store,
        default_robot_id=default_robot_id,
    )
    app.state.engine = engine
    registry.on_event(engine.on_status_event)

    scheduler = BackgroundScheduler(timezone="America/New_York")
    scheduler.add_job(engine.morning_stretch, "cron", hour=9, minute=0, id="morning_stretch")
    scheduler.start()
    app.state.scheduler = scheduler
    log.info("autonomy engine + scheduler started (morning stretch daily 09:00)")
```

Replace the bare `yield` so the scheduler is stopped on shutdown:
```python
    try:
        yield
    finally:
        app.state.scheduler.shutdown(wait=False)
```

Note: `cfg` and `registry` are the local names already bound earlier in the Phase 4 `lifespan`. If Phase 4 named them differently, use its names — the additions only need `app.state.agent`, `app.state.store`, the registry object, and `cfg.robot_ids`.

- [ ] **Step 6: Run the endpoint/wiring test to verify it passes**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_admin_autonomy.py -q`
Expected: PASS (4 passed). (This test builds its own minimal `FastAPI` app with the router + a fake engine, so it exercises the route and `on_status_event` wiring without AWS or Bedrock.)

- [ ] **Step 7: Write the gated integration round-trip test**

`agent_service/tests/integration/test_autonomy_roundtrip.py`:
```python
"""Gated end-to-end: a synthetic low-battery event records a real turn in DynamoDB.

Requires GUIDEMATE_INTEGRATION=1 (real DynamoDB) and live Bedrock creds (the agent turn
calls the model). Run:
    GUIDEMATE_INTEGRATION=1 GUIDEMATE_LIVE=1 .venv/bin/python -m pytest \
      agent_service/tests/integration/test_autonomy_roundtrip.py -q -s
"""
import uuid

import pytest
from fastapi.testclient import TestClient


@pytest.mark.integration
def test_synthetic_event_records_message_in_dynamodb(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "test-admin-pw")
    # Isolate this run's system session so the assertion is unambiguous.
    session_id = f"system-autonomy-itest-{uuid.uuid4().hex[:8]}"
    monkeypatch.setenv("GUIDEMATE_AUTONOMY_SESSION_ID", session_id)

    from guidemate_agent.app import app

    with TestClient(app) as client:
        client.post("/api/admin/login", data={"password": "test-admin-pw"})
        res = client.post(
            "/api/admin/synthetic-event", json={"type": "low_battery", "battery": 0.11}
        )
        assert res.status_code == 200
        assert res.json()["fired"] == "low_battery"

        store = app.state.store
        messages = store.list_messages(app.state.engine.session_id)
        assert messages, "expected the autonomy turn to be persisted to guidemate-messages"
```

Note: this test relies on `EventEngine.session_id` being overridable via env for isolation. Add that support in the next step. `Store.list_messages` is a Phase 3 method; if Phase 3 named the reader differently, adapt the final assertion to it.

- [ ] **Step 8: Make the autonomy session id env-overridable**

In `agent_service/guidemate_agent/app.py`, where the `EventEngine` is constructed (Step 5), pass an env-overridable session id:
```python
    import os
    from guidemate_agent.autonomy import AUTONOMY_SESSION_ID
    engine = EventEngine(
        agent=app.state.agent,
        store=app.state.store,
        default_robot_id=default_robot_id,
        session_id=os.environ.get("GUIDEMATE_AUTONOMY_SESSION_ID", AUTONOMY_SESSION_ID),
    )
```
(Keep the `registry.on_event`, scheduler, and `app.state.engine = engine` lines from Step 5 unchanged; only the `engine = EventEngine(...)` construction gains the `session_id=` argument.)

- [ ] **Step 9: Verify the gated test is skipped by default, then commit**

Run (default — should skip): `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/integration/test_autonomy_roundtrip.py -q`
Expected: `1 skipped` (GUIDEMATE_INTEGRATION unset).

```bash
cd ~/cs7980-guide-mate
git add agent_service/pyproject.toml agent_service/guidemate_agent/app.py \
  agent_service/guidemate_agent/admin.py agent_service/tests/test_admin_autonomy.py \
  agent_service/tests/integration/test_autonomy_roundtrip.py
git commit -m "Kalhar: wire autonomy engine + APScheduler + synthetic-event admin endpoint"
```

---

## Task 4: Maps — S3 bucket, `pgm`→`png` conversion, operator upload script

**Files:**
- Modify: `agent_service/pyproject.toml` (add `pillow` dep)
- Create: `agent_service/guidemate_agent/maps.py` (conversion + S3 key helpers)
- Create: `scripts/upload_map_from_pi.sh` (operator-run uploader)
- Modify: `docs/agent-poc/access-ground-truth.md` (record the new bucket)
- Test: `agent_service/tests/test_maps.py` (conversion round-trip)

**Interfaces:**
- Consumes: nothing (self-contained).
- Produces:
  - `MAPS_BUCKET = "guidemate-maps-852373397000"`, `map_key(robot_id) -> "maps/{robot_id}/latest.png"`, `meta_key(robot_id) -> "maps/{robot_id}/meta.json"`.
  - `pgm_to_png(pgm_path: str, png_path: str) -> None` — opens the SLAM occupancy `.pgm` (Pillow), converts to 8-bit grayscale, writes a PNG.
  - `scripts/upload_map_from_pi.sh [robot_id]` — probes the Pi for the newest saved `.pgm`, `scp`s it, converts locally, writes `meta.json` `{captured_ts, source}`, uploads both to `s3://guidemate-maps-852373397000/maps/<robot_id>/`. Read-only on the Pi.

- [ ] **Step 1: Add the `pillow` dependency**

In `agent_service/pyproject.toml`, add `"pillow"` to `dependencies`:
```toml
    "boto3",
    "apscheduler",
    "pillow",
    "guidemate-msgs",
```
Reinstall:
```bash
cd ~/cs7980-guide-mate && .venv/bin/pip install -e agent_service pillow
```
Expected: `pillow` (PIL) importable.

- [ ] **Step 2: Write the failing conversion test**

`agent_service/tests/test_maps.py`:
```python
import os

from PIL import Image

from guidemate_agent.maps import MAPS_BUCKET, map_key, meta_key, pgm_to_png


def test_key_helpers():
    assert MAPS_BUCKET == "guidemate-maps-852373397000"
    assert map_key("turtlebot468") == "maps/turtlebot468/latest.png"
    assert meta_key("turtlebot468") == "maps/turtlebot468/meta.json"


def test_pgm_to_png_roundtrip(tmp_path):
    pgm = tmp_path / "map.pgm"
    png = tmp_path / "latest.png"
    # A tiny grayscale occupancy grid saved as binary PGM (P5).
    Image.new("L", (6, 4), color=205).save(str(pgm))  # 205 = "unknown" in SLAM maps
    pgm_to_png(str(pgm), str(png))
    assert os.path.exists(png) and os.path.getsize(png) > 0
    with Image.open(str(png)) as out:
        assert out.format == "PNG"
        assert out.size == (6, 4)
        assert out.mode == "L"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_maps.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_agent.maps'`.

- [ ] **Step 4: Implement `maps.py`**

`agent_service/guidemate_agent/maps.py`:
```python
"""S3 map storage helpers + local PGM->PNG conversion for the admin Maps tab."""
from __future__ import annotations

import json

MAPS_BUCKET = "guidemate-maps-852373397000"


def map_key(robot_id: str) -> str:
    return f"maps/{robot_id}/latest.png"


def meta_key(robot_id: str) -> str:
    return f"maps/{robot_id}/meta.json"


def pgm_to_png(pgm_path: str, png_path: str) -> None:
    """Convert a SLAM occupancy-grid .pgm to an 8-bit grayscale PNG."""
    from PIL import Image

    with Image.open(pgm_path) as im:
        im.convert("L").save(png_path, format="PNG")


def fetch_map_png(s3_client, robot_id: str) -> bytes:
    """Read the latest map PNG bytes from S3 (raises the boto3 error if absent)."""
    obj = s3_client.get_object(Bucket=MAPS_BUCKET, Key=map_key(robot_id))
    return obj["Body"].read()


def fetch_map_meta(s3_client, robot_id: str) -> dict:
    """Read the latest map meta.json from S3 (raises the boto3 error if absent)."""
    obj = s3_client.get_object(Bucket=MAPS_BUCKET, Key=meta_key(robot_id))
    return json.loads(obj["Body"].read())
```
(`fetch_map_png`/`fetch_map_meta` are used by the Task 5 endpoint; defined here so the maps module owns all S3 access.)

- [ ] **Step 5: Run the conversion test to verify it passes**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_maps.py -q`
Expected: PASS (2 passed).

- [ ] **Step 6: Create the S3 bucket (tagged, private)**

Run:
```bash
AWS=~/.local/bin/aws
$AWS s3api create-bucket --bucket guidemate-maps-852373397000 \
  --region us-west-2 --create-bucket-configuration LocationConstraint=us-west-2
$AWS s3api put-bucket-tagging --bucket guidemate-maps-852373397000 \
  --tagging 'TagSet=[{Key=project,Value=guidemate-poc}]'
$AWS s3api put-public-access-block --bucket guidemate-maps-852373397000 \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```
Expected: bucket created in `us-west-2`, tagged `project=guidemate-poc`, all public access blocked. (Maps are served **through the service** by boto3 — never public.) If the bucket already exists and is owned by this account, `create-bucket` returns `BucketAlreadyOwnedByYou` — that is fine, continue.

- [ ] **Step 7: Write the operator upload script**

`scripts/upload_map_from_pi.sh`:
```bash
#!/usr/bin/env bash
# Upload robot 468's most-recent saved SLAM map to S3 for the admin Maps tab.
# OPERATOR-RUN from the Linux box (needs SSH to the Pi + AWS creds). ADDITIVE / read-only:
# it only scp's files off the Pi and writes nothing there. Not runnable from the service.
set -euo pipefail

ROBOT_ID="${1:-turtlebot468}"
BUCKET="guidemate-maps-852373397000"
REGION="us-west-2"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
VENV_PY="${REPO}/.venv/bin/python"
AWS="${HOME}/.local/bin/aws"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "[1/5] Probing the Pi for the newest saved map (.pgm)..."
# bfs_explorer auto-saves the map; probe the likely locations, newest first.
PGM_REMOTE="$(ssh guidemate 'ls -t ~/maps/*.pgm ~/*.pgm 2>/dev/null | head -n1' || true)"
if [ -z "${PGM_REMOTE}" ]; then
  echo "    ...not in ~/maps or ~; widening the search under \$HOME (maxdepth 3)..."
  PGM_REMOTE="$(ssh guidemate 'find ~ -maxdepth 3 -name "*.pgm" -printf "%T@ %p\n" 2>/dev/null | sort -rn | head -n1 | cut -d" " -f2-' || true)"
fi
if [ -z "${PGM_REMOTE}" ]; then
  echo "ERROR: no .pgm map found on the Pi. Has a mapping run saved a map yet?" >&2
  echo "       (probe manually: ssh guidemate 'ls -t ~/*.pgm ~/maps/ 2>/dev/null')" >&2
  exit 1
fi
YAML_REMOTE="${PGM_REMOTE%.pgm}.yaml"
echo "    found: ${PGM_REMOTE}"

echo "[2/5] Copying map files to a scratch dir..."
scp "guidemate:${PGM_REMOTE}" "${WORK}/map.pgm"
scp "guidemate:${YAML_REMOTE}" "${WORK}/map.yaml" 2>/dev/null \
  || echo "    (no sidecar .yaml alongside the .pgm; continuing with the image only)"

echo "[3/5] Converting .pgm -> .png locally (Pillow)..."
"${VENV_PY}" -c "from guidemate_agent.maps import pgm_to_png; pgm_to_png('${WORK}/map.pgm', '${WORK}/latest.png')"

echo "[4/5] Writing meta.json..."
CAPTURED_TS="$(date -u +%Y-%m-%dT%H:%M:%S+00:00)"
"${VENV_PY}" - "${WORK}/meta.json" "${PGM_REMOTE}" "${CAPTURED_TS}" <<'PY'
import json, sys
out, source, ts = sys.argv[1], sys.argv[2], sys.argv[3]
with open(out, "w") as f:
    json.dump({"captured_ts": ts, "source": source}, f)
PY

echo "[5/5] Uploading to s3://${BUCKET}/maps/${ROBOT_ID}/ ..."
"${AWS}" s3 cp "${WORK}/latest.png" "s3://${BUCKET}/maps/${ROBOT_ID}/latest.png" \
  --region "${REGION}" --content-type image/png
"${AWS}" s3 cp "${WORK}/meta.json" "s3://${BUCKET}/maps/${ROBOT_ID}/meta.json" \
  --region "${REGION}" --content-type application/json
echo "Done. Refresh the admin Maps tab."
```
Make it executable:
```bash
chmod +x ~/cs7980-guide-mate/scripts/upload_map_from_pi.sh
```

- [ ] **Step 8: Smoke-test the script's syntax (no Pi/S3 side effects)**

Run: `bash -n ~/cs7980-guide-mate/scripts/upload_map_from_pi.sh && echo "syntax OK"`
Expected: `syntax OK`. (A full run requires a saved map on the Pi; that is an operator action, not a plan step.)

- [ ] **Step 9: Document the bucket in `access-ground-truth.md`**

In `docs/agent-poc/access-ground-truth.md`, add a row to the AWS-resources table (the same table that lists the KB docs bucket and IoT policies):
```markdown
| S3 bucket `guidemate-maps-852373397000` | us-west-2, private (public access fully blocked), tag `project=guidemate-poc` | Admin Maps tab storage: `maps/<robot_id>/latest.png` + `maps/<robot_id>/meta.json` `{captured_ts, source}`. Populated by `scripts/upload_map_from_pi.sh` (operator-run from the Linux box); served through the service via boto3 (never public). |
```

- [ ] **Step 10: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/pyproject.toml agent_service/guidemate_agent/maps.py \
  agent_service/tests/test_maps.py scripts/upload_map_from_pi.sh \
  docs/agent-poc/access-ground-truth.md
git commit -m "Kalhar: maps S3 bucket + pgm->png converter + operator upload script"
```

---

## Task 5: Admin Maps tab — streamed-bytes endpoint + UI + Playwright

**Files:**
- Modify: `agent_service/guidemate_agent/app.py` (create the S3 client in `lifespan`)
- Modify: `agent_service/guidemate_agent/admin.py` (add `GET /map/{robot_id}` + `/map/{robot_id}/meta.json`) [Phase 3 file]
- Modify: `agent_service/static/admin.html` (add the Maps tab) [Phase 3 file]
- Test: `agent_service/tests/test_maps.py` (add endpoint tests with a fake S3 client)
- Test: `agent_service/tests/e2e/test_admin_maps.py` (Playwright, gated `GUIDEMATE_E2E=1`)

**Interfaces:**
- Consumes: `fetch_map_png`, `fetch_map_meta`, `map_key` (Task 4); Phase 3 `router` + `admin_required`; Phase 3 `static/admin.html` tab structure (`showTab(name)` helper toggling `<section class="tab-panel" id="tab-...">`); Phase 5 Playwright fixtures `page`, `admin_login`, `base_url` + the `e2e` marker.
- Produces:
  - `GET /api/admin/map/{robot_id}` → `Response(content=<png bytes>, media_type="image/png")`, 404 if no map uploaded. Streamed bytes through boto3 (no presigned URL → nothing external for the page to fetch → CSP-safe).
  - `GET /api/admin/map/{robot_id}/meta.json` → `{"captured_ts": ..., "source": ...}`, 404 if absent.
  - `app.state.s3` — a `boto3.client("s3", region_name=cfg.region)` created in `lifespan`.
  - A read-only Maps tab (image + captured timestamp + a "how to refresh" note pointing at `scripts/upload_map_from_pi.sh`; **no** server-side upload button — the uploader needs SSH and is operator-run).

- [ ] **Step 1: Write the failing endpoint tests**

Append to `agent_service/tests/test_maps.py`:
```python
import io
import json as _json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from guidemate_agent.admin import router


class FakeBody:
    def __init__(self, data: bytes):
        self._data = data

    def read(self):
        return self._data


class FakeS3:
    """Minimal boto3-s3 stand-in: returns preset objects or raises for missing keys."""

    def __init__(self, objects):
        self._objects = objects  # {key: bytes}

    def get_object(self, Bucket, Key):
        if Key not in self._objects:
            raise KeyError(Key)
        return {"Body": FakeBody(self._objects[Key])}


@pytest.fixture()
def map_client(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "test-admin-pw")
    app = FastAPI()
    app.include_router(router, prefix="/api/admin")
    app.state.s3 = FakeS3(
        {
            "maps/turtlebot468/latest.png": b"\x89PNG\r\n\x1a\nFAKEPNGBYTES",
            "maps/turtlebot468/meta.json": _json.dumps(
                {"captured_ts": "2026-07-05T18:00:00+00:00", "source": "/home/ubuntu/maps/map.pgm"}
            ).encode(),
        }
    )
    with TestClient(app) as c:
        c.post("/api/admin/login", data={"password": "test-admin-pw"})
        yield c


def test_get_map_streams_png(map_client):
    res = map_client.get("/api/admin/map/turtlebot468")
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/png"
    assert res.content.startswith(b"\x89PNG")


def test_get_map_meta(map_client):
    res = map_client.get("/api/admin/map/turtlebot468/meta.json")
    assert res.status_code == 200
    assert res.json()["source"].endswith("map.pgm")


def test_get_map_missing_is_404(map_client):
    res = map_client.get("/api/admin/map/turtlebotsim")
    assert res.status_code == 404


def test_get_map_requires_admin():
    app = FastAPI()
    app.include_router(router, prefix="/api/admin")
    app.state.s3 = FakeS3({})
    with TestClient(app) as c:
        res = c.get("/api/admin/map/turtlebot468")  # no login
        assert res.status_code in (401, 403)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_maps.py -q`
Expected: FAIL — the `/api/admin/map/...` routes don't exist yet (404 on the streaming test).

- [ ] **Step 3: Add the map routes to `admin.py`**

Add imports at the top of `agent_service/guidemate_agent/admin.py` (add any missing):
```python
from fastapi import Response
from fastapi.responses import JSONResponse

from guidemate_agent.maps import fetch_map_meta, fetch_map_png
```

Append the routes:
```python
@router.get("/map/{robot_id}")
def get_map(robot_id: str, request: Request, _=Depends(admin_required)) -> Response:
    try:
        png = fetch_map_png(request.app.state.s3, robot_id)
    except Exception:  # noqa: BLE001 — missing key (or any read failure) -> no map yet
        raise HTTPException(status_code=404, detail="no map uploaded for this robot yet")
    return Response(content=png, media_type="image/png")


@router.get("/map/{robot_id}/meta.json")
def get_map_meta(robot_id: str, request: Request, _=Depends(admin_required)) -> JSONResponse:
    try:
        meta = fetch_map_meta(request.app.state.s3, robot_id)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="no map metadata for this robot yet")
    return JSONResponse(meta)
```

- [ ] **Step 4: Create the S3 client in `lifespan`**

In `agent_service/guidemate_agent/app.py`, add `import boto3` near the top (if not already imported), and inside `lifespan` (after `cfg` is read, before `yield`) add:
```python
    app.state.s3 = boto3.client("s3", region_name=cfg.region)
```

- [ ] **Step 5: Run the endpoint tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_maps.py -q`
Expected: PASS (6 passed — 2 from Task 4 + 4 new).

- [ ] **Step 6: Add the Maps tab to `static/admin.html`**

Add a nav button next to the existing admin tab buttons (matching the Phase 3 pattern that calls `showTab`):
```html
<button type="button" onclick="showTab('maps')">Maps</button>
```

Add the panel section (alongside the other `<section class="tab-panel" id="tab-...">` blocks):
```html
<section class="tab-panel" id="tab-maps" hidden>
  <h2>Maps</h2>
  <label>Robot:
    <select id="maps-robot" onchange="loadMap(this.value)">
      <option value="turtlebot468">turtlebot468</option>
    </select>
  </label>
  <p id="maps-timestamp" class="muted">&mdash;</p>
  <div class="map-frame">
    <img id="maps-image" alt="latest saved map" style="max-width:100%;" hidden />
    <p id="maps-empty" hidden>No map uploaded yet.</p>
  </div>
  <details class="how-to-refresh">
    <summary>How to refresh this map</summary>
    <p>Maps are operator-uploaded (the uploader needs SSH to the Pi, so it can't run from
       this panel). From the Linux box:</p>
    <pre>./scripts/upload_map_from_pi.sh turtlebot468</pre>
  </details>
</section>
```

Add the loader script (inside the existing admin `<script>`, or a new one before `</body>`):
```html
<script>
async function loadMap(robotId) {
  const img = document.getElementById('maps-image');
  const empty = document.getElementById('maps-empty');
  const ts = document.getElementById('maps-timestamp');
  try {
    const res = await fetch(`/api/admin/map/${robotId}/meta.json`, {credentials: 'same-origin'});
    if (!res.ok) throw new Error('no map');
    const meta = await res.json();
    ts.textContent = `Captured: ${meta.captured_ts} (source: ${meta.source})`;
    img.src = `/api/admin/map/${robotId}?t=${Date.now()}`;  // cache-bust; cookie rides same-origin
    img.hidden = false;
    empty.hidden = true;
  } catch (e) {
    img.hidden = true;
    empty.hidden = false;
    ts.textContent = '—';
  }
}
// Load the current robot's map whenever the Maps tab is opened.
document.addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('maps-robot');
  if (sel) loadMap(sel.value);
});
</script>
```
Note: match the exact nav-button markup and `showTab` helper name that Phase 3 established in `static/admin.html`; the snippets above assume that pattern. If Phase 3 loads tab content lazily on click, also call `loadMap(document.getElementById('maps-robot').value)` from `showTab('maps')`.

- [ ] **Step 7: Write the gated Playwright e2e test**

`agent_service/tests/e2e/test_admin_maps.py`:
```python
"""Playwright: the admin Maps tab renders (image or empty-state) with refresh instructions.

Gated by the Phase 5 e2e harness (GUIDEMATE_E2E=1 + a running service). Uses the Phase 5
fixtures: `page` (Playwright page), `admin_login` (logs in, lands on /admin), `base_url`.
"""
import pytest


@pytest.mark.e2e
def test_admin_maps_tab_renders(page, admin_login, base_url):
    admin_login(page)
    page.click("text=Maps")
    page.wait_for_selector("#tab-maps:not([hidden])")

    # The refresh instructions are always present (read-only tab).
    assert page.is_visible("summary:has-text('How to refresh this map')")

    # Either the map image shows (a map was uploaded) or the empty-state note does.
    image_visible = page.locator("#maps-image").is_visible()
    empty_visible = page.locator("#maps-empty").is_visible()
    assert image_visible or empty_visible
```

- [ ] **Step 8: Confirm the e2e test is skipped by default, then run the full suite**

Run (e2e skipped): `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/e2e/test_admin_maps.py -q`
Expected: `1 skipped` (GUIDEMATE_E2E unset — the Phase 5 conftest gates the `e2e` marker).

Run the whole non-gated suite to confirm no regressions:
```bash
cd ~/cs7980-guide-mate && .venv/bin/python -m pytest -q
```
Expected: all default (non-gated) tests pass; integration/live/e2e tests skipped.

- [ ] **Step 9: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/app.py agent_service/guidemate_agent/admin.py \
  agent_service/static/admin.html agent_service/tests/test_maps.py \
  agent_service/tests/e2e/test_admin_maps.py
git commit -m "Kalhar: admin Maps tab (streamed-bytes endpoint + UI + Playwright)"
```

---

## Phase 6 exit test (from the spec's phase table)

> **6 — Autonomy + maps:** Synthetic low-battery event triggers an unprompted agent turn (checklist item **6**); map renders in admin.

- **Autonomy / checklist item 6:** `POST /api/admin/synthetic-event {"type":"low_battery","battery":0.12}` returns `{"fired":"low_battery","session_id":"system-autonomy"}`, and (gated) `test_autonomy_roundtrip.py` shows the resulting motion-free turn persisted to `guidemate-messages` under `system-autonomy` — visible in the admin **Sessions** tab. No robot change required.
- **Maps:** run `./scripts/upload_map_from_pi.sh turtlebot468` (operator, once a map exists on the Pi), then open the admin **Maps** tab — the PNG renders with its captured timestamp; `test_admin_maps.py` (Playwright) asserts the tab renders.

---

## Self-Review

**1. Spec coverage.**
- Component 24 (S3 maps tab): Task 4 (bucket + upload script) + Task 5 (endpoint + UI + Playwright). ✅
- Autonomy hook / EventEngine wired in `app.py` lifespan, subscribing to `RobotRegistry` via `on_event`: Task 2 (engine + hook) + Task 3 (wiring). ✅
- Rules as data (low_battery debounced fire<0.15/reset>0.25; robot_offline on offline event): Task 1 (`RULES` data + debouncer) + Task 2 (dispatch). ✅
- Firing → `DogAgent.chat(system_event=...)` on `system-autonomy`, motion tools excluded, result stored in messages, session visible in admin Sessions: Task 2 (`_fire` with `allow_motion=False` + `ensure_session`). ✅
- APScheduler one demo job (daily 09:00 morning stretch, emote only, respects flags): Task 3 Step 5. ✅
- Synthetic-event test endpoint (checklist item 6 evidence, no robot change): Task 3 (`POST /api/admin/synthetic-event`) + gated round-trip test. ✅
- Maps upload from this box (SSH probe with the exact fallback probe, Pillow convert, new tagged bucket documented in access-ground-truth, key `maps/<robot_id>/latest.png` + `meta.json {captured_ts, source}`): Task 4. ✅
- Admin Maps tab: streamed bytes via boto3 (chosen over presigned), read-only display + "how to refresh" note, no server-side upload button: Task 5. ✅
- Tests: unit (debounce, EventEngine dispatch with fakes) Tasks 1–2; integration env-gated (synthetic → DynamoDB message) Task 3; Playwright Maps addition Task 5. ✅ (~5 tasks, as scoped.)
- Additive-only Pi rule: the upload script only `scp`s and writes `meta.json` locally; no `pkill`, no Pi writes. ✅

**2. Placeholder scan.** No `TBD`/`TODO`/"add error handling"/"similar to Task N" — every code step carries complete code. Cross-phase symbols (`Store`, `admin_required`, `router`, `DogAgent.chat` new kwargs, Phase 5 Playwright fixtures) are explicitly pinned in "Consumed from prior phases" and flagged per task, not invented placeholders.

**3. Type consistency.** `EventEngine(agent, store, default_robot_id, session_id=…)` and its `.session_id`/`.default_robot_id` attrs are used identically in Task 3's endpoint and lifespan. `on_status_event(event: dict)` receives `{"robot_id", "data"}` — the exact shape `RobotRegistry._dispatch_event` produces (Task 2) and the synthetic endpoint builds (Task 3). `DogAgent.chat(message=None, session_id=…, robot_id=…, system_event=…, allow_motion=False)` — same signature in the `FakeAgent` test doubles, `_fire`, and the pinned Phase 4 interface. `MAPS_BUCKET`/`map_key`/`meta_key`/`fetch_map_png`/`fetch_map_meta`/`pgm_to_png` names match between `maps.py` (Task 4), the script (Task 4), and the endpoints (Task 5). All consistent.
