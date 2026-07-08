# Phase-6 Task 4 report — S3 maps bucket + operator upload script

## Status: DONE

## Scope deviation (deliberate, per parent instructions)
Parent brief explicitly said "Do NOT touch agent_service (the Maps tab is Task 5)," which
conflicts with the task-4 brief file's literal paths (`agent_service/guidemate_agent/maps.py`,
`agent_service/tests/test_maps.py`). Resolved by placing the conversion/key-helper module
and its tests in `scripts/` instead (mirrors the existing `scripts/collect_claude_conversations.py`
+ `scripts/test_collect_claude_conversations.py` pattern: standalone module, sys.path-inserted
test file). Content matches the brief's `maps.py` verbatim (same functions/docstrings), just
relocated. Task 5 can import/relocate into `agent_service` when it wires the admin endpoint.

## Files
- `scripts/maps.py` — `MAPS_BUCKET`, `map_key`, `meta_key`, `pgm_to_png` (Pillow), plus
  `fetch_map_png`/`fetch_map_meta` (boto3 helpers for the future Task-5 endpoint).
- `scripts/test_maps.py` — unittest-style, run via pytest: key helpers, pgm→png round-trip
  (uniform + non-uniform pixel data), and fetch helpers against a fake boto3 client.
- `scripts/upload_map_from_pi.sh` — operator-run, read-only probe of the Pi, scp, local
  convert, meta.json, `aws s3 cp` upload. `chmod +x` set; `bash -n` syntax-checked OK.
- `docs/agent-poc/access-ground-truth.md` — new row in the "Dog-agent POC dev resources"
  table documenting the bucket + the verified real upload.

## Worktree / branch
`/home/khouryloaner/cs7980/cs7980-guide-mate/.claude/worktrees/agent-ab1cacf68ee72f800`,
branch `worktree-agent-ab1cacf68ee72f800`.

## Base / head SHAs
Base merged in: `45ff4ff` (fast-forwarded from `fe63d10`). Head after commit: `4329b7d`.

## Tests
`PYTHONPATH=$PWD/shared/guidemate_msgs .venv/bin/pytest scripts/test_maps.py -v` →
**7 passed** (key helpers x3, pgm→png round-trip x2, fetch helpers x2). Pillow already
present in the main venv (12.3.0) — no reinstall needed.

## Bucket (real, verified)
Created `guidemate-maps-852373397000` in `us-west-2` via `s3api create-bucket`. Verified:
`get-bucket-tagging` → `project=guidemate-poc`; `get-public-access-block` → all four flags
`true`; `get-bucket-location` → `us-west-2`.

## Pi probe (read-only, real)
`ssh guidemate 'ls -t ~/*.pgm ~/maps/'` found a **real saved map**:
`/home/ubuntu/maps/guide_mate_map.pgm` (+ sidecar `.yaml`), newer than a stray
`/home/ubuntu/my_map.pgm`. No probe/find commands modified anything on the Pi.

## Upload (real, not synthetic)
Ran the script's logic against the real map: scp'd both files, converted via
`scripts/maps.py:pgm_to_png` → 174x200 8-bit grayscale PNG, wrote `meta.json`
(`source=/home/ubuntu/maps/guide_mate_map.pgm`), uploaded to
`s3://guidemate-maps-852373397000/maps/turtlebot468/{latest.png,meta.json}`, confirmed
present via `list-objects-v2`. (Ran the equivalent commands manually rather than invoking
the shell script directly, since the worktree has no `.venv` of its own — the script's
`REPO`-relative venv path only resolves correctly from the main repo checkout, which is how
it will actually be operator-run.)

## Concerns
- The script hard-codes `${REPO}/.venv/bin/python`; only runnable from the real repo root
  with its `.venv` (not from an isolated worktree) — expected/by design for an operator tool,
  noted here for the controller's awareness.
- Task 5 will need to decide whether to import `scripts.maps` from `agent_service` or copy
  the module in; flagged in both this report and a code comment in `scripts/maps.py`.

## Report path
`.superpowers/sdd/p6-task-4-report.md` (this file).
