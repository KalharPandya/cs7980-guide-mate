# Dog Agent POC — Phase 4 (Sessions + Companion Flow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-user chat into a multi-user, session-aware system with an admin-approved *physical-companion* flow: every visitor takes a named intake, chats with per-session history, and can request the physical robot; exactly one session at a time holds the robot lock and drives real (dry-run) emotes while everyone else gets *virtual* avatar-only emotes; the admin approves/denies/aborts/reassigns from the admin panel.

**Architecture:** A new self-contained DynamoDB session layer (`agent_service/guidemate_agent/sessions.py`) owns sessions, per-session messages, companion requests, and the **atomic per-robot lock** (conditional write on `guidemate-config`). The FastAPI app grows session + companion endpoints and a 3-second polling `state` endpoint (no WebSocket for this flow). `DogAgent.chat` gains a user name, last-10-message history, and lock-gated robot tools — physical when the session holds the lock, virtual otherwise. The admin router grows requests/sessions/robot-control endpoints, and the admin UI grows Requests/Sessions tabs plus a Robot tab. A `GUIDEMATE_FAKE_ROBOT=1` fake registry lets the Playwright 3-context e2e run against **real DynamoDB** without a live bridge.

**Tech Stack:** Python 3.10, boto3 (DynamoDB resource), pydantic v2, FastAPI + uvicorn, Strands (Bedrock `us.anthropic.claude-sonnet-4-6`), moto (offline DynamoDB for unit TDD), Playwright (pytest-playwright, Chromium) for the e2e.

## Global Constraints

Every task's requirements implicitly include this section.

- **Python 3.10-compatible** on both machines — no 3.11+ syntax (no `X | Y` in `isinstance`, no `tomllib`, etc.). `list[...]`/`dict[...]` generics are fine with `from __future__ import annotations`.
- **pydantic v2** (`>=2`); use `model_validate_json` / `model_dump_json` / `model_validate` / `model_dump` / `field_validator` / `model_validator`.
- **TDD**: write the failing test first, run it red, implement the minimum, run it green, then commit — every task.
- **Commit after every task** with a `Kalhar:` message prefix. **NEVER** add any Claude/AI/co-author line or `Co-Authored-By`. Do not push (the user pushes).
- **Never `pkill -f`** anything on the Pi (gotcha #6 — it self-matches the shell). This plan never kills robot processes.
- **Robot 468 stays docked and motion-locked**: nothing here publishes real motion; the bridge/fake stays in dry-run, the Device Shadow is **not touched**, and no `cmd_vel` is ever published. Direct `dock` commands from the admin panel are exercised **only through their refusal path**.
- **No credentials or IoT endpoints committed** to the repo. IoT data endpoint is discovered at runtime via `aws iot describe-endpoint --endpoint-type iot:Data-ATS`. Cert/key files stay out of git.
- **On-Pi work over SSH is additive only** — this plan does not touch the Pi.
- **Every new AWS resource** is tagged `guidemate-poc` and documented in `docs/agent-poc/access-ground-truth.md`. (Phase 4 creates no new AWS resource — the four DynamoDB tables already exist from Phase 3's `scripts/create_dynamo_tables.py`.)
- **Integration/live tests are env-gated** (`GUIDEMATE_INTEGRATION=1`, `GUIDEMATE_LIVE=1`) and skipped by default. The Playwright 3-context e2e is `integration`-marked (it needs real DynamoDB).

**Verified environment facts (do not re-derive):** AWS account `852373397000`, region `us-west-2`; creds via `credential_process` (identity `guidemate-agent-role`, AdministratorAccess); AWS CLI v2 at `~/.local/bin/aws`. Bedrock model id `us.anthropic.claude-sonnet-4-6`. `.venv` at repo root already has `boto3` 1.43.40, `playwright` 1.61.0, `pytest-playwright` 0.8.0, and Chromium (`chromium-1228`) installed. `moto` is **not** installed (Task 1 installs it).

## Pinned interfaces from parallel phases (treat as existing; each usage below is an integration point)

- **Phase 3 → `guidemate_agent/store.py`**: DynamoDB-backed flags/prompts. `store.get_flags() -> dict[str, bool]`, `store.set_flag(name, value)`, `store.get_prompt() -> str`, `store.set_prompt(text)`. Tables `guidemate-sessions`, `guidemate-messages`, `guidemate-requests`, `guidemate-config` are **already created** by `scripts/create_dynamo_tables.py`. **Phase 4 does not modify `store.py`** — the session layer is a separate module (`sessions.py`) so the two files never collide. `DogAgent` (Task 4) reads `store.get_flags()` for tool gating.
- **Phase 3 → `guidemate_agent/admin.py`**: an `APIRouter` (call it `router`) already mounted by `app.py`, plus an `admin_required` FastAPI dependency (signed HttpOnly cookie auth) and a login route that sets the cookie from the `GUIDEMATE_ADMIN_PASSWORD` env var. Task 6 **adds routes to this existing router** and reuses `admin_required`.
- **Phase 3 → `static/admin/`**: a tabbed admin UI shell (Flags / Robot / KB tabs). Task 6 **adds** Requests and Sessions tabs and extends the Robot tab, following the existing tab pattern.
- **Phase 2 → `RobotRegistry`**: `registry.get_status(robot_id) -> dict` including heartbeat + safety gates; `registry.send_command(robot_id, cmd: Command, timeout_s=5.0) -> list[Ack]` (already present from Phase 0-1). `DogAgent` already exposes `run_motion` / `stop` / `get_status` tools (Phase 2). Task 4 wraps tool registration with lock gating without removing Phase 2's tools.
- **Config partition key:** the robot lock is stored in `guidemate-config` under a partition-key value `robot_lock#<robot_id>`. `sessions.CONFIG_PK` (default `"key"`) **must equal** the partition-key *attribute name* that `scripts/create_dynamo_tables.py` gave `guidemate-config`. Verify once with `aws dynamodb describe-table --table-name guidemate-config --query 'Table.KeySchema'` and set `CONFIG_PK` to match before running the e2e.

---

## File Structure

```
cs7980-guide-mate/
├── agent_service/
│   ├── guidemate_agent/
│   │   ├── sessions.py            # NEW (Tasks 1-3) — session/message/request/lock store
│   │   ├── fake_robot.py          # NEW (Task 5) — GUIDEMATE_FAKE_ROBOT registry
│   │   ├── dog_agent.py           # MODIFY (Task 4) — user_name + history + lock-gated tools
│   │   ├── app.py                 # MODIFY (Task 5) — session + companion endpoints, fake wiring
│   │   └── admin.py               # MODIFY (Task 6) — requests/sessions/robot-control routes
│   ├── static/
│   │   ├── index.html             # MODIFY (Task 7) — intake + request states + virtual emote + polling
│   │   └── admin/index.html       # MODIFY (Task 6) — Requests + Sessions tabs, Robot tab controls
│   └── tests/
│       ├── conftest.py            # NEW (Task 1) — moto `ddb` fixture (tables + dummy creds)
│       ├── test_sessions.py       # NEW (Task 1) — sessions + messages
│       ├── test_locks.py          # NEW (Task 2) — requests + atomic robot lock
│       ├── test_orchestration.py  # NEW (Task 3) — approve/deny/abort/reassign
│       ├── test_dog_agent.py      # MODIFY (Task 4) — virtual vs physical emote, prompt builder
│       ├── test_app.py            # MODIFY (Task 5) — session/companion API
│       ├── test_admin.py          # MODIFY (Task 6) — admin request/robot routes (or NEW if Phase 3 had none)
│       └── integration/
│           └── test_companion_e2e.py   # NEW (Task 7) — Playwright 3-context (gated)
```

---

## Task 1: Session layer — sessions + messages (`sessions.py`) + moto test harness

**Files:**
- Create: `agent_service/guidemate_agent/sessions.py`
- Create: `agent_service/tests/conftest.py`
- Test: `agent_service/tests/test_sessions.py`

**Interfaces:**
- Consumes: nothing from other Phase 4 tasks. Uses `boto3` DynamoDB resource against tables created by Phase 3.
- Produces:
  - Constants `REGION = "us-west-2"`, `TABLE_SESSIONS`, `TABLE_MESSAGES`, `TABLE_REQUESTS`, `TABLE_CONFIG`, `CONFIG_PK = "key"`.
  - `new_id() -> str` (uuid4 hex), `_now_iso() -> str` (UTC ISO-8601), `_table(name)` (boto3 Table).
  - `create_session(name: str, comfortable: bool) -> str` — returns a new `session_id`; item `{session_id, name, comfortable(bool), created_ts, status:"active", request_status:"none", robot_id:None}`.
  - `get_session(session_id) -> Optional[dict]`.
  - `list_sessions() -> list[dict]` — newest-first by `created_ts`.
  - `append_message(session_id, role, text) -> str` — returns the sort key `f"{iso_ts}#{uuid}"`; item `{session_id, sk, role, text}`.
  - `get_messages(session_id, limit=None) -> list[dict]` — ascending by `sk`; the last `limit` when given.

- [ ] **Step 1: Install moto into the dev venv**

Run:
```bash
cd ~/cs7980-guide-mate && .venv/bin/pip install "moto[dynamodb]>=5"
```
Expected: `moto` (>=5) installs. (Dev-only; not added to `pyproject.toml` runtime deps.)

- [ ] **Step 2: Write the moto fixture `conftest.py`**

`agent_service/tests/conftest.py`:
```python
"""Shared test fixtures: an offline DynamoDB (moto) with the four guidemate tables."""
from __future__ import annotations

import boto3
import pytest
from moto import mock_aws


@pytest.fixture
def ddb(monkeypatch):
    """Start moto, create the four tables, yield the dynamodb resource.

    Env creds are forced to dummies so botocore never touches the real
    credential_process while mocked (env creds outrank the shared-config profile).
    """
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-west-2")
    with mock_aws():
        res = boto3.resource("dynamodb", region_name="us-west-2")
        res.create_table(
            TableName="guidemate-sessions",
            KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        res.create_table(
            TableName="guidemate-messages",
            KeySchema=[
                {"AttributeName": "session_id", "KeyType": "HASH"},
                {"AttributeName": "sk", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "session_id", "AttributeType": "S"},
                {"AttributeName": "sk", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        res.create_table(
            TableName="guidemate-requests",
            KeySchema=[{"AttributeName": "request_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "request_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        res.create_table(
            TableName="guidemate-config",
            KeySchema=[{"AttributeName": "key", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "key", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield res
```

- [ ] **Step 3: Write the failing tests**

`agent_service/tests/test_sessions.py`:
```python
from guidemate_agent import sessions


def test_create_and_get_session(ddb):
    sid = sessions.create_session("Ada", True)
    assert sid
    row = sessions.get_session(sid)
    assert row["name"] == "Ada"
    assert row["comfortable"] is True
    assert row["status"] == "active"
    assert row["request_status"] == "none"
    assert row.get("robot_id") in (None, "")


def test_get_missing_session_returns_none(ddb):
    assert sessions.get_session("nope") is None


def test_list_sessions_newest_first(ddb):
    a = sessions.create_session("A", False)
    b = sessions.create_session("B", True)
    ids = [s["session_id"] for s in sessions.list_sessions()]
    assert set(ids) >= {a, b}


def test_append_and_get_messages_order(ddb):
    sid = sessions.create_session("Ada", True)
    sessions.append_message(sid, "user", "hi")
    sessions.append_message(sid, "dog", "woof")
    sessions.append_message(sid, "user", "sit")
    msgs = sessions.get_messages(sid)
    assert [m["text"] for m in msgs] == ["hi", "woof", "sit"]
    assert [m["role"] for m in msgs] == ["user", "dog", "user"]


def test_get_messages_last_n(ddb):
    sid = sessions.create_session("Ada", True)
    for i in range(5):
        sessions.append_message(sid, "user", f"m{i}")
    last2 = sessions.get_messages(sid, limit=2)
    assert [m["text"] for m in last2] == ["m3", "m4"]
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_sessions.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_agent.sessions'`.

- [ ] **Step 5: Implement `sessions.py` (sessions + messages)**

`agent_service/guidemate_agent/sessions.py`:
```python
"""DynamoDB session layer: sessions, per-session messages, companion requests,
and the atomic per-robot lock. Self-contained (no dependency on store.py)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

REGION = "us-west-2"
TABLE_SESSIONS = "guidemate-sessions"
TABLE_MESSAGES = "guidemate-messages"
TABLE_REQUESTS = "guidemate-requests"
TABLE_CONFIG = "guidemate-config"
# Must equal the partition-key ATTRIBUTE NAME of guidemate-config (Phase 3
# create_dynamo_tables.py). Verify: aws dynamodb describe-table
# --table-name guidemate-config --query 'Table.KeySchema'.
CONFIG_PK = "key"

_resource = None


def _ddb():
    global _resource
    if _resource is None:
        _resource = boto3.resource("dynamodb", region_name=REGION)
    return _resource


def _table(name: str):
    return _ddb().Table(name)


def new_id() -> str:
    return uuid.uuid4().hex


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------- sessions ----
def create_session(name: str, comfortable: bool) -> str:
    session_id = new_id()
    _table(TABLE_SESSIONS).put_item(
        Item={
            "session_id": session_id,
            "name": name,
            "comfortable": bool(comfortable),
            "created_ts": _now_iso(),
            "status": "active",
            "request_status": "none",
            "robot_id": None,
        }
    )
    return session_id


def get_session(session_id: str) -> Optional[dict]:
    item = _table(TABLE_SESSIONS).get_item(Key={"session_id": session_id}).get("Item")
    return item


def list_sessions() -> list[dict]:
    rows = _table(TABLE_SESSIONS).scan().get("Items", [])
    return sorted(rows, key=lambda r: r.get("created_ts", ""), reverse=True)


# ---------------------------------------------------------------- messages ----
def append_message(session_id: str, role: str, text: str) -> str:
    sk = f"{_now_iso()}#{new_id()}"
    _table(TABLE_MESSAGES).put_item(
        Item={"session_id": session_id, "sk": sk, "role": role, "text": text}
    )
    return sk


def get_messages(session_id: str, limit: Optional[int] = None) -> list[dict]:
    items = _table(TABLE_MESSAGES).query(
        KeyConditionExpression=Key("session_id").eq(session_id),
        ScanIndexForward=True,
    ).get("Items", [])
    if limit is not None:
        return items[-limit:]
    return items
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_sessions.py -q`
Expected: PASS (5 passed).

- [ ] **Step 7: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/sessions.py agent_service/tests/conftest.py agent_service/tests/test_sessions.py
git commit -m "Kalhar: DynamoDB session + message store (sessions.py) with moto tests"
```

---

## Task 2: Companion requests + atomic per-robot lock (`sessions.py`)

**Files:**
- Modify: `agent_service/guidemate_agent/sessions.py`
- Test: `agent_service/tests/test_locks.py`

**Interfaces:**
- Consumes: `create_session`, `get_session`, `_table`, `new_id`, `_now_iso`, `REGION`, `TABLE_*`, `CONFIG_PK` (Task 1).
- Produces:
  - `create_request(session_id) -> str` — returns `request_id`; reads the session for intake context; writes request `{request_id, session_id, name, comfortable, status:"pending", created_ts}`; sets session `request_status="pending"`.
  - `get_request(request_id) -> Optional[dict]`.
  - `list_pending_requests() -> list[dict]` — requests with `status=="pending"`, oldest-first.
  - `_set_request_status(request_id, status) -> None` — updates the request item's `status`.
  - `_update_session(session_id, **attrs) -> None` — SETs the given attributes on a session.
  - `acquire_robot_lock(robot_id, session_id) -> bool` — **atomic** conditional write on `guidemate-config` (`attribute_not_exists` on the partition key); `True` if acquired, `False` if already held.
  - `get_lock_holder(robot_id) -> Optional[str]` — the holding `session_id` (or `None`).
  - `release_robot_lock(robot_id) -> None`.
  - `robot_for_session(session_id) -> Optional[str]` — the `robot_id` this session **authoritatively** holds (session bound AND lock holder matches), else `None`. This is the source of truth for physical-vs-virtual gating.

- [ ] **Step 1: Write the failing tests**

`agent_service/tests/test_locks.py`:
```python
from guidemate_agent import sessions


def test_create_request_captures_intake(ddb):
    sid = sessions.create_session("Ada", True)
    rid = sessions.create_request(sid)
    req = sessions.get_request(rid)
    assert req["session_id"] == sid
    assert req["name"] == "Ada"
    assert req["comfortable"] is True
    assert req["status"] == "pending"
    assert sessions.get_session(sid)["request_status"] == "pending"


def test_list_pending_requests(ddb):
    s1 = sessions.create_session("A", True)
    s2 = sessions.create_session("B", False)
    r1 = sessions.create_request(s1)
    r2 = sessions.create_request(s2)
    ids = [r["request_id"] for r in sessions.list_pending_requests()]
    assert set(ids) == {r1, r2}


def test_acquire_lock_is_exclusive(ddb):
    a = sessions.create_session("A", True)
    b = sessions.create_session("B", True)
    assert sessions.acquire_robot_lock("turtlebot468", a) is True
    assert sessions.acquire_robot_lock("turtlebot468", b) is False
    assert sessions.get_lock_holder("turtlebot468") == a


def test_release_then_reacquire(ddb):
    a = sessions.create_session("A", True)
    b = sessions.create_session("B", True)
    assert sessions.acquire_robot_lock("turtlebot468", a) is True
    sessions.release_robot_lock("turtlebot468")
    assert sessions.get_lock_holder("turtlebot468") is None
    assert sessions.acquire_robot_lock("turtlebot468", b) is True


def test_robot_for_session_requires_binding_and_lock(ddb):
    a = sessions.create_session("A", True)
    # No lock yet -> not physical.
    assert sessions.robot_for_session(a) is None
    sessions.acquire_robot_lock("turtlebot468", a)
    sessions._update_session(a, robot_id="turtlebot468", request_status="approved")
    assert sessions.robot_for_session(a) == "turtlebot468"
    # Lock stolen by another session -> a is no longer authoritative.
    sessions.release_robot_lock("turtlebot468")
    b = sessions.create_session("B", True)
    sessions.acquire_robot_lock("turtlebot468", b)
    assert sessions.robot_for_session(a) is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_locks.py -q`
Expected: FAIL — `AttributeError: module 'guidemate_agent.sessions' has no attribute 'create_request'`.

- [ ] **Step 3: Append the request + lock functions to `sessions.py`**

Add to the end of `agent_service/guidemate_agent/sessions.py`:
```python
# ---------------------------------------------------------------- requests ----
def _update_session(session_id: str, **attrs) -> None:
    names = {f"#a{i}": k for i, k in enumerate(attrs)}
    values = {f":v{i}": v for i, k in enumerate(attrs.values())}
    set_expr = ", ".join(f"#a{i} = :v{i}" for i in range(len(attrs)))
    _table(TABLE_SESSIONS).update_item(
        Key={"session_id": session_id},
        UpdateExpression="SET " + set_expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def create_request(session_id: str) -> str:
    session = get_session(session_id) or {}
    request_id = new_id()
    _table(TABLE_REQUESTS).put_item(
        Item={
            "request_id": request_id,
            "session_id": session_id,
            "name": session.get("name", ""),
            "comfortable": bool(session.get("comfortable", False)),
            "status": "pending",
            "created_ts": _now_iso(),
        }
    )
    _update_session(session_id, request_status="pending")
    return request_id


def get_request(request_id: str) -> Optional[dict]:
    return _table(TABLE_REQUESTS).get_item(Key={"request_id": request_id}).get("Item")


def list_pending_requests() -> list[dict]:
    rows = _table(TABLE_REQUESTS).scan().get("Items", [])
    pending = [r for r in rows if r.get("status") == "pending"]
    return sorted(pending, key=lambda r: r.get("created_ts", ""))


def _set_request_status(request_id: str, status: str) -> None:
    _table(TABLE_REQUESTS).update_item(
        Key={"request_id": request_id},
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": status},
    )


# ------------------------------------------------------------- robot lock ----
def _lock_key(robot_id: str) -> dict:
    return {CONFIG_PK: f"robot_lock#{robot_id}"}


def acquire_robot_lock(robot_id: str, session_id: str) -> bool:
    try:
        item = dict(_lock_key(robot_id))
        item.update({"session_id": session_id, "acquired_ts": _now_iso()})
        _table(TABLE_CONFIG).put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(#k)",
            ExpressionAttributeNames={"#k": CONFIG_PK},
        )
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def get_lock_holder(robot_id: str) -> Optional[str]:
    item = _table(TABLE_CONFIG).get_item(Key=_lock_key(robot_id)).get("Item")
    return item.get("session_id") if item else None


def release_robot_lock(robot_id: str) -> None:
    _table(TABLE_CONFIG).delete_item(Key=_lock_key(robot_id))


def robot_for_session(session_id: str) -> Optional[str]:
    session = get_session(session_id)
    if not session:
        return None
    robot_id = session.get("robot_id")
    if not robot_id:
        return None
    if get_lock_holder(robot_id) == session_id:
        return robot_id
    return None
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_locks.py -q`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/sessions.py agent_service/tests/test_locks.py
git commit -m "Kalhar: companion requests + atomic per-robot lock in sessions.py"
```

---

## Task 3: Approve / deny / abort / reassign orchestration (`sessions.py`)

**Files:**
- Modify: `agent_service/guidemate_agent/sessions.py`
- Test: `agent_service/tests/test_orchestration.py`

**Interfaces:**
- Consumes: everything from Tasks 1-2.
- Produces:
  - `get_session_state(session_id) -> dict` — `{"request_status": str, "robot_id": Optional[str]}` where `robot_id` uses `robot_for_session` (authoritative). This backs `GET /api/session/{id}/state`.
  - `_bind_robot(robot_id, session_id) -> Optional[str]` — internal: if another session holds the lock, release it and mark that previous holder **aborted** (`request_status="aborted"`, `robot_id` cleared), then acquire the lock for `session_id` and bind it (`robot_id=robot_id`, `request_status="approved"`). Returns the aborted previous `session_id` (or `None`).
  - `approve_request(request_id, robot_id) -> dict` — `{"session_id", "aborted_session_id"}`; sets the request `status="approved"` and binds its session via `_bind_robot`.
  - `deny_request(request_id) -> None` — request `status="denied"`, session `request_status="denied"`.
  - `abort_robot(robot_id) -> Optional[str]` — release the lock, mark the holder aborted, return the freed `session_id` (or `None`).
  - `reassign_robot(robot_id, session_id) -> Optional[str]` — `_bind_robot` to a chosen session (used by the Robot tab even when that session never filed a request); returns the aborted previous holder.

- [ ] **Step 1: Write the failing tests**

`agent_service/tests/test_orchestration.py`:
```python
from guidemate_agent import sessions


def test_approve_binds_session_and_lock(ddb):
    sid = sessions.create_session("Ada", True)
    rid = sessions.create_request(sid)
    out = sessions.approve_request(rid, "turtlebot468")
    assert out["session_id"] == sid
    assert out["aborted_session_id"] is None
    assert sessions.get_lock_holder("turtlebot468") == sid
    assert sessions.robot_for_session(sid) == "turtlebot468"
    assert sessions.get_request(rid)["status"] == "approved"
    state = sessions.get_session_state(sid)
    assert state == {"request_status": "approved", "robot_id": "turtlebot468"}


def test_approve_second_request_aborts_first(ddb):
    a = sessions.create_session("A", True)
    b = sessions.create_session("B", True)
    ra = sessions.create_request(a)
    rb = sessions.create_request(b)
    sessions.approve_request(ra, "turtlebot468")
    out = sessions.approve_request(rb, "turtlebot468")
    assert out["aborted_session_id"] == a
    assert sessions.get_lock_holder("turtlebot468") == b
    assert sessions.get_session_state(a) == {"request_status": "aborted", "robot_id": None}
    assert sessions.robot_for_session(b) == "turtlebot468"


def test_deny_request(ddb):
    sid = sessions.create_session("Ada", True)
    rid = sessions.create_request(sid)
    sessions.deny_request(rid)
    assert sessions.get_request(rid)["status"] == "denied"
    assert sessions.get_session_state(sid) == {"request_status": "denied", "robot_id": None}


def test_abort_robot_frees_lock(ddb):
    sid = sessions.create_session("Ada", True)
    rid = sessions.create_request(sid)
    sessions.approve_request(rid, "turtlebot468")
    freed = sessions.abort_robot("turtlebot468")
    assert freed == sid
    assert sessions.get_lock_holder("turtlebot468") is None
    assert sessions.get_session_state(sid) == {"request_status": "aborted", "robot_id": None}


def test_reassign_without_prior_request(ddb):
    a = sessions.create_session("A", True)
    b = sessions.create_session("B", True)  # never filed a request
    sessions.approve_request(sessions.create_request(a), "turtlebot468")
    aborted = sessions.reassign_robot("turtlebot468", b)
    assert aborted == a
    assert sessions.robot_for_session(b) == "turtlebot468"
    assert sessions.get_session_state(a) == {"request_status": "aborted", "robot_id": None}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_orchestration.py -q`
Expected: FAIL — `AttributeError: module 'guidemate_agent.sessions' has no attribute 'approve_request'`.

- [ ] **Step 3: Append the orchestration functions to `sessions.py`**

Add to the end of `agent_service/guidemate_agent/sessions.py`:
```python
# ------------------------------------------------------------ orchestration ----
def get_session_state(session_id: str) -> dict:
    session = get_session(session_id) or {}
    return {
        "request_status": session.get("request_status", "none"),
        "robot_id": robot_for_session(session_id),
    }


def _mark_session_aborted(session_id: str) -> None:
    _update_session(session_id, request_status="aborted", robot_id=None)


def _bind_robot(robot_id: str, session_id: str) -> Optional[str]:
    aborted = None
    holder = get_lock_holder(robot_id)
    if holder and holder != session_id:
        release_robot_lock(robot_id)
        _mark_session_aborted(holder)
        aborted = holder
    if not acquire_robot_lock(robot_id, session_id):
        # Lost a race (or same session re-binding): reset and take it.
        release_robot_lock(robot_id)
        acquire_robot_lock(robot_id, session_id)
    _update_session(session_id, robot_id=robot_id, request_status="approved")
    return aborted


def approve_request(request_id: str, robot_id: str) -> dict:
    req = get_request(request_id)
    if not req:
        raise KeyError(f"no such request {request_id}")
    aborted = _bind_robot(robot_id, req["session_id"])
    _set_request_status(request_id, "approved")
    return {"session_id": req["session_id"], "aborted_session_id": aborted}


def deny_request(request_id: str) -> None:
    req = get_request(request_id)
    if not req:
        raise KeyError(f"no such request {request_id}")
    _set_request_status(request_id, "denied")
    _update_session(req["session_id"], request_status="denied")


def abort_robot(robot_id: str) -> Optional[str]:
    holder = get_lock_holder(robot_id)
    release_robot_lock(robot_id)
    if holder:
        _mark_session_aborted(holder)
    return holder


def reassign_robot(robot_id: str, session_id: str) -> Optional[str]:
    return _bind_robot(robot_id, session_id)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_orchestration.py -q`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/sessions.py agent_service/tests/test_orchestration.py
git commit -m "Kalhar: approve/deny/abort/reassign companion orchestration in sessions.py"
```

---

## Task 4: `DogAgent` — user name, history, and lock-gated virtual/physical tools

**Files:**
- Modify: `agent_service/guidemate_agent/dog_agent.py`
- Test: `agent_service/tests/test_dog_agent.py`

**Interfaces:**
- Consumes: `RobotRegistry.send_command` (Phase 0-1), `store.get_flags()` (Phase 3, tolerated-absent), `Command` (Phase 0-1).
- Produces (extends the Phase 2/3 `DogAgent`):
  - `chat(message, session_id=None, user_name=None, history=None, robot_id=None) -> dict` — same return shape as before (`reply_text`, `emote`, `robot`, `turn_id`), now with a `session_id` echo. `robot_id` is set **only when the session authoritatively holds the lock** (the caller passes `sessions.robot_for_session(...)`); when set the emote is **physical** (published), otherwise **virtual** (avatar-only, no MQTT). Robot-only tools (`run_motion`, `stop`) are offered to the model **only when physical**.
  - `_build_system_prompt(user_name, history) -> str` — persona + optional user name line + last-10-message recap.
  - `_emote_impl(name, target, captured, physical) -> str` — physical publishes via the registry; virtual only records the emote name for the UI (no publish).

**Note on the Phase 2/3 file:** by execution time `dog_agent.py` already carries Phase 2's `run_motion`/`stop`/`get_status` tools and Phase 3's `store.get_flags()` gating. This task **replaces `chat` and `_emote_impl`** with the versions below and adds `_build_system_prompt` and `_build_tools`; it preserves flag gating by consulting `store.get_flags()`. Keep any additional Phase 2/3 tool *impl* helpers (`_motion_impl`, etc.) if present — `_build_tools` references `run_motion`/`stop` closures defined inline below, which call `registry.send_command` directly, so no unknown helper is required.

- [ ] **Step 1: Write the failing tests (extend `test_dog_agent.py`)**

Append to `agent_service/tests/test_dog_agent.py`:
```python
from guidemate_msgs.messages import Ack


class RecordingRegistry:
    def __init__(self):
        self.sent = []

    def send_command(self, robot_id, cmd, timeout_s=5.0):
        self.sent.append((robot_id, cmd.type, cmd.name))
        return [
            Ack(cmd_id=cmd.cmd_id, state="received", simulated=True),
            Ack(cmd_id=cmd.cmd_id, state="done", simulated=True),
        ]


def _agent(reg):
    from guidemate_agent.dog_agent import DogAgent
    return DogAgent(registry=reg, model_id="us.anthropic.claude-sonnet-4-6",
                    robot_ids=["turtlebot468"])


def test_virtual_emote_does_not_publish():
    reg = RecordingRegistry()
    agent = _agent(reg)
    captured = {"emote": None, "acks": []}
    out = agent._emote_impl("happy", target="turtlebot468", captured=captured, physical=False)
    assert reg.sent == []                       # nothing published
    assert captured["emote"] == "happy"         # UI still animates the avatar
    assert captured["acks"] == []
    assert "virtual" in out.lower()


def test_physical_emote_publishes():
    reg = RecordingRegistry()
    agent = _agent(reg)
    captured = {"emote": None, "acks": []}
    out = agent._emote_impl("yes", target="turtlebot468", captured=captured, physical=True)
    assert reg.sent == [("turtlebot468", "emote", "yes")]
    assert captured["emote"] == "yes"
    assert captured["acks"] and captured["acks"][-1]["state"] == "done"
    assert "simulated" in out.lower() or "delivered" in out.lower()


def test_system_prompt_includes_name_and_history():
    agent = _agent(RecordingRegistry())
    prompt = agent._build_system_prompt(
        "Ada", [{"role": "user", "text": "hi"}, {"role": "dog", "text": "woof"}]
    )
    assert "Robert" in prompt
    assert "Ada" in prompt
    assert "hi" in prompt and "woof" in prompt


def test_system_prompt_truncates_history_to_last_10():
    agent = _agent(RecordingRegistry())
    history = [{"role": "user", "text": f"m{i}"} for i in range(15)]
    prompt = agent._build_system_prompt(None, history)
    assert "m14" in prompt
    assert "m4" not in prompt   # only the last 10 kept (m5..m14)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_dog_agent.py -q`
Expected: FAIL — `_emote_impl` has no `physical` kwarg / `_build_system_prompt` missing.

- [ ] **Step 3: Rewrite `dog_agent.py`**

`agent_service/guidemate_agent/dog_agent.py`:
```python
"""Robert the robot dog — session-aware Strands agent.

Physical emotes/motions are published to the robot ONLY when the session holds
the robot lock (caller passes robot_id from sessions.robot_for_session). Every
other session gets a virtual emote: the name is returned for avatar animation
but nothing is published to MQTT.
"""
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


def _flags() -> dict:
    """Phase 3 feature flags; tolerate absence so chat always works."""
    try:
        from guidemate_agent import store
        return store.get_flags() or {}
    except Exception:  # noqa: BLE001
        return {}


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

    def _build_system_prompt(self, user_name: Optional[str], history) -> str:
        parts = [PERSONA]
        if user_name:
            parts.append(
                f"You are talking with {user_name}. Greet them warmly by name now and then."
            )
        if history:
            lines = []
            for m in history[-10:]:
                who = "User" if m.get("role") == "user" else "Robert"
                lines.append(f"{who}: {m.get('text', '')}")
            parts.append("Recent conversation so far:\n" + "\n".join(lines))
        return "\n\n".join(parts)

    def _emote_impl(self, name: str, target: Optional[str], captured: dict,
                    physical: bool) -> str:
        captured["emote"] = name
        if not physical or target is None:
            captured["acks"] = []
            return "virtual emote played (avatar only — not connected to a robot)"
        acks = self._registry.send_command(target, Command(type="emote", name=name))
        captured["acks"] = [a.model_dump() for a in acks]
        if not acks:
            return "robot did not respond — I'm probably napping offline"
        return "emote delivered (simulated)"

    def _motion_impl(self, name: str, target: Optional[str], captured: dict) -> str:
        if target is None:
            return "robot did not respond — I'm probably napping offline"
        acks = self._registry.send_command(target, Command(type="motion", name=name))
        captured["acks"] = [a.model_dump() for a in acks]
        if acks and acks[-1].state == "failed":
            return f"motion refused: {acks[-1].reason}"
        return "motion delivered (simulated)"

    def _build_tools(self, physical: bool, target: Optional[str], captured: dict):
        flags = _flags()
        tools = []

        if flags.get("send_emote", True):
            @tool
            def send_emote(name: str) -> str:
                """Play an emote. name is one of happy, yes, no."""
                return self._emote_impl(name, target, captured, physical)
            tools.append(send_emote)

        if physical and flags.get("run_motion", True):
            @tool
            def run_motion(name: str) -> str:
                """Run a motion primitive on the connected robot. name is circle or spin."""
                return self._motion_impl(name, target, captured)

            @tool
            def stop() -> str:
                """Stop the connected robot immediately."""
                return self._motion_impl("stop", target, captured)
            tools.extend([run_motion, stop])

        return tools

    def chat(
        self,
        message: str,
        session_id: Optional[str] = None,
        user_name: Optional[str] = None,
        history=None,
        robot_id: Optional[str] = None,
    ) -> dict:
        turn_id = str(uuid.uuid4())
        physical = robot_id is not None
        target = robot_id or (self._robot_ids[0] if self._robot_ids else None)
        captured = {"emote": None, "acks": []}

        tools = self._build_tools(physical, target if physical else None, captured)
        model = BedrockModel(model_id=self._model_id, region_name=self._region)
        agent = Agent(
            model=model,
            system_prompt=self._build_system_prompt(user_name, history),
            tools=tools,
        )
        result = agent(message)
        return {
            "reply_text": str(result),
            "emote": captured["emote"],
            "robot": captured["acks"],
            "turn_id": turn_id,
            "session_id": session_id,
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_dog_agent.py -q`
Expected: PASS (the two Phase 0-1 tests + 4 new = 6 passed). The Phase 0-1 tests call `_emote_impl(...)` without `physical`; if they still exist unchanged they will error — update those two calls to pass `physical=True` (they assert the offline path, which now needs `physical=True, target="turtlebot468"` with a registry returning `[]`, or `physical=False`). Concretely, change `agent._emote_impl("happy", target="turtlebot468", captured=captured)` to `agent._emote_impl("happy", target="turtlebot468", captured=captured, physical=True)` and `agent._emote_impl("no", target=None, captured=captured)` to `..., physical=True)`; both still return the "napping"/virtual string and keep `captured["acks"] == []`.

- [ ] **Step 5: Run the live Bedrock smoke test (gated) to confirm tool wiring still works**

Run: `cd ~/cs7980-guide-mate && GUIDEMATE_LIVE=1 .venv/bin/python -m pytest agent_service/tests/integration/test_live_agent.py -q`
Expected: PASS (1 passed) — a real turn returns a non-empty reply and a captured emote. (The live test calls `chat("do a happy wiggle")` with no `robot_id` → virtual path, `emote` still captured.)

- [ ] **Step 6: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/dog_agent.py agent_service/tests/test_dog_agent.py
git commit -m "Kalhar: DogAgent gains user name, history, and lock-gated virtual/physical tools"
```

---

## Task 5: Session + companion HTTP API + fake-robot wiring (`app.py`, `fake_robot.py`)

**Files:**
- Create: `agent_service/guidemate_agent/fake_robot.py`
- Modify: `agent_service/guidemate_agent/app.py`
- Test: `agent_service/tests/test_app.py`

**Interfaces:**
- Consumes: `sessions.*` (Tasks 1-3), `DogAgent.chat` (Task 4), `Config` (Phase 0-1), `RobotRegistry` (Phase 0-1).
- Produces:
  - `class FakeRobotRegistry(robot_ids)` — drop-in for `RobotRegistry` used when `GUIDEMATE_FAKE_ROBOT=1`: `connect()` no-op; `send_command(robot_id, cmd, timeout_s=5.0)` returns simulated `received→done` acks for emotes / `circle` / `spin` / `stop`, and a `received` + `failed(reason="motion_disabled")` pair for `dock`/`undock`; `get_status(robot_id)` returns a canned docked/motion-locked status.
  - New endpoints on the existing `app`:
    - `POST /api/session {name, comfortable}` → `{"session_id": str}`.
    - `POST /api/chat {message, session_id?}` → `DogAgent.chat` JSON. When `session_id` is present: appends the user message, loads the last 10 prior messages as history, resolves the bound robot via `sessions.robot_for_session`, calls the agent with `user_name`/`history`/`robot_id`, then appends the dog reply.
    - `POST /api/session/{session_id}/request-companion` → `{"request_id": str, "status": "pending"}`.
    - `GET /api/session/{session_id}/state` → `sessions.get_session_state(session_id)`.

- [ ] **Step 1: Write the failing tests (extend `test_app.py`)**

Append to `agent_service/tests/test_app.py`:
```python
import os

from fastapi.testclient import TestClient

from guidemate_agent import sessions


class _FakeAgent:
    def __init__(self):
        self.calls = []

    def chat(self, message, session_id=None, user_name=None, history=None, robot_id=None):
        self.calls.append(
            {"message": message, "session_id": session_id, "user_name": user_name,
             "history": history, "robot_id": robot_id}
        )
        return {"reply_text": "woof", "emote": "happy", "robot": [],
                "turn_id": "t", "session_id": session_id}


def _client(monkeypatch, ddb):
    monkeypatch.setenv("GUIDEMATE_FAKE_ROBOT", "1")
    import guidemate_agent.app as appmod
    client = TestClient(appmod.app)
    return appmod, client


def test_create_session_and_chat_records_messages(monkeypatch, ddb):
    appmod, _ = _client(monkeypatch, ddb)
    with TestClient(appmod.app) as client:
        fake = _FakeAgent()
        client.app.state.agent = fake
        sid = client.post("/api/session", json={"name": "Ada", "comfortable": True}).json()["session_id"]
        assert sid
        resp = client.post("/api/chat", json={"session_id": sid, "message": "hello"})
        assert resp.status_code == 200
        assert resp.json()["reply_text"] == "woof"
        # history was empty on the first turn; user_name threaded through
        assert fake.calls[0]["user_name"] == "Ada"
        assert fake.calls[0]["robot_id"] is None      # no lock -> virtual
        # both user + dog messages persisted
        msgs = sessions.get_messages(sid)
        assert [m["role"] for m in msgs] == ["user", "dog"]


def test_request_companion_and_state(monkeypatch, ddb):
    appmod, _ = _client(monkeypatch, ddb)
    with TestClient(appmod.app) as client:
        client.app.state.agent = _FakeAgent()
        sid = client.post("/api/session", json={"name": "Ada", "comfortable": True}).json()["session_id"]
        r = client.post(f"/api/session/{sid}/request-companion")
        assert r.status_code == 200
        assert r.json()["status"] == "pending"
        state = client.get(f"/api/session/{sid}/state").json()
        assert state["request_status"] == "pending"
        assert state["robot_id"] is None


def test_chat_uses_bound_robot_when_locked(monkeypatch, ddb):
    appmod, _ = _client(monkeypatch, ddb)
    with TestClient(appmod.app) as client:
        fake = _FakeAgent()
        client.app.state.agent = fake
        sid = client.post("/api/session", json={"name": "Ada", "comfortable": True}).json()["session_id"]
        sessions.approve_request(sessions.create_request(sid), "turtlebot468")
        client.post("/api/chat", json={"session_id": sid, "message": "wiggle"})
        assert fake.calls[-1]["robot_id"] == "turtlebot468"   # physical path
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_app.py -q`
Expected: FAIL — no `/api/session` route (404) / `GUIDEMATE_FAKE_ROBOT` unhandled.

- [ ] **Step 3: Implement `fake_robot.py`**

`agent_service/guidemate_agent/fake_robot.py`:
```python
"""In-process fake robot registry for e2e/demo without a live bridge.

Enabled by GUIDEMATE_FAKE_ROBOT=1. Emotes and circle/spin/stop return simulated
success; dock/undock return the bridge's motion-locked refusal so the admin
'dock' control can be exercised through its refusal path only.
"""
from __future__ import annotations

from datetime import datetime, timezone

from guidemate_msgs.messages import Ack

_SIMULATED = {("emote",), ("motion", "circle"), ("motion", "spin"), ("stop", "stop")}


class FakeRobotRegistry:
    def __init__(self, robot_ids: list[str]) -> None:
        self._robot_ids = robot_ids

    def connect(self) -> None:
        return None

    def send_command(self, robot_id, cmd, timeout_s: float = 5.0) -> list[Ack]:
        if cmd.type == "motion" and cmd.name in ("dock", "undock"):
            return [
                Ack(cmd_id=cmd.cmd_id, state="received"),
                Ack(cmd_id=cmd.cmd_id, state="failed",
                    reason="motion_disabled (docking blocked while motion is locked)"),
            ]
        return [
            Ack(cmd_id=cmd.cmd_id, state="received", simulated=True),
            Ack(cmd_id=cmd.cmd_id, state="running", simulated=True),
            Ack(cmd_id=cmd.cmd_id, state="done", simulated=True),
        ]

    def get_status(self, robot_id) -> dict:
        return {
            "robot_id": robot_id,
            "presence": "online",
            "gates": {"motion_enabled": False, "docked": True, "dry_run": True},
            "heartbeat_ts": datetime.now(timezone.utc).isoformat(),
        }
```

- [ ] **Step 4: Modify `app.py`**

Make these changes to `agent_service/guidemate_agent/app.py` (integrate with whatever Phase 3 added — admin router mount, static mounts — leaving those intact):

1. Add imports near the top:
```python
import os

from fastapi import HTTPException
from typing import Optional

from guidemate_agent import sessions
from guidemate_agent.fake_robot import FakeRobotRegistry
```

2. In the `lifespan` function, replace the `RobotRegistry(...)` construction with a fake-aware build:
```python
    if os.environ.get("GUIDEMATE_FAKE_ROBOT") == "1":
        registry = FakeRobotRegistry(cfg.robot_ids)
    else:
        registry = RobotRegistry(
            endpoint=cfg.iot_endpoint, region=cfg.region, robot_ids=cfg.robot_ids
        )
```

3. Replace the `ChatRequest` model and the `/api/chat` route, and add the three session routes:
```python
class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None


class SessionRequest(BaseModel):
    name: str
    comfortable: bool = False


@app.post("/api/session")
def create_session(req: SessionRequest) -> dict:
    return {"session_id": sessions.create_session(req.name, req.comfortable)}


@app.post("/api/chat")
def chat(req: ChatRequest) -> JSONResponse:
    if req.session_id is None:
        return JSONResponse(app.state.agent.chat(req.message))
    session = sessions.get_session(req.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="unknown session")
    history = sessions.get_messages(req.session_id, limit=10)
    sessions.append_message(req.session_id, "user", req.message)
    result = app.state.agent.chat(
        req.message,
        session_id=req.session_id,
        user_name=session.get("name"),
        history=history,
        robot_id=sessions.robot_for_session(req.session_id),
    )
    sessions.append_message(req.session_id, "dog", result.get("reply_text", ""))
    return JSONResponse(result)


@app.post("/api/session/{session_id}/request-companion")
def request_companion(session_id: str) -> dict:
    if sessions.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="unknown session")
    return {"request_id": sessions.create_request(session_id), "status": "pending"}


@app.get("/api/session/{session_id}/state")
def session_state(session_id: str) -> dict:
    return sessions.get_session_state(session_id)
```

(If Phase 3 already made `/api/chat` a WebSocket or changed its signature, keep this REST route as `/api/chat` — the chat UI in Task 7 posts to it. The `Optional[str]` `session_id` keeps the Phase 0-1 message-only callers working.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_app.py -q`
Expected: PASS. (The Phase 0-1 `test_healthz` / `test_index_served` still pass; new session tests pass under moto.)

- [ ] **Step 6: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/fake_robot.py agent_service/guidemate_agent/app.py agent_service/tests/test_app.py
git commit -m "Kalhar: session + companion HTTP API + GUIDEMATE_FAKE_ROBOT registry"
```

---

## Task 6: Admin endpoints + admin UI tabs (requests / sessions / robot controls)

**Files:**
- Modify: `agent_service/guidemate_agent/admin.py`
- Modify: `agent_service/static/admin/index.html`
- Test: `agent_service/tests/test_admin.py`

**Interfaces:**
- Consumes: Phase 3's `router` (`APIRouter`) + `admin_required` dependency; `sessions.*` (Tasks 1-3); `request.app.state.registry` (Task 5). `Command` (Phase 0-1).
- Produces (all `Depends(admin_required)`), added to the existing router:
  - `GET  /admin/api/requests` → `sessions.list_pending_requests()`.
  - `POST /admin/api/requests/{request_id}/approve {robot_id}` → `sessions.approve_request(...)`.
  - `POST /admin/api/requests/{request_id}/deny` → `{"ok": True}`.
  - `GET  /admin/api/sessions` → `sessions.list_sessions()`.
  - `GET  /admin/api/sessions/{session_id}/messages` → `sessions.get_messages(session_id)`.
  - `POST /admin/api/robot/{robot_id}/abort` → `{"freed_session_id": ...}`.
  - `POST /admin/api/robot/{robot_id}/reassign {session_id}` → `{"aborted_session_id": ...}`.
  - `POST /admin/api/robot/{robot_id}/command {type, name}` → `{"refused": bool, "acks": [...]}` — builds `Command(type, name)`; if it fails schema validation (e.g. `dock`, which is motion and blocked while locked) it returns a synthesized `failed`/`motion_disabled` refusal without publishing; otherwise it publishes via the registry and reports the acks.

**Note on the router prefix:** Phase 3 mounts the router; assume it carries the `/admin` prefix so the paths above resolve as written. If Phase 3 mounted it with `prefix="/admin"`, define the routes below with the sub-paths only (`/api/requests`, ...). Match the existing routes in `admin.py` — read one to see whether they already include `/admin`.

- [ ] **Step 1: Write the failing tests**

`agent_service/tests/test_admin.py` (create; if Phase 3 already created it, append these functions):
```python
from fastapi.testclient import TestClient

from guidemate_agent import sessions


def _admin_client(monkeypatch, ddb):
    monkeypatch.setenv("GUIDEMATE_FAKE_ROBOT", "1")
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "letmein")
    import guidemate_agent.app as appmod
    client = TestClient(appmod.app)
    # Obtain the admin cookie via Phase 3's login route.
    resp = client.post("/admin/api/login", json={"password": "letmein"})
    assert resp.status_code == 200, "align this with Phase 3's admin login route"
    return appmod, client


def test_list_and_approve_request(monkeypatch, ddb):
    appmod, client = _admin_client(monkeypatch, ddb)
    with client:
        client.app.state.agent = object()  # not used on these routes
        sid = sessions.create_session("Ada", True)
        rid = sessions.create_request(sid)
        pending = client.get("/admin/api/requests").json()
        assert any(r["request_id"] == rid for r in pending)
        out = client.post(f"/admin/api/requests/{rid}/approve",
                          json={"robot_id": "turtlebot468"}).json()
        assert out["session_id"] == sid
        assert sessions.get_lock_holder("turtlebot468") == sid


def test_reassign_and_abort(monkeypatch, ddb):
    appmod, client = _admin_client(monkeypatch, ddb)
    with client:
        a = sessions.create_session("A", True)
        b = sessions.create_session("B", True)
        sessions.approve_request(sessions.create_request(a), "turtlebot468")
        out = client.post("/admin/api/robot/turtlebot468/reassign",
                          json={"session_id": b}).json()
        assert out["aborted_session_id"] == a
        freed = client.post("/admin/api/robot/turtlebot468/abort").json()
        assert freed["freed_session_id"] == b


def test_dock_command_is_refused(monkeypatch, ddb):
    appmod, client = _admin_client(monkeypatch, ddb)
    with client:
        out = client.post("/admin/api/robot/turtlebot468/command",
                          json={"type": "dock", "name": "dock"}).json()
        assert out["refused"] is True
        assert "motion" in out["acks"][-1]["reason"].lower()


def test_sessions_transcript(monkeypatch, ddb):
    appmod, client = _admin_client(monkeypatch, ddb)
    with client:
        sid = sessions.create_session("Ada", True)
        sessions.append_message(sid, "user", "hi")
        sessions.append_message(sid, "dog", "woof")
        listed = client.get("/admin/api/sessions").json()
        assert any(s["session_id"] == sid for s in listed)
        msgs = client.get(f"/admin/api/sessions/{sid}/messages").json()
        assert [m["text"] for m in msgs] == ["hi", "woof"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_admin.py -q`
Expected: FAIL — 404s on the new admin routes (or a login-route mismatch to reconcile against Phase 3).

- [ ] **Step 3: Add the routes to `admin.py`**

Add to `agent_service/guidemate_agent/admin.py` (using the existing `router` and `admin_required`; drop the `/admin` prefix on each path if the router is mounted with `prefix="/admin"`):
```python
from fastapi import Body, Depends, Request
from pydantic import BaseModel, ValidationError

from guidemate_msgs.messages import Command, new_cmd_id
from guidemate_agent import sessions


class _ApproveBody(BaseModel):
    robot_id: str


class _ReassignBody(BaseModel):
    session_id: str


class _RobotCommandBody(BaseModel):
    type: str
    name: str


@router.get("/admin/api/requests")
def admin_list_requests(_=Depends(admin_required)) -> list:
    return sessions.list_pending_requests()


@router.post("/admin/api/requests/{request_id}/approve")
def admin_approve(request_id: str, body: _ApproveBody, _=Depends(admin_required)) -> dict:
    return sessions.approve_request(request_id, body.robot_id)


@router.post("/admin/api/requests/{request_id}/deny")
def admin_deny(request_id: str, _=Depends(admin_required)) -> dict:
    sessions.deny_request(request_id)
    return {"ok": True}


@router.get("/admin/api/sessions")
def admin_list_sessions(_=Depends(admin_required)) -> list:
    return sessions.list_sessions()


@router.get("/admin/api/sessions/{session_id}/messages")
def admin_session_messages(session_id: str, _=Depends(admin_required)) -> list:
    return sessions.get_messages(session_id)


@router.post("/admin/api/robot/{robot_id}/abort")
def admin_abort_robot(robot_id: str, _=Depends(admin_required)) -> dict:
    return {"freed_session_id": sessions.abort_robot(robot_id)}


@router.post("/admin/api/robot/{robot_id}/reassign")
def admin_reassign_robot(robot_id: str, body: _ReassignBody,
                         _=Depends(admin_required)) -> dict:
    return {"aborted_session_id": sessions.reassign_robot(robot_id, body.session_id)}


@router.post("/admin/api/robot/{robot_id}/command")
def admin_robot_command(robot_id: str, body: _RobotCommandBody, request: Request,
                        _=Depends(admin_required)) -> dict:
    try:
        cmd = Command(type=body.type, name=body.name)
    except ValidationError:
        # dock/undock (and any non-choreography command) are motion and refused
        # while motion is locked — surface the refusal without publishing.
        return {
            "refused": True,
            "acks": [{
                "cmd_id": new_cmd_id(),
                "state": "failed",
                "reason": (f"blocked: {body.type}/{body.name} is a motion command, "
                           "refused while motion is locked"),
            }],
        }
    acks = request.app.state.registry.send_command(robot_id, cmd)
    refused = bool(acks) and acks[-1].state == "failed"
    return {"refused": refused, "acks": [a.model_dump() for a in acks]}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_admin.py -q`
Expected: PASS (4 passed). If the login POST 404s, read `admin.py` for Phase 3's real login path/body and update `_admin_client` + the e2e helper (Task 7) to match.

- [ ] **Step 5: Add the Requests + Sessions tabs and Robot controls to the admin UI**

Modify `agent_service/static/admin/index.html`, following the existing tab pattern (a nav button that shows a `<section>` panel). Add two tab buttons and panels, and extend the Robot panel. Insert these panels and this `<script>` block (adapt the show/hide helper to the file's existing tab switcher; the IDs below are what the e2e and manual QA rely on):
```html
<!-- Requests tab panel -->
<section id="tab-requests" hidden>
  <h2>Companion requests</h2>
  <button id="reload-requests">Reload</button>
  <ul id="requests-list"></ul>
</section>

<!-- Sessions tab panel -->
<section id="tab-sessions" hidden>
  <h2>Sessions</h2>
  <button id="reload-sessions">Reload</button>
  <ul id="sessions-list"></ul>
  <h3>Transcript</h3>
  <div id="transcript" style="border:1px solid #ccc;padding:8px;min-height:120px;"></div>
</section>

<!-- Robot controls (add into the existing Robot panel) -->
<div id="robot-holder">Robot holder: <span id="robot-holder-value">(none)</span></div>
<button id="robot-abort">Abort robot session</button>
<button id="robot-dock">Send dock (expect refusal)</button>
<button id="robot-stop">Send stop</button>
<div id="robot-command-result"></div>

<script>
  const ROBOT_ID = "turtlebot468";
  async function reloadRequests() {
    const rs = await (await fetch("/admin/api/requests")).json();
    const ul = document.getElementById("requests-list");
    ul.innerHTML = "";
    rs.forEach((r) => {
      const li = document.createElement("li");
      li.textContent = `${r.name} (comfortable=${r.comfortable}) — ${r.session_id}`;
      const approve = document.createElement("button");
      approve.textContent = "Approve";
      approve.onclick = async () => {
        await fetch(`/admin/api/requests/${r.request_id}/approve`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ robot_id: ROBOT_ID }),
        });
        reloadRequests();
      };
      const deny = document.createElement("button");
      deny.textContent = "Deny";
      deny.onclick = async () => {
        await fetch(`/admin/api/requests/${r.request_id}/deny`, { method: "POST" });
        reloadRequests();
      };
      li.append(" ", approve, deny);
      ul.appendChild(li);
    });
  }
  async function reloadSessions() {
    const ss = await (await fetch("/admin/api/sessions")).json();
    const ul = document.getElementById("sessions-list");
    ul.innerHTML = "";
    ss.forEach((s) => {
      const li = document.createElement("li");
      li.textContent = `${s.name} — ${s.request_status} — robot=${s.robot_id || "-"}`;
      const view = document.createElement("button");
      view.textContent = "Transcript";
      view.onclick = async () => {
        const msgs = await (await fetch(`/admin/api/sessions/${s.session_id}/messages`)).json();
        document.getElementById("transcript").textContent =
          msgs.map((m) => `${m.role}: ${m.text}`).join("\n");
      };
      const reassign = document.createElement("button");
      reassign.textContent = "Give robot";
      reassign.onclick = async () => {
        await fetch(`/admin/api/robot/${ROBOT_ID}/reassign`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: s.session_id }),
        });
        reloadSessions();
      };
      li.append(" ", view, reassign);
      ul.appendChild(li);
    });
  }
  document.getElementById("reload-requests")?.addEventListener("click", reloadRequests);
  document.getElementById("reload-sessions")?.addEventListener("click", reloadSessions);
  document.getElementById("robot-abort")?.addEventListener("click", async () => {
    await fetch(`/admin/api/robot/${ROBOT_ID}/abort`, { method: "POST" });
  });
  async function sendRobotCommand(type, name) {
    const out = await (await fetch(`/admin/api/robot/${ROBOT_ID}/command`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, name }),
    })).json();
    const last = out.acks[out.acks.length - 1];
    document.getElementById("robot-command-result").textContent =
      (out.refused ? "REFUSED: " : "OK: ") + (last ? last.reason || last.state : "");
  }
  document.getElementById("robot-dock")?.addEventListener("click",
    () => sendRobotCommand("dock", "dock"));
  document.getElementById("robot-stop")?.addEventListener("click",
    () => sendRobotCommand("stop", "stop"));
</script>
```

- [ ] **Step 6: Manual smoke of the admin UI (optional but recommended)**

Run:
```bash
cd ~/cs7980-guide-mate
GUIDEMATE_FAKE_ROBOT=1 GUIDEMATE_ADMIN_PASSWORD=letmein \
  .venv/bin/python -m uvicorn guidemate_agent.app:app --app-dir agent_service --port 8080 &
```
Open `http://127.0.0.1:8080/admin`, log in with `letmein`, click through Requests/Sessions/Robot tabs, then `kill %1`. Expected: tabs render; Reload buttons fetch without console errors.

- [ ] **Step 7: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/admin.py agent_service/static/admin/index.html agent_service/tests/test_admin.py
git commit -m "Kalhar: admin request/session/robot-control endpoints + admin UI tabs"
```

---

## Task 7: Chat UI (intake / request states / virtual emote) + Playwright 3-context e2e

**Files:**
- Modify: `agent_service/static/index.html`
- Test: `agent_service/tests/integration/test_companion_e2e.py`

**Interfaces:**
- Consumes: all API from Tasks 5-6; `GUIDEMATE_FAKE_ROBOT=1`; the admin login route (Phase 3).
- Produces: a full chat page with intake, per-session chat, a companion request banner, virtual/physical emote display, 3-second `state` polling, and a Start-new-session button — and a gated Playwright 3-context e2e proving lock exclusivity, reassign/abort within 6 s, and dock refusal.

- [ ] **Step 1: Rewrite the chat page `static/index.html`**

`agent_service/static/index.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Robert the Robot Dog</title>
  <style>
    #avatar { font-size: 48px; display: inline-block; }
    #avatar.wiggle { animation: wig 0.5s ease-in-out 3; }
    @keyframes wig { 0%,100% { transform: rotate(0); } 25% { transform: rotate(-15deg); }
      75% { transform: rotate(15deg); } }
    .banner { padding: 6px; margin: 8px 0; border: 1px solid #999; }
  </style>
</head>
<body>
  <h1>Robert the Robot Dog</h1>

  <div id="intake">
    <p>What's your name, and are you comfortable around Physical AI Dogs?</p>
    <input id="name" placeholder="Your name" autocomplete="off" />
    <label><input type="checkbox" id="comfortable" /> I'm comfortable around Physical AI Dogs</label>
    <button id="start">Start chatting</button>
  </div>

  <div id="chat" hidden>
    <span id="avatar">🐶</span>
    <span id="emote-label"></span>
    <div id="companion-status" class="banner">Virtual dog (avatar only)</div>
    <button id="request-companion">Request physical companion</button>
    <button id="new-session">Start new session</button>
    <div id="messages" style="border:1px solid #ccc;padding:8px;min-height:200px;margin:8px 0;"></div>
    <form id="chat-form">
      <input id="message" autocomplete="off" placeholder="Say something to Robert..." style="width:70%" />
      <button type="submit">Send</button>
    </form>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);
    let sessionId = localStorage.getItem("guidemate_session_id");
    let userName = localStorage.getItem("guidemate_name") || "";

    function showChat() { $("intake").hidden = true; $("chat").hidden = false; }
    function add(role, text) {
      const p = document.createElement("p");
      p.textContent = role + ": " + text;
      $("messages").appendChild(p);
      $("messages").scrollTop = $("messages").scrollHeight;
    }

    if (sessionId) { showChat(); startPolling(); }

    $("start").addEventListener("click", async () => {
      const name = $("name").value.trim() || "friend";
      const comfortable = $("comfortable").checked;
      const resp = await fetch("/api/session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, comfortable }),
      });
      sessionId = (await resp.json()).session_id;
      userName = name;
      localStorage.setItem("guidemate_session_id", sessionId);
      localStorage.setItem("guidemate_name", name);
      showChat();
      startPolling();
    });

    $("new-session").addEventListener("click", () => {
      localStorage.removeItem("guidemate_session_id");
      localStorage.removeItem("guidemate_name");
      location.reload();
    });

    $("request-companion").addEventListener("click", async () => {
      await fetch(`/api/session/${sessionId}/request-companion`, { method: "POST" });
      $("companion-status").textContent = "Request pending admin approval…";
    });

    $("chat-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = $("message").value.trim();
      if (!text) return;
      add("You", text);
      $("message").value = "";
      try {
        const resp = await fetch("/api/chat", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, message: text }),
        });
        const data = await resp.json();
        let line = data.reply_text || "(no reply)";
        if (data.emote) {
          $("emote-label").textContent = "[emote: " + data.emote + "]";
          $("avatar").classList.remove("wiggle");
          void $("avatar").offsetWidth;      // restart the animation
          $("avatar").classList.add("wiggle");
        }
        if (data.robot && data.robot.length) {
          const last = data.robot[data.robot.length - 1];
          line += "  [physical ack: " + last.state +
                  (last.simulated ? " (simulated)" : "") + "]";
        } else if (data.emote) {
          line += "  [virtual emote]";
        }
        add("Robert", line);
      } catch (err) {
        add("Robert", "(error: " + err + ")");
      }
    });

    function startPolling() {
      async function poll() {
        if (!sessionId) return;
        try {
          const s = await (await fetch(`/api/session/${sessionId}/state`)).json();
          const banner = $("companion-status");
          if (s.robot_id) {
            banner.textContent = "Connected to " + s.robot_id + " 🐕 (physical)";
          } else if (s.request_status === "pending") {
            banner.textContent = "Request pending admin approval…";
          } else if (s.request_status === "denied") {
            banner.textContent = "Request denied by admin.";
          } else if (s.request_status === "aborted") {
            banner.textContent = "Session disconnected by admin — back to virtual.";
          } else {
            banner.textContent = "Virtual dog (avatar only)";
          }
        } catch (err) { /* keep polling */ }
      }
      poll();
      setInterval(poll, 3000);
    }
  </script>
</body>
</html>
```

- [ ] **Step 2: Write the failing Playwright 3-context e2e**

`agent_service/tests/integration/test_companion_e2e.py`:
```python
import os
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

pytestmark = pytest.mark.integration

ADMIN_PASSWORD = "letmein"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait_healthz(base: str, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base + "/healthz", timeout=2) as r:
                if r.status == 200:
                    return
        except Exception:  # noqa: BLE001
            time.sleep(0.5)
    raise RuntimeError("service did not become healthy")


@pytest.fixture
def service():
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    env = dict(os.environ)
    env.update({
        "GUIDEMATE_FAKE_ROBOT": "1",
        "GUIDEMATE_ADMIN_PASSWORD": ADMIN_PASSWORD,
        "GUIDEMATE_ROBOTS": "turtlebot468",
    })
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "guidemate_agent.app:app",
         "--app-dir", "agent_service", "--port", str(port)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        _wait_healthz(base)
        yield base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def _intake(page, base, name, comfortable):
    page.goto(base + "/")
    page.fill("#name", name)
    if comfortable:
        page.check("#comfortable")
    page.click("#start")
    page.wait_for_selector("#chat:not([hidden])")


def _send(page, text):
    page.fill("#message", text)
    page.click("#chat-form button[type=submit]")


def _session_id(page):
    return page.evaluate("() => localStorage.getItem('guidemate_session_id')")


def test_companion_flow_exclusivity_reassign_abort_and_dock_refusal(service, browser):
    base = service
    ctx_a = browser.new_context()
    ctx_b = browser.new_context()
    admin = browser.new_context()
    page_a, page_b = ctx_a.new_page(), ctx_b.new_page()

    # Admin logs in (the cookie rides admin.request thereafter). Playwright
    # serializes a dict `data=` as JSON with application/json; if Phase 3's login
    # expects a form, switch to form={...} here and in test_admin.py.
    login = admin.request.post(base + "/admin/api/login",
                               data={"password": ADMIN_PASSWORD})
    assert login.ok, "align with Phase 3 admin login route/body"

    # A + B take intake and chat (both virtual to start).
    _intake(page_a, base, "Ada", True)
    _intake(page_b, base, "Bo", False)
    sid_a, sid_b = _session_id(page_a), _session_id(page_b)

    _send(page_a, "do a happy wiggle")
    page_a.wait_for_selector("text=virtual emote")

    # A requests the physical companion.
    page_a.click("#request-companion")

    # Admin approves A's request (dict data -> JSON body).
    reqs = admin.request.get(base + "/admin/api/requests").json()
    rid = next(r["request_id"] for r in reqs if r["session_id"] == sid_a)
    admin.request.post(base + f"/admin/api/requests/{rid}/approve",
                       data={"robot_id": "turtlebot468"})

    # A now drives the physical robot: acks visible.
    page_a.wait_for_selector("text=Connected to turtlebot468", timeout=8000)
    _send(page_a, "wiggle again")
    page_a.wait_for_selector("text=physical ack", timeout=8000)

    # B stays virtual.
    _send(page_b, "you too?")
    page_b.wait_for_selector("text=virtual emote")

    # Admin reassigns the robot to B.
    admin.request.post(base + "/admin/api/robot/turtlebot468/reassign",
                       data={"session_id": sid_b})

    # A's UI shows aborted within ~6 s (2 polls).
    page_a.wait_for_selector("text=disconnected by admin", timeout=6500)

    # Admin dock command is refused.
    out = admin.request.post(base + "/admin/api/robot/turtlebot468/command",
                             data={"type": "dock", "name": "dock"}).json()
    assert out["refused"] is True

    for c in (ctx_a, ctx_b, admin):
        c.close()
```

- [ ] **Step 3: Run the e2e to verify it fails first (page not yet wired / route mismatch)**

Run: `cd ~/cs7980-guide-mate && GUIDEMATE_INTEGRATION=1 .venv/bin/python -m pytest agent_service/tests/integration/test_companion_e2e.py -q`
Expected: FAIL initially if the chat page or admin login route isn't wired — that's the red bar. Reconcile the admin login `data=`/route with Phase 3 (JSON vs form) until the `login.ok` assertion passes, then iterate to green.

- [ ] **Step 4: Run the e2e to verify it passes (Phase 4 exit test)**

Prereq: the four DynamoDB tables exist (Phase 3 `scripts/create_dynamo_tables.py`) and `sessions.CONFIG_PK` matches `guidemate-config`'s partition-key attribute name.
Run: `cd ~/cs7980-guide-mate && GUIDEMATE_INTEGRATION=1 .venv/bin/python -m pytest agent_service/tests/integration/test_companion_e2e.py -q`
Expected: PASS (1 passed). This proves lock exclusivity (A physical while B virtual), reassign→abort surfacing on A's UI within 6 s, and the dock refusal — the Phase 4 exit criteria.

- [ ] **Step 5: Run the full default suite (gated tests skipped)**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service -q`
Expected: all unit tests green; the `live` and `integration` tests skipped by default.

- [ ] **Step 6: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/static/index.html agent_service/tests/integration/test_companion_e2e.py
git commit -m "Kalhar: chat UI intake/request/virtual-emote + Playwright 3-context companion e2e"
```

---

## Phase 4 exit checklist (verify before declaring done)

- [ ] `sessions.py` unit tests green offline via moto: `.venv/bin/python -m pytest agent_service/tests/test_sessions.py agent_service/tests/test_locks.py agent_service/tests/test_orchestration.py -q`.
- [ ] `DogAgent` gates physical vs virtual emotes and offers robot tools only when locked: `.venv/bin/python -m pytest agent_service/tests/test_dog_agent.py -q`.
- [ ] Session + companion API and admin endpoints green: `.venv/bin/python -m pytest agent_service/tests/test_app.py agent_service/tests/test_admin.py -q`.
- [ ] Playwright 3-context e2e passes with `GUIDEMATE_FAKE_ROBOT=1` + real DynamoDB: A drives the robot (dry-run acks) while B stays virtual; admin reassign shows "disconnected by admin" on A within 6 s; admin dock command is refused.
- [ ] `sessions.CONFIG_PK` verified against `aws dynamodb describe-table --table-name guidemate-config`.
- [ ] Robot 468 untouched; no shadow writes; no real `cmd_vel`; dock exercised through refusal only.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-05-dog-agent-phase-4.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
