# Moses Wave-2 backend — no-motion capabilities

Backend contract for three Wave-2, **no-motion** features the frontend builds against.
All new HTTP routes are **user-facing (NOT admin-gated)** but scoped to the caller's own
`session_id` — they only ever read that session's bound robot, never cross-session data —
and are **best-effort / never-500** (they degrade to `404` or `false`/`null`).

No motion, no robot commands, no bridge/safety/Device-Shadow code was touched. Only Python
files changed. Existing reply-frame fields, the emote-sync gate, and the legacy return
shapes are all preserved.

---

## 1. KB citation sources on chat replies

When a chat turn grounds on the KB (the model calls `retrieve_kb`), the WS reply frame now
carries the citation sources.

**Reply frame** (`type:"reply"` on `/ws/chat/{session_id}`) — existing fields unchanged,
one new field appended:

```json
{
  "type": "reply",
  "text": "woof! robert is a turtlebot 4",
  "emote": "happy",
  "gate_released": true,
  "turn_id": "…uuid…",
  "sources": [ { "title": "robert-facts.md", "url": null } ]
}
```

- `sources` — array of `{ "title": <str>, "url": <str|null> }`.
  - `title` = the KB doc key / name, derived from the S3 source URI basename
    (`s3://bucket/robert-facts.md` → `"robert-facts.md"`).
  - `url` = `null` (the S3-backed KB has no public link).
  - De-duplicated by title, in first-seen order.
  - **Empty list `[]`** for a turn that used no KB. The field is **always present** on the
    reply frame, so the frontend can rely on it (empty ⇒ hide the citations UI).

**Where it comes from:** `DogAgent.chat()` accumulates sources on the per-turn `captured`
dict (`kb_sources`) whenever `retrieve_kb` runs, and returns them as `result["sources"]`.
`ws_chat._run_pipeline` copies `result.get("sources", [])` onto the reply frame. The
`/api/chat` JSON turn result also now includes `sources` (same shape) for parity.

New KB helper: `guidemate_agent.kb.retrieve_passages_with_sources(query, …) -> (text, sources)`
— returns the same passage text as `retrieve_passages` (now a thin wrapper over it) plus the
structured sources list. Empty sources on error / empty result / `unknown-source` placeholder.

---

## 2. User-facing map routes

Stream the session's **bound robot's** latest SLAM map through the app's own IAM role
(`app.state.s3` + `maps.fetch_map_png` / `fetch_map_meta`). Robot resolved via
`sessions.robot_for_session(session_id)` (requires both a binding AND the live lock).

### `GET /api/session/{session_id}/map`
- **200** `image/png` — raw PNG bytes of the bound robot's `maps/{robot}/latest.png`.
- **404** `{"detail": "..."}` when: the session has no bound robot, no map object exists,
  or any S3 read fails. Never a 500 / traceback.

### `GET /api/session/{session_id}/map/meta`
- **200** `application/json` — the map's `meta.json`, e.g.
  `{ "captured_ts": "2026-07-06T12:00:00+00:00", "source": "/home/ubuntu/map.pgm" }`.
- **404** `{"detail": "..."}` — same conditions as above.

---

## 3. Agent arsenal status

### `GET /api/session/{session_id}/arsenal`
Moses's capability/tool status for THIS session. Not admin-gated. Never 500 — every field
degrades to `false`/`null` on any lookup error.

```json
{
  "knowledge":     { "available": true },
  "maps":          { "available": true },
  "human_handoff": { "available": true },
  "robot": {
    "bound": true,
    "robot_id": "turtlebot468",
    "dry_run": true,
    "motion_enabled": false
  },
  "safety": { "dry_run": true }
}
```

Field derivation:
- `knowledge.available` — `bool(cfg.kb_id)` (KB configured).
- `maps.available` — `true` only when a map object actually exists in S3 for the bound
  robot; `false` when unbound or on any S3 error.
- `human_handoff.available` — always `true`.
- `robot.bound` / `robot.robot_id` — from `sessions.robot_for_session` (binding + live lock).
- `robot.dry_run` / `robot.motion_enabled` — from the registry's `get_status(robot_id)`
  `gates` (`null` when unbound or status unreachable).
- `safety.dry_run` — **effective safety posture**: `true` when the session is unbound
  (can never move a robot) OR the bound robot reports `dry_run` true.

Unbound session example: `maps.available=false`, `robot={bound:false, robot_id:null,
dry_run:null, motion_enabled:null}`, `safety.dry_run=true`.

---

## Files changed
- `agent_service/guidemate_agent/kb.py` — `retrieve_passages_with_sources` + `_source_title`;
  `retrieve_passages` now wraps it.
- `agent_service/guidemate_agent/dog_agent.py` — `captured["kb_sources"]`, `_kb_impl` captures
  sources, `chat()` returns `sources`.
- `agent_service/guidemate_agent/ws_chat.py` — reply frame carries `sources`.
- `agent_service/guidemate_agent/app.py` — `GET …/map`, `…/map/meta`, `…/arsenal` routes.
- Tests: `tests/test_kb.py`, `tests/test_dog_agent` path via `tests/test_ws_chat.py`
  (KB-grounded vs non-KB reply frame), `tests/test_app.py` (map bound/no-robot/missing-key,
  arsenal bound/unbound).

## Verification
`349 passed, 24 skipped` (336 baseline + 13 new). Run from repo root with the worktree on
the path (the shared `.venv` editable-installs `guidemate_agent` from the main checkout, so
the worktree dir must precede it):
`PYTHONPATH=$PWD/agent_service .venv/bin/python -m pytest -q`.
