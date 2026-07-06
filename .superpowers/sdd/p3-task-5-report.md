# Phase-3 Task 5 Report — Admin API + cookie auth (`admin.py`)

## Status
COMPLETE. Committed in worktree (no push). Controller to merge.

- Worktree branch: `worktree-agent-a5b933f3117ce40e8`
- Base SHA (after required merge of `6590675`): `6590675`
- Head SHA: `6a7d613` — "Kalhar: admin API + cookie auth (flags/prompt/status/kill-switch/KB)"
- The worktree started at `fe63d10` (did NOT contain `6590675`); merged `6590675` first per the brief, then implemented on top.

## Files
- NEW `agent_service/guidemate_agent/admin.py` — the `/api/admin` router.
- MOD `agent_service/guidemate_agent/config.py` — additive KB + `thing_names` fields (brief Step 1, verbatim).
- MOD `agent_service/guidemate_agent/app.py` — ONLY: import `admin`/`KBManager`, set `app.state.config`/`app.state.kb` in lifespan, `app.include_router(admin.router)`. Every existing route/behavior unchanged.
- NEW `agent_service/tests/test_admin.py`.
- Also installed/verified `python-multipart` (0.0.32) + `itsdangerous` (2.2.0) already present in `.venv`.

## Test summary
`PYTHONPATH=…/shared/guidemate_msgs:…/agent_service .venv/bin/pytest agent_service/tests/ -v`
→ **67 passed, 3 skipped**. Admin suite alone: **14 passed**.
The 3 skips are pre-existing live-AWS gates (`GUIDEMATE_INTEGRATION`, `GUIDEMATE_LIVE_KB`), unrelated to this task.
TDD followed: wrote `test_admin.py` first, confirmed ImportError fail, then implemented.

## Adaptations vs the brief (merged code wins)
1. **KB endpoints consume the post-merge KBManager dict shapes** (brief's Interfaces were stale):
   - `POST /kb` (upload): `kb.upload()` now returns `{"ok": bool, "error"?}`; endpoint returns `{"key": filename, **result}` (was hardcoded `{"ok": True, "key": …}`).
   - `POST /kb/sync`: `kb.start_ingestion()` now returns `{"ok": bool, "job_id"?, "error"?}`; endpoint passes it through (brief wrapped a string in `{"job_id": …}` — that shape no longer applies).
   - `DELETE /kb`: returns `{"key": key, **kb.delete()}` (delete now returns a dict).
   - `GET /kb/sync-status`: passes `kb.latest_job_status()` (`{"status": …}`) through unchanged (already compatible).
   - `FakeKB` in the test was updated to return these new shapes.
2. **Kill-switch hard safety guard added (task requirement beyond brief):** `KillBody` gained optional `motion_enabled`/`dry_run` fields; `_assert_kill_is_safe()` runs first and raises **400** if `motion_enabled is True` or `dry_run is False`, BEFORE any shadow write. The written `desired` is still hardcoded `{"dry_run": True, "motion_enabled": False}` and never sourced from the body. New test `test_kill_switch_refuses_to_enable_motion_even_when_authed` proves 400 for an authenticated request and that nothing is written to the fake shadow.
3. **Cookie assertion made case-insensitive:** this Starlette version emits `SameSite=strict` (lowercase value), so the brief's exact `"SameSite=Strict"` substring check fails against real output. Test now asserts `"samesite=strict" in set_cookie.lower()`. `HttpOnly`/`Secure`/max-age/strict-samesite are all still verified.
4. **Extra defensive tests added** (not in brief): `test_bad_cookie_rejected_401`, `test_kill_switch_unknown_robot_400`, `test_kb_delete`.

## Safety invariants verified
- No `GUIDEMATE_ADMIN_PASSWORD` → every admin route returns 503.
- Wrong password → 401; 6th failure inside 60 s window → 429 (in-process global counter).
- All non-login routes gated by signed HttpOnly/Secure/SameSite=strict cookie via `admin_required`.
- Kill switch is one-way-to-safe: only ever writes `dry_run=true`/`motion_enabled=false`; any attempt to enable motion or disable dry_run is refused 400 regardless of auth (test-proven).

## Concerns / notes
- `admin._failures` is a module-global in-process deque (per brief). Rate limiting is per-process, not shared across workers — acceptable for the single-process POC; noted for future multi-worker deployment.
- `app.state.kb = KBManager(...)` constructs real boto3 s3/bedrock-agent clients at lifespan startup (no network at client construction), consistent with the existing `ConfigStore` startup pattern; unit tests use `FakeKB` and never hit AWS.
- The kill-switch endpoint builds an `iot-data` boto3 client with `endpoint_url=https://{cfg.iot_endpoint}`; unit test monkeypatches `admin.boto3.client`. Not exercised against live AWS in this task.

## Report path
Written to worktree copy: `.superpowers/sdd/p3-task-5-report.md` (did not touch the main checkout).

## Follow-up: security review fix (S3 key sanitization + non-leaky KB errors)

Security review flagged (Important) `kb_upload` passing `file.filename` verbatim as
the S3 key: `None`/empty filename → `Key=None` → uncaught 500; `..`/slashes allowed
writing arbitrary prefixes.

**Fix in `admin.py` (endpoint layer only — `KBManager` untouched):**
- Added `_safe_key(filename: str | None) -> str`: `os.path.basename()` (drops any
  directory components / `..` traversal) → strip leading dots/whitespace → replace
  anything outside `[A-Za-z0-9._-]` with `_` → raise `HTTPException(400, "invalid
  filename")` if the input was `None`/empty or nothing safe remains after
  normalization.
- `POST /kb` (`kb_upload`) and `DELETE /kb` (`kb_delete`) both run their
  filename/key through `_safe_key()` before touching `KBManager`; the sanitized key
  is what's stored/deleted and echoed back in the response.

**Minor also folded in:** `kb.py`'s AWS-error `except` blocks (`upload`, `delete`,
`start_ingestion`, `latest_job_status`) now return `_safe_error(exc)` —
`f"{exc.__class__.__name__} (see logs)"` — instead of `str(exc)`, so raw AWS
exception text (bucket names, ARNs, request ids) never reaches an API response.
The full message is still `logger.warning`'d server-side unchanged. Existing
`test_kb.py` assertions only checked `"error" in result`, so no test changes were
needed there.

**TDD:** wrote failing tests first in `test_admin.py`:
- `test_kb_upload_sanitizes_path_traversal_filename` — `../../etc/passwd` → stored
  key `passwd`.
- `test_kb_delete_normalizes_nested_key` — delete key `a/../b` → normalized `b`.
- `test_kb_delete_rejects_empty_after_normalization` — key `../` → 400.
- `test_kb_upload_rejects_dotdot_only_filename` — filename `..` → 400.
- `test_safe_key_rejects_none_and_empty` — unit-tests `_safe_key(None)` /
  `_safe_key("")` directly for 400, since a multipart part with `filename=""`
  never reaches our handler as an `UploadFile` in the first place (python-multipart
  treats it as a plain form field and FastAPI 422s before our code runs — an even
  earlier rejection, so the original brief's "empty filename → 400 via the upload
  endpoint" case is provably unreachable through that path; confirmed empirically).

All green: `72 passed, 3 skipped` (`agent_service/tests/`).
