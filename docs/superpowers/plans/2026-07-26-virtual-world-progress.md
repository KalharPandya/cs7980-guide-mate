# Virtual World Guide Fleet — Progress

Living status doc. Update this after every task completes or changes state. Task IDs below
match the task numbers in `2026-07-26-virtual-world-implementation-plan.md` (e.g. #1 = Task 0.1).

Worktree: `.claude/worktrees/feat+kalhar-virtual-world`, branch `feat/kalhar-virtual-world`.

**Rewritten 2026-07-31** — the previous version of this table had accumulated duplicate/conflicting
rows for #7, #9, #12, #13 from several interrupted sessions (some rows said "pending" for tasks that
were, per other rows in the same table, already done and reviewed). This version consolidates to one
row per task reflecting the real state as of commit `f433170` (2026-07-27 04:10, HEAD of this branch)
plus same-day (2026-07-31) re-verification.

## Status

| # | Plan task | Status | Notes |
|---|---|---|---|
| 1 | 0.1 Colyseus world-server scaffold | **done** | commits 55542ad + 98a7674. Spec+quality clean. |
| 2 | 0.2 Three.js/R3F client scaffold | **done** | commit 23f4c53. Spec+quality clean. Screenshot proof was env-blocked in the original session (Browser pane not compositing); not re-attempted since superseded by 3.1/3.2's own screenshot requirements. |
| 3 | 0.3 Floor-plan data | **done** | controller-authored, `world/data/floor-14.json`. |
| 4 | 0.4 CC0 asset fetch script | **done** | commit 7cf481d. Spec+quality clean. |
| 5 | 1.1 Navmesh generation | **done** | commits 2e63430 + 0d72704. Spec+quality clean, re-verified (tsc, build, test:nav 18/18 rooms path-reachable, patch-package durable). Re-reviewed again 2026-07-31 by a fresh independent reviewer as review debt cleanup — see Log. |
| 6 | 1.2 Crowd simulation loop | **done** | commits d58397f + 9a5ba5d (fix round: extracted shared `world/src/nav/agentProfile.ts`, added `onDispose` WASM cleanup, named the idle threshold). Measured baseline `crowd.update` ~0.008-0.010ms/tick @ 1 agent. |
| 7 | 1.3 Load test ~95 agents | **done** | commit 0aaa0e1. **GO.** Original run: avg ~0.6ms/tick, 0/22500 ticks over the 16.6ms budget. Independently re-measured fresh 2026-07-31 (see Log): 0/7500 ticks over budget, max 2.58ms. Confirmed twice now by two different reviewers on two different days. |
| 8 | 2.1 navigate command schema | **done** | commit 477006a. Spec+quality clean. |
| 9 | 2.2 Virtual fleet IoT identity | **script done, AWAITING KALHAR'S `--apply`** | commit b112d7c. Write-only (dry-run by default). I (controller) personally reviewed the script and the exact IAM policy JSON 2026-07-31 and dry-ran it — confirmed safe: least-privilege (`iot:Connect` scoped to `client/guidemate-*`, publish/subscribe scoped to `guidemate/virtual/*` + own shadow only), default-deny shadow init, idempotent. **I will not run `--apply` myself — that mutates real AWS IAM/account resources, which is Kalhar's call, not mine to make autonomously.** `docs/agent-poc/access-ground-truth.md` already documents it. Only gates the *live* half of Task 2.3's IoT round-trip; 2.3 can otherwise be built and gate-tested now. |
| 10 | 2.3 Node MQTT bridge | **done** | commits `8869e5d` + fix `63080af`. mqtt.js (justified over aws-iot-device-sdk-v2: no native aws-crt dependency). Spec+quality review found one real bug (idempotent/repeat navigate to an already-arrived target hung to a false `failed`/`nav_timeout` since it relied solely on an observed `moving→idle` edge) — fixed with a synchronous already-arrived check, independently re-reviewed and confirmed correct (traced the sync call stack to rule out the race the fix could have introduced). All 13 bridge tests + full `test:all` pass. |
| 11 | 3.1 Floor/wall geometry | **done** | commit fdcf089. Spec+quality clean. 1 floor mesh (hole subtracted), 54 walls (5 glass/49 solid), 18 room labels. |
| 12 | 3.2 Animated agents | **done (DONE_WITH_CONCERNS: pixel proof only)** | commits db08d2d + 5f28989 (fix round: shadow-camera frustum widened, DirectionalLight.target fixed, shared `agentMotion.ts` lerp helper). Caught and fixed 2 real bugs (heading double-convert, ref-vs-React-state clip switch). Only outstanding item is a literal screenshot, blocked by the same Browser-pane env limit as #2 — not a code concern. |
| 13 | 3.3 Colyseus client wiring + route line | **needs review** | commit f433170, most recent on the branch, has NOT had a completed review cycle (previous session's notes say "spec review dispatched" but no fix/re-review commit follows it — genuine review debt, not just stale doc). Reviewing now, 2026-07-31. |
| 14 | Phase 4 (Moses control, sim visitors, phone controller) | **in progress — 4.1 + 4.2 done** | Detailed task breakdown written 2026-07-31 (see implementation plan). **4.1** (sim visitor spawner + `requestGuide`), commit `1876b95`: found+fixed a real deadlock bug (naive fixed-offset trailing point sat in the robot's own future path under Detour's local avoidance; fixed with a position-history "conga line"). Steady-state ~45 simulated visitors held, no double-assignment. **4.2** (Moses `guide_to_room` tool + fleet `assign` command + bridge/mqtt_link routing), commit `ae3b2e0`: found+fixed TWO more real bugs — (a) the fleet topic `guidemate/virtual/fleet/cmd` structurally matched the per-robot wildcard regex, could have misrouted; exact-string-checked first now. (b) `mqtt_link.py`'s `guidemate/+/status` subscription is a single MQTT wildcard level and could never match virtual robots' 2-segment `guidemate/virtual/N/status` topics — no virtual robot ack/heartbeat was ever reaching the Python side before this fix. Cross-language Python-JSON-into-TS round-trip independently reproduced. Both tasks: spec review DONE, quality review "approved with minor follow-ups" (no blockers). **Deferred cleanup (non-blocking, bundle into one follow-up pass, don't spin individual fix cycles for these):** split `visitors.ts` (569 lines) into `escortManager.ts`+`simulatedVisitorSpawner.ts`; dedupe `mqtt_link.py`'s `send_command`/`send_fleet_command` (~25 duplicated lines) into a shared helper; import shared `maxSpeed` constant instead of `ASSUMED_ROBOT_SPEED_MPS` literal; `dog_agent.py` (505 lines) and `bridge.ts` (609 lines) both trending large across tasks, watch before the next tool/command addition. Task 4.3 (phone QR join) next. |
| 15 | Phase 5 (polish/demo hardening) | **pending** | Blocked by 14. |

## Decisions made (don't re-litigate)
- Branch `feat/kalhar-virtual-world` in an isolated worktree (this repo has multiple concurrent
  Claude sessions sharing the main tree — see memory `multi-agent-shared-worktree-git-discipline`).
- All subagents dispatched on Sonnet 5 (the session's resolved model), per user instruction.
- `world/data/floor-14.json` coordinates are eyeballed from the pasted floor plan images, not
  survey-accurate. Accepted as good-enough for a demo (per the design spec).
- Parallel dispatch only for tasks with disjoint file sets (see "Parallelization notes" at the
  bottom of the implementation plan). Never parallelize two tasks touching the same file.
- **Task 2.2's `--apply` step is controller-prohibited, not just "pending"**: creating/mutating AWS
  IoT things/policies/certs is an account security-settings change. The script is safe to review
  and dry-run, but only Kalhar runs it with `--apply`.

## How to resume if this session ends mid-flight
1. `EnterWorktree` with `path: .claude/worktrees/feat+kalhar-virtual-world` (or cd there).
2. Run `TaskList` — the harness tracker is being kept live this session (unlike earlier sessions
   where it was noted as reset/stale). If empty, rebuild it from this table's first non-done row.
3. Read this file's table for the narrative version + the Log below for the most recent activity.
4. Pick the lowest-numbered non-done, unblocked task and dispatch its implementer subagent using
   the full task text from `2026-07-26-virtual-world-implementation-plan.md` (Phase 4/5 tasks:
   use whatever detailed breakdown exists lower in this file once written).

## Architecture-video live-clip slice (2026-07-26, side excursion — historical, superseded)
An early throwaway demo slice (one hardcoded agent walking in a loop, a colored-box client) was
built to produce a requested architecture video before Tasks 1.2/3.2/3.3 existed for real. It is
now fully superseded by the real implementations of those tasks — `DemoAgents.tsx` was deleted
during Task 3.2/3.3 cleanup. Kept here only as historical context; nothing to resume from it.

## Log
- 2026-07-26: Design spec + implementation plan + task tracker created. floor-14.json authored.
  Worktree created. Phase 0 built and reviewed (#1-4). Phase 1 built and reviewed (#5-7, GO on
  the 95-agent load test). Phase 2's #8 (schema) and #9 (IoT identity script, write-only) built
  and reviewed. Phase 3 built and reviewed (#11, #12). Task 3.3 (#13) implemented but not
  reviewed before the session ended.
- 2026-07-31: Resumed under an open-ended "keep working until this is solid" directive. Verified
  the harness task tracker was genuinely empty (prior "reset" note confirmed still true).
  Personally reviewed and dry-ran Task 2.2's script (safe, correct, apply intentionally withheld
  from myself). Dispatched parallel review-debt agents for #5 (1.1, re-review since the doc trail
  was ambiguous), #7 (1.3, re-measure fresh), and #13 (3.3, first real review). #7 result: fresh
  independent measurement confirms GO (0/7500 ticks over budget, max 2.58ms) — consistent with
  the original claim, not just trusted. Rewrote this progress doc to remove the duplicate/
  conflicting rows. Dispatched research into the existing Moses agent-tool and chat-frontend
  architecture to ground Phase 4's detailed task breakdown. Dispatching Task 2.3 (MQTT bridge)
  implementer since it's unblocked and doesn't need #9 applied to be built and gate-tested.
- 2026-07-31 (continued): Phase 4 completed (4.1, 4.2, 4.3 all done and reviewed, commits
  `1876b95`/`ae3b2e0`/`a871b05`). Task 4.3's own e2e testing surfaced a real production bug Task
  4.2 introduced: the WS chat production path's `CaptureRegistry` never got a `send_fleet_command`
  method, so every real "take me to room X" chat request silently failed (`AttributeError`,
  swallowed, generic apology reply) — `guide_to_room` never actually dispatched a robot in
  production despite passing all of Task 4.2's own tests (which used a purpose-built fake, never
  `CaptureRegistry`). Fixed in commit `578ed12`, which also found and fixed a second real bug
  (`FakeRobotRegistry` missing a `collect_all` kwarg, breaking the `GUIDEMATE_FAKE_ROBOT=1` demo
  path specifically). Phase 5 detailed and started: 5.4 (kiosk mode) done+reviewed, commit
  `52d9138`. 5.2 (fleet kill-switch) and 5.3 (emote mirroring) in flight. **Process note**: the
  578ed12 fix agent used a bare `git stash`/`git stash pop` on this shared worktree mid-task
  (against the project's own git-discipline rule for shared worktrees) to get a clean diff view;
  it reports a clean round-trip with no data loss, verified by the controller afterward (repo
  history sane, other agents' concurrent uncommitted work intact) — flagging here as a reminder
  this keeps recurring under time pressure, not because it caused damage this time. Also noted:
  running many agents' full test suites concurrently in this one worktree causes real memory
  contention (one agent got OOM-killed mid-run) — worth throttling parallel full-suite runs in
  future dispatches rather than always running everything in parallel.
