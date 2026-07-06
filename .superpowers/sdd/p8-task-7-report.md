# Phase 8 Task 7 report — virtual-pet grant

## Brief-vs-reality adaptations

The brief was written against assumed file paths (`static/admin.html`, `static/index.html`
as a monolith). Reality (post P4/P5 merges):

- Admin UI is `static/admin/index.html` + `static/admin/admin.js` + `static/admin/admin.css`,
  all DOM built/wired dynamically in JS (no static per-row markup to hand-edit).
- Chat UI is the P5-T5 rewrite: `static/index.html` + `static/chat.js` + `static/chat.css`,
  with a status chip + companion banner already driven by a `renderState(s)` function fed
  from a 3 s poll of `/api/session/{id}/state`.
- Admin router prefix is `/api/admin` (not `/admin/api` as the brief's Step 5 snippet
  assumed).
- The repo's real e2e tests (`tests/e2e/test_companion_flow.py`, `test_admin.py`,
  `test_admin_maps.py`) all select by element **id**/text, not `data-testid`. I followed
  that convention for the test body, but added the specific `data-testid` hooks the brief
  asked for (`approve-robot-select`, `virtual-pet-badge`, plus `request-row`/`approve-btn`
  on the request row for the new picker) so both selector styles work on the new elements.

## 1. Config (`agent_service/guidemate_agent/config.py`)

Changed the `GUIDEMATE_ROBOTS` default from `"turtlebot468"` to `"turtlebot468,turtlebotsim"`
(line ~33), still fully env-overridable. `Config.from_env().robot_ids` now defaults to
`["turtlebot468", "turtlebotsim"]`.

This flows through everywhere `cfg.robot_ids` is read (already generic, no hardcoding):
`app.py` builds the registry/`RobotRegistry`/`FakeRobotRegistry` from it, and
`/api/admin/status` and `/api/admin/health` iterate it to build the robot list — so
`turtlebotsim` is automatically grantable and shows up in the admin Robot/Maps/Health tabs
with zero further code changes.

**Existing test updated:** `tests/test_app.py::test_config_defaults` asserted
`cfg.robot_ids == ["turtlebot468"]` with the default env; updated to
`["turtlebot468", "turtlebotsim"]` (the exact behavior this task changes). Its neighbor
`test_config_parses_multiple_robots` was already asserting the two-robot env-override case
and needed no change.

## 2. Approve endpoint — already multi-robot, no server change needed

Checked `agent_service/guidemate_agent/admin.py:292-301`:

```python
class _ApproveBody(BaseModel):
    robot_id: str

@router.post("/requests/{request_id}/approve")
def admin_approve(request_id: str, body: _ApproveBody, request: Request, ...):
    return sessions.approve_request(request_id, body.robot_id, registry=request.app.state.registry)
```

The endpoint **already requires** `robot_id` in the body and passes it straight through to
`sessions.approve_request(request_id, robot_id, registry)`, which binds/locks whatever
`robot_id` it's given (no `turtlebot468` hardcoding anywhere in that path). **The brief's
Phase-4 FLAG does not apply** — Phase 4 shipped this fully generic already. Task 7 only
needed to supply the UI picker that feeds a real choice instead of always sending
`turtlebot468`.

## 3. Admin Requests approve picker (`static/admin/admin.js`)

`reloadRequests()` (previously hardcoded `body: JSON.stringify({ robot_id: ROBOT_ID })`)
now:
- fetches the registry's robot list from `/api/admin/status` (`_registryRobotIds()`,
  same source the Maps tab's `populateMapsRobotSelect()` already used — reused the pattern,
  not duplicated logic style),
- builds a `<select data-testid="approve-robot-select" class="approve-robot-select">` per
  request row with one `<option>` per registered robot (labels `turtlebotsim` as
  "Virtual pet — turtlebotsim"), defaulting to `turtlebot468` so the existing
  `test_companion_flow.py` e2e (which just clicks "Approve" without touching the select)
  is unaffected,
- the Approve button (`data-testid="approve-btn"`) now sends `{ robot_id: robotSelect.value }`
  instead of the hardcoded constant,
- the `<li>` itself got `data-testid="request-row"` so a picker + button can be scoped per
  pending request in tests.

No change to `sessions.py`/`admin.py` was needed — see point 2.

## 4. Virtual-pet badge (`static/index.html` + `static/chat.js` + `static/chat.css`)

- `index.html`: added
  `<span id="virtual-pet-badge" data-testid="virtual-pet-badge" class="chip chip-virtual-pet hidden">🐾 Virtual pet</span>`
  next to the existing `#status-chip`.
- `chat.js`: `renderState(s)` (the same function that already drives the companion banner
  from the `/state` poll) now also does
  `virtualPetBadge.classList.toggle("hidden", s.robot_id !== "turtlebotsim")`. All existing
  banner strings (`"Connected to " + robot_id + " ..."`, `"Request pending..."`,
  `"Virtual dog (avatar only)"`, etc.) are untouched — `test_companion_flow.py` still
  passes verbatim.
- `chat.css`: added `.chip-virtual-pet { background: var(--accent-soft); color: var(--accent); }`.

**Bug caught during verification:** the badge was first wired with the native `hidden`
boolean attribute, but `.chip { display: inline-flex; }` (author stylesheet) beats the UA
`[hidden]{display:none}` rule at equal specificity, so the badge rendered visible on load
despite the `hidden` attribute. Fixed by switching to the repo's existing `.hidden`
utility class (`display:none !important`, already used by `#toast`) and toggling that
class from JS instead of the `hidden` property. Caught by actually running the Playwright
test (`upage.locator(...).is_hidden()` returned `False` before the fix) — worth flagging
since it's an easy trap for any future `hidden`-attribute + class-driven badge in this UI.

## 5. Tests

- **`agent_service/tests/test_config.py`** (new): `test_default_registry_includes_virtual_pet`
  and `test_env_override_still_wins`, exactly per brief.
- **`agent_service/tests/test_app.py`**: updated `test_config_defaults` (see point 1).
- **`agent_service/tests/e2e/test_virtual_pet.py`** (new, `pytest.mark.e2e`, gated by the
  repo's root `conftest.py` `GUIDEMATE_E2E=1` skip): boots its own uvicorn subprocess
  (`GUIDEMATE_FAKE_ROBOT=1`, `GUIDEMATE_ROBOTS=turtlebot468,turtlebotsim`, random admin
  password) — same pattern as `test_companion_flow.py`. Drives a user + admin browser
  context: user requests a companion, admin picks `turtlebotsim` in the new
  `approve-robot-select` and clicks Approve, then asserts:
  - the badge is hidden before approval, visible after (`data-testid="virtual-pet-badge"`),
  - the banner still shows the existing "Connected to turtlebotsim ..." string,
  - `/api/admin/sessions` shows the session's `robot_id == "turtlebotsim"`,
  - the physical robot's `/robot/turtlebot468/assign-events` log did not grow (baseline
    captured post-login, compared post-approval — robust to any pre-existing entries in
    the shared real DynamoDB table, since this test hits real AWS, not moto),
  - the sim's own assign-events log recorded the `undock` action (best-effort/simulated
    ack under `GUIDEMATE_FAKE_ROBOT=1`, exactly as the brief's integration-point note
    anticipated — no bridge-side change needed).
  Real-AWS DynamoDB items created (`guidemate-sessions`/`guidemate-requests` rows,
  `robot_lock#*`/`robot_assign_events#*` config rows for both robot ids) are deleted in a
  `finally`/trailing cleanup, mirroring `test_companion_flow.py`.
  **Actually ran it against the real app + real AWS** (not just inspected):
  `GUIDEMATE_E2E=1 pytest agent_service/tests/e2e/test_virtual_pet.py -q` → `1 passed`.

## Verification

- `PYTHONPATH= .venv/bin/pytest -q` (repo root) → **334 passed, 18 skipped** (gated
  e2e/integration/live tests skip as expected without their env flags).
- `GUIDEMATE_E2E=1 .venv/bin/pytest agent_service/tests/e2e -q` (all e2e including the new
  test + the untouched `test_companion_flow.py`/`test_admin.py`/`test_admin_maps.py`) →
  **10 passed**, confirming the companion-flow strings and admin flows still work
  unmodified alongside the new picker/badge.

## Safety

No bridge/safety code touched. `turtlebot468` stays motion-locked exactly as before — the
approve endpoint, dock-guard, and shadow logic are untouched; only the config default and
two UI files (a `<select>` and a badge) changed. Approving a session onto `turtlebotsim` is
the only newly-reachable path, and it goes through the identical `sessions.approve_request`
→ `_bind_robot` → best-effort-undock code path that already existed for any robot id.
