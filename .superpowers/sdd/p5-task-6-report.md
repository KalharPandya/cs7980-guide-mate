## Task 6 report: admin Health tab

### Route
`GET /api/admin/health` (not `/admin/api/health` — the brief's stub path predates
Phase 3's real router, which mounts at `prefix="/api/admin"`; this matches every
sibling route, e.g. `/api/admin/status`, `/api/admin/flags`). Auth: the existing
`admin_required` cookie dependency (signed `guidemate_admin` cookie via
`itsdangerous.TimestampSigner`) — no new auth was invented. Returns 503 if
`GUIDEMATE_ADMIN_PASSWORD` is unset (admin disabled), 401 if the cookie is
missing/tampered/expired, 200 with the snapshot otherwise.

Response shape:
```json
{
  "commands": [...],   // Observability.snapshot()["commands"], newest first
  "latencies": [...],  // Observability.snapshot()["latencies"], newest first
  "errors": [...],     // Observability.snapshot()["errors"], newest first
  "robots": [...]      // one get_status(rid) per cfg.robot_ids, real robot list
}
```

Implementation (`agent_service/guidemate_agent/admin.py`, new `@router.get("/health")`
next to the existing `/status` route): reads `request.app.state.observability`
(the real `Observability` instance app.py's lifespan sets at `app.state.observability
= Observability()`), calls `.snapshot()`, then merges in
`[reg.get_status(rid) for rid in cfg.robot_ids]` — the exact same per-robot call the
`/status` route already makes, over `app.state.registry` / `app.state.config`, so it
is multi-robot aware for free (no hardcoded `turtlebot468`).

### Observability API used (read from the real merged file, not assumed)
`agent_service/guidemate_agent/observability.py`'s `Observability` class:
- `record_command(turn_id, robot_id, cmd_id, sent_monotonic, acks)` — appendleft to a
  maxlen=10 deque; record has `turn_id, robot_id, cmd_id, ts, total_ms, states,
  gates, simulated`.
- `record_latency(turn_id, bedrock_ms, session_id)` — maxlen=50 deque; record has
  `turn_id, bedrock_ms, session_id, ts`.
- `record_error(where, message, turn_id=None)` — maxlen=50 deque; record has
  `where, message, turn_id, ts`.
- `snapshot() -> {"commands": [...], "latencies": [...], "errors": [...]}` — the
  only public read API; no `robots` key (that's assembled in the route, matching
  the brief's intent but composed inline rather than mutating the dict returned
  by a hypothetical richer snapshot()).

### Frontend
- `agent_service/static/admin/index.html`: added `<button data-tab="health">Health</button>`
  to the existing tab nav and a `#tab-health` section with four `<table>`s (robot
  presence, last 10 commands, Bedrock latency, errors) — mirrors the markup style of
  the Maps/Robot tabs already in the file, not the brief's bespoke `<h2>`/innerHTML-only
  layout, so it inherits the existing `admin.css` table styling for free. Script tag
  `<script src="health.js"></script>` added after `admin.js`.
- `agent_service/static/admin/admin.js`: one-line addition to the tab-click handler —
  `if (tab === "health" && window.startHealthPolling) window.startHealthPolling();`
  — following the same per-tab lazy-load pattern as `loadRobots()`/`loadMapsTab()`.
- `agent_service/static/admin/health.js` (new): plain (non-module) script that reuses
  the `api()`/`$()` globals `admin.js` already defines (fetch base `/api/admin`,
  `credentials: "same-origin"`, same cookie) rather than the brief's self-mounting
  IIFE with its own container-creation logic — Phase 3's admin shell already owns
  the tab/panel lifecycle, so re-deriving it would have duplicated behavior instead
  of matching it. `startHealthPolling()` fetches immediately then sets a 3s
  `setInterval` (guarded so re-entering the tab doesn't stack timers). Renders robot
  presence/battery/gates, last-10 commands (states chain + rtt + sim/real), Bedrock
  latency per turn, and recent errors, with "no data yet" placeholder rows.

### Tests (`agent_service/tests/test_admin_health.py`, all new)
Follows `test_admin.py`'s established pattern — a lightweight `FastAPI()` +
`admin.router` + fake `app.state.registry`/`config`, plus a **real**
`Observability()` instance on `app.state.observability` (not a fake) — rather than
the brief's full `appmod.app` + MQTT-connect monkeypatch, since the existing admin
test suite never spins up the full lifespan and there's no reason `/health` should
be the exception.
- `test_health_requires_admin_cookie` — no cookie → 401.
- `test_health_tampered_cookie_401` — garbage cookie value → 401 (itsdangerous
  `BadSignature` path).
- `test_health_503_when_admin_not_configured` — `GUIDEMATE_ADMIN_PASSWORD` unset →
  503, matching every other admin route's contract.
- `test_health_returns_rings_and_robots` — authenticated (pre-signed cookie via
  `TimestampSigner`), pushes a synthetic command/latency/error into the real
  `Observability` instance, then asserts `/api/admin/health` reflects them
  (`commands[0].robot_id == "turtlebot468"`, `latencies[0].bedrock_ms == 700.0`,
  `errors[0].where == "chat"`) and that `robots` is multi-robot (two configured
  robot_ids both appear, in `cfg.robot_ids` order).

Full suite: `PYTHONPATH= .venv/bin/pytest -q` → 329 passed, 17 skipped (all green,
no regressions).

### Brief-vs-reality adaptations
1. **Route path**: brief's stub assumed `router = APIRouter(prefix="/admin")` and
   `/admin/api/health`; the real Phase 3 router (already merged) is
   `APIRouter(prefix="/api/admin")`, so the real, working path is
   `/api/admin/health` — matching `/api/admin/status`, `/api/admin/flags`, etc.
2. **Step 1a skipped** — Phase 3's `admin.py` already exists (richer than the
   stub: login, flags, prompt, status, kill-switch, KB, requests/sessions, maps).
   Only the new `/health` route was appended, right after `/status` for locality.
3. **`robots` field** comes from `reg.get_status(rid)` for `rid in cfg.robot_ids`
   (the same call `/status` already makes) rather than `RobotRegistry.get_status`
   returning a `presence`-only shape imagined by the brief's health.js mock data —
   the real shape (`mqtt_link.RobotRegistry.get_status` / `fakes.FakeRobotRegistry
   .get_status`) is `{robot_id, presence, last_ack, last_status, last_heartbeat,
   battery, docked, gates}`; the frontend renders those real fields.
4. **Frontend integrated into the existing admin shell** instead of the brief's
   self-mounting IIFE that creates its own `#tab-health` div and nav button via
   JS — Phase 3's `index.html`/`admin.js` tab system already exists and works, so
   `health.js` plugs into it (markup in `index.html`, one line in `admin.js`'s
   tab-click switch) rather than duplicating tab-management logic.
5. **No changes needed to `app.py`** — `app.state.observability = Observability()`
   was already wired by Phase 5 Task 3/4; Task 6 only reads it.
