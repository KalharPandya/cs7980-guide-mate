# Phase 3 Task 7 — Playwright e2e for the admin panel — REPORT

**Status:** DONE. All e2e green on two consecutive real runs; closes Phase 3.

## What was built
`agent_service/tests/e2e/__init__.py` (empty) + `agent_service/tests/e2e/test_admin.py`
(7 `@pytest.mark.e2e` tests). A module-scoped fixture boots a real uvicorn subprocess
(`guidemate_agent.app:app`, `--app-dir agent_service`) with `GUIDEMATE_FAKE_ROBOT=1`,
a random per-run `GUIDEMATE_ADMIN_PASSWORD`, a free port, and waits for `/healthz`
before yielding. The subprocess is always terminated in a `finally` (killed by the
`Popen` handle — never `pkill`); verified zero orphaned uvicorns after the runs.

## Scenarios (all passing)
1. `test_admin_wrong_password` — wrong password → `#login-error` shows "Wrong password", `#panel` stays hidden.
2. `test_admin_login_shows_tabs` — right password → all four tabs (Flags/Prompt/Robot/Knowledge) visible, flags list renders.
3. `test_admin_toggle_flag` — read `dog_muted` via `GET /flags`, click its checkbox, re-read via API to confirm it flipped; `finally` restores the prior value (real DynamoDB left as found).
4. `test_admin_set_and_clear_prompt` — set the prompt via the UI, verify via `GET /prompt`, clear it via the UI (→ null), verify; `finally` restores the original prompt value.
5. `test_admin_robot_tab_renders_status` — Robot tab renders the fake robot: `turtlebot468`, `online`, and gates `motion_enabled`/`dry_run`; kill-switch button present.
6. `test_admin_kill_switch_confirm_fires` — kill-switch confirm → POST → success alert; the POST is **intercepted with `page.route`** and stubbed 200, so the full UI wiring (confirm → fetch → "Kill switch sent." alert) is exercised WITHOUT the request ever leaving the browser. Asserts the POST body carries `robot_id`/`turtlebot468`.
7. `test_admin_kill_switch_cancel_does_not_fire` — dismissing the confirm dialog fires no POST.

## Run results (real, `GUIDEMATE_E2E=1`)
- Run 1: **7 passed** in 6.25s.
- Run 2: **7 passed** in 6.15s.
- Default (no gate): **7 skipped** (marker gate intact).
- Real DynamoDB (`guidemate-config`) read/written and restored; Bedrock never exercised.

## Kill-switch decision
`admin.py`'s `/kill-switch` builds a **real** boto3 `iot-data` client from `cfg` and
`fakes.py` does **not** stub iot-data, so firing it for real would attempt to write the
live robot shadow (and would fail anyway: `GUIDEMATE_IOT_ENDPOINT` is unset in fake mode).
Per the brief's "don't let the e2e write the real robot shadow" guardrail, I verify the
**200 path via browser-side response stubbing** (`page.route('**/api/admin/kill-switch')`
→ fulfilled 200). This exercises the complete confirm → POST → success-alert wiring and
asserts the request payload, while guaranteeing the request never reaches AWS. A second
test covers the cancel path (no POST). This is strictly stronger than "verify up-to-the-
confirm only" and touches no real robot state.

## Adaptations from the brief (reality wins)
- **Fixture renamed `base_url` → `server_url`.** The installed `pytest-base-url` plugin
  registers a session-scoped `base_url` fixture; a module-scoped same-name fixture caused
  a `ScopeMismatch` at collection. Renaming resolved it.
- **Real DOM selectors** (from `static/admin/*`), all of which matched the brief's guesses:
  `#password`, `#login-form button[type=submit]`, `#login-error`, `#panel[hidden]`,
  `#flags-list label`, `.tabs button[data-tab="…"]`, `#prompt-text`/`#prompt-save`/`#prompt-clear`.
  The admin JS uses `credentials: "same-origin"`, so the in-page API helper uses the same.
- **Random per-run password** (`secrets.token_urlsafe`) instead of the brief's fixed
  `"e2e-secret"` literal — no credential-shaped constant in the repo.
- **Split into 7 focused tests** (login-ok, wrong-password, flag, prompt, robot, kill-fire,
  kill-cancel) instead of the brief's 2, covering the full review-note scenario list.
- **finally-block cleanup**: flag and prompt tests restore the prior DynamoDB value.
- Fixture also fails fast if uvicorn exits early (`proc.poll()`), and uses
  `wait_for_function` polling instead of fixed `wait_for_timeout` sleeps for robustness.

## Concerns
- The e2e hits **real DynamoDB**; it needs AWS creds + the `guidemate-config` table (both
  present here). Cleanup is best-effort in `finally`; a hard crash mid-test could leave
  `dog_muted`/`prompt` mutated, but the values are restored on every observed run and the
  table state was confirmed clean afterward (prompt = null, as before).
- `guidemate_msgs` resolves from the editable install at the shared checkout, not the
  worktree; content is identical post-merge, so no behavioral difference. The app code
  under test is the worktree's (via `--app-dir agent_service` from the worktree cwd).

## Report path
`.superpowers/sdd/p3-task-7-report.md` (this file).
