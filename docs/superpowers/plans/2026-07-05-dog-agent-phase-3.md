# Dog Agent POC — Phase 3 (Knowledge + Admin Base) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the admin/knowledge base of the "Robert" dog agent: a DynamoDB config store (feature flags + admin-set system prompt), per-turn flag gating in `DogAgent` (a disabled tool disappears from the model's tool list mid-session), a Bedrock Knowledge-Base `retrieve_kb` tool, an admin API + password/cookie auth, an admin web UI (Flags / Prompt / Robot / Knowledge tabs, incl. a shadow-writing kill switch), and a Playwright e2e that logs in and toggles a flag.

**Architecture:** Extends the existing `agent_service/guidemate_agent/` package (which already has `app.py`, `dog_agent.py`, `config.py`, `mqtt_link.py` working from Phase 0–2). Phase 3 adds four new modules — `store.py` (DynamoDB `guidemate-config`), `kb.py` (KB retrieval helper + admin doc manager), `admin.py` (FastAPI `APIRouter` under `/api/admin` with cookie auth), and `fakes.py` (an in-memory robot registry for tests) — plus a `static/admin/` UI and one idempotent AWS bootstrap script. `DogAgent.chat()` reads flags fresh from the store every turn (a fresh Strands `Agent` is already built per call) and selects tools + system prompt accordingly. The kill switch is the only Phase-3 code that writes a Device Shadow, and it may only ever write the *stricter* `dry_run=true` / `motion_enabled=false`.

**Tech Stack:** Python 3.10, FastAPI + uvicorn, boto3 (DynamoDB `resource`, `s3`, `bedrock-agent`, `bedrock-agent-runtime`, `iot-data`), itsdangerous (signed cookie), python-multipart (upload), strands-agents (Bedrock `us.anthropic.claude-sonnet-4-6`), pytest, Playwright (chromium, headless) via pytest-playwright.

## Global Constraints

Every task's requirements implicitly include this section. The first block is copied verbatim from the Phase 0–1 plan; the second block is the Phase-3 additions.

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

**Phase-3 additions to the Global Constraints:**

- **DynamoDB tables** (`guidemate-sessions`, `guidemate-messages`, `guidemate-requests`, `guidemate-config`) are **on-demand** (`BillingMode=PAY_PER_REQUEST`), **tagged `project=guidemate-poc`**, created by the idempotent `scripts/create_dynamo_tables.py`, and **documented in `docs/agent-poc/access-ground-truth.md`** (a Task-1 step). Phase 3 reads/writes **only `guidemate-config`**; the other three are created now, used in Phase 4.
- **Admin session cookie flags are exactly** `HttpOnly`, `Secure`, `SameSite=Strict`, 12 h max age. (`http://localhost` / `127.0.0.1` is a *secure context* in Chromium, so `Secure` cookies still flow in the Playwright e2e — do **not** weaken the flag for tests. FastAPI `TestClient` unit tests instead inject a pre-signed cookie via a raw `Cookie:` header, which bypasses httpx's `Secure` jar filter.)
- **Kill switch is one-way-to-safe:** the `/api/admin/kill-switch` endpoint may only ever write `dry_run=true` and/or `motion_enabled=false` to a Device Shadow's `desired` state. It must **never** write `motion_enabled=true` or `dry_run=false` — there is no code path that does, and a test asserts the invariant.
- **`GUIDEMATE_ADMIN_PASSWORD` absent ⇒ every admin route returns 503** (admin is disabled, not open). Timing-safe compare (`hmac.compare_digest`) + a 5-failures-per-minute in-process rate limit → 429.
- **New runtime deps:** `itsdangerous`, `python-multipart`. **New dev deps:** `playwright`, `pytest-playwright`. All added to `agent_service/pyproject.toml` in Task 1.
- **New env vars** (all have safe defaults except the admin password): `GUIDEMATE_ADMIN_PASSWORD` (required to enable admin routes), `GUIDEMATE_KB_ID` (default `A1NIQYZ0KQ`), `GUIDEMATE_KB_BUCKET` (default `guidemate-kb-docs-852373397000`), `GUIDEMATE_KB_DATA_SOURCE` (default `OT8JLH57TE`), `GUIDEMATE_THING_NAMES` (default `turtlebot468=Turtlebot-468`), `GUIDEMATE_FAKE_ROBOT` (test-only, `1` swaps in the in-memory registry), `GUIDEMATE_E2E` (test-only gate).

**Verified environment facts (do not re-derive):** AWS account `852373397000`, region `us-west-2`; creds via `credential_process` (identity `guidemate-agent-role`, AdministratorAccess); AWS CLI v2 at `~/.local/bin/aws`. Bedrock model id `us.anthropic.claude-sonnet-4-6`. Knowledge Base **`A1NIQYZ0KQ`** (`guidemate-kb`), data source **`OT8JLH57TE`** (`guidemate-kb-docs`), docs bucket **`s3://guidemate-kb-docs-852373397000`** — all verified end-to-end (upload → ingest → retrieve). IoT thing **`Turtlebot-468`**, classic Device Shadow already initialized; the data endpoint is discovered at runtime and passed to the service as `GUIDEMATE_IOT_ENDPOINT`. The existing `agent_service/guidemate_agent/` modules (`app.py`, `dog_agent.py`, `config.py`, `mqtt_link.py`) are working — Phase 3 **extends** them, it does not rewrite them.

---

## File Structure

```
cs7980-guide-mate/
├── scripts/create_dynamo_tables.py              # NEW (Task 1) — idempotent 4-table bootstrap
├── pytest.ini                                    # MODIFY (Task 1) — register `e2e` marker
├── conftest.py                                   # MODIFY (Task 1) — env-gate the `e2e` marker
├── agent_service/
│   ├── pyproject.toml                            # MODIFY (Task 1) — add itsdangerous, python-multipart, playwright, pytest-playwright
│   ├── guidemate_agent/
│   │   ├── store.py                              # NEW (Task 1) — ConfigStore (guidemate-config) + DEFAULT_FLAGS
│   │   ├── dog_agent.py                          # MODIFY (Task 2, Task 3) — flag gating, persona/mute, retrieve_kb tool
│   │   ├── config.py                             # MODIFY (Task 5) — kb + thing-name fields
│   │   ├── kb.py                                 # NEW (Task 3, Task 4) — retrieve_passages() + KBManager
│   │   ├── admin.py                              # NEW (Task 5) — APIRouter /api/admin + cookie auth
│   │   ├── fakes.py                              # NEW (Task 6) — FakeRobotRegistry (GUIDEMATE_FAKE_ROBOT)
│   │   └── app.py                                # MODIFY (Task 6) — wire store/kb/admin router/fake robot/static mount
│   ├── static/admin/
│   │   ├── index.html                            # NEW (Task 6)
│   │   ├── admin.js                              # NEW (Task 6)
│   │   └── admin.css                             # NEW (Task 6)
│   └── tests/
│       ├── test_store.py                         # NEW (Task 1)
│       ├── test_dog_agent_flags.py              # NEW (Task 2)
│       ├── test_kb.py                            # NEW (Task 3, Task 4)
│       ├── test_admin.py                         # NEW (Task 5) — unit (TestClient, injected cookie)
│       └── e2e/
│           ├── __init__.py                       # NEW (Task 7)
│           └── test_admin.py                     # NEW (Task 7) — Playwright, gated GUIDEMATE_E2E=1
└── docs/agent-poc/access-ground-truth.md         # MODIFY (Task 1) — document the 4 DynamoDB tables
```

---

## Task 1: DynamoDB `ConfigStore` + idempotent 4-table bootstrap

**Files:**
- Create: `agent_service/guidemate_agent/store.py`, `scripts/create_dynamo_tables.py`
- Test: `agent_service/tests/test_store.py`
- Modify: `agent_service/pyproject.toml`, `pytest.ini`, `conftest.py`, `docs/agent-poc/access-ground-truth.md`

**Interfaces:**
- Consumes: nothing from earlier Phase-3 tasks (boto3 only).
- Produces:
  - `DEFAULT_FLAGS: dict[str, bool]` = `{"dog_muted": False, "emotes_enabled": True, "motion_tools_enabled": True, "persona_enabled": True, "kb_enabled": True}` — the canonical flag set (all permissive except `dog_muted`). Imported by `dog_agent.py` (Task 2) and `admin.py` (Task 5).
  - `class ConfigStore(table=None, table_name="guidemate-config", ttl_s=5.0, region=None)`. `get_flags() -> dict[str, bool]` (defaults merged with the stored `pk="flags"` item, 5 s TTL cache). `set_flag(name: str, value: bool) -> None` (raises `ValueError` for a name not in `DEFAULT_FLAGS`; whole-item write; invalidates cache). `get_prompt() -> Optional[str]` (the `pk="prompt"` item's `system_prompt`, or `None`). `set_prompt(value: Optional[str]) -> None` (empty/`None` clears). `table` is injectable for tests (any object with `get_item(Key=...)` / `put_item(Item=...)`).
  - `scripts/create_dynamo_tables.py`: `table_specs() -> list[dict]` (the 4 key schemas) and `main()` (idempotent create, `PAY_PER_REQUEST`, tag `project=guidemate-poc`).

- [ ] **Step 1: Add the new dependencies to `agent_service/pyproject.toml`**

Edit `agent_service/pyproject.toml` — replace the `dependencies = [...]` list and append an `[project.optional-dependencies]` table:
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
    "itsdangerous",
    "python-multipart",
    "guidemate-msgs",
]

[project.optional-dependencies]
dev = [
    "pytest",
    "httpx",
    "playwright",
    "pytest-playwright",
]

[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["."]
include = ["guidemate_agent*"]
```

- [ ] **Step 2: Install the new deps into the dev venv**

Run:
```bash
cd ~/cs7980-guide-mate
.venv/bin/pip install -e "agent_service[dev]"
.venv/bin/playwright install chromium
```
Expected: `itsdangerous`, `python-multipart`, `playwright`, `pytest-playwright` install; `playwright install chromium` downloads the headless browser. (Chromium download is one-time; it needs outbound network.)

- [ ] **Step 3: Register the `e2e` marker (used in Task 7) so pytest doesn't warn**

Edit `pytest.ini` — add the `e2e` marker under the existing `markers:` block (keep `integration` and `live`):
```ini
[pytest]
testpaths =
    shared/guidemate_msgs/tests
    agent_service/tests
    src/guide_mate_bridge/tests
markers =
    integration: real AWS IoT Core round-trip (set GUIDEMATE_INTEGRATION=1 to run)
    live: real Bedrock model call (set GUIDEMATE_LIVE=1 to run)
    e2e: Playwright browser e2e against a live uvicorn (set GUIDEMATE_E2E=1 to run)
```

Edit `conftest.py` — extend the existing `pytest_collection_modifyitems` to also gate `e2e`:
```python
import os
import pytest


def pytest_collection_modifyitems(config, items):
    run_integration = os.environ.get("GUIDEMATE_INTEGRATION") == "1"
    run_live = os.environ.get("GUIDEMATE_LIVE") == "1"
    run_e2e = os.environ.get("GUIDEMATE_E2E") == "1"
    skip_integration = pytest.mark.skip(reason="set GUIDEMATE_INTEGRATION=1 to run")
    skip_live = pytest.mark.skip(reason="set GUIDEMATE_LIVE=1 to run")
    skip_e2e = pytest.mark.skip(reason="set GUIDEMATE_E2E=1 to run")
    for item in items:
        if "integration" in item.keywords and not run_integration:
            item.add_marker(skip_integration)
        if "live" in item.keywords and not run_live:
            item.add_marker(skip_live)
        if "e2e" in item.keywords and not run_e2e:
            item.add_marker(skip_e2e)
```

- [ ] **Step 4: Write the failing tests**

`agent_service/tests/test_store.py`:
```python
import pytest

from guidemate_agent.store import DEFAULT_FLAGS, ConfigStore
from scripts_create_dynamo_tables import table_specs


class FakeTable:
    """In-memory stand-in for a boto3 DynamoDB Table (pk-keyed)."""

    def __init__(self):
        self.items = {}

    def get_item(self, Key):
        item = self.items.get(Key["pk"])
        return {"Item": item} if item is not None else {}

    def put_item(self, Item):
        self.items[Item["pk"]] = dict(Item)


def test_default_flags_shape():
    assert DEFAULT_FLAGS == {
        "dog_muted": False,
        "emotes_enabled": True,
        "motion_tools_enabled": True,
        "persona_enabled": True,
        "kb_enabled": True,
    }


def test_get_flags_returns_defaults_when_empty():
    store = ConfigStore(table=FakeTable(), ttl_s=0.0)
    flags = store.get_flags()
    assert flags["dog_muted"] is False
    assert flags["emotes_enabled"] is True
    assert flags["kb_enabled"] is True


def test_set_flag_round_trips():
    store = ConfigStore(table=FakeTable(), ttl_s=0.0)
    store.set_flag("dog_muted", True)
    assert store.get_flags()["dog_muted"] is True
    # other flags keep their defaults
    assert store.get_flags()["emotes_enabled"] is True


def test_unknown_flag_rejected():
    store = ConfigStore(table=FakeTable(), ttl_s=0.0)
    with pytest.raises(ValueError):
        store.set_flag("does_not_exist", True)


def test_prompt_round_trips_and_clears():
    store = ConfigStore(table=FakeTable(), ttl_s=0.0)
    assert store.get_prompt() is None
    store.set_prompt("be terse")
    assert store.get_prompt() == "be terse"
    store.set_prompt(None)
    assert store.get_prompt() is None
    store.set_prompt("  ")  # blank clears too
    assert store.get_prompt() is None


def test_ttl_cache_hides_external_writes_until_invalidated():
    table = FakeTable()
    store = ConfigStore(table=table, ttl_s=100.0)
    assert store.get_flags()["dog_muted"] is False  # caches the empty read
    table.put_item(Item={"pk": "flags", "dog_muted": True})  # out-of-band write
    assert store.get_flags()["dog_muted"] is False  # still serving the cache
    store._invalidate("flags")
    assert store.get_flags()["dog_muted"] is True


def test_table_specs_cover_all_four_on_demand_tables():
    specs = table_specs()
    names = {s["TableName"] for s in specs}
    assert names == {
        "guidemate-sessions",
        "guidemate-messages",
        "guidemate-requests",
        "guidemate-config",
    }


def test_config_table_partition_key_is_pk():
    spec = next(s for s in table_specs() if s["TableName"] == "guidemate-config")
    assert spec["KeySchema"][0]["AttributeName"] == "pk"
```

Add a tiny import shim so the test can import the script without packaging it — `agent_service/tests/conftest.py`:
```python
import importlib.util
import sys
from pathlib import Path

# Make scripts/create_dynamo_tables.py importable as `scripts_create_dynamo_tables`.
_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "create_dynamo_tables.py"
_spec = importlib.util.spec_from_file_location("scripts_create_dynamo_tables", _SCRIPT)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["scripts_create_dynamo_tables"] = _mod
_spec.loader.exec_module(_mod)
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_store.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_agent.store'` (and the script shim can't find the file yet).

- [ ] **Step 6: Implement `store.py`**

`agent_service/guidemate_agent/store.py`:
```python
"""DynamoDB-backed config store for the dog agent (guidemate-config table).

Phase 3 uses ONLY guidemate-config, holding two items:
  {pk: "flags", <flag booleans>}   — agent-tier feature flags
  {pk: "prompt", system_prompt: str}  — admin-set system prompt (absent => built-in persona)
A short in-process TTL cache keeps per-turn flag reads from hammering DynamoDB.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Optional

import boto3

# Canonical flag set. All permissive except dog_muted. Single source of truth
# for the agent (tool/persona gating) and the admin API (validation).
DEFAULT_FLAGS = {
    "dog_muted": False,
    "emotes_enabled": True,
    "motion_tools_enabled": True,
    "persona_enabled": True,
    "kb_enabled": True,
}


class ConfigStore:
    def __init__(
        self,
        table=None,
        table_name: str = "guidemate-config",
        ttl_s: float = 5.0,
        region: Optional[str] = None,
    ) -> None:
        if table is None:
            region = region or os.environ.get("AWS_REGION", "us-west-2")
            table = boto3.resource("dynamodb", region_name=region).Table(table_name)
        self._table = table
        self._ttl_s = ttl_s
        self._cache: dict[str, tuple[float, Optional[dict]]] = {}
        self._lock = threading.Lock()

    # --- low-level item access -------------------------------------------
    def _read_item(self, pk: str) -> Optional[dict]:
        resp = self._table.get_item(Key={"pk": pk})
        return resp.get("Item")

    def _get_cached(self, pk: str) -> Optional[dict]:
        now = time.monotonic()
        with self._lock:
            entry = self._cache.get(pk)
            if entry is not None and entry[0] > now:
                return entry[1]
        item = self._read_item(pk)
        with self._lock:
            self._cache[pk] = (now + self._ttl_s, item)
        return item

    def _invalidate(self, pk: str) -> None:
        with self._lock:
            self._cache.pop(pk, None)

    # --- flags ------------------------------------------------------------
    def get_flags(self) -> dict:
        item = self._get_cached("flags") or {}
        flags = dict(DEFAULT_FLAGS)
        for key in DEFAULT_FLAGS:
            if key in item and isinstance(item[key], bool):
                flags[key] = item[key]
        return flags

    def set_flag(self, name: str, value: bool) -> None:
        if name not in DEFAULT_FLAGS:
            raise ValueError(f"unknown flag {name!r}; valid flags: {sorted(DEFAULT_FLAGS)}")
        item = self._read_item("flags") or {}
        item["pk"] = "flags"
        item[name] = bool(value)
        self._table.put_item(Item=item)
        self._invalidate("flags")

    # --- admin-set prompt -------------------------------------------------
    def get_prompt(self) -> Optional[str]:
        item = self._get_cached("prompt") or {}
        value = item.get("system_prompt")
        return value if value else None

    def set_prompt(self, value: Optional[str]) -> None:
        item = {"pk": "prompt"}
        if value and value.strip():
            item["system_prompt"] = value
        self._table.put_item(Item=item)
        self._invalidate("prompt")
```

- [ ] **Step 7: Implement `scripts/create_dynamo_tables.py`**

`scripts/create_dynamo_tables.py`:
```python
#!/usr/bin/env python3
"""Idempotently create the 4 on-demand DynamoDB tables for the dog agent POC.

Tables (all PAY_PER_REQUEST, tagged project=guidemate-poc):
  guidemate-sessions   pk: session_id
  guidemate-messages   pk: session_id, sk: ts
  guidemate-requests   pk: request_id
  guidemate-config     pk: pk           (flags + admin-set prompt; used from Phase 3)

Re-running is safe: an already-existing table is left untouched.
Run: python3 scripts/create_dynamo_tables.py
"""
from __future__ import annotations

import os

import boto3
from botocore.exceptions import ClientError

TAGS = [{"Key": "project", "Value": "guidemate-poc"}]


def table_specs() -> list:
    return [
        {
            "TableName": "guidemate-sessions",
            "KeySchema": [{"AttributeName": "session_id", "KeyType": "HASH"}],
            "AttributeDefinitions": [
                {"AttributeName": "session_id", "AttributeType": "S"}
            ],
        },
        {
            "TableName": "guidemate-messages",
            "KeySchema": [
                {"AttributeName": "session_id", "KeyType": "HASH"},
                {"AttributeName": "ts", "KeyType": "RANGE"},
            ],
            "AttributeDefinitions": [
                {"AttributeName": "session_id", "AttributeType": "S"},
                {"AttributeName": "ts", "AttributeType": "S"},
            ],
        },
        {
            "TableName": "guidemate-requests",
            "KeySchema": [{"AttributeName": "request_id", "KeyType": "HASH"}],
            "AttributeDefinitions": [
                {"AttributeName": "request_id", "AttributeType": "S"}
            ],
        },
        {
            "TableName": "guidemate-config",
            "KeySchema": [{"AttributeName": "pk", "KeyType": "HASH"}],
            "AttributeDefinitions": [{"AttributeName": "pk", "AttributeType": "S"}],
        },
    ]


def main() -> None:
    region = os.environ.get("AWS_REGION", "us-west-2")
    client = boto3.client("dynamodb", region_name=region)
    existing = set(client.list_tables().get("TableNames", []))
    for spec in table_specs():
        name = spec["TableName"]
        if name in existing:
            print(f"exists, skipping: {name}")
            continue
        try:
            client.create_table(
                BillingMode="PAY_PER_REQUEST",
                Tags=TAGS,
                **spec,
            )
            print(f"created: {name} (PAY_PER_REQUEST, tagged guidemate-poc)")
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ResourceInUseException":
                print(f"race, already exists: {name}")
            else:
                raise


if __name__ == "__main__":
    main()
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_store.py -q`
Expected: PASS (8 passed).

- [ ] **Step 9: Create the tables in AWS and document them**

Run:
```bash
cd ~/cs7980-guide-mate && .venv/bin/python scripts/create_dynamo_tables.py
.venv/bin/aws dynamodb list-tables --region us-west-2 --output text
```
Expected: four `created:` (or `exists, skipping:`) lines; the list includes `guidemate-config`, `guidemate-messages`, `guidemate-requests`, `guidemate-sessions`.

Then append a row-block to `docs/agent-poc/access-ground-truth.md` under the AWS-resource inventory (match the surrounding table style):
```markdown
| DynamoDB tables | `guidemate-sessions`, `guidemate-messages`, `guidemate-requests`, `guidemate-config` | on-demand (`PAY_PER_REQUEST`), tag `project=guidemate-poc`, region us-west-2. Created by `scripts/create_dynamo_tables.py` (idempotent). Phase 3 uses only `guidemate-config` (`pk="flags"` feature flags + `pk="prompt"` admin-set system prompt); the other three are Phase 4 (sessions / chat history / companion requests). |
```

- [ ] **Step 10: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/pyproject.toml pytest.ini conftest.py \
  agent_service/guidemate_agent/store.py scripts/create_dynamo_tables.py \
  agent_service/tests/conftest.py agent_service/tests/test_store.py \
  docs/agent-poc/access-ground-truth.md
git commit -m "Kalhar: DynamoDB ConfigStore + on-demand table bootstrap (flags/prompt)"
```

---

## Task 2: Per-turn flag gating + persona/mute in `DogAgent`

**Files:**
- Modify: `agent_service/guidemate_agent/dog_agent.py`
- Test: `agent_service/tests/test_dog_agent_flags.py`

**Interfaces:**
- Consumes: `DEFAULT_FLAGS` (Task 1); the existing `DogAgent`, `PERSONA`, `Command`, `_emote_impl` (already in `dog_agent.py`).
- Produces (added to `DogAgent`):
  - `PERSONA_BASE`, `EMOTE_INSTRUCTION`, `KB_INSTRUCTION`, `NEUTRAL_PROMPT: str` module constants. `PERSONA` is kept (now defined as `PERSONA_BASE + " " + EMOTE_INSTRUCTION`) so the Phase-0 tests still pass.
  - `DogAgent.__init__(..., store=None)` — a new keyword arg (defaults `None` ⇒ `DEFAULT_FLAGS`, no persona override). Also a `self._motion_available = False` attribute — the documented Phase-2-cloud integration point (flip to `True` and add `run_motion`/`stop` closures when those tools land).
  - `DogAgent._enabled_tool_names(flags: dict) -> list[str]` — the ordered names of tools offered to the model this turn.
  - `DogAgent._system_prompt(flags: dict) -> str` — admin prompt (if set) or persona/neutral base, with emote + KB instructions appended programmatically per flags.
  - `DogAgent.chat(...)` now: reads `flags` fresh each turn; if `dog_muted` returns `{"reply_text": "(the dog is sleeping)", "emote": None, "robot": [], "turn_id": ...}` **without calling Bedrock**; otherwise builds only the enabled tools and the flag-derived system prompt.

- [ ] **Step 1: Write the failing tests**

`agent_service/tests/test_dog_agent_flags.py`:
```python
from guidemate_agent.dog_agent import (
    DogAgent,
    EMOTE_INSTRUCTION,
    NEUTRAL_PROMPT,
    PERSONA_BASE,
)
from guidemate_agent.store import DEFAULT_FLAGS


class FakeRegistry:
    def send_command(self, robot_id, cmd, timeout_s=5.0):
        return []


class FakeStore:
    def __init__(self, flags=None, prompt=None):
        self._flags = dict(DEFAULT_FLAGS)
        if flags:
            self._flags.update(flags)
        self._prompt = prompt

    def get_flags(self):
        return dict(self._flags)

    def get_prompt(self):
        return self._prompt


def _agent(flags=None, prompt=None):
    return DogAgent(
        registry=FakeRegistry(),
        model_id="us.anthropic.claude-sonnet-4-6",
        robot_ids=["turtlebot468"],
        store=FakeStore(flags, prompt),
    )


def test_all_permissive_flags_offer_emote_and_kb():
    names = _agent()._enabled_tool_names(dict(DEFAULT_FLAGS))
    assert "send_emote" in names
    assert "retrieve_kb" in names


def test_emotes_disabled_removes_send_emote():
    names = _agent()._enabled_tool_names({**DEFAULT_FLAGS, "emotes_enabled": False})
    assert "send_emote" not in names


def test_kb_disabled_removes_retrieve_kb():
    names = _agent()._enabled_tool_names({**DEFAULT_FLAGS, "kb_enabled": False})
    assert "retrieve_kb" not in names


def test_motion_tools_absent_until_integrated():
    # Phase-2 cloud lane not landed yet: run_motion/stop are not offered even
    # when motion_tools_enabled is True, because _motion_available is False.
    names = _agent()._enabled_tool_names(dict(DEFAULT_FLAGS))
    assert "run_motion" not in names
    assert "stop" not in names


def test_system_prompt_uses_persona_and_emote_rule_by_default():
    prompt = _agent()._system_prompt(dict(DEFAULT_FLAGS))
    assert PERSONA_BASE in prompt
    assert EMOTE_INSTRUCTION in prompt


def test_system_prompt_neutral_when_persona_disabled():
    prompt = _agent()._system_prompt({**DEFAULT_FLAGS, "persona_enabled": False})
    assert NEUTRAL_PROMPT in prompt
    assert "Robert" not in prompt


def test_system_prompt_omits_emote_rule_when_emotes_disabled():
    prompt = _agent()._system_prompt({**DEFAULT_FLAGS, "emotes_enabled": False})
    assert EMOTE_INSTRUCTION not in prompt


def test_admin_prompt_replaces_persona_base():
    prompt = _agent(prompt="You are a stern robot. Be brief.")._system_prompt(dict(DEFAULT_FLAGS))
    assert "stern robot" in prompt
    assert PERSONA_BASE not in prompt
    # emote instruction is still appended programmatically
    assert EMOTE_INSTRUCTION in prompt


def test_muted_returns_sleeping_without_bedrock():
    # No BedrockModel is constructed on the mute path, so this runs with no creds/network.
    result = _agent({"dog_muted": True}).chat("hello")
    assert result == {
        "reply_text": "(the dog is sleeping)",
        "emote": None,
        "robot": [],
        "turn_id": result["turn_id"],
    }
    assert result["turn_id"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_dog_agent_flags.py -q`
Expected: FAIL — `ImportError: cannot import name 'PERSONA_BASE'` (and `_enabled_tool_names` missing).

- [ ] **Step 3: Rewrite `dog_agent.py` with flag gating (keeps `_emote_impl` and `PERSONA`)**

Replace the whole file `agent_service/guidemate_agent/dog_agent.py`:
```python
"""Robert the robot dog — Strands agent with per-turn flag gating.

Flags are read fresh from the ConfigStore every turn (a fresh Strands Agent is
already built per chat() call), so an admin flag flip takes effect on the very
next message: a disabled tool disappears from the model's tool list, and the
system prompt swaps persona / mutes emotes accordingly.
"""
from __future__ import annotations

import logging
import os
import uuid
from typing import Optional

from strands import Agent, tool
from strands.models import BedrockModel

from guidemate_msgs.messages import Command

from guidemate_agent.kb import retrieve_passages
from guidemate_agent.store import DEFAULT_FLAGS

log = logging.getLogger(__name__)

PERSONA_BASE = (
    "You are Robert, the friendly robot dog of the CS7980 guide-mate project. "
    "You are playful and warm and speak in short, dog-like replies."
)
EMOTE_INSTRUCTION = (
    "You MUST call the send_emote tool exactly once per reply, with one of "
    "'happy', 'yes', or 'no' — pick the emote that matches your reply's mood."
)
KB_INSTRUCTION = (
    "For factual questions about the project or about yourself, call the "
    "retrieve_kb tool and ground your answer in what it returns."
)
NEUTRAL_PROMPT = (
    "You are a helpful assistant for the CS7980 guide-mate project. "
    "Answer clearly and concisely."
)
# Kept for backward compatibility with the Phase-0 tests (they assert "Robert"
# and "send_emote" are present in PERSONA).
PERSONA = PERSONA_BASE + " " + EMOTE_INSTRUCTION


class DogAgent:
    def __init__(
        self,
        registry,
        model_id: str,
        robot_ids: list[str],
        region: str = "us-west-2",
        store=None,
        kb_id: Optional[str] = None,
    ) -> None:
        self._registry = registry
        self._model_id = model_id
        self._robot_ids = robot_ids
        self._region = region
        self._store = store
        self._kb_id = kb_id or os.environ.get("GUIDEMATE_KB_ID", "A1NIQYZ0KQ")
        # Phase-2 cloud-lane integration point: when run_motion/stop tools land,
        # implement their closures in _build_tools and flip this to True.
        self._motion_available = False

    # --- flag helpers -----------------------------------------------------
    def _flags(self) -> dict:
        return self._store.get_flags() if self._store is not None else dict(DEFAULT_FLAGS)

    def _enabled_tool_names(self, flags: dict) -> list:
        names: list = []
        if flags.get("emotes_enabled", True):
            names.append("send_emote")
        if flags.get("kb_enabled", True):
            names.append("retrieve_kb")
        if flags.get("motion_tools_enabled", True) and self._motion_available:
            names.extend(["run_motion", "stop"])
        return names

    def _system_prompt(self, flags: dict) -> str:
        admin_prompt = self._store.get_prompt() if self._store is not None else None
        if admin_prompt:
            base = admin_prompt
        elif flags.get("persona_enabled", True):
            base = PERSONA_BASE
        else:
            base = NEUTRAL_PROMPT
        parts = [base]
        if flags.get("emotes_enabled", True):
            parts.append(EMOTE_INSTRUCTION)
        if flags.get("kb_enabled", True):
            parts.append(KB_INSTRUCTION)
        return " ".join(parts)

    def _emote_impl(self, name: str, target: Optional[str], captured: dict) -> str:
        """Body of the send_emote tool, factored out so it's testable without Strands."""
        captured["emote"] = name
        if target is None:
            return "robot did not respond — I'm probably napping offline"
        acks = self._registry.send_command(target, Command(type="emote", name=name))
        captured["acks"] = [a.model_dump() for a in acks]
        if not acks:
            return "robot did not respond — I'm probably napping offline"
        return "emote delivered (simulated)"

    def _build_tools(self, names: list, target: Optional[str], captured: dict) -> list:
        tools: list = []
        if "send_emote" in names:

            @tool
            def send_emote(name: str) -> str:
                """Play a physical emote on the dog. name is one of happy, yes, no."""
                return self._emote_impl(name, target, captured)

            tools.append(send_emote)
        if "retrieve_kb" in names:

            @tool
            def retrieve_kb(query: str) -> str:
                """Search Robert's knowledge base for facts about the project or Robert."""
                return retrieve_passages(query, self._kb_id, region=self._region)

            tools.append(retrieve_kb)
        return tools

    # --- main turn --------------------------------------------------------
    def chat(self, message: str, robot_id: Optional[str] = None) -> dict:
        turn_id = str(uuid.uuid4())
        flags = self._flags()
        if flags.get("dog_muted", False):
            return {
                "reply_text": "(the dog is sleeping)",
                "emote": None,
                "robot": [],
                "turn_id": turn_id,
            }
        target = robot_id or (self._robot_ids[0] if self._robot_ids else None)
        captured = {"emote": None, "acks": []}
        names = self._enabled_tool_names(flags)
        tools = self._build_tools(names, target, captured)
        system_prompt = self._system_prompt(flags)
        model = BedrockModel(model_id=self._model_id, region_name=self._region)
        agent = Agent(model=model, system_prompt=system_prompt, tools=tools)
        result = agent(message)
        return {
            "reply_text": str(result),
            "emote": captured["emote"],
            "robot": captured["acks"],
            "turn_id": turn_id,
        }
```

> NOTE: this import `from guidemate_agent.kb import retrieve_passages` requires `kb.py` — that module is created in **Task 3**. Implement Task 3 in the same session (or stub `kb.py` with the `retrieve_passages` signature first). The subagent-driven workflow runs tasks in order, so Task 2's green run happens after Task 3 lands `kb.py`. If you are running Task 2 strictly alone, create the minimal `retrieve_passages` from Task 3 Step 3 first.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_dog_agent_flags.py agent_service/tests/test_dog_agent.py agent_service/tests/test_app.py -q`
Expected: PASS. The old `test_dog_agent.py` (`_emote_impl` behaviour) and `test_app.py` (`"Robert" in PERSONA`, `"send_emote" in PERSONA`) still pass — `_emote_impl` and `PERSONA` are unchanged in meaning.

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/dog_agent.py agent_service/tests/test_dog_agent_flags.py
git commit -m "Kalhar: per-turn flag gating + persona/mute in DogAgent"
```

---

## Task 3: `retrieve_kb` tool (Bedrock KB retrieval helper)

**Files:**
- Create: `agent_service/guidemate_agent/kb.py`
- Test: `agent_service/tests/test_kb.py`

**Interfaces:**
- Consumes: nothing from earlier Phase-3 tasks (boto3 only). Used by `DogAgent._build_tools` (Task 2).
- Produces: `retrieve_passages(query: str, kb_id: str, region: str = "us-west-2", top_k: int = 4, client=None) -> str`. Calls `bedrock-agent-runtime.retrieve` for the top `top_k` results and returns the passages concatenated as `"[<source-uri>] <text>"` blocks joined by blank lines. On **any** exception returns the literal `"knowledge base unavailable"` (so the agent answers without it); on an empty result set returns `"no relevant knowledge found"`. `client` is injectable for tests.

- [ ] **Step 1: Write the failing tests**

`agent_service/tests/test_kb.py`:
```python
from guidemate_agent.kb import retrieve_passages


class FakeKBRuntime:
    def __init__(self, results=None, boom=False):
        self._results = results or []
        self._boom = boom
        self.calls = []

    def retrieve(self, **kwargs):
        self.calls.append(kwargs)
        if self._boom:
            raise RuntimeError("bedrock exploded")
        return {"retrievalResults": self._results}


def _result(text, uri):
    return {"content": {"text": text}, "location": {"s3Location": {"uri": uri}}}


def test_retrieve_concatenates_passages_with_sources():
    client = FakeKBRuntime(
        results=[
            _result("Robert is a TurtleBot 4.", "s3://guidemate-kb-docs/robert.md"),
            _result("Robert maps indoor spaces.", "s3://guidemate-kb-docs/robert.md"),
        ]
    )
    out = retrieve_passages("who is robert", "A1NIQYZ0KQ", client=client)
    assert "Robert is a TurtleBot 4." in out
    assert "Robert maps indoor spaces." in out
    assert "s3://guidemate-kb-docs/robert.md" in out
    # top_k propagated into the request
    cfg = client.calls[0]["retrievalConfiguration"]["vectorSearchConfiguration"]
    assert cfg["numberOfResults"] == 4


def test_retrieve_empty_results_message():
    out = retrieve_passages("nothing", "A1NIQYZ0KQ", client=FakeKBRuntime(results=[]))
    assert out == "no relevant knowledge found"


def test_retrieve_error_is_swallowed():
    out = retrieve_passages("boom", "A1NIQYZ0KQ", client=FakeKBRuntime(boom=True))
    assert out == "knowledge base unavailable"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_kb.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_agent.kb'`.

- [ ] **Step 3: Implement `retrieve_passages` in `kb.py`**

`agent_service/guidemate_agent/kb.py`:
```python
"""Bedrock Knowledge-Base access: a retrieval helper for the agent tool, and
(Task 4) a KBManager for admin document management."""
from __future__ import annotations

import logging

import boto3

log = logging.getLogger(__name__)


def retrieve_passages(
    query: str,
    kb_id: str,
    region: str = "us-west-2",
    top_k: int = 4,
    client=None,
) -> str:
    """Top-k KB passages for `query`, concatenated with their source keys.

    Returns "knowledge base unavailable" on any error (agent answers without it)
    and "no relevant knowledge found" when the KB returns nothing.
    """
    client = client or boto3.client("bedrock-agent-runtime", region_name=region)
    try:
        resp = client.retrieve(
            knowledgeBaseId=kb_id,
            retrievalQuery={"text": query},
            retrievalConfiguration={
                "vectorSearchConfiguration": {"numberOfResults": top_k}
            },
        )
    except Exception:  # noqa: BLE001 — degrade gracefully, agent still answers
        log.exception("KB retrieve failed", extra={"kb_id": kb_id})
        return "knowledge base unavailable"
    results = resp.get("retrievalResults", [])
    if not results:
        return "no relevant knowledge found"
    blocks = []
    for item in results:
        text = item.get("content", {}).get("text", "").strip()
        src = (
            item.get("location", {})
            .get("s3Location", {})
            .get("uri", "unknown-source")
        )
        blocks.append(f"[{src}] {text}")
    return "\n\n".join(blocks)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_kb.py -q`
Expected: PASS (3 passed). Now also re-run Task 2's suite (the `dog_agent.py` import of `retrieve_passages` now resolves): `.venv/bin/python -m pytest agent_service/tests/test_dog_agent_flags.py -q` → PASS.

- [ ] **Step 5: (Optional, env-gated) live KB smoke**

`agent_service/tests/test_kb.py` — append a gated live test:
```python
import os

import pytest


@pytest.mark.live
def test_live_kb_retrieve_smoke():
    if os.environ.get("GUIDEMATE_LIVE") != "1":
        pytest.skip("set GUIDEMATE_LIVE=1")
    out = retrieve_passages("what is Robert", "A1NIQYZ0KQ")
    assert isinstance(out, str) and out
```
Run (only when you want the live check): `cd ~/cs7980-guide-mate && GUIDEMATE_LIVE=1 .venv/bin/python -m pytest agent_service/tests/test_kb.py::test_live_kb_retrieve_smoke -q` → PASS (grounded in the seed doc). Default runs skip it.

- [ ] **Step 6: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/kb.py agent_service/tests/test_kb.py
git commit -m "Kalhar: retrieve_kb Bedrock KB retrieval helper (graceful degrade)"
```

---

## Task 4: KB manager — list / upload / delete / sync (admin doc ops)

**Files:**
- Modify: `agent_service/guidemate_agent/kb.py` (append `KBManager`)
- Test: `agent_service/tests/test_kb.py` (append `KBManager` tests)

**Interfaces:**
- Consumes: nothing new (boto3 `s3` + `bedrock-agent`).
- Produces: `class KBManager(bucket, kb_id, data_source_id, region="us-west-2", s3=None, agent=None)` with:
  - `list_docs() -> list[dict]` — `{"key", "size", "modified"}` per object (S3 `list_objects_v2`).
  - `upload(key: str, data: bytes) -> None` — `put_object`.
  - `delete(key: str) -> None` — `delete_object`.
  - `start_ingestion() -> str` — `bedrock-agent.start_ingestion_job`, returns the job id.
  - `latest_job_status() -> dict` — `{"job_id", "status"}` of the most recent ingestion job, or `{"status": "NONE"}`.
  - `s3` / `agent` clients injectable for tests.

- [ ] **Step 1: Write the failing tests (append to `test_kb.py`)**

Add to `agent_service/tests/test_kb.py`:
```python
from datetime import datetime, timezone

from guidemate_agent.kb import KBManager


class FakeS3:
    def __init__(self):
        self.objects = {}

    def list_objects_v2(self, Bucket):
        if not self.objects:
            return {}
        return {
            "Contents": [
                {
                    "Key": key,
                    "Size": len(body),
                    "LastModified": datetime(2026, 7, 5, tzinfo=timezone.utc),
                }
                for key, body in self.objects.items()
            ]
        }

    def put_object(self, Bucket, Key, Body):
        self.objects[Key] = Body

    def delete_object(self, Bucket, Key):
        self.objects.pop(Key, None)


class FakeBedrockAgent:
    def __init__(self):
        self.jobs = []

    def start_ingestion_job(self, knowledgeBaseId, dataSourceId):
        job_id = f"job-{len(self.jobs) + 1}"
        self.jobs.append({"ingestionJobId": job_id, "status": "STARTING"})
        return {"ingestionJob": {"ingestionJobId": job_id, "status": "STARTING"}}

    def list_ingestion_jobs(self, knowledgeBaseId, dataSourceId, maxResults=1, sortBy=None):
        if not self.jobs:
            return {"ingestionJobSummaries": []}
        latest = self.jobs[-1]
        return {"ingestionJobSummaries": [{**latest, "status": "COMPLETE"}]}


def _manager():
    return KBManager(
        bucket="guidemate-kb-docs-852373397000",
        kb_id="A1NIQYZ0KQ",
        data_source_id="OT8JLH57TE",
        s3=FakeS3(),
        agent=FakeBedrockAgent(),
    )


def test_upload_then_list_then_delete():
    mgr = _manager()
    assert mgr.list_docs() == []
    mgr.upload("notes.md", b"hello world")
    docs = mgr.list_docs()
    assert len(docs) == 1
    assert docs[0]["key"] == "notes.md"
    assert docs[0]["size"] == 11
    assert "2026-07-05" in docs[0]["modified"]
    mgr.delete("notes.md")
    assert mgr.list_docs() == []


def test_start_ingestion_returns_job_id():
    mgr = _manager()
    job_id = mgr.start_ingestion()
    assert job_id == "job-1"


def test_latest_job_status_none_then_complete():
    mgr = _manager()
    assert mgr.latest_job_status() == {"status": "NONE"}
    mgr.start_ingestion()
    status = mgr.latest_job_status()
    assert status["job_id"] == "job-1"
    assert status["status"] == "COMPLETE"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_kb.py -q`
Expected: FAIL — `ImportError: cannot import name 'KBManager' from 'guidemate_agent.kb'`.

- [ ] **Step 3: Append `KBManager` to `kb.py`**

Append to `agent_service/guidemate_agent/kb.py`:
```python
class KBManager:
    """Admin-side KB document management: S3 docs + Bedrock ingestion jobs."""

    def __init__(
        self,
        bucket: str,
        kb_id: str,
        data_source_id: str,
        region: str = "us-west-2",
        s3=None,
        agent=None,
    ) -> None:
        self._bucket = bucket
        self._kb_id = kb_id
        self._ds = data_source_id
        self._s3 = s3 or boto3.client("s3", region_name=region)
        self._agent = agent or boto3.client("bedrock-agent", region_name=region)

    def list_docs(self) -> list:
        resp = self._s3.list_objects_v2(Bucket=self._bucket)
        out = []
        for obj in resp.get("Contents", []):
            out.append(
                {
                    "key": obj["Key"],
                    "size": obj["Size"],
                    "modified": obj["LastModified"].isoformat(),
                }
            )
        return out

    def upload(self, key: str, data: bytes) -> None:
        self._s3.put_object(Bucket=self._bucket, Key=key, Body=data)

    def delete(self, key: str) -> None:
        self._s3.delete_object(Bucket=self._bucket, Key=key)

    def start_ingestion(self) -> str:
        resp = self._agent.start_ingestion_job(
            knowledgeBaseId=self._kb_id, dataSourceId=self._ds
        )
        return resp["ingestionJob"]["ingestionJobId"]

    def latest_job_status(self) -> dict:
        resp = self._agent.list_ingestion_jobs(
            knowledgeBaseId=self._kb_id,
            dataSourceId=self._ds,
            maxResults=1,
            sortBy={"attribute": "STARTED_AT", "order": "DESCENDING"},
        )
        jobs = resp.get("ingestionJobSummaries", [])
        if not jobs:
            return {"status": "NONE"}
        job = jobs[0]
        return {"job_id": job["ingestionJobId"], "status": job["status"]}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_kb.py -q`
Expected: PASS (6 passed, plus the gated live test skipped).

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/kb.py agent_service/tests/test_kb.py
git commit -m "Kalhar: KBManager — list/upload/delete/ingest KB docs"
```

---

## Task 5: Admin API + password/cookie auth (`admin.py`) + Config fields

**Files:**
- Create: `agent_service/guidemate_agent/admin.py`
- Modify: `agent_service/guidemate_agent/config.py`
- Test: `agent_service/tests/test_admin.py`

**Interfaces:**
- Consumes: `DEFAULT_FLAGS` (Task 1); reads `request.app.state.store` (`ConfigStore`, Task 1), `request.app.state.kb` (`KBManager`, Task 4), `request.app.state.registry` (`RobotRegistry`/`FakeRobotRegistry` with `get_status`), `request.app.state.config` (extended `Config`).
- Produces:
  - `router: APIRouter` (prefix `/api/admin`). `COOKIE_NAME = "guidemate_admin"`, `TOKEN = "admin"`, `MAX_AGE = 12 * 3600`. `admin_required(request) -> bool` (FastAPI dependency: 503 if unconfigured, 401 if cookie missing/invalid/expired).
  - Endpoints: `POST /login {password}`; `GET /flags`; `PUT /flags {name, value}`; `GET /prompt`; `PUT /prompt {system_prompt}`; `GET /status`; `POST /kill-switch {robot_id}`; `GET /kb`; `POST /kb` (multipart `file`); `DELETE /kb?key=`; `POST /kb/sync`; `GET /kb/sync-status`.
  - Extended `Config`: adds `kb_id`, `kb_bucket`, `kb_data_source`, `thing_names: dict` (parsed from `GUIDEMATE_THING_NAMES`, e.g. `"turtlebot468=Turtlebot-468"`), all with the Task-1 defaults. Existing fields unchanged.

- [ ] **Step 1: Extend `Config` with KB + thing-name fields**

Replace `agent_service/guidemate_agent/config.py`:
```python
"""Simple env-based config (no pydantic dependency)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _parse_things(raw: str) -> dict:
    """Parse GUIDEMATE_THING_NAMES='robot_id=ThingName,robot2=Thing2' -> dict."""
    mapping = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair or "=" not in pair:
            continue
        robot_id, thing = pair.split("=", 1)
        mapping[robot_id.strip()] = thing.strip()
    return mapping


@dataclass
class Config:
    robot_ids: list[str]
    iot_endpoint: str
    model_id: str
    region: str
    kb_id: str = "A1NIQYZ0KQ"
    kb_bucket: str = "guidemate-kb-docs-852373397000"
    kb_data_source: str = "OT8JLH57TE"
    thing_names: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "Config":
        robots = os.environ.get("GUIDEMATE_ROBOTS", "turtlebot468")
        robot_ids = [r.strip() for r in robots.split(",") if r.strip()]
        return cls(
            robot_ids=robot_ids,
            iot_endpoint=os.environ.get("GUIDEMATE_IOT_ENDPOINT", ""),
            model_id=os.environ.get("GUIDEMATE_MODEL_ID", "us.anthropic.claude-sonnet-4-6"),
            region=os.environ.get("AWS_REGION", "us-west-2"),
            kb_id=os.environ.get("GUIDEMATE_KB_ID", "A1NIQYZ0KQ"),
            kb_bucket=os.environ.get(
                "GUIDEMATE_KB_BUCKET", "guidemate-kb-docs-852373397000"
            ),
            kb_data_source=os.environ.get("GUIDEMATE_KB_DATA_SOURCE", "OT8JLH57TE"),
            thing_names=_parse_things(
                os.environ.get("GUIDEMATE_THING_NAMES", "turtlebot468=Turtlebot-468")
            ),
        )
```

- [ ] **Step 2: Write the failing tests**

`agent_service/tests/test_admin.py`:
```python
import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner

from guidemate_agent import admin
from guidemate_agent.store import DEFAULT_FLAGS


class FakeStore:
    def __init__(self):
        self._flags = dict(DEFAULT_FLAGS)
        self._prompt = None

    def get_flags(self):
        return dict(self._flags)

    def set_flag(self, name, value):
        if name not in DEFAULT_FLAGS:
            raise ValueError(name)
        self._flags[name] = bool(value)

    def get_prompt(self):
        return self._prompt

    def set_prompt(self, value):
        self._prompt = value if (value and value.strip()) else None


class FakeRegistry:
    def get_status(self, robot_id):
        return {"robot_id": robot_id, "presence": "online", "battery": 0.9}


class FakeKB:
    def __init__(self):
        self.docs = []
        self.synced = False

    def list_docs(self):
        return self.docs

    def upload(self, key, data):
        self.docs.append({"key": key, "size": len(data), "modified": "now"})

    def delete(self, key):
        self.docs = [d for d in self.docs if d["key"] != key]

    def start_ingestion(self):
        self.synced = True
        return "job-1"

    def latest_job_status(self):
        return {"job_id": "job-1", "status": "COMPLETE"} if self.synced else {"status": "NONE"}


class FakeIotData:
    """Captures the last update_thing_shadow payload."""

    last_payload = None
    last_thing = None

    def update_thing_shadow(self, thingName, payload):
        FakeIotData.last_thing = thingName
        FakeIotData.last_payload = json.loads(payload.decode("utf-8"))
        return {"payload": payload}


def _make_app(monkeypatch, password="secret"):
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", password)
    admin._failures.clear()
    app = FastAPI()
    app.include_router(admin.router)
    app.state.store = FakeStore()
    app.state.registry = FakeRegistry()
    app.state.kb = FakeKB()
    app.state.config = SimpleNamespace(
        robot_ids=["turtlebot468"],
        thing_names={"turtlebot468": "Turtlebot-468"},
        iot_endpoint="abc123-ats.iot.us-west-2.amazonaws.com",
        region="us-west-2",
    )
    return app


def _auth_header(password="secret"):
    # Pre-sign the cookie and inject it via a raw header — httpx would not send a
    # Secure cookie over http, but a raw Cookie header bypasses the jar filter.
    value = TimestampSigner(password).sign(admin.TOKEN).decode()
    return {"Cookie": f"{admin.COOKIE_NAME}={value}"}


def test_routes_503_when_password_unset(monkeypatch):
    monkeypatch.delenv("GUIDEMATE_ADMIN_PASSWORD", raising=False)
    admin._failures.clear()
    app = FastAPI()
    app.include_router(admin.router)
    with TestClient(app) as client:
        assert client.post("/api/admin/login", json={"password": "x"}).status_code == 503
        assert client.get("/api/admin/flags").status_code == 503


def test_login_wrong_password_401_then_rate_limited_429(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        for _ in range(5):
            assert client.post("/api/admin/login", json={"password": "nope"}).status_code == 401
        # 6th attempt within the window is rate-limited
        assert client.post("/api/admin/login", json={"password": "nope"}).status_code == 429


def test_login_success_sets_hardened_cookie(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        resp = client.post("/api/admin/login", json={"password": "secret"})
        assert resp.status_code == 200
        set_cookie = resp.headers["set-cookie"]
        assert admin.COOKIE_NAME in set_cookie
        assert "HttpOnly" in set_cookie
        assert "Secure" in set_cookie
        assert "SameSite=Strict" in set_cookie


def test_flags_require_auth(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        assert client.get("/api/admin/flags").status_code == 401


def test_get_and_put_flag(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        h = _auth_header()
        assert client.get("/api/admin/flags", headers=h).json()["dog_muted"] is False
        resp = client.put(
            "/api/admin/flags", json={"name": "dog_muted", "value": True}, headers=h
        )
        assert resp.status_code == 200
        assert resp.json()["dog_muted"] is True


def test_put_unknown_flag_400(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        resp = client.put(
            "/api/admin/flags", json={"name": "bogus", "value": True}, headers=_auth_header()
        )
        assert resp.status_code == 400


def test_get_and_put_prompt(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        h = _auth_header()
        assert client.get("/api/admin/prompt", headers=h).json()["system_prompt"] is None
        client.put("/api/admin/prompt", json={"system_prompt": "be terse"}, headers=h)
        assert client.get("/api/admin/prompt", headers=h).json()["system_prompt"] == "be terse"


def test_status_lists_robots(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        data = client.get("/api/admin/status", headers=_auth_header()).json()
        assert data["robots"][0]["robot_id"] == "turtlebot468"
        assert data["robots"][0]["presence"] == "online"


def test_kill_switch_writes_only_safe_shadow(monkeypatch):
    app = _make_app(monkeypatch)
    monkeypatch.setattr(admin.boto3, "client", lambda *a, **k: FakeIotData())
    with TestClient(app) as client:
        resp = client.post(
            "/api/admin/kill-switch", json={"robot_id": "turtlebot468"}, headers=_auth_header()
        )
        assert resp.status_code == 200
        desired = FakeIotData.last_payload["state"]["desired"]
        assert desired["dry_run"] is True
        assert desired["motion_enabled"] is False
        # SAFETY INVARIANT: the kill switch never re-enables motion.
        assert desired.get("motion_enabled") is not True
        assert desired.get("dry_run") is not False
        assert FakeIotData.last_thing == "Turtlebot-468"


def test_kb_upload_list_sync(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        h = _auth_header()
        assert client.get("/api/admin/kb", headers=h).json()["docs"] == []
        up = client.post(
            "/api/admin/kb",
            files={"file": ("notes.md", b"hello", "text/markdown")},
            headers=h,
        )
        assert up.status_code == 200
        assert client.get("/api/admin/kb", headers=h).json()["docs"][0]["key"] == "notes.md"
        assert client.post("/api/admin/kb/sync", headers=h).json()["job_id"] == "job-1"
        assert client.get("/api/admin/kb/sync-status", headers=h).json()["status"] == "COMPLETE"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_admin.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_agent.admin'`.

- [ ] **Step 4: Implement `admin.py`**

`agent_service/guidemate_agent/admin.py`:
```python
"""Admin API: password login -> signed HttpOnly Secure SameSite=Strict cookie,
then flags / prompt / robot-status / kill-switch / KB management endpoints.

Absent GUIDEMATE_ADMIN_PASSWORD => every route returns 503 (admin disabled).
The kill switch may ONLY ever write the stricter dry_run=true / motion_enabled=false.
"""
from __future__ import annotations

import collections
import hmac
import json
import logging
import os
import time
from typing import Optional

import boto3
from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from itsdangerous import BadSignature, SignatureExpired, TimestampSigner
from pydantic import BaseModel

from guidemate_agent.store import DEFAULT_FLAGS

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin")

COOKIE_NAME = "guidemate_admin"
TOKEN = "admin"
MAX_AGE = 12 * 3600  # 12 hours
_RATE_WINDOW_S = 60
_RATE_MAX_FAILURES = 5

# In-process failure timestamps (single credential => one global counter).
_failures: collections.deque = collections.deque()


def _password() -> Optional[str]:
    return os.environ.get("GUIDEMATE_ADMIN_PASSWORD")


def _signer() -> Optional[TimestampSigner]:
    pw = _password()
    return TimestampSigner(pw) if pw else None


def _require_configured() -> None:
    if not _password():
        raise HTTPException(status_code=503, detail="admin not configured")


def _rate_limited() -> bool:
    now = time.time()
    while _failures and now - _failures[0] > _RATE_WINDOW_S:
        _failures.popleft()
    return len(_failures) >= _RATE_MAX_FAILURES


def admin_required(request: Request) -> bool:
    _require_configured()
    raw = request.cookies.get(COOKIE_NAME)
    if not raw:
        raise HTTPException(status_code=401, detail="not authenticated")
    try:
        value = _signer().unsign(raw, max_age=MAX_AGE).decode("utf-8")
    except (BadSignature, SignatureExpired):
        raise HTTPException(status_code=401, detail="invalid session")
    if value != TOKEN:
        raise HTTPException(status_code=401, detail="invalid session")
    return True


# --- auth ----------------------------------------------------------------
class LoginBody(BaseModel):
    password: str


@router.post("/login")
def login(body: LoginBody, response: Response) -> dict:
    _require_configured()
    if _rate_limited():
        raise HTTPException(status_code=429, detail="too many attempts, wait a minute")
    if not hmac.compare_digest(body.password, _password()):
        _failures.append(time.time())
        raise HTTPException(status_code=401, detail="invalid password")
    token = _signer().sign(TOKEN).decode("utf-8")
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=MAX_AGE,
        httponly=True,
        secure=True,
        samesite="strict",
    )
    return {"ok": True}


# --- flags ---------------------------------------------------------------
class FlagBody(BaseModel):
    name: str
    value: bool


@router.get("/flags")
def get_flags(request: Request, _: bool = Depends(admin_required)) -> dict:
    return request.app.state.store.get_flags()


@router.put("/flags")
def put_flag(body: FlagBody, request: Request, _: bool = Depends(admin_required)) -> dict:
    if body.name not in DEFAULT_FLAGS:
        raise HTTPException(status_code=400, detail=f"unknown flag {body.name!r}")
    request.app.state.store.set_flag(body.name, body.value)
    return request.app.state.store.get_flags()


# --- admin-set prompt ----------------------------------------------------
class PromptBody(BaseModel):
    system_prompt: Optional[str] = None


@router.get("/prompt")
def get_prompt(request: Request, _: bool = Depends(admin_required)) -> dict:
    return {"system_prompt": request.app.state.store.get_prompt()}


@router.put("/prompt")
def put_prompt(body: PromptBody, request: Request, _: bool = Depends(admin_required)) -> dict:
    request.app.state.store.set_prompt(body.system_prompt)
    return {"system_prompt": request.app.state.store.get_prompt()}


# --- robot status --------------------------------------------------------
@router.get("/status")
def status(request: Request, _: bool = Depends(admin_required)) -> dict:
    reg = request.app.state.registry
    cfg = request.app.state.config
    return {"robots": [reg.get_status(rid) for rid in cfg.robot_ids]}


# --- kill switch (one-way-to-safe) --------------------------------------
class KillBody(BaseModel):
    robot_id: str


@router.post("/kill-switch")
def kill_switch(body: KillBody, request: Request, _: bool = Depends(admin_required)) -> dict:
    cfg = request.app.state.config
    thing = cfg.thing_names.get(body.robot_id)
    if not thing:
        raise HTTPException(status_code=400, detail=f"unknown robot {body.robot_id!r}")
    # HARD INVARIANT: only ever the stricter values. Never motion_enabled=true / dry_run=false.
    desired = {"dry_run": True, "motion_enabled": False}
    payload = json.dumps({"state": {"desired": desired}}).encode("utf-8")
    client = boto3.client(
        "iot-data",
        region_name=cfg.region,
        endpoint_url=f"https://{cfg.iot_endpoint}",
    )
    client.update_thing_shadow(thingName=thing, payload=payload)
    log.warning("kill switch fired", extra={"robot_id": body.robot_id, "thing": thing})
    return {"ok": True, "thing": thing, "desired": desired}


# --- KB management -------------------------------------------------------
@router.get("/kb")
def kb_list(request: Request, _: bool = Depends(admin_required)) -> dict:
    return {"docs": request.app.state.kb.list_docs()}


@router.post("/kb")
async def kb_upload(
    request: Request,
    file: UploadFile = File(...),
    _: bool = Depends(admin_required),
) -> dict:
    data = await file.read()
    request.app.state.kb.upload(file.filename, data)
    return {"ok": True, "key": file.filename}


@router.delete("/kb")
def kb_delete(key: str, request: Request, _: bool = Depends(admin_required)) -> dict:
    request.app.state.kb.delete(key)
    return {"ok": True, "key": key}


@router.post("/kb/sync")
def kb_sync(request: Request, _: bool = Depends(admin_required)) -> dict:
    return {"job_id": request.app.state.kb.start_ingestion()}


@router.get("/kb/sync-status")
def kb_sync_status(request: Request, _: bool = Depends(admin_required)) -> dict:
    return request.app.state.kb.latest_job_status()
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_admin.py agent_service/tests/test_app.py -q`
Expected: PASS. (`test_app.py`'s `Config` tests still pass — the new fields all have defaults.)

- [ ] **Step 6: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/admin.py agent_service/guidemate_agent/config.py agent_service/tests/test_admin.py
git commit -m "Kalhar: admin API + cookie auth (flags/prompt/status/kill-switch/KB)"
```

---

## Task 6: Admin UI + app wiring (store, KB, admin router, fake robot, static mount)

**Files:**
- Create: `agent_service/static/admin/index.html`, `agent_service/static/admin/admin.js`, `agent_service/static/admin/admin.css`, `agent_service/guidemate_agent/fakes.py`
- Modify: `agent_service/guidemate_agent/app.py`
- Test: `agent_service/tests/test_app.py` (append wiring tests)

**Interfaces:**
- Consumes: `ConfigStore` (Task 1), `KBManager` (Task 4), `admin.router` (Task 5), `Config` (Task 5), `RobotRegistry` (existing), `DogAgent` (Task 2 — now takes `store=`, `kb_id=`).
- Produces:
  - `class FakeRobotRegistry(robot_ids)` in `fakes.py` — `connect()` (no-op), `get_status(robot_id) -> dict` (`presence="online"`, fake battery), `send_command(robot_id, cmd, timeout_s=5.0) -> list[Ack]` (three simulated acks). Selected in the lifespan when `GUIDEMATE_FAKE_ROBOT=1`.
  - Updated `app.py` lifespan: builds `Config`, a `ConfigStore`, a `KBManager`, the registry (real or fake), and a `DogAgent(store=..., kb_id=...)`; sets `app.state.config/store/kb/registry/agent`; `app.include_router(admin.router)`; mounts `static/admin` at `/admin`.

- [ ] **Step 1: Write the failing wiring tests (append to `test_app.py`)**

Add to `agent_service/tests/test_app.py`:
```python
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
    with TestClient(appmod.app) as client:
        # admin static page
        page = client.get("/admin/")
        assert page.status_code == 200
        assert "Admin" in page.text
        # admin API mounted (401 without a cookie, NOT 404)
        assert client.get("/api/admin/flags").status_code == 401
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_app.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guidemate_agent.fakes'` (and no `/admin/` route yet).

- [ ] **Step 3: Implement `fakes.py`**

`agent_service/guidemate_agent/fakes.py`:
```python
"""In-memory robot registry for tests / demos (GUIDEMATE_FAKE_ROBOT=1).

No MQTT, no robot: get_status reports a healthy docked robot and send_command
returns the same simulated ack sequence the real dry-run bridge would."""
from __future__ import annotations

from typing import Optional

from guidemate_msgs.messages import Ack, Command


class FakeRobotRegistry:
    def __init__(self, robot_ids: list) -> None:
        self._robot_ids = list(robot_ids)

    def connect(self) -> None:
        return None

    def get_status(self, robot_id: str) -> dict:
        return {
            "robot_id": robot_id,
            "presence": "online",
            "battery": 0.87,
            "last_ack": None,
            "last_status": {"event": "online", "robot_id": robot_id},
        }

    def send_command(self, robot_id: str, cmd: Command, timeout_s: float = 5.0) -> list:
        return [
            Ack(cmd_id=cmd.cmd_id, state=state, simulated=True)
            for state in ("received", "running", "done")
        ]
```

- [ ] **Step 4: Rewrite `app.py` to wire everything**

Replace `agent_service/guidemate_agent/app.py`:
```python
"""FastAPI app: chat API + static chat page + admin API/UI."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from guidemate_msgs.jsonlog import setup

from guidemate_agent import admin
from guidemate_agent.config import Config
from guidemate_agent.dog_agent import DogAgent
from guidemate_agent.fakes import FakeRobotRegistry
from guidemate_agent.kb import KBManager
from guidemate_agent.mqtt_link import RobotRegistry
from guidemate_agent.store import ConfigStore

log = logging.getLogger(__name__)
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


class ChatRequest(BaseModel):
    message: str


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup("agent-service")
    cfg = Config.from_env()
    store = ConfigStore(table_name="guidemate-config", region=cfg.region)
    kb = KBManager(
        bucket=cfg.kb_bucket,
        kb_id=cfg.kb_id,
        data_source_id=cfg.kb_data_source,
        region=cfg.region,
    )

    if os.environ.get("GUIDEMATE_FAKE_ROBOT") == "1":
        registry = FakeRobotRegistry(cfg.robot_ids)
        registry.connect()
    else:
        registry = RobotRegistry(
            endpoint=cfg.iot_endpoint, region=cfg.region, robot_ids=cfg.robot_ids
        )
        try:
            registry.connect()
        except Exception:  # noqa: BLE001 — chat still works if robots are unreachable
            log.exception("registry connect failed — robots unreachable, chat still works")

    app.state.config = cfg
    app.state.store = store
    app.state.kb = kb
    app.state.registry = registry
    app.state.agent = DogAgent(
        registry=registry,
        model_id=cfg.model_id,
        robot_ids=cfg.robot_ids,
        region=cfg.region,
        store=store,
        kb_id=cfg.kb_id,
    )
    yield


app = FastAPI(lifespan=lifespan)
app.include_router(admin.router)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.post("/api/chat")
def chat(req: ChatRequest) -> JSONResponse:
    return JSONResponse(app.state.agent.chat(req.message))


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# Admin UI (index.html + admin.js + admin.css). Mounted AFTER the API routes so
# /api/admin/* is handled by the router, not the static files.
app.mount("/admin", StaticFiles(directory=STATIC_DIR / "admin", html=True), name="admin")
```

- [ ] **Step 5: Implement the admin UI — `static/admin/index.html`**

`agent_service/static/admin/index.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Robert Admin</title>
  <link rel="stylesheet" href="admin.css" />
</head>
<body>
  <header><h1>Robert — Admin</h1></header>

  <section id="login-view">
    <h2>Admin login</h2>
    <form id="login-form">
      <input id="password" type="password" placeholder="Admin password" autocomplete="current-password" />
      <button type="submit">Log in</button>
    </form>
    <p id="login-error" class="error"></p>
  </section>

  <section id="panel" hidden>
    <nav class="tabs">
      <button data-tab="flags" class="active">Flags</button>
      <button data-tab="prompt">Prompt</button>
      <button data-tab="robot">Robot</button>
      <button data-tab="knowledge">Knowledge</button>
    </nav>

    <div id="tab-flags" class="tab">
      <h2>Feature flags</h2>
      <div id="flags-list"></div>
    </div>

    <div id="tab-prompt" class="tab" hidden>
      <h2>System prompt</h2>
      <p class="hint">Blank = built-in Robert persona.</p>
      <textarea id="prompt-text" rows="8" placeholder="(built-in persona)"></textarea>
      <div class="row">
        <button id="prompt-save">Save</button>
        <button id="prompt-clear" class="secondary">Reset to persona</button>
      </div>
      <p id="prompt-status" class="hint"></p>
    </div>

    <div id="tab-robot" class="tab" hidden>
      <h2>Robot status</h2>
      <button id="robot-refresh" class="secondary">Refresh</button>
      <div id="robot-list"></div>
    </div>

    <div id="tab-knowledge" class="tab" hidden>
      <h2>Knowledge base</h2>
      <form id="kb-upload-form">
        <input id="kb-file" type="file" />
        <button type="submit">Upload</button>
      </form>
      <div class="row">
        <button id="kb-sync">Sync (ingest)</button>
        <span id="kb-sync-status" class="hint"></span>
      </div>
      <table id="kb-table"><thead><tr><th>Key</th><th>Size</th><th>Modified</th><th></th></tr></thead><tbody></tbody></table>
    </div>
  </section>

  <script src="admin.js"></script>
</body>
</html>
```

- [ ] **Step 6: Implement the admin UI — `static/admin/admin.js`**

`agent_service/static/admin/admin.js`:
```javascript
"use strict";
const api = (path, opts = {}) =>
  fetch("/api/admin" + path, { credentials: "include", ...opts });
const jsonHeaders = { "Content-Type": "application/json" };

function show(el, on) { el.hidden = !on; }

// --- login ---------------------------------------------------------------
const loginView = document.getElementById("login-view");
const panel = document.getElementById("panel");
const loginError = document.getElementById("login-error");

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const password = document.getElementById("password").value;
  const resp = await api("/login", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ password }),
  });
  if (resp.ok) {
    enterPanel();
  } else if (resp.status === 429) {
    loginError.textContent = "Too many attempts — wait a minute.";
  } else {
    loginError.textContent = "Wrong password.";
  }
});

async function enterPanel() {
  show(loginView, false);
  show(panel, true);
  await loadFlags();
  await loadPrompt();
}

// If a valid cookie already exists, skip the login screen.
(async () => {
  const resp = await api("/flags");
  if (resp.ok) enterPanel();
})();

// --- tabs ----------------------------------------------------------------
document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => (t.hidden = true));
    show(document.getElementById("tab-" + tab), true);
    if (tab === "robot") loadRobots();
    if (tab === "knowledge") loadKb();
  });
});

// --- flags ---------------------------------------------------------------
async function loadFlags() {
  const flags = await (await api("/flags")).json();
  const list = document.getElementById("flags-list");
  list.innerHTML = "";
  Object.keys(flags).sort().forEach((name) => {
    const label = document.createElement("label");
    label.className = "flag";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = flags[name];
    cb.addEventListener("change", async () => {
      await api("/flags", {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ name, value: cb.checked }),
      });
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + name));
    list.appendChild(label);
  });
}

// --- prompt --------------------------------------------------------------
async function loadPrompt() {
  const data = await (await api("/prompt")).json();
  document.getElementById("prompt-text").value = data.system_prompt || "";
}
document.getElementById("prompt-save").addEventListener("click", async () => {
  const val = document.getElementById("prompt-text").value;
  await api("/prompt", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ system_prompt: val }),
  });
  document.getElementById("prompt-status").textContent = "Saved.";
});
document.getElementById("prompt-clear").addEventListener("click", async () => {
  await api("/prompt", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ system_prompt: null }),
  });
  document.getElementById("prompt-text").value = "";
  document.getElementById("prompt-status").textContent = "Reset to persona.";
});

// --- robot ---------------------------------------------------------------
async function loadRobots() {
  const data = await (await api("/status")).json();
  const list = document.getElementById("robot-list");
  list.innerHTML = "";
  data.robots.forEach((r) => {
    const div = document.createElement("div");
    div.className = "robot";
    const battery = r.battery != null ? Math.round(r.battery * 100) + "%" : "?";
    div.textContent = `${r.robot_id} — ${r.presence} — battery ${battery}`;
    const kill = document.createElement("button");
    kill.textContent = "KILL SWITCH";
    kill.className = "danger";
    kill.addEventListener("click", async () => {
      if (!confirm(`Kill switch ${r.robot_id}? (sets dry_run + motion off)`)) return;
      const resp = await api("/kill-switch", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ robot_id: r.robot_id }),
      });
      alert(resp.ok ? "Kill switch sent." : "Kill switch failed.");
    });
    div.appendChild(document.createTextNode("  "));
    div.appendChild(kill);
    list.appendChild(div);
  });
}
document.getElementById("robot-refresh").addEventListener("click", loadRobots);

// --- knowledge -----------------------------------------------------------
async function loadKb() {
  const data = await (await api("/kb")).json();
  const tbody = document.querySelector("#kb-table tbody");
  tbody.innerHTML = "";
  data.docs.forEach((d) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${d.key}</td><td>${d.size}</td><td>${d.modified}</td>`;
    const td = document.createElement("td");
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.className = "danger";
    del.addEventListener("click", async () => {
      await api("/kb?key=" + encodeURIComponent(d.key), { method: "DELETE" });
      loadKb();
    });
    td.appendChild(del);
    tr.appendChild(td);
    tbody.appendChild(tr);
  });
}
document.getElementById("kb-upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById("kb-file");
  if (!fileInput.files.length) return;
  const fd = new FormData();
  fd.append("file", fileInput.files[0]);
  await api("/kb", { method: "POST", body: fd });
  fileInput.value = "";
  loadKb();
});
document.getElementById("kb-sync").addEventListener("click", async () => {
  await api("/kb/sync", { method: "POST" });
  const status = await (await api("/kb/sync-status")).json();
  document.getElementById("kb-sync-status").textContent =
    "Ingestion: " + (status.status || "?");
});
```

- [ ] **Step 7: Implement the admin UI — `static/admin/admin.css`**

`agent_service/static/admin/admin.css`:
```css
:root { --fg: #1a1a1a; --muted: #666; --accent: #2563eb; --danger: #dc2626; --border: #ddd; }
* { box-sizing: border-box; }
body { font-family: system-ui, sans-serif; color: var(--fg); margin: 0; padding: 0 1rem 3rem; max-width: 780px; }
header h1 { font-size: 1.4rem; }
h2 { font-size: 1.1rem; margin-top: 1.4rem; }
button { cursor: pointer; border: 1px solid var(--border); background: #fff; padding: 0.4rem 0.8rem; border-radius: 6px; font-size: 0.95rem; }
button:hover { border-color: var(--accent); }
button.secondary { color: var(--muted); }
button.danger { color: var(--danger); border-color: #f3c2c2; }
button[type="submit"], #prompt-save { background: var(--accent); color: #fff; border-color: var(--accent); }
input, textarea { font: inherit; padding: 0.4rem; border: 1px solid var(--border); border-radius: 6px; width: 100%; max-width: 100%; }
textarea { width: 100%; }
.row { display: flex; gap: 0.6rem; align-items: center; margin: 0.6rem 0; }
.hint { color: var(--muted); font-size: 0.85rem; }
.error { color: var(--danger); }
.tabs { display: flex; gap: 0.4rem; border-bottom: 1px solid var(--border); margin-top: 1rem; }
.tabs button { border: none; border-bottom: 2px solid transparent; border-radius: 0; }
.tabs button.active { border-bottom-color: var(--accent); color: var(--accent); font-weight: 600; }
.tab { padding-top: 0.6rem; }
.flag { display: block; padding: 0.35rem 0; }
.flag input { width: auto; margin-right: 0.4rem; }
.robot { padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
table { width: 100%; border-collapse: collapse; margin-top: 0.8rem; }
th, td { text-align: left; padding: 0.4rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
form { display: flex; gap: 0.6rem; align-items: center; margin: 0.6rem 0; flex-wrap: wrap; }
#login-form input { max-width: 260px; }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_app.py -q`
Expected: PASS. The `test_admin_ui_served_and_router_mounted` test reloads `app` with `GUIDEMATE_FAKE_ROBOT=1` so the lifespan builds the fake registry (no MQTT), serves `/admin/`, and `/api/admin/flags` returns 401 (mounted, unauthenticated) rather than 404.

- [ ] **Step 9: Manual smoke (optional but recommended)**

Run:
```bash
cd ~/cs7980-guide-mate
GUIDEMATE_FAKE_ROBOT=1 GUIDEMATE_ADMIN_PASSWORD=devpass \
  .venv/bin/uvicorn guidemate_agent.app:app --app-dir agent_service --port 8080 &
sleep 3
curl -s -c /tmp/cj.txt -X POST localhost:8080/api/admin/login -H 'Content-Type: application/json' -d '{"password":"devpass"}'
curl -s -b /tmp/cj.txt localhost:8080/api/admin/flags
kill %1
```
Expected: login `{"ok":true}`; flags JSON shows the five flags. Open `http://localhost:8080/admin/` in Chrome to eyeball the tabs (localhost is a secure context, so the Secure cookie is accepted).

- [ ] **Step 10: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/app.py agent_service/guidemate_agent/fakes.py \
  agent_service/static/admin/index.html agent_service/static/admin/admin.js \
  agent_service/static/admin/admin.css agent_service/tests/test_app.py
git commit -m "Kalhar: admin UI (flags/prompt/robot/KB) + app wiring + fake robot hook"
```

---

## Task 7: Playwright e2e — admin login + flag toggle (gated `GUIDEMATE_E2E=1`)

**Files:**
- Create: `agent_service/tests/e2e/__init__.py`, `agent_service/tests/e2e/test_admin.py`

**Interfaces:**
- Consumes: the wired `app` (Task 6), `admin` cookie flags (Task 5), the `e2e` marker (Task 1). Self-contained: no robot (`GUIDEMATE_FAKE_ROBOT=1`), no Bedrock (chat isn't exercised); **DynamoDB is real** (the `guidemate-config` table from Task 1 must exist).
- Produces: `test_admin_login_and_toggle_flag` and `test_admin_wrong_password` (both `@pytest.mark.e2e`). A module-scoped fixture boots uvicorn as a subprocess and waits for `/healthz`.

- [ ] **Step 1: Write the e2e test**

`agent_service/tests/e2e/__init__.py` — empty file.

`agent_service/tests/e2e/test_admin.py`:
```python
import os
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

pytestmark = pytest.mark.e2e

PASSWORD = "e2e-secret"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def base_url():
    port = _free_port()
    env = dict(os.environ)
    env["GUIDEMATE_FAKE_ROBOT"] = "1"
    env["GUIDEMATE_ADMIN_PASSWORD"] = PASSWORD
    env.setdefault("AWS_REGION", "us-west-2")
    proc = subprocess.Popen(
        [
            sys.executable, "-m", "uvicorn",
            "guidemate_agent.app:app",
            "--app-dir", "agent_service",
            "--host", "127.0.0.1",
            "--port", str(port),
        ],
        env=env,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(url + "/healthz", timeout=1) as resp:
                    if resp.status == 200:
                        break
            except Exception:  # noqa: BLE001
                time.sleep(0.5)
        else:
            raise RuntimeError("uvicorn did not become healthy")
        yield url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def _api(page, path):
    """Read an admin API endpoint from inside the page (carries the cookie)."""
    return page.evaluate(
        """async (p) => {
            const r = await fetch('/api/admin' + p, { credentials: 'include' });
            return { ok: r.ok, status: r.status, body: r.ok ? await r.json() : null };
        }""",
        path,
    )


def test_admin_login_and_toggle_flag(base_url):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(base_url + "/admin/")

        page.fill("#password", PASSWORD)
        page.click("#login-form button[type=submit]")
        page.wait_for_selector("#panel:not([hidden])", timeout=5000)

        # Read the current dog_muted value via the API, toggle its checkbox, re-read.
        before = _api(page, "/flags")["body"]["dog_muted"]
        # The flags checkboxes render sorted; dog_muted is first alphabetically.
        page.wait_for_selector("#flags-list label")
        checkboxes = page.query_selector_all("#flags-list label")
        target = None
        for label in checkboxes:
            if "dog_muted" in label.inner_text():
                target = label.query_selector("input")
                break
        assert target is not None
        target.click()
        # give the PUT a moment to round-trip
        page.wait_for_timeout(500)
        after = _api(page, "/flags")["body"]["dog_muted"]
        assert after != before

        # Set the system prompt and verify it persisted.
        page.click('.tabs button[data-tab="prompt"]')
        page.fill("#prompt-text", "You are a stern robot. Be brief.")
        page.click("#prompt-save")
        page.wait_for_timeout(500)
        prompt = _api(page, "/prompt")["body"]["system_prompt"]
        assert prompt == "You are a stern robot. Be brief."

        browser.close()


def test_admin_wrong_password(base_url):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(base_url + "/admin/")
        page.fill("#password", "definitely-wrong")
        page.click("#login-form button[type=submit]")
        page.wait_for_selector("#login-error", timeout=5000)
        assert "Wrong password" in page.inner_text("#login-error")
        # panel stays hidden
        assert page.get_attribute("#panel", "hidden") is not None
        browser.close()
```

- [ ] **Step 2: Verify the tests are collected but skipped by default**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/e2e/test_admin.py -q`
Expected: `2 skipped` (the `e2e` marker is gated off unless `GUIDEMATE_E2E=1`).

- [ ] **Step 3: Run the e2e for real (requires the DynamoDB table + AWS creds + chromium)**

Run: `cd ~/cs7980-guide-mate && GUIDEMATE_E2E=1 .venv/bin/python -m pytest agent_service/tests/e2e/test_admin.py -q`
Expected: PASS (2 passed). This boots uvicorn with the fake robot, drives Chromium headless through login → toggles `dog_muted` (verified via the API) → sets the prompt (verified via the API), and confirms the wrong-password path shows the error and keeps the panel hidden. `guidemate-config` reads/writes hit real DynamoDB.

- [ ] **Step 4: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/tests/e2e/__init__.py agent_service/tests/e2e/test_admin.py
git commit -m "Kalhar: Playwright e2e — admin login + flag toggle + prompt set"
```

---

## Phase 3 exit checklist (maps to the spec's exit test)

- **Flag flip removes a tool from the model mid-session** — Task 2 (`_enabled_tool_names` respects `emotes_enabled`/`kb_enabled`; flags read fresh every `chat()` turn; `dog_muted` short-circuits before Bedrock). Verified by `test_dog_agent_flags.py` + the e2e toggle.
- **KB answer grounded in an uploaded doc** — Task 3 (`retrieve_kb` tool → `retrieve_passages`) + Task 4 (`KBManager` upload → `start_ingestion`). Live path: upload via `POST /api/admin/kb`, `POST /api/admin/kb/sync`, then ask the dog a doc-specific question (env-gated live tests cover the retrieval leg).
- **Kill switch flips shadow** — Task 5 (`POST /api/admin/kill-switch` → `iot-data.update_thing_shadow` desired `dry_run=true`/`motion_enabled=false`), one-way-to-safe invariant tested.
- **Admin can edit the dog's system prompt and the agent follows it** — Task 5 (`PUT /api/admin/prompt` → `ConfigStore.set_prompt`) + Task 2 (`_system_prompt` uses the admin prompt as the base). e2e sets the prompt; a live turn (env-gated) would show the agent obeying it.

---

## Self-Review

**1. Spec coverage** (Phase 3 row + components 6-flags/7/10-partial + deltas + observability):
- Component 6 (DynamoDB store, flags + admin prompt, config table only in Phase 3, other 3 tables created now) → Task 1. ✓
- Component 7 (KB manager: upload → S3 → StartIngestionJob → sync status) → Task 4; the `retrieve_kb` agent tool → Task 3. ✓
- Component 10 partial (admin UI flags/status/KB tabs + prompt tab + kill switch) → Task 6; admin API + auth → Task 5. ✓
- DynamoDB delta (on-demand, console-browsable, tag, doc) → Task 1 Steps 1/7/9 + Global Constraints. ✓
- Admin auth delta (password → signed HttpOnly Secure SameSite=Strict cookie, timing-safe compare, rate limit) → Task 5. ✓
- Admin-set agent prompts delta (stored in guidemate-config, applied next turn, agent must follow) → Task 1 (`set_prompt`/`get_prompt`) + Task 2 (`_system_prompt`) + Task 5 (`PUT /prompt`). ✓
- Flag gating semantics from the brief (motion/emote/kb/persona/mute + admin prompt replaces persona base + emote/tool instructions appended programmatically + registry dict for tools) → Task 2. The tool registry is realized as `_enabled_tool_names` + `_build_tools` (a name-keyed selection); motion tools gated by name behind `_motion_available` (documented Phase-2 integration hook) since `run_motion`/`stop` may not exist yet. ✓
- Playwright e2e, gated `GUIDEMATE_E2E=1`, fake-robot mode via `GUIDEMATE_FAKE_ROBOT=1`, real DynamoDB, no Bedrock/robot, wrong-password path → Task 7 + Task 6 fake hook. ✓
- Observability: `store`/`admin`/`kb` all log via the shared `jsonlog.setup` root logger already installed in the lifespan; kill switch logs a `WARNING` with `robot_id`/`thing`; KB retrieve logs exceptions with `kb_id`. Full EMF/CloudWatch dashboards are later phases (this is the "base"); the correlation-ID plumbing (`turn_id`) already exists in `chat()`. Consistent with the Phase-3 scope. ✓
- **Not in Phase 3 (correctly deferred):** sessions/messages/requests table *usage* (Phase 4), voice (Phase 5), maps (Phase 6), production deploy (Phase 7). The three extra tables are *created* now per the locked decision, but not read/written.

**2. Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N". Every code step shows complete code; every test step shows the full test; every run step gives an exact command + expected output. The one forward-reference (Task 2's `dog_agent.py` imports `retrieve_passages` from Task 3's `kb.py`) is called out explicitly with a NOTE and the ordered-execution rationale.

**3. Type consistency:**
- `DEFAULT_FLAGS` keys (`dog_muted`, `emotes_enabled`, `motion_tools_enabled`, `persona_enabled`, `kb_enabled`) are identical in `store.py`, `dog_agent.py`, `admin.py`, and every test. ✓
- `ConfigStore` methods (`get_flags`/`set_flag`/`get_prompt`/`set_prompt`/`_invalidate`) match between Task 1 impl, the `FakeStore`s in Tasks 2 & 5, and the admin router calls. ✓
- `retrieve_passages(query, kb_id, region=, top_k=, client=)` — signature identical in Task 3 impl, its tests, and the Task 2 `_build_tools` call (`retrieve_passages(query, self._kb_id, region=self._region)`). ✓
- `KBManager(bucket, kb_id, data_source_id, region, s3, agent)` + `list_docs`/`upload`/`delete`/`start_ingestion`/`latest_job_status` — consistent across Task 4 impl, its tests, `admin.py`, and `app.py`'s construction from `Config` fields (`kb_bucket`/`kb_id`/`kb_data_source`). ✓
- `admin` module symbols used by tests (`router`, `COOKIE_NAME`, `TOKEN`, `_failures`, `boto3`) all exist in the Task 5 impl. ✓
- `DogAgent.__init__` new kwargs (`store=`, `kb_id=`) are additive and defaulted, so the existing `test_dog_agent.py` (positional `registry, model_id, robot_ids`) and Phase-0 `test_app.py` still construct it fine; `PERSONA` retains `"Robert"` + `"send_emote"`. ✓
- `Config` new fields are all defaulted → `test_config_defaults` (which only asserts `robot_ids`/`model_id`/`region`) still passes. ✓
- `FakeRobotRegistry.get_status`/`send_command` signatures match what `admin.py` (`get_status(rid)`) and `DogAgent` (`send_command(target, Command)`) call. ✓

No inconsistencies found; no missing tasks.
</content>
</invoke>
