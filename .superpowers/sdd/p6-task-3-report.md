# Phase-6 Task 3 report — EventEngine wiring + scheduler + synthetic-event endpoint

## Status: DONE

## Base / head
- Base (merged in): `052505f` (Merge branch 'worktree-agent-ad986481940503795' into kalhar/dog-agent-poc)
- Head: `249983f` (Kalhar: wire autonomy engine + APScheduler + synthetic-event admin endpoint)

## What changed
- `agent_service/pyproject.toml`: added `apscheduler` dep; installed into the shared venv.
- `agent_service/guidemate_agent/app.py`: lifespan now builds `EventEngine(agent, store=sessions, default_robot_id, session_id=env-overridable)`, registers `registry.on_event(engine.on_status_event)`, starts a `BackgroundScheduler` with a daily 09:00 America/New_York cron job calling `engine.morning_stretch`, stores both on `app.state`, and shuts the scheduler down in a `finally` around `yield`.
- `agent_service/guidemate_agent/admin.py`: added `POST /api/admin/synthetic-event` (`SyntheticEvent{type, battery, robot_id}` → `engine.on_status_event(...)` → `{"fired", "session_id"}`), behind `admin_required`.
- `agent_service/guidemate_agent/dog_agent.py`: `DogAgent.chat()` gained `system_event: Optional[str] = None` and `allow_motion: bool = True`. When `system_event` is set it's used as the model input instead of `message` (and no "user" message is persisted); `allow_motion=False` strips `run_motion`/`stop` from the tool list regardless of flags/lock state.
- `agent_service/guidemate_agent/sessions.py`: added `ensure_session(session_id, name)` — idempotent put with an explicit id (conditional on `attribute_not_exists`), unlike `create_session` which always mints a new id.
- `agent_service/guidemate_agent/fakes.py`: `FakeRobotRegistry.on_event()` no-op added so `GUIDEMATE_FAKE_ROBOT=1` lifespan startup (used by most of the existing test suite) doesn't break on the new unconditional `registry.on_event(...)` call.
- Tests: `agent_service/tests/test_admin_autonomy.py` (4 tests, not gated), `agent_service/tests/integration/test_autonomy_roundtrip.py` (1 gated test, skips by default via `pytestmark`).

## Adaptations from the brief (reality won)
1. **EventEngine's `store` arg**: brief said pass `app.state.store` (`ConfigStore`), but `ConfigStore` only holds flags/prompt (guidemate-config) and has no `ensure_session`. Sessions live in the `sessions` module (guidemate-sessions table). Passed `store=sessions` and added `sessions.ensure_session()`.
2. **Admin router double-prefix**: `admin.router` already carries `prefix="/api/admin"` (Phase 3); the brief's test built its `FastAPI()` with an *extra* `prefix="/api/admin"` on `include_router`, which 404s every route. Fixed to `include_router(router)`.
3. **Login body/cookie**: brief's test posted form `data=` to `/login`, but the real route takes JSON (`LoginBody`). Also the login cookie is `Secure`, which httpx's `TestClient` (plain http) won't resend — same issue this repo's `test_admin.py` already solved by injecting a pre-signed `Cookie` header directly. Test now does both: a real JSON login (to prove the route works) plus the raw-header pattern for the authenticated calls.
4. **Integration test assertion**: brief's draft used `store.list_messages(...)`; adapted to `sessions.get_messages(...)` (the actual Phase 3 reader), as the brief itself anticipated.
5. `DogAgent.chat()` didn't have `system_event`/`allow_motion` — added per the task instructions, minimally, with no existing test needing changes (only the `EventEngine`/admin fakes use those kwargs).

## Tests
`pytest agent_service/tests/ -q` → **178 passed, 16 skipped** (all gated/integration). Gated `test_autonomy_roundtrip.py` alone → **1 skipped** (no `GUIDEMATE_INTEGRATION`).

## Concerns
- `sessions.ensure_session` and the morning-stretch cron are untested against real DynamoDB/wall-clock (by design — no AWS/scheduler-wall-clock in unit tests); only the gated integration test (skipped by default) exercises the DynamoDB path.
- Scheduler timezone hardcoded `America/New_York` per brief; not configurable via env — flag if that's wrong for deployment.
