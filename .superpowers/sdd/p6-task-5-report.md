# Phase 6, Task 5 — Admin Maps tab (streamed-bytes endpoint + UI)

## Route

- `GET /api/admin/map/{robot_id}` → `Response(content=<png bytes>, media_type="image/png")`;
  404 if the key is absent (or any S3 read fails).
- `GET /api/admin/map/{robot_id}/meta.json` → `JSONResponse({"captured_ts", "source"})`; 404 if
  absent.
- Both live in `agent_service/guidemate_agent/admin.py` under the existing `router`
  (`/api/admin` prefix from Phase 3), right before the `/robot/{robot_id}/command` route.

## Auth reuse

No new auth was invented. Both routes take `_: bool = Depends(admin_required)` — the same
cookie-based dependency every other admin route uses (503 if `GUIDEMATE_ADMIN_PASSWORD` unset,
401 on missing/bad/expired signed cookie).

## S3 proxy approach

The maps bucket (`guidemate-maps-852373397000`) blocks public access, so the route proxies
bytes through the app's own IAM role rather than any public/presigned URL — this also keeps
the browser CSP-safe (no external fetch, same-origin `<img src>` cookie-authenticated).

- `app.state.s3 = boto3.client("s3", region_name=cfg.region)` created in `app.py`'s `lifespan`,
  alongside the KB manager, following the existing pattern of resources hung off `app.state`.
- `get_map`/`get_map_meta` call `fetch_map_png`/`fetch_map_meta` (Task 4's helpers) with
  `request.app.state.s3`, catching any exception (`KeyError` from the fake client in tests,
  `botocore.exceptions.ClientError` for a real missing key) and turning it into a 404 — "no map
  yet" is a normal, not-catastrophic state.

## Robot-picker UI

The Maps tab's `<select id="maps-robot">` is populated from `GET /api/admin/status` — the same
endpoint the existing Robot tab already uses to list `cfg.robot_ids` — not hardcoded to
`turtlebot468`. Switching the dropdown re-fetches `/map/{robot_id}/meta.json` then swaps
`<img src>` to `/map/{robot_id}?t=<cache-bust>`. Falls back to showing a
`#maps-empty` "No map uploaded yet." note (never a broken image or a 500) when the meta fetch
fails, and always shows the "How to refresh this map" `<details>` pointing at
`scripts/upload_map_from_pi.sh <robot_id>` (read-only tab; the uploader needs SSH so there is
no server-side upload button, per the brief).

## Test coverage

- `agent_service/tests/test_maps.py` (new, 7 tests, all pass): streams PNG bytes with
  `image/png` content-type; meta.json round-trips; missing map/meta → 404; unauthenticated
  request → 401; tampered cookie → 401; admin-unconfigured → 503. Uses an isolated
  `FastAPI()` + `admin.router` + a `FakeS3` stand-in, matching `test_admin.py`'s established
  `_make_app`/`_auth_header` pre-signed-cookie pattern (a `Secure` cookie is not resent by
  httpx over http).
- `agent_service/tests/e2e/test_admin_maps.py` (new, Playwright, `@pytest.mark.e2e`): boots a
  real uvicorn subprocess (`GUIDEMATE_FAKE_ROBOT=1`, real `app.state.s3`), logs in, opens the
  Maps tab, and asserts either the image finishes loading (`naturalWidth > 0`) or the
  empty-state note renders, plus that the refresh instructions are always visible. Ran it BOTH
  ways: default (`GUIDEMATE_E2E` unset) → `1 skipped`; and live (`GUIDEMATE_E2E=1`) against the
  real maps bucket → **passed**, which is direct evidence the real uploaded `turtlebot468` map
  streams and renders end-to-end.
- Full suite: `PYTHONPATH= .venv/bin/pytest -q` → **308 passed, 17 skipped**, no regressions.
  (This worktree had no `.venv`; one was created and `pip install -e` run for
  `shared/guidemate_msgs`, `agent_service[dev]`, `src/guide_mate_bridge`, plus the ad hoc
  `Pillow`/`amazon-transcribe --no-deps`/`matplotlib` deps the existing suite already needed —
  matches the main repo's venv contents, nothing new introduced by this task.)

## Brief-vs-reality adaptations

1. **`scripts/maps.py` re-homed into the package.** Task 4 deliberately left the S3/PGM
   helpers in a standalone `scripts/maps.py` with a comment that Task 5 "owns wiring
   `fetch_map_png`/`fetch_map_meta` into the FastAPI app and may re-home... this module at that
   point." Re-homed it to `agent_service/guidemate_agent/maps.py` (the package is
   editable-installed into `.venv`, so `from guidemate_agent.maps import ...` works cleanly in
   `admin.py` with no `sys.path`/`PYTHONPATH` hack). Updated the two other consumers to match:
   `scripts/test_maps.py` (import changed from a `sys.path.insert` + `import maps as m` to
   `from guidemate_agent import maps as m`) and `scripts/upload_map_from_pi.sh` (dropped the
   `PYTHONPATH="${REPO}/scripts"` prefix, now calls `from guidemate_agent.maps import
   pgm_to_png` directly). `MAPS_BUCKET`/`map_key`/`meta_key`/`fetch_map_png`/`fetch_map_meta`/
   `pgm_to_png` are otherwise byte-for-byte unchanged.
2. **No `templates/` or `static/admin.html` exists.** The real Phase 3 admin UI is
   `agent_service/static/admin/index.html` + `admin.js` (not a single `admin.html` with a
   `showTab()` helper as the brief assumed). The real tab pattern is
   `<nav class="tabs"><button data-tab="...">` + `<div id="tab-...">`, with a
   `document.querySelectorAll(".tabs button")` click handler that hides all `.tab` divs and
   shows the clicked one, dispatching to a `load*()` function per tab. Followed that exact
   pattern instead: added a `data-tab="maps"` button, a `#tab-maps` div, and a
   `loadMapsTab()` case in the existing dispatch (calls `populateMapsRobotSelect()` then
   `loadMap()`).
3. **Robot list source picked explicitly.** The brief's own HTML snippet hardcoded a single
   `<option value="turtlebot468">` and left "multi-robot" as an open question elsewhere; per
   this task's brief the picker must use "the same robot list source the rest of the admin
   panel uses" — that's `GET /api/admin/status` (`cfg.robot_ids`), which the existing Robot tab
   already calls via `loadRobots()`. Reused it rather than the `ROBOT_ID` constant (that
   constant is scoped to the Task 6 single-robot session/assignment demo, not general robot
   listing).
4. **Playwright e2e fixtures don't exist as named in the brief.** The brief assumed shared
   `page`/`admin_login`/`base_url` fixtures and an `e2e` marker from "Phase 5". In this repo
   there is no e2e `conftest.py` — `test_admin.py` (the real Phase-something e2e admin test)
   is fully self-contained: its own `server_url` module-scoped fixture (spawns a real uvicorn
   subprocess with `GUIDEMATE_FAKE_ROBOT=1`), its own `_login` helper, and `pytestmark =
   pytest.mark.e2e` (skipped by the root `conftest.py`'s `pytest_collection_modifyitems` unless
   `GUIDEMATE_E2E=1`). Copied that exact self-contained pattern for
   `test_admin_maps.py` instead of assuming shared fixtures.
5. **Real `app.state.s3` in the e2e test, not a fake.** Since the maps tab's whole point is
   streaming through the app's own real IAM role, the e2e test intentionally does NOT stub S3 —
   `admin.py`'s blanket `except Exception → 404` means the tab always renders one of its two
   states cleanly (image or empty note) regardless of what the real bucket call resolves to.
   Running it live against the real `guidemate-maps-852373397000` bucket showed the actual
   `turtlebot468` map loading (`naturalWidth > 0`), which is stronger evidence than a stub would
   have given — first draft of the assertion raced the `<img>` `hidden` flip against the actual
   network load and failed; fixed by waiting for `img.complete` before checking visibility.

## Files touched

- `agent_service/guidemate_agent/admin.py` — new imports (`JSONResponse`,
  `fetch_map_meta`/`fetch_map_png`) + the two map routes.
- `agent_service/guidemate_agent/app.py` — `import boto3` + `app.state.s3` in `lifespan`.
- `agent_service/guidemate_agent/maps.py` — moved here from `scripts/maps.py` (git-tracked
  rename), docstring updated to describe the re-home.
- `agent_service/static/admin/index.html` — `data-tab="maps"` nav button + `#tab-maps` panel.
- `agent_service/static/admin/admin.js` — `populateMapsRobotSelect`/`loadMap`/`loadMapsTab` +
  dispatch wiring + `#maps-robot` change listener.
- `scripts/test_maps.py`, `scripts/upload_map_from_pi.sh` — updated imports for the re-home.
- `agent_service/tests/test_maps.py` (new) — 7 unit tests.
- `agent_service/tests/e2e/test_admin_maps.py` (new) — gated Playwright test.
