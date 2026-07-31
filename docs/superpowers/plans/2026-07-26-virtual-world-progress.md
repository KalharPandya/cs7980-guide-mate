# Virtual World Guide Fleet: Progress

Living status doc. Update this after every task completes or changes state. Task IDs below
match the task numbers in `2026-07-26-virtual-world-implementation-plan.md` (e.g. #1 = Task 0.1).

Worktree: `.claude/worktrees/feat+kalhar-virtual-world`, branch `feat/kalhar-virtual-world`.

**Rewritten 2026-07-31**: the previous version of this table had accumulated duplicate/conflicting
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
| 5 | 1.1 Navmesh generation | **done** | commits 2e63430 + 0d72704. Spec+quality clean, re-verified (tsc, build, test:nav 18/18 rooms path-reachable, patch-package durable). Re-reviewed again 2026-07-31 by a fresh independent reviewer as review debt cleanup, see Log. |
| 6 | 1.2 Crowd simulation loop | **done** | commits d58397f + 9a5ba5d (fix round: extracted shared `world/src/nav/agentProfile.ts`, added `onDispose` WASM cleanup, named the idle threshold). Measured baseline `crowd.update` ~0.008-0.010ms/tick @ 1 agent. |
| 7 | 1.3 Load test ~95 agents | **done** | commit 0aaa0e1. **GO.** Original run: avg ~0.6ms/tick, 0/22500 ticks over the 16.6ms budget. Independently re-measured fresh 2026-07-31 (see Log): 0/7500 ticks over budget, max 2.58ms. Confirmed twice now by two different reviewers on two different days. |
| 8 | 2.1 navigate command schema | **done** | commit 477006a. Spec+quality clean. |
| 9 | 2.2 Virtual fleet IoT identity | **script done, AWAITING KALHAR'S `--apply`** | commit b112d7c. Write-only (dry-run by default). I (controller) personally reviewed the script and the exact IAM policy JSON 2026-07-31 and dry-ran it: confirmed safe, least-privilege (`iot:Connect` scoped to `client/guidemate-*`, publish/subscribe scoped to `guidemate/virtual/*` + own shadow only), default-deny shadow init, idempotent. **I will not run `--apply` myself: that mutates real AWS IAM/account resources, which is Kalhar's call, not mine to make autonomously.** `docs/agent-poc/access-ground-truth.md` already documents it. Only gates the *live* half of Task 2.3's IoT round-trip; 2.3 can otherwise be built and gate-tested now. |
| 10 | 2.3 Node MQTT bridge | **done** | commits `8869e5d` + fix `63080af`. mqtt.js (justified over aws-iot-device-sdk-v2: no native aws-crt dependency). Spec+quality review found one real bug (idempotent/repeat navigate to an already-arrived target hung to a false `failed`/`nav_timeout` since it relied solely on an observed `moving→idle` edge), fixed with a synchronous already-arrived check, independently re-reviewed and confirmed correct (traced the sync call stack to rule out the race the fix could have introduced). All 13 bridge tests + full `test:all` pass. |
| 11 | 3.1 Floor/wall geometry | **done** | commit fdcf089. Spec+quality clean. 1 floor mesh (hole subtracted), 54 walls (5 glass/49 solid), 18 room labels. |
| 12 | 3.2 Animated agents | **done (DONE_WITH_CONCERNS: pixel proof only)** | commits db08d2d + 5f28989 (fix round: shadow-camera frustum widened, DirectionalLight.target fixed, shared `agentMotion.ts` lerp helper). Caught and fixed 2 real bugs (heading double-convert, ref-vs-React-state clip switch). Only outstanding item is a literal screenshot, blocked by the same Browser-pane env limit as #2, not a code concern. |
| 13 | 3.3 Colyseus client wiring + route line | **done** | commit f433170. Reviewed 2026-07-31 (closed the review debt): DONE, real navmesh path route line confirmed live, interpolation confirmed real (lerp, not snap). Pixel proof still env-blocked (Browser pane compositing limit), not a code concern. |
| 14 | Phase 4 (Moses control, sim visitors, phone controller) | **done, all tasks implemented and reviewed** | Detailed task breakdown written 2026-07-31 (see implementation plan). **4.1** (sim visitor spawner + `requestGuide`), commit `1876b95`: found+fixed a real deadlock bug (naive fixed-offset trailing point sat in the robot's own future path under Detour's local avoidance; fixed with a position-history "conga line"). Steady-state ~45 simulated visitors held, no double-assignment. **4.2** (Moses `guide_to_room` tool + fleet `assign` command + bridge/mqtt_link routing), commit `ae3b2e0`: found+fixed TWO more real bugs: (a) the fleet topic `guidemate/virtual/fleet/cmd` structurally matched the per-robot wildcard regex, could have misrouted; exact-string-checked first now. (b) `mqtt_link.py`'s `guidemate/+/status` subscription is a single MQTT wildcard level and could never match virtual robots' 2-segment `guidemate/virtual/N/status` topics, so no virtual robot ack/heartbeat was ever reaching the Python side before this fix. Cross-language Python-JSON-into-TS round-trip independently reproduced. **4.3** (phone QR join + visitor-bound banner), commit `a871b05`: e2e-tested twice, real Bedrock call, both green. Surfaced (and a follow-up commit `578ed12` fixed) a THIRD real bug: the production WS chat path's `CaptureRegistry` never got a `send_fleet_command`, so every real chat-driven guide request was silently failing in production despite passing all of 4.2's own tests. All three tasks: spec review DONE, quality review approved (4.1/4.2 "with minor follow-ups", 4.3 clean). Deferred cleanup items from 4.1/4.2 reviews (splitting `visitors.ts`, deduping `mqtt_link.py`) done as follow-up commits `cb86902`/`5ebcbd2`, see below. |
| 15 | Phase 5 (polish/demo hardening) | **done, all tasks implemented and reviewed** | 5.1 (containerize world-server as third Compose service, commits `e9ef883`+`d179522`): safe (no real AWS/infra touched, verified), a real `.dockerignore` bug found+fixed (unanchored `src/` silently excluded `world/src` from the build context), Docker daemon unreachable in this sandbox so build/up were validated as far as possible without one. 5.2 (fleet kill-switch, commit `f6b79f2`+`40f19c7`+`cd9aef0`): found+fixed a real pause/nav_timeout wall-clock interaction bug, fix verified via actual mutation testing (sabotaged the fix twice, confirmed the strengthened regression test catches both failure modes). 5.3 (emote mirroring, commit `b3919b9`): approved clean. 5.4 (kiosk mode, commit `52d9138`): approved clean. 5.5 (risk register + rehearsal checklist, controller-authored): `docs/superpowers/specs/2026-07-31-virtual-world-risk-register.md`. **Nothing in this project has been deployed to real production infrastructure or run against real AWS IoT Core** -- see the risk register's top risks; that's Kalhar's action from here. |

## Decisions made (don't re-litigate)
- Branch `feat/kalhar-virtual-world` in an isolated worktree (this repo has multiple concurrent
  Claude sessions sharing the main tree, see memory `multi-agent-shared-worktree-git-discipline`).
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
2. Run `TaskList`: the harness tracker is being kept live this session (unlike earlier sessions
   where it was noted as reset/stale). If empty, rebuild it from this table's first non-done row.
3. Read this file's table for the narrative version + the Log below for the most recent activity.
4. Pick the lowest-numbered non-done, unblocked task and dispatch its implementer subagent using
   the full task text from `2026-07-26-virtual-world-implementation-plan.md` (Phase 4/5 tasks:
   use whatever detailed breakdown exists lower in this file once written).

## Architecture-video live-clip slice (2026-07-26, side excursion: historical, superseded)
An early throwaway demo slice (one hardcoded agent walking in a loop, a colored-box client) was
built to produce a requested architecture video before Tasks 1.2/3.2/3.3 existed for real. It is
now fully superseded by the real implementations of those tasks; `DemoAgents.tsx` was deleted
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
  independent measurement confirms GO (0/7500 ticks over budget, max 2.58ms), consistent with
  the original claim, not just trusted. Rewrote this progress doc to remove the duplicate/
  conflicting rows. Dispatched research into the existing Moses agent-tool and chat-frontend
  architecture to ground Phase 4's detailed task breakdown. Dispatching Task 2.3 (MQTT bridge)
  implementer since it's unblocked and doesn't need #9 applied to be built and gate-tested.
- 2026-07-31 (continued): Phase 4 completed (4.1, 4.2, 4.3 all done and reviewed, commits
  `1876b95`/`ae3b2e0`/`a871b05`). Task 4.3's own e2e testing surfaced a real production bug Task
  4.2 introduced: the WS chat production path's `CaptureRegistry` never got a `send_fleet_command`
  method, so every real "take me to room X" chat request silently failed (`AttributeError`,
  swallowed, generic apology reply): `guide_to_room` never actually dispatched a robot in
  production despite passing all of Task 4.2's own tests (which used a purpose-built fake, never
  `CaptureRegistry`). Fixed in commit `578ed12`, which also found and fixed a second real bug
  (`FakeRobotRegistry` missing a `collect_all` kwarg, breaking the `GUIDEMATE_FAKE_ROBOT=1` demo
  path specifically). Phase 5 detailed and started: 5.4 (kiosk mode) done+reviewed, commit
  `52d9138`. 5.2 (fleet kill-switch) and 5.3 (emote mirroring) in flight. **Process note**: the
  578ed12 fix agent used a bare `git stash`/`git stash pop` on this shared worktree mid-task
  (against the project's own git-discipline rule for shared worktrees) to get a clean diff view;
  it reports a clean round-trip with no data loss, verified by the controller afterward (repo
  history sane, other agents' concurrent uncommitted work intact); flagging here as a reminder
  this keeps recurring under time pressure, not because it caused damage this time. Also noted:
  running many agents' full test suites concurrently in this one worktree causes real memory
  contention (one agent got OOM-killed mid-run); worth throttling parallel full-suite runs in
  future dispatches rather than always running everything in parallel.
- 2026-07-31 (continued): Phase 5 completed in full. 5.1 (containerize world-server, commits
  `e9ef883`+`d179522`): safe, no real AWS/infra touched; found+fixed a real `.dockerignore` bug
  that would have silently excluded `world/src` from every Docker build context. 5.2 (fleet
  kill-switch, commits `f6b79f2`+`40f19c7`+`cd9aef0`): found+fixed a real pause/nav_timeout
  wall-clock interaction bug, then found the FIX's own regression test didn't actually
  distinguish the bug it claimed to catch, so strengthened it and verified via real mutation
  testing (sabotaged the fix twice, confirmed the test catches both failure modes, reverted
  cleanly). 5.3 (emote mirroring, `b3919b9`) and 5.4 (kiosk mode, `52d9138`): both approved
  clean on first review. 5.5 (risk register + rehearsal checklist, controller-authored):
  `docs/superpowers/specs/2026-07-31-virtual-world-risk-register.md`, the definitive place to
  look for what still needs Kalhar's own action (real AWS mutation, real deploy, physical
  presence for robot 468 safety, actually looking at the rendered scene). Also cleaned up two
  non-blocking code-quality items deferred from earlier reviews: deduped `mqtt_link.py`'s
  `send_command`/`send_fleet_command` (commit `5ebcbd2`) and split `visitors.ts` into
  `escortManager.ts`+`simulatedVisitorSpawner.ts` (commit `cb86902`), both pure refactors,
  independently re-verified as zero behavior change. Full repo health check at this point: `world/`
  build+test:all clean, `world-client/` build clean, `shared/guidemate_msgs` 45/45 pass,
  `agent_service` 247 passed/9 skipped/1 pre-existing unrelated failure (stale "Robert" branding
  assertion, not this project's responsibility). **Every task in the implementation plan
  (Phases 0 through 5) is now implemented and reviewed.** What remains is entirely Kalhar's own
  action per the risk register: apply the virtual-fleet IoT identity, deploy world-server, and
  rehearse end to end with a human watching robot 468 if the emote mirror is enabled.
