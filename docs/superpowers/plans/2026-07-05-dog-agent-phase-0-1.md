# Dog Agent POC — Phase 0 & 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the vertical slice of the "Robert" robot-dog agent — a shared command/ack schema + choreography library, a Pi-side MQTT bridge running in forced dry-run, and a minimal Strands agent + FastAPI chat page — so that `curl "do a happy wiggle"` yields a dog reply while the docked robot's bridge logs the computed `cmd_vel` sequence and acks `"simulated": true`.

**Architecture:** Three Python packages in this repo. `shared/guidemate_msgs` is a pip package (pydantic v2) holding the cmd/ack schema, the hard-capped choreography primitives, and the shared JSON-logging helper — both sides import it. `agent_service/` is the cloud side (FastAPI + Strands + a multi-robot registry over one MQTT-over-WebSocket SigV4 connection). `src/guide_mate_bridge/` is the Pi side (AWS IoT mTLS SDK + a dry-run choreography executor); it lives under `src/` but carries a `COLCON_IGNORE` so the existing colcon workflow never touches it — it is venv-managed. Both sides dial *outbound* to AWS IoT Core us-west-2, the only live runtime channel.

**Tech Stack:** Python 3.10, pydantic v2, FastAPI + uvicorn, strands-agents (Bedrock `us.anthropic.claude-sonnet-4-6`), awsiotsdk (awscrt MQTT), boto3, pytest + matplotlib, systemd on the Pi.

## Global Constraints

Every task's requirements implicitly include this section.

- **Python 3.10-compatible** on both machines — no 3.11+ syntax (no `X | Y` in `isinstance`, no `tomllib`, etc.). `list[...]`/`dict[...]` generics are fine (they work at 3.10 with `from __future__ import annotations`).
- **pydantic v2** (`>=2`); use `model_validate_json` / `model_dump_json` / `model_validate` / `model_dump` / `field_validator` / `model_validator`.
- **TDD**: write the failing test first, run it red, implement the minimum, run it green, then commit — every task.
- **Commit after every task** with a `Kalhar:` message prefix. **NEVER** add any Claude/AI/co-author line or `Co-Authored-By`. Do not push (the user pushes).
- **Never `pkill -f`** anything on the Pi (gotcha #6 — it self-matches the shell). Kill by PID or `ps comm` if ever needed; this plan never kills.
- **Robot 468 stays docked and motion-locked**: bridge forces `GUIDEMATE_DRY_RUN=1` (refuses to start otherwise in Phase 1), the Device Shadow is **not touched** by this plan, and no `cmd_vel` is ever published.
- **No credentials or IoT endpoints committed** to the repo. The IoT data endpoint is always discovered at runtime via `aws iot describe-endpoint --endpoint-type iot:Data-ATS`. Cert/key files stay out of git (already gitignored: `*.pem`, `*.key`).
- **On-Pi work over SSH is additive only** — never modify existing bringup, services, or configs; the installer only adds `guidemate-bridge.service`.
- **Every new AWS resource** is tagged `guidemate-poc` where the API supports tags and documented in `docs/agent-poc/access-ground-truth.md`.
- **Integration/live tests are env-gated** (`GUIDEMATE_INTEGRATION=1`, `GUIDEMATE_LIVE=1`) and skipped by default.

**Verified environment facts (do not re-derive):** AWS account `852373397000`, region `us-west-2`; creds work via `credential_process` (identity `guidemate-agent-role`, AdministratorAccess); AWS CLI v2 at `~/.local/bin/aws`. Bedrock model id `us.anthropic.claude-sonnet-4-6`. SSH alias `guidemate` → Pi (`ubuntu`, passwordless sudo). Pi robot cert: `~/cs7980-guide-mate/Turtlebot-468.cert.pem` + `.private.key`. Dev cert on this box: `~/.aws/guidemate-dev.cert.pem` + `~/.aws/guidemate-dev.private.key` (cert id/ARN suffix `aec82bf4fbb4c9c0f91ae5869e58b8b057d0d8d02d6ac37dbfa8e292f411d140`). Existing policy `guidemate-robot-policy` (client ids `guidemate-*`, topics `guidemate/turtlebot468/*` + shadow) is attached to the **robot** cert only.

---

## File Structure

```
cs7980-guide-mate/
├── pytest.ini                         # NEW (Task 1) — marker registration + testpaths
├── conftest.py                        # NEW (Task 1) — env-gated skip for integration/live
├── shared/guidemate_msgs/
│   ├── pyproject.toml                 # NEW (Task 1) — pkg guidemate-msgs, pydantic>=2
│   ├── guidemate_msgs/
│   │   ├── __init__.py                # NEW (Task 1)
│   │   ├── messages.py                # NEW (Task 1) — Command/Ack schema + topic helpers
│   │   ├── jsonlog.py                 # NEW (Task 1) — JSON logging + correlation IDs
│   │   └── choreography.py            # NEW (Task 2) — TwistStep + build()
│   └── tests/
│       ├── test_messages.py           # NEW (Task 1)
│       ├── test_jsonlog.py            # NEW (Task 1)
│       └── test_choreography.py       # NEW (Task 2) — kinematics + PNG plots
├── agent_service/
│   ├── pyproject.toml                 # NEW (Task 1) — pkg guidemate-agent
│   ├── guidemate_agent/
│   │   ├── __init__.py                # NEW (Task 1)
│   │   ├── config.py                  # NEW (Task 6) — env reader
│   │   ├── mqtt_link.py               # NEW (Task 5) — RobotRegistry (SigV4 WSS)
│   │   ├── dog_agent.py               # NEW (Task 6) — DogAgent (Strands)
│   │   └── app.py                     # NEW (Task 6) — FastAPI
│   ├── static/index.html              # NEW (Task 6) — plain chat page
│   └── tests/
│       ├── test_mqtt_link.py          # NEW (Task 5)
│       ├── test_app.py                # NEW (Task 6)
│       └── integration/
│           ├── test_roundtrip.py      # NEW (Task 7) — real IoT Core (gated)
│           └── test_live_agent.py     # NEW (Task 6) — real Bedrock (gated)
└── src/guide_mate_bridge/
    ├── COLCON_IGNORE                  # NEW (Task 1) — keep colcon out
    ├── pyproject.toml                 # NEW (Task 1) — pkg guide-mate-bridge
    ├── guide_mate_bridge/
    │   ├── __init__.py                # NEW (Task 1)
    │   ├── executor.py                # NEW (Task 3) — ChoreographyRunner
    │   ├── iot_client.py              # NEW (Task 4) — IotClient (mTLS)
    │   └── bridge.py                  # NEW (Task 4) — main + dedupe + queue
    ├── systemd/guidemate-bridge.service   # NEW (Task 8) — unit template
    ├── scripts/install_bridge_on_pi.sh    # NEW (Task 8) — SSH-driven installer
    └── tests/
        ├── test_executor.py           # NEW (Task 3)
        └── test_bridge.py             # NEW (Task 4)
scripts/slice_check.sh                 # NEW (Task 8) — Phase 1 exit test
```

---

## Task 1: Workspace scaffolding + command/ack schema + JSON logging

**Files:**
- Create: `shared/guidemate_msgs/pyproject.toml`, `shared/guidemate_msgs/guidemate_msgs/__init__.py`, `shared/guidemate_msgs/guidemate_msgs/messages.py`, `shared/guidemate_msgs/guidemate_msgs/jsonlog.py`
- Create (empty package skeletons so editable installs resolve): `agent_service/pyproject.toml`, `agent_service/guidemate_agent/__init__.py`, `src/guide_mate_bridge/pyproject.toml`, `src/guide_mate_bridge/guide_mate_bridge/__init__.py`, `src/guide_mate_bridge/COLCON_IGNORE`
- Create: `pytest.ini`, `conftest.py`
- Modify: `.gitignore` (add `.venv/`, `**/__pycache__/`, `**/artifacts/`)
- Test: `shared/guidemate_msgs/tests/test_messages.py`, `shared/guidemate_msgs/tests/test_jsonlog.py`

**Interfaces:**
- Produces (schema): `Command(type, name, params={}, cmd_id=<uuid4>, ts=<iso>)` with validation that emote names ∈ `("happy","yes","no")`, motion names ∈ `("circle","spin")`, stop name == `"stop"`. `Ack(cmd_id, state, reason=None, simulated=False, battery=None, ts=<iso>)`, state ∈ `("received","running","done","failed")`. `new_cmd_id() -> str`. `cmd_topic(robot_id) -> "guidemate/{robot_id}/cmd"`. `status_topic(robot_id) -> "guidemate/{robot_id}/status"`.
- Produces (logging): `setup(component: str, level=INFO) -> logging.Logger` installs a JSON formatter on the root logger; `log_extra(**ids) -> dict` returns a dict for logging's `extra=` kwarg (drops `None`s). Every log line carries `ts`, `level`, `component`, `msg`, plus any `extra` keys (e.g. `turn_id`, `cmd_id`, `session_id`, `robot_id`).

- [ ] **Step 1: Create the three package skeletons and config files**

`shared/guidemate_msgs/pyproject.toml`:
```toml
[project]
name = "guidemate-msgs"
version = "0.1.0"
description = "Shared command/ack schema, choreography library, and JSON logging for guide-mate."
requires-python = ">=3.10"
dependencies = ["pydantic>=2"]

[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["."]
include = ["guidemate_msgs*"]
```

`shared/guidemate_msgs/guidemate_msgs/__init__.py`:
```python
"""Shared schema, choreography, and logging for the guide-mate dog agent."""
```

`agent_service/pyproject.toml`:
```toml
[project]
name = "guidemate-agent"
version = "0.1.0"
description = "Cloud-side dog agent (FastAPI + Strands + multi-robot MQTT registry)."
requires-python = ">=3.10"
dependencies = [
    "fastapi",
    "uvicorn[standard]",
    "strands-agents",
    "awsiotsdk",
    "boto3",
    "guidemate-msgs",
]

[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["."]
include = ["guidemate_agent*"]
```

`agent_service/guidemate_agent/__init__.py`:
```python
"""Cloud-side dog agent service."""
```

`src/guide_mate_bridge/pyproject.toml`:
```toml
[project]
name = "guide-mate-bridge"
version = "0.1.0"
description = "Pi-side AWS IoT bridge for the guide-mate dog agent (dry-run in Phase 1)."
requires-python = ">=3.10"
dependencies = ["awsiotsdk", "guidemate-msgs"]

[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["."]
include = ["guide_mate_bridge*"]
```

`src/guide_mate_bridge/guide_mate_bridge/__init__.py`:
```python
"""Pi-side AWS IoT bridge (venv-managed, not colcon-built)."""
```

`src/guide_mate_bridge/COLCON_IGNORE` — create an empty file:
```text
```

`pytest.ini` (repo root):
```ini
[pytest]
testpaths =
    shared/guidemate_msgs/tests
    agent_service/tests
    src/guide_mate_bridge/tests
markers =
    integration: real AWS IoT Core round-trip (set GUIDEMATE_INTEGRATION=1 to run)
    live: real Bedrock model call (set GUIDEMATE_LIVE=1 to run)
```

`conftest.py` (repo root):
```python
import os
import pytest


def pytest_collection_modifyitems(config, items):
    run_integration = os.environ.get("GUIDEMATE_INTEGRATION") == "1"
    run_live = os.environ.get("GUIDEMATE_LIVE") == "1"
    skip_integration = pytest.mark.skip(reason="set GUIDEMATE_INTEGRATION=1 to run")
    skip_live = pytest.mark.skip(reason="set GUIDEMATE_LIVE=1 to run")
    for item in items:
        if "integration" in item.keywords and not run_integration:
            item.add_marker(skip_integration)
        if "live" in item.keywords and not run_live:
            item.add_marker(skip_live)
```

- [ ] **Step 2: Extend `.gitignore`**

Append these lines to `.gitignore` (the existing `__pycache__/` line can stay; add the venv + artifacts globs):
```gitignore
# Python dev venv + test artifacts (dog agent POC)
.venv/
**/__pycache__/
**/artifacts/
```

- [ ] **Step 3: Create the dev venv and install editable packages**

Run:
```bash
cd ~/cs7980-guide-mate
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -e shared/guidemate_msgs -e src/guide_mate_bridge -e agent_service pytest matplotlib httpx
```
Expected: all three `guidemate-*` packages install in editable/development mode; pytest, matplotlib, httpx present. (This pulls fastapi, strands-agents, awsiotsdk, boto3 — heavy but one-time.) `guidemate-msgs` listed as a dependency of the other two is satisfied by the co-installed editable copy.

- [ ] **Step 4: Write the failing tests for schema + logging**

`shared/guidemate_msgs/tests/test_messages.py`:
```python
import json

import pytest
from pydantic import ValidationError

from guidemate_msgs.messages import (
    Ack,
    Command,
    cmd_topic,
    new_cmd_id,
    status_topic,
)


def test_command_defaults_and_roundtrip():
    cmd = Command(type="emote", name="happy")
    assert cmd.cmd_id
    assert cmd.params == {}
    assert cmd.ts.endswith("+00:00")
    restored = Command.model_validate_json(cmd.model_dump_json())
    assert restored == cmd


def test_command_rejects_bad_emote_name():
    with pytest.raises(ValidationError):
        Command(type="emote", name="sad")


def test_command_rejects_bad_motion_name():
    with pytest.raises(ValidationError):
        Command(type="motion", name="teleport")


def test_command_stop_requires_stop_name():
    Command(type="stop", name="stop")
    with pytest.raises(ValidationError):
        Command(type="stop", name="halt")


def test_ack_defaults():
    ack = Ack(cmd_id="abc", state="done", simulated=True)
    assert ack.reason is None
    assert ack.battery is None
    assert ack.simulated is True
    data = json.loads(ack.model_dump_json())
    assert data["state"] == "done"


def test_new_cmd_id_unique():
    assert new_cmd_id() != new_cmd_id()


def test_topic_helpers():
    assert cmd_topic("turtlebot468") == "guidemate/turtlebot468/cmd"
    assert status_topic("turtlebot468") == "guidemate/turtlebot468/status"
```

`shared/guidemate_msgs/tests/test_jsonlog.py`:
```python
import json
import logging

from guidemate_msgs.jsonlog import log_extra, setup


def test_setup_emits_json_with_correlation_ids(capsys):
    log = setup("unittest")
    log.info("hello", extra=log_extra(turn_id="t1", cmd_id="c1", session_id=None))
    line = capsys.readouterr().out.strip().splitlines()[-1]
    payload = json.loads(line)
    assert payload["component"] == "unittest"
    assert payload["level"] == "INFO"
    assert payload["msg"] == "hello"
    assert payload["turn_id"] == "t1"
    assert payload["cmd_id"] == "c1"
    assert "session_id" not in payload  # None dropped by log_extra
    assert payload["ts"].endswith("+00:00")


def test_setup_is_idempotent_single_handler():
    setup("a")
    setup("b")
    assert len(logging.getLogger().handlers) == 1
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest shared/guidemate_msgs/tests/test_messages.py shared/guidemate_msgs/tests/test_jsonlog.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_msgs.messages'` (and `.jsonlog`).

- [ ] **Step 6: Implement `messages.py`**

`shared/guidemate_msgs/guidemate_msgs/messages.py`:
```python
"""Command / Ack schema — single source of truth for service and bridge."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

_EMOTE_NAMES = ("happy", "yes", "no")
_MOTION_NAMES = ("circle", "spin")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_cmd_id() -> str:
    return str(uuid.uuid4())


class Command(BaseModel):
    cmd_id: str = Field(default_factory=new_cmd_id)
    type: Literal["emote", "motion", "stop"]
    name: str
    params: dict = Field(default_factory=dict)
    ts: str = Field(default_factory=_utc_now_iso)

    @model_validator(mode="after")
    def _check_name(self) -> "Command":
        if self.type == "emote" and self.name not in _EMOTE_NAMES:
            raise ValueError(f"emote name must be one of {_EMOTE_NAMES}, got {self.name!r}")
        if self.type == "motion" and self.name not in _MOTION_NAMES:
            raise ValueError(f"motion name must be one of {_MOTION_NAMES}, got {self.name!r}")
        if self.type == "stop" and self.name != "stop":
            raise ValueError(f"stop command name must be 'stop', got {self.name!r}")
        return self


class Ack(BaseModel):
    cmd_id: str
    state: Literal["received", "running", "done", "failed"]
    reason: Optional[str] = None
    simulated: bool = False
    battery: Optional[float] = None
    ts: str = Field(default_factory=_utc_now_iso)


def cmd_topic(robot_id: str) -> str:
    return f"guidemate/{robot_id}/cmd"


def status_topic(robot_id: str) -> str:
    return f"guidemate/{robot_id}/status"
```

- [ ] **Step 7: Implement `jsonlog.py`**

`shared/guidemate_msgs/guidemate_msgs/jsonlog.py`:
```python
"""Shared structured JSON logging + correlation IDs (used by service AND bridge)."""
from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone

# LogRecord attributes we never copy into the JSON payload.
_RESERVED = {
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
    "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
    "created", "msecs", "relativeCreated", "thread", "threadName",
    "processName", "process", "taskName", "message",
}


class JsonFormatter(logging.Formatter):
    def __init__(self, component: str) -> None:
        super().__init__()
        self._component = component

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "component": self._component,
            "msg": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def setup(component: str, level: int = logging.INFO) -> logging.Logger:
    """Install a single JSON handler on the root logger (idempotent)."""
    root = logging.getLogger()
    root.setLevel(level)
    for handler in list(root.handlers):
        root.removeHandler(handler)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(component))
    root.addHandler(handler)
    return root


def log_extra(**ids) -> dict:
    """Return a dict for logging's `extra=` kwarg, dropping None values."""
    return {key: value for key, value in ids.items() if value is not None}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest shared/guidemate_msgs/tests/test_messages.py shared/guidemate_msgs/tests/test_jsonlog.py -q`
Expected: PASS (8 passed).

- [ ] **Step 9: Commit**

```bash
cd ~/cs7980-guide-mate
git add pytest.ini conftest.py .gitignore \
  shared/guidemate_msgs agent_service/pyproject.toml agent_service/guidemate_agent/__init__.py \
  src/guide_mate_bridge/pyproject.toml src/guide_mate_bridge/COLCON_IGNORE \
  src/guide_mate_bridge/guide_mate_bridge/__init__.py
git commit -m "Kalhar: scaffold guidemate packages + cmd/ack schema + JSON logging"
```

---

## Task 2: Choreography library — hard-capped primitives + kinematic tests + PNG plots

**Files:**
- Create: `shared/guidemate_msgs/guidemate_msgs/choreography.py`
- Test: `shared/guidemate_msgs/tests/test_choreography.py`

**Interfaces:**
- Consumes: `Command` (from Task 1).
- Produces: dataclass `TwistStep(vx: float, wz: float, duration: float)`. Constants `MAX_LINEAR = 0.15`, `MAX_ANGULAR = 1.5`, `MAX_TOTAL_S = 30.0`. `build(command: Command, max_speed: float = MAX_LINEAR) -> list[TwistStep]` — dispatches on `(type, name)`, raises `ValueError` for anything unknown, returns caps-clamped steps whose total duration never exceeds `MAX_TOTAL_S`. `stop` returns the sentinel `[TwistStep(0.0, 0.0, 0.0)]`.

- [ ] **Step 1: Write the failing tests (kinematics + PNG plots)**

`shared/guidemate_msgs/tests/test_choreography.py`:
```python
import math
import os

import matplotlib
matplotlib.use("Agg")  # headless
import matplotlib.pyplot as plt  # noqa: E402
import pytest  # noqa: E402

from guidemate_msgs.choreography import (  # noqa: E402
    MAX_ANGULAR,
    MAX_LINEAR,
    MAX_TOTAL_S,
    TwistStep,
    build,
)
from guidemate_msgs.messages import Command  # noqa: E402

ARTIFACT_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
PRIMITIVES = {
    "happy": Command(type="emote", name="happy"),
    "yes": Command(type="emote", name="yes"),
    "no": Command(type="emote", name="no"),
    "circle": Command(type="motion", name="circle"),
    "spin": Command(type="motion", name="spin"),
    "stop": Command(type="stop", name="stop"),
}


def simulate(steps, dt=0.01):
    """Unicycle-model integrator -> (x, y, theta, points)."""
    x = y = theta = 0.0
    points = [(x, y)]
    for step in steps:
        n = int(round(step.duration / dt))
        for _ in range(n):
            x += step.vx * math.cos(theta) * dt
            y += step.vx * math.sin(theta) * dt
            theta += step.wz * dt
            points.append((x, y))
    return x, y, theta, points


def test_unknown_command_raises():
    class Fake:
        type = "emote"
        name = "moonwalk"
    with pytest.raises(ValueError):
        build(Fake())


def test_all_steps_within_caps_and_total_bounded():
    for cmd in PRIMITIVES.values():
        steps = build(cmd)
        total = sum(s.duration for s in steps)
        assert total <= MAX_TOTAL_S + 1e-9, cmd.name
        for s in steps:
            assert abs(s.vx) <= MAX_LINEAR + 1e-9, cmd.name
            assert abs(s.wz) <= MAX_ANGULAR + 1e-9, cmd.name
            assert s.duration >= 0.0, cmd.name


def test_stop_is_sentinel():
    assert build(PRIMITIVES["stop"]) == [TwistStep(0.0, 0.0, 0.0)]


def test_circle_closes_with_full_turn():
    x, y, theta, _ = simulate(build(PRIMITIVES["circle"]))
    assert math.hypot(x, y) < 0.05
    assert abs(abs(theta) - 2 * math.pi) < 0.1


def test_spin_no_displacement_full_turn():
    x, y, theta, _ = simulate(build(PRIMITIVES["spin"]))
    assert math.hypot(x, y) < 0.02
    assert abs(abs(theta) - 2 * math.pi) < 0.05


def test_no_returns_to_start_yaw():
    _, _, theta, _ = simulate(build(PRIMITIVES["no"]))
    assert abs(theta) < 0.02


def test_yes_small_net_displacement():
    x, y, _, _ = simulate(build(PRIMITIVES["yes"]))
    assert math.hypot(x, y) < 0.02


def test_renders_all_primitive_paths_to_png():
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    for name, cmd in PRIMITIVES.items():
        _, _, _, points = simulate(build(cmd))
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        fig, ax = plt.subplots()
        ax.plot(xs, ys, marker=".", markersize=1)
        ax.set_aspect("equal", "datalim")
        ax.set_title(name)
        path = os.path.join(ARTIFACT_DIR, f"{name}.png")
        fig.savefig(path)
        plt.close(fig)
        assert os.path.exists(path) and os.path.getsize(path) > 0
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest shared/guidemate_msgs/tests/test_choreography.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_msgs.choreography'`.

- [ ] **Step 3: Implement `choreography.py`**

`shared/guidemate_msgs/guidemate_msgs/choreography.py`:
```python
"""Named choreography primitives -> time-bounded twist sequences. Hard-capped."""
from __future__ import annotations

import math
from dataclasses import dataclass

from .messages import Command

MAX_LINEAR = 0.15    # m/s
MAX_ANGULAR = 1.5    # rad/s
MAX_TOTAL_S = 30.0   # s total per primitive


@dataclass
class TwistStep:
    vx: float
    wz: float
    duration: float


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _step(vx: float, wz: float, duration: float) -> TwistStep:
    """Every generator output flows through here — the single caps enforcer."""
    return TwistStep(
        vx=_clamp(vx, -MAX_LINEAR, MAX_LINEAR),
        wz=_clamp(wz, -MAX_ANGULAR, MAX_ANGULAR),
        duration=max(0.0, duration),
    )


def _cap_total(steps: list[TwistStep]) -> list[TwistStep]:
    """Defence in depth: truncate durations so the sequence never exceeds MAX_TOTAL_S."""
    total = 0.0
    out: list[TwistStep] = []
    for s in steps:
        if total >= MAX_TOTAL_S:
            break
        dur = min(s.duration, MAX_TOTAL_S - total)
        out.append(TwistStep(s.vx, s.wz, dur))
        total += dur
    return out


def _yes() -> list[TwistStep]:
    # forward/back nod x2, net displacement ~0
    steps: list[TwistStep] = []
    for _ in range(2):
        steps.append(_step(0.08, 0.0, 0.5))
        steps.append(_step(-0.08, 0.0, 0.5))
    return steps


def _no() -> list[TwistStep]:
    # rotate CW/CCW returning to start; net yaw 0
    return [
        _step(0.0, 0.9, 0.5),
        _step(0.0, -0.9, 1.0),
        _step(0.0, 0.9, 0.5),
    ]


def _happy() -> list[TwistStep]:
    # wiggle: alternate wz +/-1.2 @ 0.4 s with small vx 0.05, 3 cycles
    steps: list[TwistStep] = []
    for _ in range(3):
        steps.append(_step(0.05, 1.2, 0.4))
        steps.append(_step(0.05, -1.2, 0.4))
    return steps


def _circle(params: dict) -> list[TwistStep]:
    radius = _clamp(float(params.get("radius", 0.5)), 0.2, 1.0)
    vx = 0.12
    wz = vx / radius
    duration = 2 * math.pi / wz
    return [_step(vx, wz, duration)]


def _spin() -> list[TwistStep]:
    wz = 0.9
    return [_step(0.0, wz, 2 * math.pi / wz)]


_STOP = [TwistStep(0.0, 0.0, 0.0)]


def build(command: Command, max_speed: float = MAX_LINEAR) -> list[TwistStep]:
    key = (command.type, command.name)
    if key == ("emote", "yes"):
        steps = _yes()
    elif key == ("emote", "no"):
        steps = _no()
    elif key == ("emote", "happy"):
        steps = _happy()
    elif key == ("motion", "circle"):
        steps = _circle(command.params)
    elif key == ("motion", "spin"):
        steps = _spin()
    elif key == ("stop", "stop"):
        return list(_STOP)
    else:
        raise ValueError(
            f"unknown choreography for type={command.type!r} name={command.name!r}"
        )
    # Optional per-call speed override (defaults to MAX_LINEAR -> no-op for primitives).
    steps = [
        TwistStep(_clamp(s.vx, -max_speed, max_speed), s.wz, s.duration) for s in steps
    ]
    return _cap_total(steps)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest shared/guidemate_msgs/tests/test_choreography.py -q`
Expected: PASS (8 passed). Six PNGs written under `shared/guidemate_msgs/tests/artifacts/` (gitignored).

- [ ] **Step 5: Eyeball the trajectory PNGs (Phase 0 exit criterion)**

Run: `ls -la shared/guidemate_msgs/tests/artifacts/`
Expected: `happy.png yes.png no.png circle.png spin.png stop.png`. Open `circle.png` (a closed loop) and `spin.png` (a point/tight cluster) to confirm they look right — this is the Phase 0 "trajectory PNGs visually correct" check.

- [ ] **Step 6: Commit**

```bash
cd ~/cs7980-guide-mate
git add shared/guidemate_msgs/guidemate_msgs/choreography.py shared/guidemate_msgs/tests/test_choreography.py
git commit -m "Kalhar: choreography primitives with hard caps + kinematic/PNG tests"
```

---

## Task 3: Bridge choreography executor (dry-run acks)

**Files:**
- Create: `src/guide_mate_bridge/guide_mate_bridge/executor.py`
- Test: `src/guide_mate_bridge/tests/test_executor.py`

**Interfaces:**
- Consumes: `build` + `TwistStep` (Task 2); `Command`, `Ack` (Task 1); `log_extra` (Task 1).
- Produces: `class ChoreographyRunner(publish_ack: Callable[[Ack], None], dry_run: bool = True, publish_twist: Optional[Callable[[TwistStep], None]] = None)` with `handle(cmd: Command) -> None`. `handle` publishes acks in order: `received` → (`failed` with reason if `build` raises `ValueError`, and returns) → `running` → per-step dry-run log line `"DRY-RUN twist vx=%.3f wz=%.3f dur=%.2fs"` (no sleep) → `done` with `simulated=dry_run`. `publish_twist` is never invoked in Phase 1.

- [ ] **Step 1: Write the failing test**

`src/guide_mate_bridge/tests/test_executor.py`:
```python
import logging

from guidemate_msgs.messages import Ack, Command

from guide_mate_bridge.executor import ChoreographyRunner


def _runner(acks, dry_run=True):
    return ChoreographyRunner(publish_ack=acks.append, dry_run=dry_run)


def test_happy_path_ack_sequence_dry_run():
    acks = []
    _runner(acks).handle(Command(type="emote", name="happy"))
    states = [a.state for a in acks]
    assert states == ["received", "running", "done"]
    assert acks[-1].simulated is True


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
        dry_run=True,
        publish_twist=published.append,
    )
    runner.handle(Command(type="emote", name="yes"))
    assert published == []
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_executor.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guide_mate_bridge.executor'`.

- [ ] **Step 3: Implement `executor.py`**

`src/guide_mate_bridge/guide_mate_bridge/executor.py`:
```python
"""Choreography executor — dry-run in Phase 1 (never publishes twists)."""
from __future__ import annotations

import logging
from typing import Callable, Optional

from guidemate_msgs.choreography import TwistStep, build
from guidemate_msgs.jsonlog import log_extra
from guidemate_msgs.messages import Ack, Command

log = logging.getLogger(__name__)


class ChoreographyRunner:
    def __init__(
        self,
        publish_ack: Callable[[Ack], None],
        dry_run: bool = True,
        publish_twist: Optional[Callable[[TwistStep], None]] = None,
    ) -> None:
        self._publish_ack = publish_ack
        self._dry_run = dry_run
        self._publish_twist = publish_twist

    def handle(self, cmd: Command) -> None:
        self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="received"))
        try:
            steps = build(cmd)
        except ValueError as exc:
            self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="failed", reason=str(exc)))
            return
        self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="running"))
        for step in steps:
            if self._dry_run:
                log.info(
                    "DRY-RUN twist vx=%.3f wz=%.3f dur=%.2fs",
                    step.vx,
                    step.wz,
                    step.duration,
                    extra=log_extra(cmd_id=cmd.cmd_id),
                )
                continue
            # Real cmd_vel publishing arrives in a later phase; not wired in Phase 1.
            if self._publish_twist is not None:
                self._publish_twist(step)
        self._publish_ack(
            Ack(cmd_id=cmd.cmd_id, state="done", simulated=self._dry_run)
        )
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_executor.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980-guide-mate
git add src/guide_mate_bridge/guide_mate_bridge/executor.py src/guide_mate_bridge/tests/test_executor.py
git commit -m "Kalhar: bridge choreography executor with dry-run acks"
```

---

## Task 4: Bridge IoT client (mTLS) + main (dedupe, single-worker queue)

**Files:**
- Create: `src/guide_mate_bridge/guide_mate_bridge/iot_client.py`, `src/guide_mate_bridge/guide_mate_bridge/bridge.py`
- Test: `src/guide_mate_bridge/tests/test_bridge.py`

**Interfaces:**
- Consumes: `ChoreographyRunner` (Task 3); `Command`, `Ack`, `cmd_topic`, `status_topic` (Task 1); `setup`, `log_extra` (Task 1).
- Produces:
  - `class IotClient(endpoint, cert_filepath, pri_key_filepath, client_id, robot_id, ca_filepath=None, connection=None)`. `connect()` (dials, then publishes `{"event":"online","robot_id":...}` to `status_topic`); `subscribe(topic, callback: Callable[[str, str], None])` QoS 1 (callback gets decoded `(topic, payload_str)`); `publish(topic, payload_str)` QoS 1. Constructor sets an MQTT Last Will on `status_topic` = `{"event":"offline","robot_id":...}` QoS 1. `connection` is injectable for tests (a fake awscrt-style connection whose `connect()` returns a future and whose `subscribe`/`publish` return `(future, packet_id)`).
  - `class Bridge(client: IotClient, robot_id: str, dry_run: bool = True)` with `on_message(topic: str, payload: str)` (parse → validate → dedupe by `cmd_id` via a `deque(maxlen=256)` + set → enqueue) and `start()` (spawn one worker thread that drains a `queue.Queue` and runs `ChoreographyRunner.handle`, publishing acks to `status_topic`).
  - `main()` — reads env (`GUIDEMATE_ROBOT_ID` default `turtlebot468`, `GUIDEMATE_DRY_RUN` default `"1"` — **raises `SystemExit` if not truthy**, `GUIDEMATE_IOT_ENDPOINT` required, `GUIDEMATE_CERT`, `GUIDEMATE_KEY`, `GUIDEMATE_CA` optional), `client_id = f"guidemate-bridge-{robot_id}"`, wires everything, blocks forever.

- [ ] **Step 1: Write the failing test (FakeConnection round-trip + dedupe + dry-run guard)**

`src/guide_mate_bridge/tests/test_bridge.py`:
```python
import json

import pytest

from guidemate_msgs.messages import Command, cmd_topic, status_topic

from guide_mate_bridge.bridge import Bridge, main
from guide_mate_bridge.iot_client import IotClient


class FakeFuture:
    def result(self, timeout=None):
        return None


class FakeConnection:
    """Mimics an awscrt mqtt connection: connect()->future, subscribe/publish->(future, id)."""

    def __init__(self):
        self.published = []          # list[(topic, payload_str)]
        self.subscriptions = {}      # topic -> callback

    def connect(self):
        return FakeFuture()

    def disconnect(self):
        return FakeFuture()

    def publish(self, topic, payload, qos, **kwargs):
        text = payload.decode("utf-8") if isinstance(payload, (bytes, bytearray)) else payload
        self.published.append((topic, text))
        return FakeFuture(), 1

    def subscribe(self, topic, qos, callback):
        self.subscriptions[topic] = callback
        return FakeFuture(), 1


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
    return Bridge(client=client, robot_id=robot_id, dry_run=True), fake


def test_connect_publishes_online_and_subscribes():
    bridge, fake = _bridge()
    bridge.start()
    assert (status_topic("devtest"), json.dumps({"event": "online", "robot_id": "devtest"})) in fake.published
    assert cmd_topic("devtest") in fake.subscriptions


def test_command_produces_ack_sequence():
    bridge, fake = _bridge()
    bridge.start()
    cmd = Command(type="emote", name="happy")
    bridge.on_message(cmd_topic("devtest"), cmd.model_dump_json())
    bridge._queue.join()
    states = [json.loads(p)["state"] for t, p in fake.published if "state" in p]
    assert states == ["received", "running", "done"]


def test_duplicate_cmd_id_is_ignored():
    bridge, _ = _bridge()
    bridge.start()
    cmd = Command(type="emote", name="yes")
    bridge.on_message(cmd_topic("devtest"), cmd.model_dump_json())
    bridge.on_message(cmd_topic("devtest"), cmd.model_dump_json())  # same cmd_id
    bridge._queue.join()
    assert bridge._queue.qsize() == 0
    # Only one execution -> exactly one "done" ack.
    assert bridge._seen_count(cmd.cmd_id) == 1


def test_invalid_payload_is_ignored():
    bridge, _ = _bridge()
    bridge.start()
    bridge.on_message(cmd_topic("devtest"), "{not json")
    bridge.on_message(cmd_topic("devtest"), json.dumps({"type": "emote"}))  # missing name
    bridge._queue.join()
    assert bridge._queue.qsize() == 0


def test_main_refuses_without_dry_run(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_DRY_RUN", "0")
    monkeypatch.setenv("GUIDEMATE_IOT_ENDPOINT", "x")
    monkeypatch.setenv("GUIDEMATE_CERT", "x")
    monkeypatch.setenv("GUIDEMATE_KEY", "x")
    with pytest.raises(SystemExit):
        main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_bridge.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guide_mate_bridge.iot_client'`.

- [ ] **Step 3: Implement `iot_client.py`**

`src/guide_mate_bridge/guide_mate_bridge/iot_client.py`:
```python
"""AWS IoT MQTT client wrapper (mTLS). Connection object is injectable for tests."""
from __future__ import annotations

import json
import logging
from typing import Callable, Optional

from awscrt import mqtt
from awsiot import mqtt_connection_builder

from guidemate_msgs.messages import status_topic

log = logging.getLogger(__name__)


class IotClient:
    def __init__(
        self,
        endpoint: str,
        cert_filepath: str,
        pri_key_filepath: str,
        client_id: str,
        robot_id: str,
        ca_filepath: Optional[str] = None,
        connection=None,
    ) -> None:
        self._robot_id = robot_id
        self._status_topic = status_topic(robot_id)
        if connection is not None:
            self._conn = connection
            return
        will = mqtt.Will(
            topic=self._status_topic,
            qos=mqtt.QoS.AT_LEAST_ONCE,
            payload=json.dumps({"event": "offline", "robot_id": robot_id}).encode("utf-8"),
            retain=False,
        )
        kwargs = dict(
            endpoint=endpoint,
            cert_filepath=cert_filepath,
            pri_key_filepath=pri_key_filepath,
            client_id=client_id,
            clean_session=False,
            keep_alive_secs=30,
            will=will,
        )
        if ca_filepath:
            kwargs["ca_filepath"] = ca_filepath
        self._conn = mqtt_connection_builder.mtls_from_path(**kwargs)

    def connect(self) -> None:
        self._conn.connect().result()
        self.publish(
            self._status_topic,
            json.dumps({"event": "online", "robot_id": self._robot_id}),
        )

    def subscribe(self, topic: str, callback: Callable[[str, str], None]) -> None:
        def _on_message(topic, payload, dup, qos, retain, **kwargs):
            callback(topic, payload.decode("utf-8"))

        future, _ = self._conn.subscribe(
            topic=topic, qos=mqtt.QoS.AT_LEAST_ONCE, callback=_on_message
        )
        future.result()

    def publish(self, topic: str, payload_str: str) -> None:
        self._conn.publish(
            topic=topic,
            payload=payload_str.encode("utf-8"),
            qos=mqtt.QoS.AT_LEAST_ONCE,
        )
```

- [ ] **Step 4: Implement `bridge.py`**

`src/guide_mate_bridge/guide_mate_bridge/bridge.py`:
```python
"""Bridge main — subscribe cmd topic, validate, dedupe, serialize execution, ack."""
from __future__ import annotations

import collections
import logging
import os
import queue
import threading

from guidemate_msgs.jsonlog import log_extra, setup
from guidemate_msgs.messages import Ack, Command, cmd_topic, status_topic
from pydantic import ValidationError

from guide_mate_bridge.executor import ChoreographyRunner
from guide_mate_bridge.iot_client import IotClient

log = logging.getLogger(__name__)


def _truthy(value: str) -> bool:
    return value.strip().lower() in ("1", "true", "yes", "on")


class Bridge:
    def __init__(self, client: IotClient, robot_id: str, dry_run: bool = True) -> None:
        self._client = client
        self._robot_id = robot_id
        self._seen = collections.deque(maxlen=256)
        self._seen_set: set[str] = set()
        self._queue: "queue.Queue[Command]" = queue.Queue()
        self._runner = ChoreographyRunner(publish_ack=self._publish_ack, dry_run=dry_run)
        self._worker = threading.Thread(target=self._run, daemon=True)

    def _publish_ack(self, ack: Ack) -> None:
        self._client.publish(status_topic(self._robot_id), ack.model_dump_json())

    def _seen_count(self, cmd_id: str) -> int:
        return sum(1 for c in self._seen if c == cmd_id)

    def on_message(self, topic: str, payload: str) -> None:
        try:
            cmd = Command.model_validate_json(payload)
        except (ValidationError, ValueError) as exc:
            log.warning("ignoring invalid command: %s", exc)
            return
        if cmd.cmd_id in self._seen_set:
            log.info("duplicate cmd_id ignored", extra=log_extra(cmd_id=cmd.cmd_id))
            return
        if len(self._seen) == self._seen.maxlen:
            self._seen_set.discard(self._seen[0])  # oldest, about to be evicted
        self._seen.append(cmd.cmd_id)
        self._seen_set.add(cmd.cmd_id)
        self._queue.put(cmd)

    def _run(self) -> None:
        while True:
            cmd = self._queue.get()
            try:
                self._runner.handle(cmd)
            except Exception:  # noqa: BLE001 — never let the worker thread die
                log.exception("runner failed", extra=log_extra(cmd_id=cmd.cmd_id))
            finally:
                self._queue.task_done()

    def start(self) -> None:
        self._worker.start()
        self._client.connect()
        self._client.subscribe(cmd_topic(self._robot_id), self.on_message)


def main() -> None:
    setup("bridge")
    robot_id = os.environ.get("GUIDEMATE_ROBOT_ID", "turtlebot468")
    if not _truthy(os.environ.get("GUIDEMATE_DRY_RUN", "1")):
        raise SystemExit(
            "GUIDEMATE_DRY_RUN must be truthy in Phase 1 — motion paths do not exist yet"
        )
    endpoint = os.environ["GUIDEMATE_IOT_ENDPOINT"]
    cert = os.environ["GUIDEMATE_CERT"]
    key = os.environ["GUIDEMATE_KEY"]
    ca = os.environ.get("GUIDEMATE_CA")
    client = IotClient(
        endpoint=endpoint,
        cert_filepath=cert,
        pri_key_filepath=key,
        client_id=f"guidemate-bridge-{robot_id}",
        robot_id=robot_id,
        ca_filepath=ca,
    )
    bridge = Bridge(client=client, robot_id=robot_id, dry_run=True)
    bridge.start()
    log.info("bridge connected", extra=log_extra(robot_id=robot_id))
    threading.Event().wait()  # block forever


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_bridge.py -q`
Expected: PASS (5 passed).

- [ ] **Step 6: Commit**

```bash
cd ~/cs7980-guide-mate
git add src/guide_mate_bridge/guide_mate_bridge/iot_client.py src/guide_mate_bridge/guide_mate_bridge/bridge.py src/guide_mate_bridge/tests/test_bridge.py
git commit -m "Kalhar: bridge IoT mTLS client + main with dedupe and dry-run guard"
```

---

## Task 5: Service-side RobotRegistry (MQTT-over-WebSocket SigV4)

**Files:**
- Create: `agent_service/guidemate_agent/mqtt_link.py`
- Test: `agent_service/tests/test_mqtt_link.py`

**Interfaces:**
- Consumes: `Command`, `Ack`, `cmd_topic`, `status_topic` (Task 1).
- Produces: `class RobotRegistry(endpoint, region, robot_ids: list[str], client_id_prefix="guidemate-svc", connection=None)`. `connect()` dials one WebSocket-SigV4 connection and subscribes wildcard `guidemate/+/status`. `send_command(robot_id, cmd: Command, timeout_s=5.0) -> list[Ack]` publishes to `cmd_topic(robot_id)` QoS 1, blocks until an ack with state `done`/`failed` or timeout, returns collected acks (empty = unreachable). `get_status(robot_id) -> dict` (presence + last ack/status). Multi-robot is first-class: state keyed by `robot_id`, parsed from the topic. `connection` injectable for tests.

- [ ] **Step 1: Verify the awscrt credentials-provider API in a REPL (do this first)**

Run:
```bash
cd ~/cs7980-guide-mate && .venv/bin/python - <<'PY'
from awscrt import auth
print("new_delegate:", hasattr(auth.AwsCredentialsProvider, "new_delegate"))
print("new_static:", hasattr(auth.AwsCredentialsProvider, "new_static"))
import inspect
print(inspect.signature(auth.AwsCredentials.__init__))
PY
```
Expected: `new_delegate: True`. If it prints `False`, the code below auto-falls back to `new_static` (already handled) — no change needed. Note the `AwsCredentials.__init__` signature: it takes positional `(access_key_id, secret_access_key, session_token=None, expiration=None)`. The implementation below passes them positionally to stay compatible.

- [ ] **Step 2: Write the failing test (injected FakeConnection round-trip)**

`agent_service/tests/test_mqtt_link.py`:
```python
import json
import threading

from guidemate_msgs.messages import Ack, Command, cmd_topic, status_topic

from guidemate_agent.mqtt_link import RobotRegistry


class FakeFuture:
    def result(self, timeout=None):
        return None


class FakeConnection:
    def __init__(self):
        self.published = []
        self.status_cb = None

    def connect(self):
        return FakeFuture()

    def subscribe(self, topic, qos, callback):
        self.status_cb = callback
        return FakeFuture(), 1

    def publish(self, topic, payload, qos, **kwargs):
        text = payload.decode("utf-8") if isinstance(payload, (bytes, bytearray)) else payload
        self.published.append((topic, text))
        return FakeFuture(), 1

    def feed_status(self, robot_id, ack: Ack):
        self.status_cb(
            topic=status_topic(robot_id),
            payload=ack.model_dump_json().encode("utf-8"),
            dup=False,
            qos=1,
            retain=False,
        )


def _registry():
    fake = FakeConnection()
    reg = RobotRegistry(
        endpoint="x", region="us-west-2", robot_ids=["turtlebot468"], connection=fake
    )
    reg.connect()
    return reg, fake


def test_send_command_collects_acks_until_done():
    reg, fake = _registry()
    cmd = Command(type="emote", name="happy")
    acks_out = {}

    def worker():
        acks_out["acks"] = reg.send_command("turtlebot468", cmd, timeout_s=2.0)

    t = threading.Thread(target=worker)
    t.start()
    # Give the worker a moment to register its waiter, then feed the robot's acks.
    for state in ("received", "running", "done"):
        fake.feed_status("turtlebot468", Ack(cmd_id=cmd.cmd_id, state=state, simulated=True))
    t.join(timeout=3.0)

    acks = acks_out["acks"]
    assert [a.state for a in acks] == ["received", "running", "done"]
    assert acks[-1].simulated is True
    assert (cmd_topic("turtlebot468"), cmd.model_dump_json()) in fake.published


def test_send_command_timeout_returns_empty():
    reg, _ = _registry()
    cmd = Command(type="emote", name="no")
    acks = reg.send_command("turtlebot468", cmd, timeout_s=0.2)
    assert acks == []


def test_presence_tracked_from_events():
    reg, fake = _registry()
    fake.status_cb(
        topic=status_topic("turtlebot468"),
        payload=json.dumps({"event": "online", "robot_id": "turtlebot468"}).encode("utf-8"),
        dup=False,
        qos=1,
        retain=False,
    )
    assert reg.get_status("turtlebot468")["presence"] == "online"
```

Note on the race: the worker registers its waiter inside `send_command` before it publishes; feeding acks after `t.start()` is safe because `feed_status` blocks on the same connection object the worker already used to register. If flakiness ever appears, add a tiny `reg._wait_registered(cmd.cmd_id)` poll — not needed for the reference implementation below, which registers the waiter before publishing.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_mqtt_link.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_agent.mqtt_link'`.

- [ ] **Step 4: Implement `mqtt_link.py`**

`agent_service/guidemate_agent/mqtt_link.py`:
```python
"""Service-side MQTT-over-WebSocket link + first-class multi-robot registry."""
from __future__ import annotations

import json
import logging
import threading
import uuid
from dataclasses import dataclass
from typing import Optional

import boto3
from awscrt import auth, mqtt
from awsiot import mqtt_connection_builder

from guidemate_msgs.messages import Ack, Command, cmd_topic

log = logging.getLogger(__name__)


@dataclass
class RobotState:
    robot_id: str
    presence: str = "unknown"          # online | offline | unknown
    last_status: Optional[dict] = None
    last_ack: Optional[dict] = None


def _credentials_provider(region: str):
    """AwsCredentialsProvider that refetches frozen boto3 creds on each signing call."""
    boto_creds = boto3.Session().get_credentials()
    if boto_creds is None:
        raise RuntimeError("no AWS credentials available for IoT WebSocket signing")

    def _fetch():
        frozen = boto_creds.get_frozen_credentials()
        return auth.AwsCredentials(frozen.access_key, frozen.secret_key, frozen.token)

    if hasattr(auth.AwsCredentialsProvider, "new_delegate"):
        return auth.AwsCredentialsProvider.new_delegate(_fetch)
    # Fallback: static provider from a one-shot freeze (documented in the plan).
    frozen = boto_creds.get_frozen_credentials()
    return auth.AwsCredentialsProvider.new_static(
        access_key_id=frozen.access_key,
        secret_access_key=frozen.secret_key,
        session_token=frozen.token,
    )


class RobotRegistry:
    def __init__(
        self,
        endpoint: str,
        region: str,
        robot_ids: list[str],
        client_id_prefix: str = "guidemate-svc",
        connection=None,
    ) -> None:
        self._endpoint = endpoint
        self._region = region
        self._robots = {rid: RobotState(robot_id=rid) for rid in robot_ids}
        self._client_id = f"{client_id_prefix}-{uuid.uuid4().hex[:8]}"
        self._lock = threading.Lock()
        self._waiters: dict[str, tuple[threading.Event, list[Ack]]] = {}
        self._conn = connection

    def _build_connection(self):
        return mqtt_connection_builder.websockets_with_default_aws_signing(
            endpoint=self._endpoint,
            region=self._region,
            credentials_provider=_credentials_provider(self._region),
            client_id=self._client_id,
        )

    def connect(self) -> None:
        if self._conn is None:
            self._conn = self._build_connection()
        self._conn.connect().result()
        future, _ = self._conn.subscribe(
            topic="guidemate/+/status",
            qos=mqtt.QoS.AT_LEAST_ONCE,
            callback=self._on_status,
        )
        future.result()

    def _on_status(self, topic, payload, dup, qos, retain, **kwargs):
        try:
            data = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            log.warning("undecodable status payload on %s", topic)
            return
        parts = topic.split("/")
        robot_id = parts[1] if len(parts) >= 2 else "?"
        with self._lock:
            state = self._robots.setdefault(robot_id, RobotState(robot_id=robot_id))
            if data.get("event") in ("online", "offline"):
                state.presence = data["event"]
                state.last_status = data
                return
            state.last_ack = data
            state.last_status = data
            cmd_id = data.get("cmd_id")
            waiter = self._waiters.get(cmd_id) if cmd_id else None
        if waiter is None:
            return
        event, acks = waiter
        try:
            acks.append(Ack.model_validate(data))
        except Exception:  # noqa: BLE001
            return
        if data.get("state") in ("done", "failed"):
            event.set()

    def send_command(self, robot_id: str, cmd: Command, timeout_s: float = 5.0) -> list[Ack]:
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
            event.wait(timeout_s)
        finally:
            with self._lock:
                self._waiters.pop(cmd.cmd_id, None)
        return list(acks)

    def get_status(self, robot_id: str) -> dict:
        with self._lock:
            state = self._robots.get(robot_id)
            if state is None:
                return {"robot_id": robot_id, "presence": "unknown"}
            return {
                "robot_id": robot_id,
                "presence": state.presence,
                "last_ack": state.last_ack,
                "last_status": state.last_status,
            }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_mqtt_link.py -q`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/mqtt_link.py agent_service/tests/test_mqtt_link.py
git commit -m "Kalhar: service RobotRegistry over MQTT-WebSocket SigV4 (multi-robot)"
```

---

## Task 6: Strands verify + DogAgent + FastAPI app + chat page

**Files:**
- Create: `agent_service/guidemate_agent/config.py`, `agent_service/guidemate_agent/dog_agent.py`, `agent_service/guidemate_agent/app.py`, `agent_service/static/index.html`
- Test: `agent_service/tests/test_app.py`, `agent_service/tests/integration/test_live_agent.py`, `agent_service/tests/integration/__init__.py`

**Interfaces:**
- Consumes: `RobotRegistry` (Task 5); `Command` (Task 1); `setup` (Task 1).
- Produces:
  - `class Config(robot_ids, iot_endpoint, model_id, region)` with `Config.from_env()` — reads `GUIDEMATE_ROBOTS` (comma-sep, default `turtlebot468`), `GUIDEMATE_IOT_ENDPOINT`, `GUIDEMATE_MODEL_ID` (default `us.anthropic.claude-sonnet-4-6`), `AWS_REGION` (default `us-west-2`).
  - `PERSONA: str`.
  - `class DogAgent(registry, model_id, robot_ids)` with `chat(message, robot_id=None) -> {"reply_text": str, "emote": Optional[str], "robot": list[dict], "turn_id": str}`. Builds a fresh Strands `Agent` per call with a closure `@tool send_emote(name)` that runs `Command(type="emote", name=name)` through `registry.send_command` against the target robot (default = first configured robot).
  - FastAPI `app` with `GET /healthz` → `{"ok": True}`, `POST /api/chat {"message": str}` → `DogAgent.chat` JSON, `GET /` → `static/index.html`.

- [ ] **Step 1: Verify the strands-agents import surface in a REPL (do this before writing dog_agent)**

Run:
```bash
cd ~/cs7980-guide-mate && .venv/bin/python - <<'PY'
import strands
from strands import Agent, tool
from strands.models import BedrockModel
import inspect
print("Agent:", "Agent" in dir(strands))
print("BedrockModel init:", inspect.signature(BedrockModel.__init__))
print("Agent init:", inspect.signature(Agent.__init__))
PY
```
Expected: imports succeed. Confirm the `BedrockModel.__init__` kwarg name for region — it is `region_name` in current strands-agents. **Fallback notes:** if the REPL shows `region` instead of `region_name`, change the `BedrockModel(...)` call in Step 5 accordingly. If `from strands.models import BedrockModel` fails, try `from strands.models.bedrock import BedrockModel`. If invoking the agent as `agent(message)` is not supported, use `agent.run(message)` (both return an object whose `str()` is the reply text). Record whichever worked in the commit message.

- [ ] **Step 2: Write the failing tests**

`agent_service/tests/test_app.py`:
```python
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
```

`agent_service/tests/integration/__init__.py` — empty file.

`agent_service/tests/integration/test_live_agent.py`:
```python
import pytest

from guidemate_agent.dog_agent import DogAgent


class FakeRegistry:
    def send_command(self, robot_id, cmd, timeout_s=5.0):
        from guidemate_msgs.messages import Ack
        return [
            Ack(cmd_id=cmd.cmd_id, state="received", simulated=True),
            Ack(cmd_id=cmd.cmd_id, state="running", simulated=True),
            Ack(cmd_id=cmd.cmd_id, state="done", simulated=True),
        ]


@pytest.mark.live
def test_live_bedrock_smoke():
    agent = DogAgent(
        registry=FakeRegistry(),
        model_id="us.anthropic.claude-sonnet-4-6",
        robot_ids=["turtlebot468"],
    )
    result = agent.chat("do a happy wiggle")
    assert result["reply_text"].strip()
    assert result["emote"] is not None
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_app.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_agent.config'`.

- [ ] **Step 4: Implement `config.py`**

`agent_service/guidemate_agent/config.py`:
```python
"""Simple env-based config (no pydantic dependency)."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Config:
    robot_ids: list[str]
    iot_endpoint: str
    model_id: str
    region: str

    @classmethod
    def from_env(cls) -> "Config":
        robots = os.environ.get("GUIDEMATE_ROBOTS", "turtlebot468")
        robot_ids = [r.strip() for r in robots.split(",") if r.strip()]
        return cls(
            robot_ids=robot_ids,
            iot_endpoint=os.environ.get("GUIDEMATE_IOT_ENDPOINT", ""),
            model_id=os.environ.get("GUIDEMATE_MODEL_ID", "us.anthropic.claude-sonnet-4-6"),
            region=os.environ.get("AWS_REGION", "us-west-2"),
        )
```

- [ ] **Step 5: Implement `dog_agent.py`**

`agent_service/guidemate_agent/dog_agent.py` (adjust the two import/kwarg lines per Step 1 if the REPL differed):
```python
"""Robert the robot dog — Strands agent that emotes exactly once per reply."""
from __future__ import annotations

import logging
import uuid
from typing import Optional

from strands import Agent, tool
from strands.models import BedrockModel

from guidemate_msgs.messages import Command

log = logging.getLogger(__name__)

PERSONA = (
    "You are Robert, the friendly robot dog of the CS7980 guide-mate project. "
    "You are playful and warm and speak in short, dog-like replies. "
    "You MUST call the send_emote tool exactly once per reply, with one of "
    "'happy', 'yes', or 'no' — pick the emote that matches your reply's mood."
)


class DogAgent:
    def __init__(self, registry, model_id: str, robot_ids: list[str]) -> None:
        self._registry = registry
        self._model_id = model_id
        self._robot_ids = robot_ids

    def chat(self, message: str, robot_id: Optional[str] = None) -> dict:
        turn_id = str(uuid.uuid4())
        target = robot_id or (self._robot_ids[0] if self._robot_ids else None)
        captured = {"emote": None, "acks": []}

        @tool
        def send_emote(name: str) -> str:
            """Play a physical emote on the dog. name is one of happy, yes, no."""
            captured["emote"] = name
            if target is None:
                return "robot did not respond — I'm probably napping offline"
            acks = self._registry.send_command(target, Command(type="emote", name=name))
            captured["acks"] = [a.model_dump() for a in acks]
            if not acks:
                return "robot did not respond — I'm probably napping offline"
            return "emote delivered (simulated)"

        model = BedrockModel(model_id=self._model_id, region_name="us-west-2")
        agent = Agent(model=model, system_prompt=PERSONA, tools=[send_emote])
        result = agent(message)
        return {
            "reply_text": str(result),
            "emote": captured["emote"],
            "robot": captured["acks"],
            "turn_id": turn_id,
        }
```

- [ ] **Step 6: Implement `app.py`**

`agent_service/guidemate_agent/app.py`:
```python
"""FastAPI app: plain chat API + static chat page."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from guidemate_msgs.jsonlog import setup

from guidemate_agent.config import Config
from guidemate_agent.dog_agent import DogAgent
from guidemate_agent.mqtt_link import RobotRegistry

log = logging.getLogger(__name__)
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


class ChatRequest(BaseModel):
    message: str


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup("agent-service")
    cfg = Config.from_env()
    registry = RobotRegistry(
        endpoint=cfg.iot_endpoint, region=cfg.region, robot_ids=cfg.robot_ids
    )
    try:
        registry.connect()
    except Exception:  # noqa: BLE001 — chat still works if robots are unreachable
        log.exception("registry connect failed — robots unreachable, chat still works")
    app.state.registry = registry
    app.state.agent = DogAgent(
        registry=registry, model_id=cfg.model_id, robot_ids=cfg.robot_ids
    )
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.post("/api/chat")
def chat(req: ChatRequest) -> JSONResponse:
    return JSONResponse(app.state.agent.chat(req.message))


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
```

- [ ] **Step 7: Implement the chat page `static/index.html`**

`agent_service/static/index.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Robert the Robot Dog</title>
</head>
<body>
  <h1>Robert the Robot Dog</h1>
  <div id="messages" style="border:1px solid #ccc;padding:8px;min-height:200px;margin-bottom:8px;"></div>
  <form id="chat-form">
    <input id="message" autocomplete="off" placeholder="Say something to Robert..." style="width:70%" />
    <button type="submit">Send</button>
  </form>
  <script>
    const messages = document.getElementById("messages");
    const form = document.getElementById("chat-form");
    const input = document.getElementById("message");

    function add(role, text) {
      const p = document.createElement("p");
      p.textContent = role + ": " + text;
      messages.appendChild(p);
      messages.scrollTop = messages.scrollHeight;
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      add("You", text);
      input.value = "";
      try {
        const resp = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        const data = await resp.json();
        let line = data.reply_text || "(no reply)";
        if (data.emote) line += "  [emote: " + data.emote + "]";
        if (data.robot && data.robot.length) {
          const last = data.robot[data.robot.length - 1];
          line += "  [ack: " + last.state + (last.simulated ? " (simulated)" : "") + "]";
        }
        add("Robert", line);
      } catch (err) {
        add("Robert", "(error: " + err + ")");
      }
    });
  </script>
</body>
</html>
```

- [ ] **Step 8: Run the unit tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_app.py -q`
Expected: PASS (5 passed). The `live` test in `tests/integration/test_live_agent.py` is skipped (no `GUIDEMATE_LIVE`).

- [ ] **Step 9: Run the live Bedrock smoke test (gated)**

Run: `cd ~/cs7980-guide-mate && GUIDEMATE_LIVE=1 .venv/bin/python -m pytest agent_service/tests/integration/test_live_agent.py -q`
Expected: PASS (1 passed) — a real Bedrock turn returns a non-empty reply and a captured emote. If this fails on an import/kwarg mismatch, apply the Step 1 fallbacks to `dog_agent.py` and re-run.

- [ ] **Step 10: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/config.py agent_service/guidemate_agent/dog_agent.py agent_service/guidemate_agent/app.py agent_service/static/index.html agent_service/tests/test_app.py agent_service/tests/integration/__init__.py agent_service/tests/integration/test_live_agent.py
git commit -m "Kalhar: DogAgent (Robert persona + send_emote) + FastAPI chat API/page"
```

---

## Task 7: IoT dev policy + IoT logging + real IoT Core round-trip integration test

**Files:**
- Create: `agent_service/tests/integration/test_roundtrip.py`
- Modify: `docs/agent-poc/access-ground-truth.md` (append resource rows)
- AWS: create policy `guidemate-dev-policy`, attach to the dev cert; enable IoT v2 logging.

**Interfaces:**
- Consumes: `RobotRegistry` (Task 5); `Command`, `Ack` (Task 1); the bridge `main` entry point (Task 4).
- Produces: a gated integration test that runs the real bridge as a subprocess on this box (dev cert, `robot_id=devtest`, dry-run) and asserts a full `received→running→done` `simulated=True` round-trip over real IoT Core in < 10 s.

- [ ] **Step 1: Create the additive dev IoT policy and attach it to the dev cert**

Write the policy document to the scratchpad, then create + attach:
```bash
cat > /tmp/guidemate-dev-policy.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "iot:Connect",
      "Resource": "arn:aws:iot:us-west-2:852373397000:client/guidemate-*"
    },
    {
      "Effect": "Allow",
      "Action": ["iot:Publish", "iot:Receive"],
      "Resource": "arn:aws:iot:us-west-2:852373397000:topic/guidemate/devtest/*"
    },
    {
      "Effect": "Allow",
      "Action": "iot:Receive",
      "Resource": "arn:aws:iot:us-west-2:852373397000:topic/guidemate/+/status"
    },
    {
      "Effect": "Allow",
      "Action": "iot:Subscribe",
      "Resource": [
        "arn:aws:iot:us-west-2:852373397000:topicfilter/guidemate/devtest/*",
        "arn:aws:iot:us-west-2:852373397000:topicfilter/guidemate/+/status"
      ]
    }
  ]
}
JSON
aws iot create-policy --policy-name guidemate-dev-policy \
  --policy-document file:///tmp/guidemate-dev-policy.json \
  --tags Key=project,Value=guidemate-poc
aws iot attach-policy --policy-name guidemate-dev-policy \
  --target arn:aws:iot:us-west-2:852373397000:cert/aec82bf4fbb4c9c0f91ae5869e58b8b057d0d8d02d6ac37dbfa8e292f411d140
```
Expected: policy created (ARN printed) and attached with no error. (If `create-policy` reports the policy already exists from a prior run, skip to `attach-policy`.)

- [ ] **Step 2: Enable IoT v2 logging (check first; create the role only if needed)**

```bash
aws iot get-v2-logging-options || echo "no logging configured yet"
```
If a suitable role ARN is already returned, reuse it in the `set-v2-logging-options` call. Otherwise create the logging role:
```bash
cat > /tmp/iot-logging-trust.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "iot.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
JSON
aws iam create-role --role-name guidemate-iot-logging-role \
  --assume-role-policy-document file:///tmp/iot-logging-trust.json \
  --tags Key=project,Value=guidemate-poc
aws iam attach-role-policy --role-name guidemate-iot-logging-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSIotLoggingRole
```
Then enable logging (substitute the real role ARN printed above):
```bash
aws iot set-v2-logging-options \
  --default-log-level WARN \
  --role-arn arn:aws:iam::852373397000:role/guidemate-iot-logging-role
```
Expected: no error. IoT policy denials now surface in CloudWatch Logs group `AWSIotLogsV2`.

- [ ] **Step 3: Write the failing integration test**

`agent_service/tests/integration/test_roundtrip.py`:
```python
import os
import subprocess
import sys
import time
import urllib.request

import pytest

from guidemate_msgs.messages import Command

from guidemate_agent.mqtt_link import RobotRegistry

DEV_CERT = os.path.expanduser("~/.aws/guidemate-dev.cert.pem")
DEV_KEY = os.path.expanduser("~/.aws/guidemate-dev.private.key")
CA_PATH = os.path.expanduser("~/certs/AmazonRootCA1.pem")
CA_URL = "https://www.amazontrust.com/repository/AmazonRootCA1.pem"


def _discover_endpoint() -> str:
    out = subprocess.check_output(
        ["aws", "iot", "describe-endpoint", "--endpoint-type", "iot:Data-ATS",
         "--query", "endpointAddress", "--output", "text"],
        text=True,
    )
    return out.strip()


def _ensure_ca() -> str:
    if not os.path.exists(CA_PATH):
        os.makedirs(os.path.dirname(CA_PATH), exist_ok=True)
        urllib.request.urlretrieve(CA_URL, CA_PATH)
    return CA_PATH


@pytest.mark.integration
def test_real_iot_roundtrip():
    endpoint = _discover_endpoint()
    ca = _ensure_ca()
    env = dict(os.environ)
    env.update({
        "GUIDEMATE_ROBOT_ID": "devtest",
        "GUIDEMATE_IOT_ENDPOINT": endpoint,
        "GUIDEMATE_CERT": DEV_CERT,
        "GUIDEMATE_KEY": DEV_KEY,
        "GUIDEMATE_CA": ca,
        "GUIDEMATE_DRY_RUN": "1",
    })
    bridge = subprocess.Popen(
        [sys.executable, "-m", "guide_mate_bridge.bridge"],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    reg = RobotRegistry(endpoint=endpoint, region="us-west-2", robot_ids=["devtest"])
    try:
        reg.connect()
        time.sleep(3.0)  # let the bridge connect + subscribe
        cmd = Command(type="emote", name="happy")
        start = time.time()
        acks = reg.send_command("devtest", cmd, timeout_s=10.0)
        elapsed = time.time() - start
        states = [a.state for a in acks]
        assert states[:1] == ["received"]
        assert states[-1] == "done"
        assert acks[-1].simulated is True
        assert elapsed < 10.0
    finally:
        bridge.terminate()
        try:
            bridge.wait(timeout=5)
        except subprocess.TimeoutExpired:
            bridge.kill()
```

- [ ] **Step 4: Run the integration test (gated)**

Run: `cd ~/cs7980-guide-mate && GUIDEMATE_INTEGRATION=1 .venv/bin/python -m pytest agent_service/tests/integration/test_roundtrip.py -q`
Expected: PASS (1 passed). If it fails with an MQTT authorization error, check the CloudWatch `AWSIotLogsV2` group (now enabled) for the denied topic and confirm the dev policy attached in Step 1.

- [ ] **Step 5: Document the new AWS resources in access-ground-truth.md**

Append a section to `docs/agent-poc/access-ground-truth.md` (below the "Required setup steps" section):
```markdown
## Dog-agent POC dev resources (created 2026-07-05, Phase 0-1)
| Resource | Id / name | Notes |
|---|---|---|
| IoT policy `guidemate-dev-policy` | attached to dev cert `aec82bf4…` | Connect `client/guidemate-*`; Pub/Receive `guidemate/devtest/*`; Receive `guidemate/+/status`; Subscribe `guidemate/devtest/*` + `guidemate/+/status`. Additive; robot policy untouched. Tag `project=guidemate-poc`. |
| IAM role `guidemate-iot-logging-role` | trusts `iot.amazonaws.com` | `AWSIotLoggingRole` managed policy; used by IoT v2 logging (default level WARN). Tag `project=guidemate-poc`. Created only if no logging role existed. |
| IoT v2 logging | default level `WARN` | Denials land in CloudWatch `AWSIotLogsV2`. |
```

- [ ] **Step 6: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/tests/integration/test_roundtrip.py docs/agent-poc/access-ground-truth.md
git commit -m "Kalhar: dev IoT policy + IoT logging + real IoT Core round-trip test"
```

---

## Task 8: Pi deploy (systemd installer over SSH) + Phase 1 slice check

**Files:**
- Create: `src/guide_mate_bridge/systemd/guidemate-bridge.service`, `src/guide_mate_bridge/scripts/install_bridge_on_pi.sh`, `scripts/slice_check.sh`

**Interfaces:**
- Consumes: the bridge package (Tasks 1, 3, 4); the agent service (Task 6); dev/robot IoT identities.
- Produces: an SSH-driven, additive, idempotent installer that stands up `guidemate-bridge.service` on the Pi in dry-run; a scripted Phase 1 exit test that proves checklist items 1 and 3 (agent reply + Pi DRY-RUN twist log + simulated ack).

- [ ] **Step 1: Create the systemd unit template**

`src/guide_mate_bridge/systemd/guidemate-bridge.service` (tokens `@…@` are rendered by the installer; no endpoint/secret is committed):
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
Environment=GUIDEMATE_DRY_RUN=1
Environment=GUIDEMATE_IOT_ENDPOINT=@IOT_ENDPOINT@
Environment=GUIDEMATE_CERT=@CERT@
Environment=GUIDEMATE_KEY=@KEY@
Environment=GUIDEMATE_CA=@CA@
ExecStart=/home/ubuntu/guidemate-venv/bin/python -m guide_mate_bridge.bridge
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Create the installer (runs FROM this box, drives the Pi over SSH)**

`src/guide_mate_bridge/scripts/install_bridge_on_pi.sh`:
```bash
#!/usr/bin/env bash
# Install/refresh the guidemate-bridge systemd service on the Pi (robot 468).
# ADDITIVE ONLY: touches nothing but ~/guidemate-venv, ~/certs, and the new unit.
# Never kills or restarts existing bringup. Run from the Linux box.
set -euo pipefail

SSH_HOST="${SSH_HOST:-guidemate}"
ROBOT_ID="${ROBOT_ID:-turtlebot468}"
PI_REPO="/home/ubuntu/cs7980-guide-mate"
PI_VENV="/home/ubuntu/guidemate-venv"
CERT="${PI_REPO}/Turtlebot-468.cert.pem"
KEY="${PI_REPO}/Turtlebot-468.private.key"
CA="/home/ubuntu/certs/AmazonRootCA1.pem"
UNIT_SRC="$(cd "$(dirname "$0")/.." && pwd)/systemd/guidemate-bridge.service"

echo ">> Discovering IoT data endpoint (local AWS creds)"
ENDPOINT="$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)"
echo "   endpoint: ${ENDPOINT}"

echo ">> git pull on the Pi (repo is the transport)"
ssh "${SSH_HOST}" "cd ${PI_REPO} && git pull --ff-only"

echo ">> Ensure venv (idempotent) + install bridge + shared msgs editable"
ssh "${SSH_HOST}" "test -d ${PI_VENV} || python3 -m venv --system-site-packages ${PI_VENV}"
ssh "${SSH_HOST}" "${PI_VENV}/bin/pip install --upgrade pip && \
  ${PI_VENV}/bin/pip install -e ${PI_REPO}/shared/guidemate_msgs -e ${PI_REPO}/src/guide_mate_bridge"

echo ">> Ensure Amazon Root CA on the Pi"
ssh "${SSH_HOST}" "mkdir -p /home/ubuntu/certs && \
  ([ -f ${CA} ] || curl -fsSL https://www.amazontrust.com/repository/AmazonRootCA1.pem -o ${CA})"

echo ">> Render + install the systemd unit via sudo tee"
sed -e "s#@ROBOT_ID@#${ROBOT_ID}#g" \
    -e "s#@IOT_ENDPOINT@#${ENDPOINT}#g" \
    -e "s#@CERT@#${CERT}#g" \
    -e "s#@KEY@#${KEY}#g" \
    -e "s#@CA@#${CA}#g" \
    "${UNIT_SRC}" \
  | ssh "${SSH_HOST}" "sudo tee /etc/systemd/system/guidemate-bridge.service >/dev/null"

echo ">> daemon-reload + enable --now (additive; no other service touched)"
ssh "${SSH_HOST}" "sudo systemctl daemon-reload && sudo systemctl enable --now guidemate-bridge.service"

echo ">> Recent logs (expect 'connected' + online event)"
ssh "${SSH_HOST}" "journalctl -u guidemate-bridge -n 30 --no-pager"
```

- [ ] **Step 3: Deploy to the Pi**

Run: `cd ~/cs7980-guide-mate && bash src/guide_mate_bridge/scripts/install_bridge_on_pi.sh`
Expected: ends by printing journalctl output containing a JSON line `"msg": "bridge connected"` and the online-event publish. If the service is `active (running)` with no `X_LINK`/auth errors, the bridge is live in dry-run.

Manual confirmation:
```bash
ssh guidemate 'systemctl is-active guidemate-bridge'
```
Expected: `active`.

- [ ] **Step 4: Create the Phase 1 slice check script**

`scripts/slice_check.sh`:
```bash
#!/usr/bin/env bash
# Phase 1 exit test (checklist items 1 & 3): chat -> agent -> MQTT -> Pi bridge dry-run.
# Prereq: bridge installed on the Pi (install_bridge_on_pi.sh) and running.
# Run from the Linux box repo root: bash scripts/slice_check.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ROBOT_ID="${ROBOT_ID:-turtlebot468}"
PORT="${PORT:-8080}"

echo ">> Discovering IoT endpoint"
export GUIDEMATE_IOT_ENDPOINT="$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)"
export GUIDEMATE_ROBOTS="${ROBOT_ID}"

echo ">> Starting uvicorn (service connects to IoT via SigV4)"
.venv/bin/python -m uvicorn guidemate_agent.app:app --app-dir agent_service --port "${PORT}" &
UVICORN_PID=$!
trap 'kill ${UVICORN_PID} 2>/dev/null || true' EXIT

# Wait for /healthz
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null; then break; fi
  sleep 1
done

echo ">> Sending chat: 'do a happy wiggle'"
RESP="$(curl -sf -X POST "http://127.0.0.1:${PORT}/api/chat" \
  -H 'Content-Type: application/json' -d '{"message":"do a happy wiggle"}')"
echo "   response: ${RESP}"

echo "${RESP}" | .venv/bin/python -c '
import json, sys
d = json.load(sys.stdin)
assert d.get("emote") is not None, "no emote captured"
acks = d.get("robot") or []
assert any(a.get("simulated") is True for a in acks), "no simulated ack"
print("   OK: emote =", d["emote"], "| acks =", [a["state"] for a in acks])
'

echo ">> Confirming the Pi bridge logged DRY-RUN twists"
ssh guidemate "journalctl -u guidemate-bridge -n 50 --no-pager | grep 'DRY-RUN twist'" \
  && echo "   OK: DRY-RUN twist lines present on the Pi" \
  || { echo "   FAIL: no DRY-RUN twist lines"; exit 1; }

echo ">> Phase 1 slice check PASSED (checklist items 1 & 3)"
```

- [ ] **Step 5: Run the slice check (Phase 1 exit test)**

Run: `cd ~/cs7980-guide-mate && chmod +x scripts/slice_check.sh src/guide_mate_bridge/scripts/install_bridge_on_pi.sh && bash scripts/slice_check.sh`
Expected: prints the chat response JSON with a non-null `emote` and a `simulated` ack, then `OK: DRY-RUN twist lines present on the Pi`, ending with `Phase 1 slice check PASSED`. This proves the spec no-motion checklist items **1** (chat → agent → MQTT → bridge ack) and **3** (bridge computes + logs the `cmd_vel` sequence, publishes nothing, acks `"simulated": true`).

- [ ] **Step 6: Commit**

```bash
cd ~/cs7980-guide-mate
git add src/guide_mate_bridge/systemd/guidemate-bridge.service src/guide_mate_bridge/scripts/install_bridge_on_pi.sh scripts/slice_check.sh
git commit -m "Kalhar: Pi bridge systemd installer + Phase 1 slice check"
```

---

## Phase 0 & 1 exit checklist (verify before declaring done)

- [ ] **Phase 0:** `.venv/bin/python -m pytest shared/guidemate_msgs/tests -q` all green; the six trajectory PNGs in `shared/guidemate_msgs/tests/artifacts/` look correct (circle closes, spin is a point).
- [ ] **Phase 1:** `bash scripts/slice_check.sh` passes end-to-end — `curl "do a happy wiggle"` returns a dog reply, the Pi's `journalctl -u guidemate-bridge` shows the computed `DRY-RUN twist …` lines, and the ack round-trips with `"simulated": true`. Checklist items 1 and 3 proven.
- [ ] Full suite (default gating): `.venv/bin/python -m pytest -q` — unit tests green, integration/live tests skipped.
- [ ] Robot 468 untouched beyond the additive `guidemate-bridge.service`; shadow not modified; `GUIDEMATE_DRY_RUN=1` enforced.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-05-dog-agent-phase-0-1.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
