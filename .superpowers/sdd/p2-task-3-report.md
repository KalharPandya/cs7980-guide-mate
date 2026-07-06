# P2 Task 3 Report — ShadowSync + delivery check + graceful SIGTERM

**Status:** COMPLETE. All 8 brief steps done via TDD (RED → GREEN). 26/26 bridge tests pass.

## Worktree / branch
- Worktree: `/home/khouryloaner/cs7980/cs7980-guide-mate/.claude/worktrees/agent-afcd3cc898cf454aa`
- Branch: `worktree-agent-afcd3cc898cf454aa`
- Base: worktree was branched from `fe63d10` (stale). Ran `git merge --ff-only 2a98987` → fast-forwarded to current bridge-T2 code before starting.

## What was implemented
- **New `shadow.py`**: `shadow_topic(thing, suffix)` + `ShadowSync`. `start()` subscribes get/accepted, get/rejected, update/delta, update/accepted; publishes empty `get`; waits `get_timeout_s` on a threading.Event; then `publish_reported()`. Missing/rejected/timeout → defaults stay LOCKED but still reports. **Subscribe-denied → returns early, `_subscribed=False`, never publishes any shadow topic** (AWS drops connection on unauthorized publish). Delta applies live + republishes reported.
- **`iot_client.py`**: `publish()` now unpacks `(future, _)` and attaches a **non-blocking** `add_done_callback` warn-on-failure delivery check (never `future.result()` inline — publish runs on awscrt callback threads; blocking would deadlock). New `disconnect()`.
- **`bridge.py`**: Phase-1 `SystemExit` dry-run guard **replaced** by env-OR-shadow composition — `SafetyState(env_dry_run=_truthy(env))`; env=0 logs a prominent warning and continues (no cmd_vel publisher exists). New `GUIDEMATE_THING_NAME` (default `Turtlebot-468`). `main()` starts Bridge + ShadowSync, installs SIGTERM/SIGINT handlers → `stop_event`. Module-level `_graceful_shutdown(client, shadow, robot_id, telemetry, heartbeat)`: publish `{"event":"offline","graceful":true}` → final `publish_reported()` → `disconnect()` → stop telemetry.
- **`executor.py`** (reviewer note, folded into same commit): one-line comment where `build()` reads `self._safety.max_speed`, noting the read is intentionally outside the `gates()` snapshot — safe at any read time because the shadow can only clamp it monotonically down.

## Tests
- New `tests/test_shadow.py` (7 tests: topic helper, get-accepted applies+reports, get-rejected locks, get-timeout locks, delta live+republish, delta cannot loosen env dry-run, subscribe-denied silent).
- `tests/test_bridge.py`: retired Phase-1 `test_main_refuses_without_dry_run` (removed `pytest`/`main` imports); added FakeFuture.add_done_callback + FakeConnection.disconnected; new `test_graceful_shutdown_publishes_offline_then_reported_then_disconnects`.
- RED confirmed first (ModuleNotFoundError shadow / ImportError _graceful_shutdown), then GREEN.
- Command: `PYTHONPATH=$PWD/shared/guidemate_msgs:$PWD/src/guide_mate_bridge .venv/bin/pytest src/guide_mate_bridge/tests/ -v` → **26 passed**. pytest rootdir = worktree; imports resolve from worktree code.

## Concerns
- None blocking. All changes confined to `src/guide_mate_bridge/**` (+ this report). `shared/` untouched; agent_service lane not touched.

---

## Review fixes (follow-up)

**Finding 1 (Important) — shadow delta feedback loop.** `SafetyState.reported()` reported the EFFECTIVE dry_run (env OR shadow). With `GUIDEMATE_DRY_RUN=1` and an operator setting `desired.dry_run=false`, desired never equalled reported, so AWS re-emitted `update/delta` on every reported publish and `_on_delta` republished reported → infinite storm. **Fix:** `reported()` now echoes the SHADOW-level value (`dry_run: _shadow_dry_run`) so the shadow converges, and surfaces the effective value under a SEPARATE `effective_dry_run` key. AWS computes the delta only over keys present in `desired`, and `effective_dry_run` is never a desired key, so it cannot cause a delta (reasoning captured in the `reported()` docstring). `gates()` / acks are unchanged and remain the enforcement surface (still effective).

**Finding 2 (Important) — final publishes may not flush before disconnect.** `_graceful_shutdown` fire-and-forgot the offline event + final reported, then disconnected; a clean disconnect suppresses the LWT, so observers could see nothing. **Fix:** new `IotClient.publish_sync(topic, payload, timeout_s=3.0)` blocks on the puback (warns on timeout, never raises) — safe only from the main thread. `_graceful_shutdown` now `publish_sync`es the offline event and calls `shadow.publish_reported(sync=True)` BEFORE `disconnect()`. Async `publish()` (with `add_done_callback`) is unchanged for all callback-thread callers.

**Minors folded in:** JSON guards in `_on_get_accepted` / `_on_delta` broadened to `(json.JSONDecodeError, AttributeError, TypeError)` so non-object JSON (null/number/list) is caught; redundant `dict()` copy of `reported()` dropped (it already returns a fresh dict); `update/rejected` subscription left unimplemented with a `FUTURE OBSERVABILITY` comment in `start()`.

## Tests (follow-up)
- `test_shadow.py`: added `test_reported_dry_run_converges_no_delta_storm` — desired `{dry_run: False}` under env dry-run ON → reported `dry_run == False` (converges), `effective_dry_run == True`, `gates()["dry_run"] == True`.
- `test_bridge.py`: added `test_graceful_shutdown_flushes_publishes_before_disconnect` — a RecordingFuture whose `add_done_callback` does NOT resolve synchronously proves the two final publishes block on their puback (`.result()`) BEFORE `disconnect()`.
- `test_safety.py`: `test_reported_uses_effective_dry_run` (which pinned the old buggy behavior) updated to `test_reported_dry_run_echoes_shadow_effective_separate`.
- RED confirmed first (both new tests failing; the shutdown fake corrected so the async path no longer masks the bug), then GREEN.
- Command: `PYTHONPATH=$PWD/shared/guidemate_msgs:$PWD/src/guide_mate_bridge .venv/bin/pytest src/guide_mate_bridge/tests/ -v` → **28 passed**.

## Deviation
- The try/except + warn-log for the shutdown flush lives INSIDE `publish_sync` (so it applies uniformly to both the offline event and the reported publish) rather than inline in `_graceful_shutdown`; `publish_sync` warns instead of raising, so shutdown always proceeds to `disconnect()`.
