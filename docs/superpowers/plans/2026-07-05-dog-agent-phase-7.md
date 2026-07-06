# Dog Agent POC — Phase 7 (Production) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the dog-agent service as a container behind Caddy auto-TLS on an EC2 t3.large at `https://<eip>.nip.io`, wired to CloudWatch observability (EMF metrics, a dashboard, four alarms, Bedrock invocation logging, and log-shipping from both EC2 and the Pi) — everything scripted, nothing clicked in the console.

**Architecture:** The already-built FastAPI service (`agent_service/`) is packaged with a `python:3.12-slim` Dockerfile and a two-file Compose stack (`app` + `caddy`) that runs *identically* on the Linux box and on EC2; a `compose.prod.yaml` overlay switches container logging to the `awslogs` driver. A shared EMF metrics helper in `shared/guidemate_msgs` turns metrics into stdout log lines that the `awslogs` driver (service) and `put-log-events` (Pi) deliver to CloudWatch, where they auto-extract — zero metrics infra. Deploy is three idempotent-ish bash scripts driven by the AWS CLI (`launch_ec2.sh`, `redeploy.sh`, `teardown.sh`), management is via SSM Session Manager (no SSH keys), and one `setup_observability.sh` creates the dashboard, alarms, metric filters, and Bedrock logging. A tiny systemd timer ships the Pi's bridge journal to CloudWatch without installing the heavy ARM CloudWatch agent.

**Tech Stack:** Docker + Compose v2, Caddy 2 (auto-TLS via Let's Encrypt on `<eip>.nip.io`), AWS EC2 (AL2023 t3.large, instance profile `guidemate-agent-profile`), Elastic IP, SSM Session Manager, CloudWatch Logs + EMF + Dashboards + Alarms, Amazon Bedrock model-invocation logging, systemd timer on the Pi, Python 3.12 runtime (3.10-compatible source), pytest.

## Global Constraints

Every task's requirements implicitly include this section.

- **Python 3.10-compatible source** on both machines — no 3.11+ syntax. The service *runs* on Python 3.12 in the container, which executes the 3.10 subset fine. `list[...]`/`dict[...]` generics are fine with `from __future__ import annotations`.
- **pydantic v2** (`>=2`) where models are used; the EMF helper is pure stdlib.
- **TDD**: write the failing test first, run it red, implement the minimum, run it green, then commit — every task that touches Python.
- **Commit after every task** with a `Kalhar:` message prefix. **NEVER** add any Claude/AI/co-author line or `Co-Authored-By`. Do not push (the user pushes).
- **Never `pkill -f`** anything on the Pi (gotcha #6 — it self-matches the shell). Kill by PID / `systemctl` if ever needed; this plan never kills.
- **Robot 468 stays docked and motion-locked**: the bridge keeps `GUIDEMATE_DRY_RUN=1`, the Device Shadow is **not touched** by this plan, no `cmd_vel` is ever published. Phase 7 adds only the log-ship timer to the Pi — additive, read-only on the bridge journal.
- **No credentials, IoT endpoints, EIPs, or admin passwords committed** to the repo. The IoT data endpoint is discovered at runtime (`aws iot describe-endpoint --endpoint-type iot:Data-ATS`). Cert/key/`.env` files stay out of git (already gitignored: `*.pem`, `*.key`, `.venv/`; this plan adds `agent_service/deploy/*.env` and `**/artifacts/`).
- **On-Pi work over SSH is additive only** — the log-ship installer only adds `guidemate-logship.{service,timer}` and a state dir; it never touches the bridge unit, bringup, or configs.
- **Every new AWS resource** is tagged `project=guidemate-poc` where the API supports tags and documented in `docs/agent-poc/access-ground-truth.md`.
- **No console clicking.** Every AWS mutation is a scripted CLI call, re-runnable.
- **Integration/live tests are env-gated** (`GUIDEMATE_INTEGRATION=1`, `GUIDEMATE_LIVE=1`) and skipped by default (existing `conftest.py`).

**Verified environment facts (do not re-derive):** AWS account `852373397000`, region `us-west-2`. IAM role `guidemate-agent-role` (**AdministratorAccess**) via `credential_process`; AWS CLI v2 at `~/.local/bin/aws` (also on `PATH` as `aws`). Instance profile **`guidemate-agent-profile`** already EXISTS (same role; instances get it with zero credential setup). Bedrock model id `us.anthropic.claude-sonnet-4-6`. Docker 29.1.3 + Compose v2 are installed on the Linux box, **but the invoking user is NOT in the `docker` group** — Docker commands in this plan use `sudo docker` (passwordless sudo is available). Git remote `https://github.com/KalharPandya/cs7980-guide-mate.git`, work branch `kalhar/dog-agent-poc`. SSH alias `guidemate` → Pi (`ubuntu`, passwordless sudo); the Pi runs `guidemate-bridge.service` (dry-run) and has AWS creds via `credential_process` in `~/.aws/config`. The service app object is `guidemate_agent.app:app`, listens on port 8000 in the container, exposes `/healthz` (`{"ok": true}`) and `/api/chat`.

---

## File Structure

```
cs7980-guide-mate/
├── shared/guidemate_msgs/guidemate_msgs/
│   └── metrics.py                         # NEW (Task 1) — EMF emit_metric() helper
├── shared/guidemate_msgs/tests/
│   └── test_metrics.py                    # NEW (Task 1)
├── agent_service/
│   ├── guidemate_agent/
│   │   ├── app.py                         # MODIFY (Task 2) — TurnLatency EMF + /readyz
│   │   ├── dog_agent.py                   # MODIFY (Task 2) — AckRoundTrip + Bedrock tokens
│   │   └── prodcheck.py                   # NEW (Task 7) — chat round-trip assertions
│   ├── tests/
│   │   ├── test_metrics_instrumentation.py# NEW (Task 2)
│   │   └── test_prodcheck.py              # NEW (Task 7)
│   ├── Dockerfile                         # NEW (Task 3)
│   ├── compose.yaml                       # NEW (Task 3)
│   ├── compose.prod.yaml                  # NEW (Task 3)
│   ├── Caddyfile                          # NEW (Task 3)
│   ├── .dockerignore                      # NEW (Task 3)
│   └── deploy/
│       ├── user_data.sh                   # NEW (Task 4) — EC2 bootstrap
│       ├── launch_ec2.sh                  # NEW (Task 4)
│       ├── redeploy.sh                    # NEW (Task 5)
│       └── teardown.sh                    # NEW (Task 5)
├── src/guide_mate_bridge/
│   ├── guide_mate_bridge/logship.py       # NEW (Task 6) — Pi journal → CloudWatch
│   ├── tests/test_logship.py              # NEW (Task 6)
│   ├── systemd/guidemate-logship.service  # NEW (Task 6)
│   ├── systemd/guidemate-logship.timer    # NEW (Task 6)
│   └── scripts/install_logship_on_pi.sh   # NEW (Task 6)
└── scripts/
    ├── setup_observability.sh             # NEW (Task 6) — dashboard + alarms + Bedrock logging
    ├── prod_slice_check.sh                # NEW (Task 7)
    └── prod_verify.sh                     # NEW (Task 7)
```

**Metric contract (used by dashboard + alarms, Tasks 1/2/6):** namespace `GuideMate`.
- `TurnLatencyMs` (Milliseconds, no dimensions) — chat turn wall time.
- `AckRoundTripMs` (Milliseconds, dim `robot_id`) — emote command → terminal ack.
- `BedrockInputTokens` / `BedrockOutputTokens` (Count, no dimensions) — per turn, when Strands reports usage.
- `PiHeartbeat` (Count, dim `robot_id`) — emitted once per log-ship run from the Pi.
- `AgentServiceErrors` / `BedrockThrottles` (Count) — from metric filters on `/guidemate/agent-service`.

---

## Task 1: EMF metrics helper in `guidemate_msgs`

**Files:**
- Create: `shared/guidemate_msgs/guidemate_msgs/metrics.py`
- Test: `shared/guidemate_msgs/tests/test_metrics.py`

**Interfaces:**
- Consumes: nothing (pure stdlib).
- Produces: `emit_metric(name: str, value: float, unit: str = "Count", dimensions: Optional[dict] = None, namespace: str = "GuideMate") -> dict`. Writes one CloudWatch Embedded Metric Format JSON object to stdout (newline-terminated, flushed) and returns the payload dict. When `dimensions` is empty the EMF `Dimensions` field is `[[]]` (metric with no dimensions). Constant `NAMESPACE = "GuideMate"`.

- [ ] **Step 1: Write the failing test**

`shared/guidemate_msgs/tests/test_metrics.py`:
```python
import json

from guidemate_msgs.metrics import NAMESPACE, emit_metric


def test_emit_metric_emf_structure(capsys):
    payload = emit_metric(
        "AckRoundTripMs", 123.4, "Milliseconds", {"robot_id": "turtlebot468"}
    )
    line = capsys.readouterr().out.strip().splitlines()[-1]
    data = json.loads(line)
    assert data["AckRoundTripMs"] == 123.4
    assert data["robot_id"] == "turtlebot468"
    meta = data["_aws"]["CloudWatchMetrics"][0]
    assert meta["Namespace"] == NAMESPACE
    assert meta["Dimensions"] == [["robot_id"]]
    assert meta["Metrics"][0] == {"Name": "AckRoundTripMs", "Unit": "Milliseconds"}
    assert isinstance(data["_aws"]["Timestamp"], int)
    assert payload["AckRoundTripMs"] == 123.4


def test_emit_metric_no_dimensions(capsys):
    emit_metric("TurnLatencyMs", 50.0, "Milliseconds")
    data = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert data["_aws"]["CloudWatchMetrics"][0]["Dimensions"] == [[]]
    assert data["TurnLatencyMs"] == 50.0


def test_emit_metric_stringifies_dimension_values(capsys):
    emit_metric("X", 1, dimensions={"robot_id": 468})
    data = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert data["robot_id"] == "468"  # dimension values are always strings for CW
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest shared/guidemate_msgs/tests/test_metrics.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_msgs.metrics'`.

- [ ] **Step 3: Implement `metrics.py`**

`shared/guidemate_msgs/guidemate_msgs/metrics.py`:
```python
"""CloudWatch Embedded Metric Format (EMF) helper.

Metrics are just log lines. Print an EMF JSON blob to stdout; the Docker
`awslogs` driver (service) or `aws logs put-log-events` (Pi log-ship) delivers
it to CloudWatch Logs, which auto-extracts the embedded metric. Zero metrics
infrastructure, no PutMetricData throttling.
"""
from __future__ import annotations

import json
import sys
import time
from typing import Optional

NAMESPACE = "GuideMate"


def emit_metric(
    name: str,
    value: float,
    unit: str = "Count",
    dimensions: Optional[dict] = None,
    namespace: str = NAMESPACE,
) -> dict:
    dims = {key: str(val) for key, val in (dimensions or {}).items()}
    dim_keys = list(dims.keys())
    payload = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": namespace,
                    "Dimensions": [dim_keys],
                    "Metrics": [{"Name": name, "Unit": unit}],
                }
            ],
        },
        name: value,
    }
    payload.update(dims)
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()
    return payload
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest shared/guidemate_msgs/tests/test_metrics.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980-guide-mate
git add shared/guidemate_msgs/guidemate_msgs/metrics.py shared/guidemate_msgs/tests/test_metrics.py
git commit -m "Kalhar: EMF emit_metric helper in guidemate_msgs (metrics as log lines)"
```

---

## Task 2: Instrument the service — turn latency, ack RTT, Bedrock tokens, `/readyz`

**Files:**
- Modify: `agent_service/guidemate_agent/app.py`
- Modify: `agent_service/guidemate_agent/dog_agent.py`
- Test: `agent_service/tests/test_metrics_instrumentation.py`

**Interfaces:**
- Consumes: `emit_metric` (Task 1); existing `DogAgent`, `RobotRegistry`, `Config`.
- Produces:
  - `app.py`: `/api/chat` emits `TurnLatencyMs` after each turn; new `GET /readyz` returns `{"ready": bool, "checks": {"creds": bool, "registry": bool}}` with status 200 when ready else 503.
  - `dog_agent.py`: `_emote_impl` emits `AckRoundTripMs` (dim `robot_id`) around `send_command`; `chat` emits `BedrockInputTokens`/`BedrockOutputTokens` when available; helper `_usage_from_result(result) -> Optional[tuple[int, int]]` (returns `(input_tokens, output_tokens)` or `None`).

- [ ] **Step 1: Write the failing test**

`agent_service/tests/test_metrics_instrumentation.py`:
```python
import json
from types import SimpleNamespace

from fastapi.testclient import TestClient

from guidemate_agent.dog_agent import DogAgent, _usage_from_result


def _last_metric(capsys, name):
    out = capsys.readouterr().out
    hits = []
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if name in data and "_aws" in data:
            hits.append(data)
    return hits[-1] if hits else None


def test_usage_from_result_reads_accumulated_usage():
    result = SimpleNamespace(
        metrics=SimpleNamespace(accumulated_usage={"inputTokens": 12, "outputTokens": 34})
    )
    assert _usage_from_result(result) == (12, 34)


def test_usage_from_result_missing_is_none():
    assert _usage_from_result(SimpleNamespace()) is None
    assert _usage_from_result(SimpleNamespace(metrics=None)) is None
    assert _usage_from_result(SimpleNamespace(metrics=SimpleNamespace())) is None


class _FakeRegistry:
    def send_command(self, robot_id, cmd, timeout_s=5.0):
        return [SimpleNamespace(model_dump=lambda: {"state": "done", "simulated": True})]


def test_emote_impl_emits_ack_roundtrip(capsys):
    agent = DogAgent(registry=_FakeRegistry(), model_id="x", robot_ids=["turtlebot468"])
    captured = {"emote": None, "acks": []}
    agent._emote_impl("happy", "turtlebot468", captured)
    metric = _last_metric(capsys, "AckRoundTripMs")
    assert metric is not None
    assert metric["robot_id"] == "turtlebot468"
    assert metric["AckRoundTripMs"] >= 0.0


class _StubAgent:
    def chat(self, message, robot_id=None):
        return {"reply_text": "woof", "emote": "happy", "robot": [], "turn_id": "t1"}


def _app_with_stub(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_IOT_ENDPOINT", "invalid.example.com")
    import guidemate_agent.app as appmod

    def _boom(self):
        raise RuntimeError("no MQTT in unit test")

    monkeypatch.setattr(appmod.RobotRegistry, "connect", _boom)
    return appmod.app


def test_chat_endpoint_emits_turn_latency(monkeypatch, capsys):
    app = _app_with_stub(monkeypatch)
    with TestClient(app) as client:
        client.app.state.agent = _StubAgent()
        resp = client.post("/api/chat", json={"message": "hi"})
        assert resp.status_code == 200
    metric = _last_metric(capsys, "TurnLatencyMs")
    assert metric is not None
    assert metric["TurnLatencyMs"] >= 0.0


def test_readyz_returns_checks(monkeypatch):
    app = _app_with_stub(monkeypatch)
    with TestClient(app) as client:
        resp = client.get("/readyz")
    assert resp.status_code in (200, 503)
    body = resp.json()
    assert "checks" in body and "registry" in body["checks"] and "creds" in body["checks"]
    assert body["ready"] == all(body["checks"].values())
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_metrics_instrumentation.py -q`
Expected: FAIL — `ImportError: cannot import name '_usage_from_result'` (and `/readyz` 404).

- [ ] **Step 3: Instrument `dog_agent.py`**

Add the imports near the top of `agent_service/guidemate_agent/dog_agent.py` (after the existing `import uuid` line):
```python
import time
from guidemate_msgs.metrics import emit_metric
```

Add this module-level helper directly below the `PERSONA` constant:
```python
def _usage_from_result(result) -> "Optional[tuple[int, int]]":
    """Pull (input_tokens, output_tokens) out of a Strands AgentResult, or None."""
    metrics = getattr(result, "metrics", None)
    usage = getattr(metrics, "accumulated_usage", None) if metrics is not None else None
    if not usage:
        return None
    try:
        return int(usage["inputTokens"]), int(usage["outputTokens"])
    except (KeyError, TypeError, ValueError):
        return None
```

Replace the body of `_emote_impl` (the `send_command` call block) so it times the round-trip:
```python
    def _emote_impl(self, name: str, target: Optional[str], captured: dict) -> str:
        """Body of the send_emote tool, factored out so it's testable without Strands."""
        captured["emote"] = name
        if target is None:
            return "robot did not respond — I'm probably napping offline"
        t0 = time.perf_counter()
        acks = self._registry.send_command(target, Command(type="emote", name=name))
        emit_metric(
            "AckRoundTripMs",
            (time.perf_counter() - t0) * 1000.0,
            "Milliseconds",
            {"robot_id": target},
        )
        captured["acks"] = [a.model_dump() for a in acks]
        if not acks:
            return "robot did not respond — I'm probably napping offline"
        return "emote delivered (simulated)"
```

In `chat`, replace the `result = agent(message)` line and the `return {...}` block with:
```python
        result = agent(message)
        usage = _usage_from_result(result)
        if usage is not None:
            emit_metric("BedrockInputTokens", usage[0])
            emit_metric("BedrockOutputTokens", usage[1])
        return {
            "reply_text": str(result),
            "emote": captured["emote"],
            "robot": captured["acks"],
            "turn_id": turn_id,
        }
```

- [ ] **Step 4: Instrument `app.py`**

Add these imports to `agent_service/guidemate_agent/app.py` (after `import logging`):
```python
import time

import boto3

from guidemate_msgs.metrics import emit_metric
```

Replace the `chat` route with the instrumented version:
```python
@app.post("/api/chat")
def chat(req: ChatRequest) -> JSONResponse:
    t0 = time.perf_counter()
    result = app.state.agent.chat(req.message)
    emit_metric("TurnLatencyMs", (time.perf_counter() - t0) * 1000.0, "Milliseconds")
    return JSONResponse(result)
```

Add the `/readyz` route directly below `/healthz`:
```python
@app.get("/readyz")
def readyz() -> JSONResponse:
    checks = {}
    try:
        checks["creds"] = boto3.Session().get_credentials() is not None
    except Exception:  # noqa: BLE001 — readiness must never raise
        checks["creds"] = False
    checks["registry"] = getattr(app.state, "registry", None) is not None
    ready = all(checks.values())
    return JSONResponse({"ready": ready, "checks": checks}, status_code=200 if ready else 503)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_metrics_instrumentation.py agent_service/tests/test_app.py agent_service/tests/test_dog_agent.py -q`
Expected: PASS (existing app/agent tests still green; 6 new tests pass).

- [ ] **Step 6: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/app.py agent_service/guidemate_agent/dog_agent.py agent_service/tests/test_metrics_instrumentation.py
git commit -m "Kalhar: instrument service with EMF metrics (turn latency, ack RTT, Bedrock tokens) + /readyz"
```

---

## Task 3: Dockerfile + Compose stack + Caddy (local verification)

**Files:**
- Create: `agent_service/Dockerfile`, `agent_service/.dockerignore`, `agent_service/compose.yaml`, `agent_service/compose.prod.yaml`, `agent_service/Caddyfile`

**Interfaces:**
- Consumes: the instrumented service (Task 2); `shared/guidemate_msgs` (installed into the image).
- Produces: an image that runs `uvicorn guidemate_agent.app:app` on port 8000 with a `/healthz` HEALTHCHECK; a Compose stack (`app` + `caddy`) that serves the app through Caddy on ports 80/443; a `compose.prod.yaml` overlay switching both services to the `awslogs` driver. Compose is invoked with build context = **repo root** so the image can `COPY` both `shared/` and `agent_service/`.

- [ ] **Step 1: Write the Dockerfile**

`agent_service/Dockerfile` (build context is the repo root; see compose `context: ..`):
```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app

# Shared schema/choreography/metrics package first (its own layer for cache reuse).
COPY shared/guidemate_msgs /app/shared/guidemate_msgs
RUN pip install /app/shared/guidemate_msgs

# The service.
COPY agent_service /app/agent_service
RUN pip install /app/agent_service

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status==200 else sys.exit(1)"

CMD ["uvicorn", "guidemate_agent.app:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 2: Write `.dockerignore`**

`agent_service/.dockerignore` (paths are relative to the repo-root build context):
```gitignore
**/__pycache__/
**/*.pyc
**/*.egg-info/
.venv/
**/artifacts/
build/
install/
log/
*.pem
*.key
agent_service/deploy/*.env
```

- [ ] **Step 3: Write the Caddyfile**

`agent_service/Caddyfile`:
```caddy
{$GUIDEMATE_DOMAIN} {
	reverse_proxy app:8000
}
```
`GUIDEMATE_DOMAIN` is `http://localhost` locally (plain HTTP, no TLS) and `<eip-dashes>.nip.io` in production (Caddy provisions a Let's Encrypt cert automatically).

- [ ] **Step 4: Write `compose.yaml`**

`agent_service/compose.yaml`:
```yaml
services:
  app:
    build:
      context: ..
      dockerfile: agent_service/Dockerfile
    restart: unless-stopped
    expose:
      - "8000"
    environment:
      - GUIDEMATE_ROBOTS=${GUIDEMATE_ROBOTS:-turtlebot468}
      - GUIDEMATE_IOT_ENDPOINT=${GUIDEMATE_IOT_ENDPOINT:-}
      - GUIDEMATE_MODEL_ID=${GUIDEMATE_MODEL_ID:-us.anthropic.claude-sonnet-4-6}
      - AWS_REGION=${AWS_REGION:-us-west-2}
      - GUIDEMATE_ADMIN_PASSWORD=${GUIDEMATE_ADMIN_PASSWORD:-}

  caddy:
    image: caddy:2
    restart: unless-stopped
    depends_on:
      - app
    ports:
      - "80:80"
      - "443:443"
    environment:
      - GUIDEMATE_DOMAIN=${GUIDEMATE_DOMAIN:-http://localhost}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data

volumes:
  caddy_data:
```

- [ ] **Step 5: Write the production logging overlay**

`agent_service/compose.prod.yaml` (merged on top of `compose.yaml` on EC2; switches both services from the default `json-file` driver to `awslogs`):
```yaml
services:
  app:
    logging:
      driver: awslogs
      options:
        awslogs-region: us-west-2
        awslogs-group: /guidemate/agent-service
        awslogs-create-group: "true"

  caddy:
    logging:
      driver: awslogs
      options:
        awslogs-region: us-west-2
        awslogs-group: /guidemate/caddy
        awslogs-create-group: "true"
```

- [ ] **Step 6: Build the image (local verification)**

Run (build context is the repo root; user is not in the `docker` group, so use `sudo`):
```bash
cd ~/cs7980-guide-mate
sudo docker build -f agent_service/Dockerfile -t guidemate-agent:local .
```
Expected: build succeeds; final line `naming to docker.io/library/guidemate-agent:local`. (First build is slow — it compiles/pulls fastapi, strands-agents, awsiotsdk, boto3.)

- [ ] **Step 7: Bring the stack up and curl `/healthz` through Caddy**

Run:
```bash
cd ~/cs7980-guide-mate/agent_service
GUIDEMATE_DOMAIN=http://localhost sudo -E docker compose -f compose.yaml up -d --build
# wait for the app healthcheck + caddy
for _ in $(seq 1 60); do curl -sf http://localhost/healthz >/dev/null && break; sleep 2; done
curl -s http://localhost/healthz
```
Expected: `{"ok":true}` returned through Caddy (port 80 → `app:8000`). `GUIDEMATE_DOMAIN=http://localhost` makes Caddy serve plain HTTP (no TLS attempt), per the locked local-verification decision.

- [ ] **Step 8: Tear the local stack down**

Run:
```bash
cd ~/cs7980-guide-mate/agent_service
sudo docker compose -f compose.yaml down -v
```
Expected: `app` and `caddy` containers + `caddy_data` volume removed. (`-v` drops the local Caddy volume so repeat runs are clean.)

- [ ] **Step 9: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/Dockerfile agent_service/.dockerignore agent_service/compose.yaml agent_service/compose.prod.yaml agent_service/Caddyfile
git commit -m "Kalhar: containerize service — Dockerfile + Compose (app+caddy) + prod awslogs overlay"
```

---

## Task 4: EC2 launch script + bootstrap user-data

**Files:**
- Create: `agent_service/deploy/user_data.sh`, `agent_service/deploy/launch_ec2.sh`

**Interfaces:**
- Consumes: the Compose stack (Task 3); instance profile `guidemate-agent-profile` (exists); the metric log groups are auto-created by the `awslogs` driver (`awslogs-create-group: "true"`).
- Produces: `launch_ec2.sh` — idempotent-ish: finds/creates SG `guidemate-poc-sg`, allocates/reuses an EIP tagged `guidemate-poc`, launches one t3.large AL2023 instance with the profile + rendered user-data, associates the EIP, tags everything `project=guidemate-poc`, prints the `https://<eip-dashes>.nip.io` URL and the generated admin password. `user_data.sh` — installs Docker + Compose v2 + the CloudWatch agent (memory/disk), clones the repo, writes `/etc/guidemate.env`, and brings the prod Compose stack up.

- [ ] **Step 1: Write `user_data.sh`**

`agent_service/deploy/user_data.sh` (a template — `launch_ec2.sh` substitutes `@@DOMAIN@@`, `@@ADMIN_PW@@`, `@@REGION@@`, `@@BRANCH@@`, `@@REPO@@` before base64-encoding it):
```bash
#!/usr/bin/env bash
# EC2 bootstrap for the guide-mate dog-agent (AL2023). Runs once at first boot.
set -euxo pipefail
exec > >(tee /var/log/guidemate-bootstrap.log) 2>&1

REGION="@@REGION@@"
DOMAIN="@@DOMAIN@@"
ADMIN_PW="@@ADMIN_PW@@"
REPO="@@REPO@@"
BRANCH="@@BRANCH@@"

# --- Docker + Compose v2 plugin ---
dnf install -y docker git
systemctl enable --now docker
mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# --- CloudWatch agent: memory + disk (system metrics; containers log via awslogs) ---
dnf install -y amazon-cloudwatch-agent
cat > /opt/aws/amazon-cloudwatch-agent/etc/guidemate-cwagent.json <<'CWCFG'
{
  "agent": {"metrics_collection_interval": 60},
  "metrics": {
    "namespace": "GuideMate/EC2",
    "append_dimensions": {"InstanceId": "${aws:InstanceId}"},
    "metrics_collected": {
      "mem": {"measurement": [{"name": "mem_used_percent", "rename": "MemUsedPercent"}]},
      "disk": {"measurement": [{"name": "used_percent", "rename": "DiskUsedPercent"}], "resources": ["/"]}
    }
  }
}
CWCFG
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/guidemate-cwagent.json

# --- App: clone repo, write env, bring the prod stack up ---
install -d -m 755 /opt
git clone --branch "${BRANCH}" "${REPO}" /opt/guidemate
IOT_ENDPOINT="$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --region "${REGION}" --query endpointAddress --output text)"

umask 077
cat > /etc/guidemate.env <<ENV
GUIDEMATE_DOMAIN=${DOMAIN}
GUIDEMATE_ROBOTS=turtlebot468
GUIDEMATE_MODEL_ID=us.anthropic.claude-sonnet-4-6
AWS_REGION=${REGION}
GUIDEMATE_IOT_ENDPOINT=${IOT_ENDPOINT}
GUIDEMATE_ADMIN_PASSWORD=${ADMIN_PW}
ENV

cd /opt/guidemate/agent_service
docker compose --env-file /etc/guidemate.env -f compose.yaml -f compose.prod.yaml up -d --build
echo "guidemate bootstrap complete"
```
Note: `${aws:InstanceId}` inside the CW-agent JSON is expanded by the agent itself (it is single-quoted in the heredoc so the shell leaves it intact). `GUIDEMATE_ADMIN_PASSWORD` is passed through user-data (readable only via IMDS on the instance — same trust boundary as the instance profile) and never committed.

- [ ] **Step 2: Write `launch_ec2.sh`**

`agent_service/deploy/launch_ec2.sh`:
```bash
#!/usr/bin/env bash
# Launch the guide-mate production host on EC2. Idempotent-ish: reuses a tagged
# SG + EIP, refuses to double-launch if a tagged instance is already running.
set -euo pipefail
cd "$(dirname "$0")"

AWS="${AWS:-aws}"
REGION="${AWS_REGION:-us-west-2}"
REPO="${GUIDEMATE_REPO:-https://github.com/KalharPandya/cs7980-guide-mate.git}"
BRANCH="${GUIDEMATE_BRANCH:-kalhar/dog-agent-poc}"
TAG="project=guidemate-poc"
SG_NAME="guidemate-poc-sg"
INSTANCE_NAME="guidemate-poc-ec2"
EIP_NAME="guidemate-poc-eip"
PROFILE_NAME="guidemate-agent-profile"
INSTANCE_TYPE="t3.large"

q() { $AWS --region "$REGION" "$@"; }

echo ">> Refuse double-launch: check for a running tagged instance"
EXISTING="$(q ec2 describe-instances \
  --filters "Name=tag:Name,Values=${INSTANCE_NAME}" "Name=instance-state-name,Values=pending,running" \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
if [ -n "${EXISTING}" ]; then
  echo "!! Instance ${EXISTING} already running. Use redeploy.sh to update, or teardown.sh first." >&2
  exit 1
fi

echo ">> Default VPC"
VPC_ID="$(q ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)"

echo ">> Security group ${SG_NAME}"
SG_ID="$(q ec2 describe-security-groups \
  --filters "Name=group-name,Values=${SG_NAME}" "Name=vpc-id,Values=${VPC_ID}" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [ "${SG_ID}" = "None" ] || [ -z "${SG_ID}" ]; then
  SG_ID="$(q ec2 create-security-group --group-name "${SG_NAME}" \
    --description "guide-mate POC (80/443 world, 22 from launcher)" --vpc-id "${VPC_ID}" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=project,Value=guidemate-poc}]" \
    --query GroupId --output text)"
fi
MYIP="$(curl -s https://checkip.amazonaws.com | tr -d '[:space:]')"
for pair in "80:0.0.0.0/0" "443:0.0.0.0/0" "22:${MYIP}/32"; do
  PORT="${pair%%:*}"; CIDR="${pair##*:}"
  q ec2 authorize-security-group-ingress --group-id "${SG_ID}" \
    --protocol tcp --port "${PORT}" --cidr "${CIDR}" 2>/dev/null || true
done

echo ">> Elastic IP (reuse tagged, else allocate)"
ALLOC_ID="$(q ec2 describe-addresses --filters "Name=tag:Name,Values=${EIP_NAME}" \
  --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)"
if [ "${ALLOC_ID}" = "None" ] || [ -z "${ALLOC_ID}" ]; then
  ALLOC_ID="$(q ec2 allocate-address --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=project,Value=guidemate-poc},{Key=Name,Value=${EIP_NAME}}]" \
    --query AllocationId --output text)"
fi
EIP="$(q ec2 describe-addresses --allocation-ids "${ALLOC_ID}" \
  --query 'Addresses[0].PublicIp' --output text)"
DOMAIN="$(echo "${EIP}" | tr '.' '-').nip.io"
echo "   EIP ${EIP} -> ${DOMAIN}"

echo ">> Admin password (generated; printed once, never committed)"
ADMIN_PW="$(openssl rand -hex 16)"

echo ">> Latest AL2023 AMI"
AMI_ID="$(q ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)"

echo ">> Render user-data"
UD="$(mktemp)"
sed -e "s#@@DOMAIN@@#${DOMAIN}#g" \
    -e "s#@@ADMIN_PW@@#${ADMIN_PW}#g" \
    -e "s#@@REGION@@#${REGION}#g" \
    -e "s#@@REPO@@#${REPO}#g" \
    -e "s#@@BRANCH@@#${BRANCH}#g" \
    user_data.sh > "${UD}"

echo ">> Launch ${INSTANCE_TYPE}"
IID="$(q ec2 run-instances --image-id "${AMI_ID}" --instance-type "${INSTANCE_TYPE}" \
  --iam-instance-profile "Name=${PROFILE_NAME}" \
  --security-group-ids "${SG_ID}" \
  --user-data "file://${UD}" \
  --tag-specifications \
    "ResourceType=instance,Tags=[{Key=project,Value=guidemate-poc},{Key=Name,Value=${INSTANCE_NAME}}]" \
  --query 'Instances[0].InstanceId' --output text)"
rm -f "${UD}"
echo "   Instance ${IID}"

echo ">> Wait for running, then associate EIP"
q ec2 wait instance-running --instance-ids "${IID}"
q ec2 associate-address --instance-id "${IID}" --allocation-id "${ALLOC_ID}" >/dev/null

cat <<DONE

============================================================
  guide-mate production launched
  Instance : ${IID}
  URL      : https://${DOMAIN}   (Caddy TLS provisions in ~1-2 min)
  Admin PW : ${ADMIN_PW}   <-- save this now; not stored anywhere else
------------------------------------------------------------
  Next:
    scripts/setup_observability.sh          # dashboard + alarms (pass the instance id)
    Watch bootstrap:  aws ssm start-session --target ${IID}
                      sudo tail -f /var/log/guidemate-bootstrap.log
============================================================
DONE
```

- [ ] **Step 3: Make the scripts executable + syntax-check them**

Run:
```bash
cd ~/cs7980-guide-mate
chmod +x agent_service/deploy/user_data.sh agent_service/deploy/launch_ec2.sh
bash -n agent_service/deploy/user_data.sh && bash -n agent_service/deploy/launch_ec2.sh && echo "syntax OK"
```
Expected: `syntax OK` (no execution — these mutate AWS; they run in Task 7).

- [ ] **Step 4: Document the launch resources in access-ground-truth.md**

Append a subsection to `docs/agent-poc/access-ground-truth.md` (under a new heading `## Phase 7 — production (EC2 + observability)`):
```markdown
## Phase 7 — production (EC2 + observability)
Launched by `agent_service/deploy/launch_ec2.sh` (idempotent-ish, no console clicking):
| Resource | Name / id | Notes |
|---|---|---|
| EC2 instance | tag `Name=guidemate-poc-ec2`, t3.large, AL2023 | instance profile `guidemate-agent-profile` (zero-cred); user-data brings up the prod Compose stack |
| Security group | `guidemate-poc-sg` | ingress 80/443 from 0.0.0.0/0, 22 from the launcher IP/32 |
| Elastic IP | tag `Name=guidemate-poc-eip` | reused across relaunches; domain `<eip-dashes>.nip.io` |
| Admin password | generated at launch (`openssl rand -hex 16`) | printed once; lives only in `/etc/guidemate.env` (mode 600) on the instance |
| Manage | `aws ssm start-session --target <iid>` | SSM Session Manager — no SSH key on the instance |
```

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/deploy/user_data.sh agent_service/deploy/launch_ec2.sh docs/agent-poc/access-ground-truth.md
git commit -m "Kalhar: EC2 launch script + bootstrap user-data (Docker, CW agent, prod compose)"
```

---

## Task 5: Redeploy + teardown (SSM, no SSH keys)

**Files:**
- Create: `agent_service/deploy/redeploy.sh`, `agent_service/deploy/teardown.sh`

**Interfaces:**
- Consumes: the tagged instance/EIP/SG from Task 4.
- Produces: `redeploy.sh` — pulls the branch on the instance and rebuilds the prod stack via one `ssm send-command` (non-interactive; the instance profile's admin rights cover SSM). `teardown.sh` — terminates the instance, releases the EIP (opt-out with `--keep-eip`), and deletes the SG once the instance is gone. Both find the instance by tag.

- [ ] **Step 1: Write `redeploy.sh`**

`agent_service/deploy/redeploy.sh`:
```bash
#!/usr/bin/env bash
# Redeploy the latest branch to the running production instance via SSM (no SSH key).
set -euo pipefail
AWS="${AWS:-aws}"
REGION="${AWS_REGION:-us-west-2}"
BRANCH="${GUIDEMATE_BRANCH:-kalhar/dog-agent-poc}"

IID="$($AWS --region "$REGION" ec2 describe-instances \
  --filters "Name=tag:Name,Values=guidemate-poc-ec2" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"
[ -n "${IID}" ] && [ "${IID}" != "None" ] || { echo "no running instance" >&2; exit 1; }
echo ">> Redeploying ${BRANCH} on ${IID}"

CMD_ID="$($AWS --region "$REGION" ssm send-command \
  --instance-ids "${IID}" --document-name "AWS-RunShellScript" \
  --comment "guidemate redeploy" \
  --parameters commands="[
    \"set -euxo pipefail\",
    \"cd /opt/guidemate\",
    \"git fetch origin ${BRANCH}\",
    \"git checkout ${BRANCH}\",
    \"git reset --hard origin/${BRANCH}\",
    \"cd /opt/guidemate/agent_service\",
    \"docker compose --env-file /etc/guidemate.env -f compose.yaml -f compose.prod.yaml up -d --build\"
  ]" --query 'Command.CommandId' --output text)"

echo ">> Waiting for SSM command ${CMD_ID}"
$AWS --region "$REGION" ssm wait command-executed --command-id "${CMD_ID}" --instance-id "${IID}" || true
$AWS --region "$REGION" ssm get-command-invocation --command-id "${CMD_ID}" --instance-id "${IID}" \
  --query '{Status:Status,Out:StandardOutputContent,Err:StandardErrorContent}' --output json
```
For an interactive shell instead, use `aws ssm start-session --target <iid>` (documented in access-ground-truth.md).

- [ ] **Step 2: Write `teardown.sh`**

`agent_service/deploy/teardown.sh`:
```bash
#!/usr/bin/env bash
# Tear down the production host. Releases the EIP unless --keep-eip is passed.
set -euo pipefail
AWS="${AWS:-aws}"
REGION="${AWS_REGION:-us-west-2}"
KEEP_EIP=0
[ "${1:-}" = "--keep-eip" ] && KEEP_EIP=1
q() { $AWS --region "$REGION" "$@"; }

IID="$(q ec2 describe-instances \
  --filters "Name=tag:Name,Values=guidemate-poc-ec2" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"

if [ -n "${IID}" ] && [ "${IID}" != "None" ]; then
  echo ">> Terminating ${IID}"
  q ec2 terminate-instances --instance-ids "${IID}" >/dev/null
  q ec2 wait instance-terminated --instance-ids "${IID}"
fi

if [ "${KEEP_EIP}" -eq 0 ]; then
  ALLOC_ID="$(q ec2 describe-addresses --filters "Name=tag:Name,Values=guidemate-poc-eip" \
    --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)"
  if [ -n "${ALLOC_ID}" ] && [ "${ALLOC_ID}" != "None" ]; then
    echo ">> Releasing EIP ${ALLOC_ID}"
    q ec2 release-address --allocation-id "${ALLOC_ID}" || true
  fi
fi

SG_ID="$(q ec2 describe-security-groups --filters "Name=group-name,Values=guidemate-poc-sg" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [ -n "${SG_ID}" ] && [ "${SG_ID}" != "None" ]; then
  echo ">> Deleting SG ${SG_ID}"
  q ec2 delete-security-group --group-id "${SG_ID}" || echo "   (SG still in use; retry after instance fully gone)"
fi
echo ">> Teardown done. CloudWatch dashboard/alarms/log-groups are left in place (delete via setup_observability.sh --clean)."
```

- [ ] **Step 3: Make executable + syntax-check**

Run:
```bash
cd ~/cs7980-guide-mate
chmod +x agent_service/deploy/redeploy.sh agent_service/deploy/teardown.sh
bash -n agent_service/deploy/redeploy.sh && bash -n agent_service/deploy/teardown.sh && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 4: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/deploy/redeploy.sh agent_service/deploy/teardown.sh
git commit -m "Kalhar: SSM-based redeploy + teardown scripts (no SSH keys)"
```

---

## Task 6: Observability plumbing — Bedrock logging, dashboard, alarms, Pi log-ship

**Files:**
- Create: `scripts/setup_observability.sh`
- Create: `src/guide_mate_bridge/guide_mate_bridge/logship.py`, `src/guide_mate_bridge/tests/test_logship.py`
- Create: `src/guide_mate_bridge/systemd/guidemate-logship.service`, `src/guide_mate_bridge/systemd/guidemate-logship.timer`
- Create: `src/guide_mate_bridge/scripts/install_logship_on_pi.sh`

**Interfaces:**
- Consumes: metric contract (Tasks 1/2); the EC2 instance (Task 4) for the CPU alarm; the Pi's bridge journal + its `credential_process` AWS creds.
- Produces:
  - `setup_observability.sh` — creates log groups, enables Bedrock model-invocation logging (+ its role), puts two metric filters, one dashboard (`guidemate-poc`), and four alarms. `--clean` deletes them.
  - `logship.py` — pure functions `parse_journal_json(text) -> list[dict]`, `chunk_events(events, max_n=1000) -> Iterator[list[dict]]`, `heartbeat_event(robot_id, now_ms) -> dict`, plus `main()` that ships new bridge-journal lines + one `PiHeartbeat` EMF event to `/guidemate/bridge` via the `aws` CLI.

- [ ] **Step 1: Write the failing test for logship pure functions**

`src/guide_mate_bridge/tests/test_logship.py`:
```python
import json

from guide_mate_bridge.logship import (
    chunk_events,
    heartbeat_event,
    parse_journal_json,
)


def test_parse_journal_json_extracts_message_and_ms_timestamp():
    lines = "\n".join(
        [
            json.dumps({"__REALTIME_TIMESTAMP": "1700000000000000", "MESSAGE": "hello"}),
            "not json — skipped",
            json.dumps({"__REALTIME_TIMESTAMP": "1700000001000000", "MESSAGE": "world"}),
            json.dumps({"MESSAGE": "no ts — skipped"}),
        ]
    )
    events = parse_journal_json(lines)
    assert events == [
        {"timestamp": 1700000000000, "message": "hello"},
        {"timestamp": 1700000001000, "message": "world"},
    ]


def test_parse_journal_json_decodes_byte_array_message():
    line = json.dumps({"__REALTIME_TIMESTAMP": "1700000000000000", "MESSAGE": [104, 105]})
    assert parse_journal_json(line) == [{"timestamp": 1700000000000, "message": "hi"}]


def test_chunk_events_batches():
    events = [{"timestamp": i, "message": str(i)} for i in range(2500)]
    batches = list(chunk_events(events, max_n=1000))
    assert [len(b) for b in batches] == [1000, 1000, 500]


def test_heartbeat_event_is_valid_emf():
    ev = heartbeat_event("turtlebot468", 1700000000000)
    assert ev["timestamp"] == 1700000000000
    emf = json.loads(ev["message"])
    assert emf["PiHeartbeat"] == 1
    assert emf["robot_id"] == "turtlebot468"
    meta = emf["_aws"]["CloudWatchMetrics"][0]
    assert meta["Namespace"] == "GuideMate"
    assert meta["Metrics"][0]["Name"] == "PiHeartbeat"
    assert meta["Dimensions"] == [["robot_id"]]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_logship.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guide_mate_bridge.logship'`.

- [ ] **Step 3: Implement `logship.py`**

`src/guide_mate_bridge/guide_mate_bridge/logship.py`:
```python
"""Ship the guide-mate bridge journal to CloudWatch Logs from the Pi.

Design: the Pi already has AWS creds (role guidemate-agent-role via
credential_process) and the `aws` CLI, but installing the heavy ARM CloudWatch
agent is not worth it on the compute-tight Pi. Instead a 5-minute systemd timer
runs this: journalctl --cursor-file gives only the NEW lines since last run,
which we push with `aws logs put-log-events` (no sequence token needed on modern
CloudWatch), plus one PiHeartbeat EMF event so the bridge-offline alarm has data.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from typing import Iterator

LOG_GROUP = "/guidemate/bridge"
CURSOR_FILE = "/var/lib/guidemate/logship.cursor"
AWS_BIN = os.environ.get("AWS_BIN", "aws")
REGION = os.environ.get("AWS_REGION", "us-west-2")


def parse_journal_json(text: str) -> list[dict]:
    """journalctl -o json lines -> [{'timestamp': ms, 'message': str}, ...]."""
    events: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = rec.get("MESSAGE")
        ts_us = rec.get("__REALTIME_TIMESTAMP")
        if msg is None or ts_us is None:
            continue
        if isinstance(msg, list):  # journald renders non-UTF8 fields as byte arrays
            msg = bytes(msg).decode("utf-8", "replace")
        events.append({"timestamp": int(ts_us) // 1000, "message": str(msg)})
    return events


def chunk_events(events: list[dict], max_n: int = 1000) -> Iterator[list[dict]]:
    for i in range(0, len(events), max_n):
        yield events[i : i + max_n]


def heartbeat_event(robot_id: str, now_ms: int) -> dict:
    emf = {
        "_aws": {
            "Timestamp": now_ms,
            "CloudWatchMetrics": [
                {
                    "Namespace": "GuideMate",
                    "Dimensions": [["robot_id"]],
                    "Metrics": [{"Name": "PiHeartbeat", "Unit": "Count"}],
                }
            ],
        },
        "robot_id": robot_id,
        "PiHeartbeat": 1,
    }
    return {"timestamp": now_ms, "message": json.dumps(emf)}


def _aws(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [AWS_BIN, "--region", REGION, *args],
        capture_output=True,
        text=True,
        check=False,
    )


def _ensure_stream(stream: str) -> None:
    _aws("logs", "create-log-group", "--log-group-name", LOG_GROUP)  # ok if exists
    _aws("logs", "create-log-stream", "--log-group-name", LOG_GROUP, "--log-stream-name", stream)


def _put(stream: str, events: list[dict]) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(events, fh)
        path = fh.name
    try:
        res = _aws(
            "logs", "put-log-events",
            "--log-group-name", LOG_GROUP,
            "--log-stream-name", stream,
            "--log-events", f"file://{path}",
        )
        if res.returncode != 0:
            sys.stderr.write(res.stderr)
    finally:
        os.unlink(path)


def main() -> None:
    robot_id = os.environ.get("GUIDEMATE_ROBOT_ID", "turtlebot468")
    stream = robot_id
    os.makedirs(os.path.dirname(CURSOR_FILE), exist_ok=True)
    proc = subprocess.run(
        [
            "journalctl", "-u", "guidemate-bridge", "-o", "json",
            "--no-pager", f"--cursor-file={CURSOR_FILE}",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    events = parse_journal_json(proc.stdout)
    events.append(heartbeat_event(robot_id, int(time.time() * 1000)))
    events.sort(key=lambda e: e["timestamp"])
    _ensure_stream(stream)
    for batch in chunk_events(events):
        _put(stream, batch)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_logship.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Write the systemd unit + timer**

`src/guide_mate_bridge/systemd/guidemate-logship.service`:
```ini
[Unit]
Description=Ship guide-mate bridge journal to CloudWatch Logs
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=ubuntu
Environment=HOME=/home/ubuntu
Environment=AWS_REGION=us-west-2
Environment=GUIDEMATE_ROBOT_ID=turtlebot468
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/ubuntu/.local/bin
ExecStart=/home/ubuntu/guidemate-venv/bin/python -m guide_mate_bridge.logship
```

`src/guide_mate_bridge/systemd/guidemate-logship.timer`:
```ini
[Unit]
Description=Run guide-mate log-ship every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Unit=guidemate-logship.service

[Install]
WantedBy=timers.target
```

- [ ] **Step 6: Write the Pi installer**

`src/guide_mate_bridge/scripts/install_logship_on_pi.sh` (SSH-driven from the Linux box; additive — reuses the bridge's `~/guidemate-venv`, which already has `guide_mate_bridge` editable-installed so `logship.py` is importable after `git pull`):
```bash
#!/usr/bin/env bash
# Install the guide-mate log-ship timer on the Pi. Additive; touches nothing else.
set -euo pipefail
SSH_HOST="${SSH_HOST:-guidemate}"
REPO_DIR="${REPO_DIR:-/home/ubuntu/cs7980-guide-mate}"
BRANCH="${GUIDEMATE_BRANCH:-kalhar/dog-agent-poc}"

ssh "${SSH_HOST}" bash -s <<EOF
set -euxo pipefail
cd "${REPO_DIR}"
git fetch origin "${BRANCH}"
git checkout "${BRANCH}"
git reset --hard "origin/${BRANCH}"

sudo install -d -m 755 -o ubuntu -g ubuntu /var/lib/guidemate
sudo cp src/guide_mate_bridge/systemd/guidemate-logship.service /etc/systemd/system/
sudo cp src/guide_mate_bridge/systemd/guidemate-logship.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now guidemate-logship.timer

# Prime once so CloudWatch gets the group/stream + first heartbeat immediately.
sudo systemctl start guidemate-logship.service
systemctl list-timers guidemate-logship.timer --no-pager || true
journalctl -u guidemate-logship.service -n 20 --no-pager || true
EOF
echo ">> log-ship timer installed on ${SSH_HOST}"
```

- [ ] **Step 7: Write `setup_observability.sh`**

`scripts/setup_observability.sh`:
```bash
#!/usr/bin/env bash
# Create all CloudWatch observability for the guide-mate POC (no console clicking):
# log groups, Bedrock invocation logging, metric filters, dashboard, 4 alarms.
# Usage:  scripts/setup_observability.sh            # create/update everything
#         scripts/setup_observability.sh --clean    # delete everything it created
set -euo pipefail
AWS="${AWS:-aws}"
REGION="${AWS_REGION:-us-west-2}"
ACCOUNT="852373397000"
NS="GuideMate"
DASH="guidemate-poc"
BEDROCK_GROUP="/guidemate/bedrock"
SVC_GROUP="/guidemate/agent-service"
BRIDGE_GROUP="/guidemate/bridge"
BEDROCK_ROLE="guidemate-bedrock-logging-role"
q() { $AWS --region "$REGION" "$@"; }

if [ "${1:-}" = "--clean" ]; then
  q cloudwatch delete-dashboards --dashboard-names "${DASH}" || true
  q cloudwatch delete-alarms --alarm-names \
    guidemate-poc-service-errors guidemate-poc-bedrock-throttle \
    guidemate-poc-bridge-offline guidemate-poc-ec2-cpu || true
  q logs delete-metric-filter --log-group-name "${SVC_GROUP}" --filter-name guidemate-service-errors || true
  q logs delete-metric-filter --log-group-name "${SVC_GROUP}" --filter-name guidemate-bedrock-throttle || true
  q bedrock delete-model-invocation-logging-configuration || true
  echo ">> cleaned"
  exit 0
fi

echo ">> Log groups"
for g in "${BEDROCK_GROUP}" "${SVC_GROUP}" "${BRIDGE_GROUP}" "/guidemate/caddy"; do
  q logs create-log-group --log-group-name "$g" 2>/dev/null || true
  q logs put-retention-policy --log-group-name "$g" --retention-in-days 30 || true
done

echo ">> Bedrock model-invocation logging role"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"bedrock.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
q iam create-role --role-name "${BEDROCK_ROLE}" \
  --assume-role-policy-document "${TRUST}" \
  --tags Key=project,Value=guidemate-poc 2>/dev/null || true
POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:aws:logs:'"${REGION}"':'"${ACCOUNT}"':log-group:'"${BEDROCK_GROUP}"':*"}]}'
q iam put-role-policy --role-name "${BEDROCK_ROLE}" \
  --policy-name guidemate-bedrock-logging --policy-document "${POLICY}"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${BEDROCK_ROLE}"
sleep 10  # let the new role/trust propagate before Bedrock validates it

echo ">> Enable Bedrock invocation logging"
q bedrock put-model-invocation-logging-configuration --logging-config '{
  "cloudWatchConfig": {"logGroupName": "'"${BEDROCK_GROUP}"'", "roleArn": "'"${ROLE_ARN}"'"},
  "textDataDeliveryEnabled": true,
  "imageDataDeliveryEnabled": false,
  "embeddingDataDeliveryEnabled": false
}'

echo ">> Metric filters on ${SVC_GROUP}"
q logs put-metric-filter --log-group-name "${SVC_GROUP}" \
  --filter-name guidemate-service-errors \
  --filter-pattern '{ $.level = "ERROR" }' \
  --metric-transformations metricName=AgentServiceErrors,metricNamespace="${NS}",metricValue=1,defaultValue=0
q logs put-metric-filter --log-group-name "${SVC_GROUP}" \
  --filter-name guidemate-bedrock-throttle \
  --filter-pattern '"ThrottlingException"' \
  --metric-transformations metricName=BedrockThrottles,metricNamespace="${NS}",metricValue=1,defaultValue=0

echo ">> Alarms (no SNS action — visible in console/dashboard state only)"
q cloudwatch put-metric-alarm --alarm-name guidemate-poc-service-errors \
  --namespace "${NS}" --metric-name AgentServiceErrors --statistic Sum \
  --period 300 --evaluation-periods 1 --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching \
  --tags Key=project,Value=guidemate-poc
q cloudwatch put-metric-alarm --alarm-name guidemate-poc-bedrock-throttle \
  --namespace "${NS}" --metric-name BedrockThrottles --statistic Sum \
  --period 300 --evaluation-periods 1 --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching \
  --tags Key=project,Value=guidemate-poc
q cloudwatch put-metric-alarm --alarm-name guidemate-poc-bridge-offline \
  --namespace "${NS}" --metric-name PiHeartbeat \
  --dimensions Name=robot_id,Value=turtlebot468 --statistic SampleCount \
  --period 300 --evaluation-periods 3 --threshold 1 \
  --comparison-operator LessThanThreshold --treat-missing-data breaching \
  --tags Key=project,Value=guidemate-poc

echo ">> EC2 CPU alarm (only if a tagged instance exists)"
IID="$(q ec2 describe-instances \
  --filters "Name=tag:Name,Values=guidemate-poc-ec2" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || true)"
if [ -n "${IID}" ] && [ "${IID}" != "None" ]; then
  q cloudwatch put-metric-alarm --alarm-name guidemate-poc-ec2-cpu \
    --namespace AWS/EC2 --metric-name CPUUtilization \
    --dimensions Name=InstanceId,Value="${IID}" --statistic Average \
    --period 300 --evaluation-periods 2 --threshold 85 \
    --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching \
    --tags Key=project,Value=guidemate-poc
else
  echo "   (no running instance — skipping CPU alarm; re-run after launch_ec2.sh)"
fi

echo ">> Dashboard ${DASH}"
DASHBODY="$(mktemp)"
cat > "${DASHBODY}" <<JSON
{"widgets":[
 {"type":"metric","x":0,"y":0,"width":12,"height":6,"properties":{
   "title":"Turn latency (ms)","region":"${REGION}","stat":"Average","period":300,
   "metrics":[["${NS}","TurnLatencyMs",{"stat":"Average"}],["${NS}","TurnLatencyMs",{"stat":"p90"}]]}},
 {"type":"metric","x":12,"y":0,"width":12,"height":6,"properties":{
   "title":"Ack round-trip (ms) by robot","region":"${REGION}","stat":"Average","period":300,
   "metrics":[["${NS}","AckRoundTripMs","robot_id","turtlebot468"]]}},
 {"type":"metric","x":0,"y":6,"width":12,"height":6,"properties":{
   "title":"Bedrock tokens / turn","region":"${REGION}","stat":"Sum","period":300,
   "metrics":[["${NS}","BedrockInputTokens"],["${NS}","BedrockOutputTokens"]]}},
 {"type":"metric","x":12,"y":6,"width":12,"height":6,"properties":{
   "title":"Errors & throttles","region":"${REGION}","stat":"Sum","period":300,
   "metrics":[["${NS}","AgentServiceErrors"],["${NS}","BedrockThrottles"]]}},
 {"type":"metric","x":0,"y":12,"width":12,"height":6,"properties":{
   "title":"Robot presence (PiHeartbeat count)","region":"${REGION}","stat":"SampleCount","period":300,
   "metrics":[["${NS}","PiHeartbeat","robot_id","turtlebot468"]]}},
 {"type":"metric","x":12,"y":12,"width":12,"height":6,"properties":{
   "title":"EC2 CPU %","region":"${REGION}","stat":"Average","period":300,
   "metrics":[["AWS/EC2","CPUUtilization"]]}}
]}
JSON
q cloudwatch put-dashboard --dashboard-name "${DASH}" --dashboard-body "file://${DASHBODY}"
rm -f "${DASHBODY}"
echo ">> observability ready — dashboard '${DASH}', 4 alarms, Bedrock logging on."
```

- [ ] **Step 8: Make scripts executable + syntax-check**

Run:
```bash
cd ~/cs7980-guide-mate
chmod +x scripts/setup_observability.sh src/guide_mate_bridge/scripts/install_logship_on_pi.sh
bash -n scripts/setup_observability.sh && bash -n src/guide_mate_bridge/scripts/install_logship_on_pi.sh && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 9: Document the observability resources in access-ground-truth.md**

Append to the `## Phase 7 — production (EC2 + observability)` section in `docs/agent-poc/access-ground-truth.md`:
```markdown
### Observability (scripts/setup_observability.sh)
| Resource | Name | Notes |
|---|---|---|
| Log groups | `/guidemate/agent-service`, `/guidemate/caddy`, `/guidemate/bridge`, `/guidemate/bedrock` | 30-day retention; EMF auto-extracts metrics in namespace `GuideMate` |
| Bedrock logging | model-invocation logging → `/guidemate/bedrock` | role `guidemate-bedrock-logging-role` (trusts bedrock.amazonaws.com) |
| Metric filters | `guidemate-service-errors` (`$.level=ERROR`→`AgentServiceErrors`), `guidemate-bedrock-throttle` (`ThrottlingException`→`BedrockThrottles`) | on `/guidemate/agent-service` |
| Dashboard | `guidemate-poc` | turn latency, ack RTT, tokens, errors/throttles, PiHeartbeat presence, EC2 CPU |
| Alarms (no SNS) | `guidemate-poc-service-errors`, `-bedrock-throttle`, `-bridge-offline` (PiHeartbeat missing 15 min = breaching), `-ec2-cpu` (>85% 10 min) | state visible in console/dashboard |
| Pi log-ship | `guidemate-logship.timer` (5 min) | ships `guidemate-bridge` journal + a `PiHeartbeat` EMF event; installed by `src/guide_mate_bridge/scripts/install_logship_on_pi.sh`; additive |
```

- [ ] **Step 10: Commit**

```bash
cd ~/cs7980-guide-mate
git add scripts/setup_observability.sh \
  src/guide_mate_bridge/guide_mate_bridge/logship.py src/guide_mate_bridge/tests/test_logship.py \
  src/guide_mate_bridge/systemd/guidemate-logship.service src/guide_mate_bridge/systemd/guidemate-logship.timer \
  src/guide_mate_bridge/scripts/install_logship_on_pi.sh docs/agent-poc/access-ground-truth.md
git commit -m "Kalhar: observability — Bedrock logging, dashboard, 4 alarms, Pi journal log-ship timer"
```

---

## Task 7: Production verification (local compose + live EC2)

**Files:**
- Create: `agent_service/guidemate_agent/prodcheck.py`, `agent_service/tests/test_prodcheck.py`
- Create: `scripts/prod_slice_check.sh`, `scripts/prod_verify.sh`

**Interfaces:**
- Consumes: everything above; the deployed EC2 URL; the existing e2e (Playwright) suite under `agent_service/tests/e2e` (built in Phases 4-5; run here against the prod URL via `BASE_URL`).
- Produces: `assert_chat_roundtrip(payload: dict) -> None` (raises `AssertionError` if the chat response lacks an emote or a `simulated` ack); `prod_slice_check.sh` (POST `/api/chat` to `$BASE_URL`, assert the round-trip); `prod_verify.sh` (local gate: full pytest + compose `/healthz` through Caddy, and documents the post-deploy prod commands).

- [ ] **Step 1: Write the failing test**

`agent_service/tests/test_prodcheck.py`:
```python
import pytest

from guidemate_agent.prodcheck import assert_chat_roundtrip


def test_roundtrip_ok():
    assert_chat_roundtrip(
        {"emote": "happy", "robot": [{"state": "done", "simulated": True}]}
    )  # no raise


def test_roundtrip_missing_emote_raises():
    with pytest.raises(AssertionError, match="emote"):
        assert_chat_roundtrip({"emote": None, "robot": [{"simulated": True}]})


def test_roundtrip_no_simulated_ack_raises():
    with pytest.raises(AssertionError, match="simulated"):
        assert_chat_roundtrip({"emote": "happy", "robot": [{"state": "done"}]})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_prodcheck.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_agent.prodcheck'`.

- [ ] **Step 3: Implement `prodcheck.py`**

`agent_service/guidemate_agent/prodcheck.py`:
```python
"""Assertions for the production / compose chat round-trip slice check."""
from __future__ import annotations


def assert_chat_roundtrip(payload: dict) -> None:
    if payload.get("emote") is None:
        raise AssertionError("no emote in chat response")
    acks = payload.get("robot") or []
    if not any(a.get("simulated") is True for a in acks):
        raise AssertionError("no simulated ack in robot round-trip")
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_prodcheck.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Write `prod_slice_check.sh`**

`scripts/prod_slice_check.sh`:
```bash
#!/usr/bin/env bash
# Chat round-trip against a running service (local compose or prod nip.io).
# Proves service -> IoT Core -> Pi bridge (dry-run) -> ack path end to end.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE_URL="${BASE_URL:?set BASE_URL, e.g. https://1-2-3-4.nip.io}"

RESP="$(curl -sf -X POST "${BASE_URL}/api/chat" \
  -H 'Content-Type: application/json' -d '{"message":"do a happy wiggle"}')"
echo "response: ${RESP}"
echo "${RESP}" | .venv/bin/python -c '
import json, sys
from guidemate_agent.prodcheck import assert_chat_roundtrip
assert_chat_roundtrip(json.load(sys.stdin))
print("OK: chat round-trip verified (emote + simulated ack)")
'
```

- [ ] **Step 6: Write `prod_verify.sh`**

`scripts/prod_verify.sh`:
```bash
#!/usr/bin/env bash
# Local production-parity gate before deploy, and a printed post-deploy checklist.
set -euo pipefail
cd "$(dirname "$0")/.."

echo ">> 1. Full unit/integration suite (default-skipped tests stay skipped)"
.venv/bin/python -m pytest -q

echo ">> 2. Build + start the prod-shaped Compose stack (Caddy on http://localhost)"
cd agent_service
GUIDEMATE_DOMAIN=http://localhost sudo -E docker compose -f compose.yaml up -d --build
trap 'sudo docker compose -f compose.yaml down -v' EXIT
for _ in $(seq 1 60); do curl -sf http://localhost/healthz >/dev/null && break; sleep 2; done
curl -s http://localhost/healthz | grep -q '"ok":true'
echo "   OK: /healthz served through Caddy"
cd ..

cat <<'NEXT'

>> 3. Post-deploy (run AFTER launch_ec2.sh + setup_observability.sh):
     DOMAIN=<eip-with-dashes>.nip.io
     # a) service health through prod Caddy TLS
     curl -sf https://$DOMAIN/healthz
     # b) full chat round-trip from EC2 -> IoT -> Pi bridge -> ack
     BASE_URL=https://$DOMAIN bash scripts/prod_slice_check.sh
     # c) the same Playwright e2e suite against the live URL (Phase 5 suite)
     BASE_URL=https://$DOMAIN .venv/bin/python -m pytest agent_service/tests/e2e -q
NEXT
echo ">> local gate PASSED"
```

- [ ] **Step 7: Make scripts executable + run the local gate**

Run:
```bash
cd ~/cs7980-guide-mate
chmod +x scripts/prod_slice_check.sh scripts/prod_verify.sh
bash -n scripts/prod_slice_check.sh && bash -n scripts/prod_verify.sh && echo "syntax OK"
bash scripts/prod_verify.sh
```
Expected: `local gate PASSED` — the full pytest suite is green, the Compose stack builds, and `/healthz` returns `{"ok":true}` through Caddy on `http://localhost`. The stack is torn down on exit.

- [ ] **Step 8: Deploy to EC2 and run the live production verification**

Run (this launches real AWS resources; the EC2 fallback per the spec is running the same prod Compose on the Linux box if a guardrail denies the launch):
```bash
cd ~/cs7980-guide-mate
agent_service/deploy/launch_ec2.sh        # prints https://<domain> + admin password
# wait ~2 min for bootstrap + Caddy TLS, watching if desired:
#   aws ssm start-session --target <iid>  ; sudo tail -f /var/log/guidemate-bootstrap.log
scripts/setup_observability.sh            # dashboard + alarms (+ EC2 CPU alarm now the instance exists)
src/guide_mate_bridge/scripts/install_logship_on_pi.sh   # Pi heartbeat -> CloudWatch

DOMAIN=<eip-with-dashes>.nip.io
curl -sf "https://${DOMAIN}/healthz"                              # service health through prod TLS
BASE_URL="https://${DOMAIN}" bash scripts/prod_slice_check.sh     # full chat round-trip from EC2
BASE_URL="https://${DOMAIN}" .venv/bin/python -m pytest agent_service/tests/e2e -q   # Playwright vs prod
```
Expected (Phase 7 exit test): `/healthz` returns `{"ok":true}` over HTTPS; `prod_slice_check.sh` prints `OK: chat round-trip verified`; the Playwright e2e suite is green against `https://<domain>` — one URL for chat (`/`), one for admin (`/admin`). Confirm the `guidemate-poc` dashboard shows `TurnLatencyMs`, `AckRoundTripMs`, and `PiHeartbeat` data points, and all four alarms exist (`aws cloudwatch describe-alarms --alarm-name-prefix guidemate-poc --query 'MetricAlarms[].AlarmName'`).

- [ ] **Step 9: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/prodcheck.py agent_service/tests/test_prodcheck.py \
  scripts/prod_slice_check.sh scripts/prod_verify.sh
git commit -m "Kalhar: production verification — chat round-trip assert + local gate + live e2e checklist"
```

---

## Self-Review

**1. Spec coverage (Phase 7 row = components 11, 17-19 + Observability):**
- Component 11 (Dockerfile + compose, awslogs) → Task 3 (Dockerfile, compose.yaml, compose.prod.yaml overlay, Caddyfile). ✅
- Component 17 (EC2 launch script: t3.large, profile, EIP, SG 80/443, tag) → Task 4 `launch_ec2.sh`. ✅
- Component 18 (bootstrap user-data: Docker, pull repo, compose up) → Task 4 `user_data.sh`. ✅
- Component 19 (Caddyfile auto-TLS on `<eip>.nip.io`) → Task 3 `Caddyfile` + Task 4 domain wiring. ✅
- Observability #2 structured logs → awslogs (Task 3), #3 EMF metrics (Tasks 1/2), Bedrock invocation logging (Task 6), CW agent on EC2 (Task 4 user-data) AND Pi (Task 6 log-ship — deliberately the lightweight timer, not the full ARM agent), dashboard + 4 alarms (Task 6). ✅
- Phase 7 exit test "full Playwright suite green against `https://<eip>.nip.io`; one URL for chat, one for admin" → Task 7 Step 8. ✅
- Locked decision (d) full suite locally against compose (BASE_URL) + Playwright vs prod + slice check (ack round-trip from EC2) → Task 7 `prod_verify.sh` + `prod_slice_check.sh` + Step 8. ✅
- redeploy via SSM + teardown documented → Task 5. ✅

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". All code blocks are complete; the only intentional `@@...@@` tokens are the `user_data.sh` template placeholders, which `launch_ec2.sh` Step-2 `sed` substitutes — documented in the task. `<eip-with-dashes>` / `<iid>` in Step 8 are runtime values the operator fills from `launch_ec2.sh` output (not code placeholders).

**3. Type consistency:** `emit_metric(name, value, unit, dimensions)` signature is identical in the helper (Task 1), the app/agent call sites (Task 2), and the hand-rolled EMF in `heartbeat_event` (Task 6, kept structurally identical). Metric names (`TurnLatencyMs`, `AckRoundTripMs`, `BedrockInputTokens`, `BedrockOutputTokens`, `PiHeartbeat`, `AgentServiceErrors`, `BedrockThrottles`) and namespace `GuideMate` match across emit sites, the dashboard JSON, and the alarms. `assert_chat_roundtrip` (Task 7) is referenced only by `prod_slice_check.sh`, consistent. `_usage_from_result` defined and used in `dog_agent.py`, imported by its test. Compose service names `app`/`caddy` match the Caddyfile `reverse_proxy app:8000` and the prod overlay. Env var names (`GUIDEMATE_DOMAIN`, `GUIDEMATE_ROBOTS`, `GUIDEMATE_IOT_ENDPOINT`, `GUIDEMATE_MODEL_ID`, `AWS_REGION`, `GUIDEMATE_ADMIN_PASSWORD`) match `config.py`, `compose.yaml`, `user_data.sh`, and `/etc/guidemate.env`.

No gaps found.
