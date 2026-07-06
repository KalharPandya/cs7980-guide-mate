# Phase-3 Task 4 report — KBManager (S3 doc ops + Bedrock KB ingestion control)

**Status:** DONE ✅

## Worktree / branch
- Worktree: `/home/khouryloaner/cs7980/cs7980-guide-mate/.claude/worktrees/agent-a7a58f2685f01074d`
- Branch: `worktree-agent-a7a58f2685f01074d`
- Base SHA: `fe63d10747976d2dd65bc8923639cf5fb84959ff`
- Head SHA: `b5a2dfc9610c44301b0aac5ed66b103ba4571b5a`

## Files (committed — my two owned files ONLY)
- `agent_service/guidemate_agent/kb.py` (NEW) — `KBManager` class.
- `agent_service/tests/test_kb.py` (NEW) — fakes + 3 unit tests + 1 env-gated live test.

## What was built
`KBManager(bucket, kb_id, data_source_id, region="us-west-2", s3=None, agent=None)`:
- `list_docs() -> list[dict]` — S3 `list_objects_v2` → `{"key","size","modified(isoformat)"}`.
- `upload(key, data)` — S3 `put_object`.
- `delete(key)` — S3 `delete_object`.
- `start_ingestion() -> str` — `bedrock-agent.start_ingestion_job`, returns ingestion job id.
- `latest_job_status() -> dict` — `list_ingestion_jobs` (maxResults=1, sortBy STARTED_AT DESC) → `{"job_id","status"}`, or `{"status":"NONE"}` when no jobs.

Code is the brief's verbatim `KBManager` plus a module docstring. Clients are injectable for tests.

## TDD sequence
1. Wrote `test_kb.py` first → RED: `ModuleNotFoundError: No module named 'guidemate_agent.kb'`.
2. Appended `KBManager` to `kb.py` → GREEN.

## Test summary
Run: `PYTHONPATH=$PWD/shared/guidemate_msgs:$PWD/agent_service .venv/bin/pytest agent_service/tests/test_kb.py -v`
- `test_upload_then_list_then_delete` PASSED
- `test_start_ingestion_returns_job_id` PASSED
- `test_latest_job_status_none_then_complete` PASSED
- `test_live_list_docs_against_real_bucket` SKIPPED by default (env-gated on `GUIDEMATE_LIVE_KB=1`)

Result: **3 passed, 1 skipped.**

### Live test (run once for real, us-west-2, credential_process)
`GUIDEMATE_LIVE_KB=1 ... pytest ...::test_live_list_docs_against_real_bucket -s` → **PASSED**. Output:
```
live list_docs -> [{'key': 'robert-facts.md', 'size': 1304, 'modified': '2026-07-05T22:53:23+00:00'}]
live latest_job_status -> {'job_id': '2TYKLDFU28', 'status': 'COMPLETE'}
```
Confirms real bucket `guidemate-kb-docs-852373397000` (seed doc present), KB `A1NIQYZ0KQ`,
data source `OT8JLH57TE`, and a prior ingestion job COMPLETE. list_docs shape verified `{key,size,modified}`.

## Notes / concerns
- My worktree is based on `fe63d10`, which predates the `agent_service/` package scaffolding
  that parallel lanes create (present as uncommitted work in the main checkout on
  `kalhar/dog-agent-poc`). To run tests in isolation I created **untracked, uncommitted**
  `agent_service/guidemate_agent/__init__.py` and `agent_service/tests/__init__.py`; these
  are deliberately NOT committed (owned by other lanes; controller merge supplies the real
  ones). My commit contains ONLY `kb.py` + `test_kb.py` per the brief's step 5.
- `kb.py` is a brand-new file here (KBManager only) — no pre-existing `KBQuery` to append
  after, contrary to the brief's "append" wording. No conflict expected: KBManager is
  self-contained; if another lane also lands content in `kb.py`, both classes coexist.
- No changes outside my two owned files. Did not push.
- Report also written to the worktree copy at `.superpowers/sdd/p3-task-4-report.md`
  (harness blocks writing into the shared checkout from this isolated worktree).

## Review-fix follow-up (2026-07-05)

Fixed two review findings in `kb.py` (TDD: added failing tests first, then implemented).

1. **Graceful error handling.** Every public method (`list_docs`, `upload`, `delete`,
   `start_ingestion`, `latest_job_status`) now wraps its AWS call(s) in
   `try/except (botocore.exceptions.ClientError, botocore.exceptions.BotoCoreError)`,
   logs a `logger.warning(...)`, and returns a safe shape instead of propagating the
   raw exception:
   - `list_docs()` → `[]` on error.
   - `upload()` / `delete()` → `{"ok": False, "error": "<msg>"}` on error,
     `{"ok": True}` on success (previously returned `None`).
   - `start_ingestion()` → `{"ok": False, "error": "<msg>"}` on error,
     `{"ok": True, "job_id": "<id>"}` on success (previously returned the bare job-id
     string).
   - `latest_job_status()` → `{"status": "ERROR", "error": "<msg>"}` on error; happy-path
     shapes (`{"status": "NONE"}` / `{"job_id", "status"}`) unchanged.
2. **S3 pagination.** `list_docs()` now loops on `IsTruncated`/`NextContinuationToken`
   across multiple `list_objects_v2` pages instead of only reading the first page.
   Return type hint tightened to `list[dict]`.

Updated `test_kb.py`: adjusted `test_upload_then_list_then_delete` and
`test_start_ingestion_returns_job_id` for the new return shapes, and added
`FakePaginatedS3` (2-page listing), `RaisingS3` / `RaisingBedrockAgent` (raise
`ClientError`/`BotoCoreError` on every call) plus 6 new tests covering pagination and
each method's error path.

Test run: `PYTHONPATH=$PWD/agent_service .venv/bin/pytest agent_service/tests/test_kb.py -v`
→ **10 passed, 1 skipped** (the env-gated live test skipped as before).

No callers of `KBManager` exist elsewhere in `agent_service/`, so the changed
`upload`/`delete`/`start_ingestion` return shapes have no other call sites to update.
