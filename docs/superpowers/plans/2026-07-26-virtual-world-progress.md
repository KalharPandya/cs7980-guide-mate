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
| 7 | 1.3 Load test ~95 agents | **done** | commit 0aaa0e1. **GO.** Original run: avg ~0.6ms/tick, 0/22500 ticks over the 16.6ms budget. Independently re-measured fresh 2026-07-31 (see Log): 0/7500 ticks over budget, max 2.58ms. Confirmed twice now by two different reviewers on two different days. **Scoping correction, 2026-08-03:** that number is `AgentCrowd.tick()` alone (loadtest.ts's own doc comment always said so), not the real per-frame `WorldRoom.update()` cost -- it excludes the Colyseus schema sync loop and `VisitorManager.tick()`. It had been quoted elsewhere (access-ground-truth.md, the risk register) as if it were the per-frame cost; both corrected. New harness `world/scripts/frametest.ts` (`npm run test:frame`) measures the real full-frame cost at the real 95-agent steady state: avg 0.53ms, max 1.48ms, p95 0.64ms, 0/7500 ticks over the 16.6ms budget on the same dev machine -- still comfortably under budget, just a different, strictly-larger quantity than the crowd-only figure. Route recomputation (`computePath`, off-tick via `moveAgentTo`): ~0.02ms/call, and a worst-case burst of all 50 robots re-tasked in one tick adds +1.85ms, still under budget. |
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
- 2026-08-02: **Kalhar ran the demo and found two things the entire Phase 0-5 review process
  had missed.** Both were real, both are instructive about where the verification was weak.

  **(1) "Only one robot is moving, people are stuck in a corner."** `WorldRoom.onCreate()`
  seeded exactly ONE robot (`test-robot-1`) while the spawner targeted 45 visitors, so
  `requestGuide` bound the single robot to visitor #1 and returned `null` for the other 44,
  who then sat at the entrance forever. The design spec had always called for ~50 robots;
  the production fleet spawn was simply never written. **Why every test passed anyway:**
  `visitors.test.ts` manually spawned ~50 test robots before exercising `requestGuide`, so
  the suite only ever tested a 50-robot world that existed exclusively inside the tests.
  Fixed in `bf06612`: `GUIDE_ROBOT_COUNT = 50`, ids `virtual/1..50` (matching the IoT topic
  scheme), spawns distributed deterministically over the navmesh via `findClosestPoint` in
  `guideFleetSpawns.ts` so they do not spawn stacked and shove each other. Live-verified:
  95 agents, 71-77 moving simultaneously, 117 of 135 distinct agents changing position.

  **(2) "The map doesn't match the map I gave you."** Correct. `floor-14.json` was a previous
  session's freehand approximation, and its own `source` field admitted it. The real plan is a
  pinwheel plate with angled wings and TWO core service bands; the file modelled it as an
  axis-aligned 36x21 rectangle with one rectangular hole. **The source images had been pasted
  into a chat and never committed** - recovered this session by extracting the base64 out of an
  old session transcript, and now committed at `world/data/source/` (both the original scan and
  a higher-DPI one) so they cannot be lost again. Re-traced algorithmically (OpenCV/Hough)
  rather than by eye.

  **The most important finding of the day, though, was a test that lied.**
  `buildNavMesh.test.ts` claimed "18/18 rooms path-reachable" while asserting only that
  `computePath` returned `success` with a non-empty path. **Detour returns success on a PARTIAL
  path** - when the target is unreachable it silently hands back a path to the nearest reachable
  point. Rooms 1407/1408/1409 were genuine dead ends the whole time, and the escort code
  (`escortManager.ts` decides "arrived" by the robot going idle) could not distinguish *stuck*
  from *arrived*, so escorts there falsely reported success and stranded robots mid-corridor.
  Strengthened in `bd3aefd` to assert the path's final point actually lands within
  `AGENT_RADIUS_M * 2` of the target AND that `DT_PARTIAL_RESULT` is clear, validated against a
  known-broken case first. It has since caught a further regression in the wild.

  Subsequent map fixes: doors moved off the corridor onto their real thresholds (`642ba65`,
  Event Space was 8.7m from its own centre), glass walls restored after an algorithmic rebuild
  silently dropped them (`6f11d0b`), Wellness Room found 5m adrift inside South Collaboration
  Space with 4 "walls" that were actually the extraction tracing its own label glyphs
  (`38ce3a4`), 1430 and 1407 centres corrected (`38ce3a4`, `d0f5adb`).

  **A false alarm worth recording, since it cost a subagent run:** the controller swept room
  centres against label positions and reported the whole east tip as 3-5m displaced. It was not
  - the label pixel positions had been *eyeballed*. Re-measured properly by pixel bounding box,
  Kitchen was 0.68m not 4.2m, 1408 0.27m not 3.8m. Only 1407 was genuinely (mildly) off. The
  lesson is the same one as (1) and the partial-path bug: **a measurement you did not actually
  make is not evidence.**

  Scale (`0.075214` m/px) had always been assumed. Now independently derived from the drawing
  itself (`7ce7817`) - elevator shafts, core corridor width and stair-tread pitch all bracket it,
  stair treads centring almost exactly on it. Confirmed, geometry unchanged. The door-width
  method was tried first and *failed* (at ~7.5cm/px a door gap is 9-12px, indistinguishable from
  this floor's corner jogs) and was reported as failed rather than forced.

  `world-client` had **zero tests** despite being the entire visual surface and consuming a
  `floor-14.json` that changed eight times in one day. Suite added in `6132bc2`, every guard
  proven by breaking the thing it protects and watching it fail: the two `floor-14.json` copies
  must be byte-identical (nothing but convention enforced that before), glass walls must survive
  a rebuild, `directionToYRotation` differs from the server's heading formula by exactly -pi/2
  (pinning the convention behind this project's documented double-convert bug), and camera
  framing must contain every wall endpoint, room centre and door.

  **Open at time of writing:** a concurrent Claude session is mid-re-trace in this shared
  worktree with uncommitted changes (156 walls replaced, outline 18->20 points, washroom doors
  moved) that currently leave the map at 17/18 reachable - Gender Neutral Washroom 0.85m short,
  `DT_PARTIAL_RESULT` set. Not reverted deliberately: it is live work, and this worktree has had
  repeated collisions today from two sessions editing one file. The committed state is good at
  18/18; the breakage is working-tree only.

  **Process note for whoever reads this next.** Phases 0-5 were built with implementer +
  spec-review + quality-review on every task, and all of it passed while the product had a
  one-robot fleet, a wrong-shaped map, three unreachable rooms, and a reachability test that
  could not detect unreachability. The reviews were not lazy - they verified against the spec and
  the tests. What was missing was **running the thing and looking at it**. Kalhar found both
  headline bugs in minutes by opening the browser. Weight "did anyone actually watch it work"
  above any amount of green CI.
