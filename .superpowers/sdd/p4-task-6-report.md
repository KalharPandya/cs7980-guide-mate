# Phase-4 Task 6 report — admin endpoints + UI tabs (requests / sessions / robot controls)

**Status:** DONE. TDD (tests first → red → green). Full agent_service suite green.
**Worktree/branch:** `.claude/worktrees/agent-a3062d76dd6b856cf` / `worktree-agent-a3062d76dd6b856cf`
**Base SHA:** `333e079` (merged into worktree first — HEAD was `fe63d10`, did not contain it).
**Head SHA:** `0919f67`

## What was built
New routes appended to the existing `admin.router` (all `Depends(admin_required)`):
`GET /requests`, `POST /requests/{id}/approve {robot_id}`, `POST /requests/{id}/deny`,
`GET /sessions`, `GET /sessions/{id}/messages`, `POST /robot/{id}/abort`,
`POST /robot/{id}/reassign {session_id}`, `GET /robot/{id}/assign-events`,
`POST /robot/{id}/command {type,name}`. All are thin adapters over `sessions.*`,
threading `request.app.state.registry` so binds/unbinds fire the best-effort
assignment undock/dock; invalid command shapes synthesize a `failed` refusal
without publishing (valid dock/undock publish and return the fake's refusal ack).

UI: extended `static/admin/index.html` + `admin.js` + `admin.css` (merged reality
splits JS/CSS out of the HTML). Added **Requests** and **Sessions** tabs and
extended the **Robot** tab with holder line, Abort / Send-dock / Send-stop buttons,
a command-result line, and an auto-refreshing (3 s) assignment undock/dock events
`<pre>` that shows `REFUSED — <reason>` verbatim (the Phase-4 evidence). Wired into
the existing `data-tab` / `.tab` switcher; kept every ID the brief/e2e rely on.

## Adaptations (reality won)
1. **Router prefix is `/api/admin`** (Phase 3), not the brief's `/admin/api`. All
   routes defined as sub-paths (`/requests`, `/robot/{id}/command`, …) and every
   UI/test path uses `/api/admin/...`.
2. **UI is `index.html` + `admin.js` + `admin.css`**, not one inline-script file.
   Brief's inline `<script>` fetch calls (`/admin/api/...`) were re-expressed via
   the existing `api()` helper (which prepends `/api/admin`); panels became `.tab`
   divs and nav `data-tab` buttons to match the existing switcher.
3. **Auth in tests via pre-signed raw Cookie header** (`_auth_header`), not the
   login-set cookie: httpx will not resend a `Secure` cookie over http. The helper
   still asserts `POST /api/admin/login` returns 200 (route sanity) before injecting.
4. `robot-holder-value` is a static placeholder (brief provides no holder endpoint
   and never updates it in its own script) — holder is conveyed by the Sessions
   list + assign-events panel.
5. Added 3 tests beyond the brief's 5: deny, invalid-command-no-publish, stop-accepted.

## Tests
`PYTHONPATH=.../shared/guidemate_msgs:.../agent_service pytest agent_service/tests/ -v`
→ **128 passed, 13 skipped** (skips are the playwright/integration gated tests).
`test_admin.py`: 27 passed (8 new Task-6 tests). Manual server smoke (uvicorn +
`GUIDEMATE_FAKE_ROBOT=1`): all 6 tabs render, requests/sessions routes 200, dock
returns the `motion_disabled` refusal verbatim, no server errors.

## Concerns
- Requests/sessions routes hit **real DynamoDB** when run against live AWS creds
  (smoke returned `[]` from the real table); tests use moto via the `ddb` fixture.
- e2e Playwright coverage for the new tabs is **not** added here (existing
  `tests/e2e/test_admin.py` covers flags/prompt/robot/kill-switch only) — that is
  Task 7's scope per the brief.
- `assign-events` polling starts on login (guarded, swallows non-200) to avoid
  401 spam before auth.
