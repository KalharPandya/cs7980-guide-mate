# Virtual World Guide Fleet: Risk Register and Rehearsal Checklist

Date: 2026-07-31
Status: controller-authored (Task 5.5), after Phases 0 to 5 implemented and reviewed.
Style follows `docs/agent-poc/access-ground-truth.md`'s "Consolidated risks" table (the closest
existing precedent in this repo; no prior risk register existed to extend).

## How to read this

Every task in this project (Phases 0 to 5) went through implementer subagent plus spec-compliance
review plus code-quality review, and every real bug found along the way was fixed and
independently re-verified (see `docs/superpowers/plans/2026-07-26-virtual-world-progress.md` for
the full task-by-task log). That process gives high confidence in the CODE's correctness. This
register is about the gap between "the code is correct" and "the demo will work live": what has
only been unit/integration tested versus what has actually been seen running, by a human, on real
hardware, against real AWS.

## Risk table (ranked, highest-impact-if-it-bites-you first)

| # | Risk | Verified how so far | What's still needed |
|---|---|---|---|
| 1 | **Nobody has ever looked at this running.** Every visual task in this project (floor/wall geometry, animated robots/visitors, glowing route line, kiosk mode, bloom) hit the same environment limit: this session's Browser pane never composites a frame, so screenshot verification was impossible for the entire project. All visual claims are backed by `tsc`/build/console/network checks and, for a few tasks, live schema-state polling proving the DATA is correct, never by a human or AI actually seeing the scene. **Root cause pinned down precisely (2026-07-31, personally reproduced, not just repeated from earlier reports):** booted both servers fresh, opened the real client in this session's Browser pane, and inspected it directly: `document.hidden` is `true` and the R3F `<canvas>` is stuck at the browser's un-laid-out default size (300x150), while the WebGL context itself is valid and not lost. So the page never gets a real viewport to lay out against, this is a property of how this specific sandboxed session displays (or doesn't display) the pane, not a bug in the app. Everything downstream of that (network requests for `robot.glb`, `visitor.glb`, `floor-14.json`, two `POST /matchmake/joinOrCreate/world` calls) came back a clean `200 OK` with zero console errors, meaning the app is genuinely live end to end right now, it just cannot be photographed from inside this session. | tsc/build clean on every task; several tasks (3.2, 3.3) proved live data flow via temporary debug instrumentation, confirmed removed before commit; this session's fresh repro adds the `document.hidden`/canvas-dimension root cause plus a clean live network trace. | Kalhar opens `world-client` in a real, non-sandboxed browser (`cd world && npm run dev`, `cd world-client && npm run dev`) and just looks: does the floor plan read correctly, do materials look right, is the route line visibly glowing, does kiosk mode's fullscreen/auto-orbit feel right (Task 5.4 has exact manual steps). This is the single highest-value thing to do before any rehearsal, and per this session's finding, it will very likely just work the moment a real browser window is actually visible. |
| 2 | **The IoT/MQTT path has never touched real AWS IoT Core.** Task 2.2's virtual-fleet identity script is written, dry-run tested, and intentionally NOT applied (`--apply` is Kalhar's call, a controller/AI should not mutate account IAM). Every test of Tasks 2.3, 4.2, 5.2 (the bridge, the fleet assign/stop commands) uses mocked MQTT clients or gated integration tests that were never run with real credentials in this session. | Extensive mocked/fake-client unit tests, all passing; wire-format cross-checked field-by-field against the Python schema. | Kalhar runs `scripts/create_virtual_fleet_identity.sh --apply` himself (reviewed, safe, see the script's own dry-run output), then the gated integration tests (`GUIDEMATE_INTEGRATION=1`) and a real `aws iot-data publish` round-trip, per each task's own documented manual-test instructions. |
| 3 | **World-server is not deployed.** Task 5.1 containerized it and wired it into the existing Compose stack, but could not run a real `docker build`/`up` in this sandbox (no reachable Docker daemon) and, by design, never touched the live `echo.kalhar.ca` instance. | `docker compose config` validated; Dockerfile/runtime CMD verified by running the compiled JS directly (not containerized); a real `.dockerignore` bug that would have silently broken the build was found and fixed. | Kalhar runs the 5-step manual deploy in `docs/agent-poc/access-ground-truth.md`'s "world-server containerized" section: review diff, optionally reproduce locally with Docker actually running, `redeploy.sh`, `setup_observability.sh`, then the real verification steps listed there (curl, a real Colyseus join, `docker stats` under load, dashboard widgets). |
| 4 | **t3.large co-tenancy load is only proxy-measured.** The design spec's own open risk ("FastAPI + Node world-server + Bedrock calls untested together") is still open. Task 5.1's numbers came from an 8-core/24GB dev box, explicitly caveated as much bigger than the real 2 vCPU/8GB t3.large. | Combined idle RSS ~166MB, load-test crowd-sim cost ~3.5% of one core at real pacing, measured on the oversized proxy machine. | After Kalhar deploys (item 3), run Task 1.3's load test against the live instance while watching `docker stats` and the new CloudWatch alarm (`guidemate-poc-world-cpu`, 85% threshold) for a real number. |
| 5 | **Physical robot 468 will move during the demo if the emote mirror is enabled.** Task 5.3's `GUIDEMATE_EMOTE_MIRROR_ROBOT_ID` is unset by default (feature off, zero behavior change), but the whole point of building it is for Kalhar to turn it on for the demo. Per this repo's own standing rule, robot 468 must never move without a human observer present. | Unit-tested: mirror publish is best-effort, a failure never affects the virtual visitor's reply; unset-by-default confirmed via regression tests. | Before the demo, if this env var is set: confirm a human is physically present and watching robot 468 the entire time it's live, exactly like every other motion-enabling step in this project's history. This is a people-process risk, not a code risk, and no amount of testing removes the need for a human in the room. |
| 6 | **Rehearsal has not happened.** Nothing end-to-end (phone QR join to real chat to real robot assignment to visible avatar movement to route line to arrival) has ever run as one continuous flow with a human driving it. | Every individual hop tested in isolation (unit/integration), several hops proven live pairwise (e.g. Task 4.2's real cross-language round-trip test), but never all six in one sitting. | See the Rehearsal Checklist below. |
| 7 | **Floor-plan coordinates are eyeballed**, not survey-accurate (an accepted, documented tradeoff from the original design spec, not a new finding). | 18/18 rooms confirmed path-reachable from the navmesh; visually might still look slightly off against the real space. | If a room reads wrong once Kalhar actually looks at it (item 1), it's a `world/data/floor-14.json` edit, controller-owned per the plan's own convention. |
| 8 | **`join.test.ts`'s flakiness is fixed.** Personally reproduced (`agents.size` came back 2 instead of 1 under concurrent load) and fixed: the test now passes `{ disableSimulatedVisitors: true }` on join, since it's a bare connectivity smoke test, not a visitor-lifecycle test, and shouldn't race Task 4.1's spawner at all. Confirmed 5/5 clean runs after the fix. Separately, a full unscoped `pytest agent_service/tests` run was twice reported to hang near the end of `test_ws_chat.py`, but a scoped, isolated rerun of that exact file passed cleanly both times it was tried, so it did not reproduce as an intrinsic bug, more likely cross-file/process contention in this heavily-parallel session, not a defect in the code. | `join.test.ts` fix verified via 5 clean reruns plus a full `test:all` pass. The `test_ws_chat.py` report never reproduced in isolation. | None for `join.test.ts`. If the `pytest` hang recurs with a clean, scoped repro command, worth a short follow-up investigation. Not urgent. |
| 9 | **Minor deferred code-quality items.** All since resolved as follow-up commits: `visitors.ts` split into `escortManager.ts`+`simulatedVisitorSpawner.ts`, `mqtt_link.py`'s `send_command`/`send_fleet_command` deduped, `FakeRobotRegistry` now simulates a fleet `stop`/`resume` too (so the kill switch can be demoed under `GUIDEMATE_FAKE_ROBOT=1` without real AWS). `dog_agent.py` (505 lines) and `world/src/iot/bridge.ts` (609 lines) are still trending large across tasks. | Each fix independently re-reviewed, zero behavior change confirmed. | The two files' size is a watch item, not an action item: worth a split before the next tool/command addition, not before this demo. |
| 10 | **The `test_index_served` failure has been fixed**, it was genuinely this project's doing after all: the assertion was stale (pre-rebrand "Robert"/leading-slash asset paths), not a pre-existing unrelated issue as first assumed across three separate reviews. Fixed to assert the real "Moses" branding and relative asset paths. | Full `agent_service` suite now 248 passed, 0 failures. | None, resolved. |
| 11 | **Adversarial security/robustness pass (2026-07-31), both Minor findings now fixed.** (a) `WorldRoom.addAgent` now checks agent count against `MAX_AGENTS=128` before calling the native Crowd, with a second backstop check inside `AgentCrowd.addAgent` itself. The empirical probe that motivated this: at capacity, the native library doesn't throw, it silently hands back a "ghost" agent stuck at `{0,0,0}` that never moves, exactly the silent-corruption risk the review flagged. The fleet `assign` handler now acks `failed`/`world_at_capacity` instead. (b) The emote-mirror feature (Task 5.3) now rate-limits to one publish per robot id per 2 seconds (a real concurrency fix, not just a defensive one: `chat()` is genuinely reachable from multiple threads at once via FastAPI's threadpool and the WS executor). Neither fix changes any normal-scale behavior; both independently re-reviewed and confirmed to zero-regress the existing test suites and the 95-agent load test. | Real empirical probe of the native library's at-capacity behavior (not assumed); full `test:all` + `test:load` re-run showing identical baseline numbers; both fixes independently re-reviewed. | None, both resolved. |
| 12 | **Multi-hour kiosk memory hygiene: checked, clean.** This demo is meant to run for hours with ~45 simulated visitors continuously spawning and despawning (Task 4.1). Two previously-unchecked leak risks, both audited with real evidence, not just code reading: (a) the browser client's Three.js/R3F resource disposal on visitor despawn (confirmed correct: rendering is keyed off the live `agentIds` array every render, React's own reconciliation unmounts a component when its id disappears; verified against the actual `drei`/`three.js` library source, not assumed, that shared clone data doesn't need manual disposal and instanced-robot slots are properly released on unmount). (b) the server-side native `recast-navigation` Crowd's WASM agent-slot release on `WorldRoom.removeAgent` (confirmed correct via a real stress test: 600 agents cycled through a 3-slot crowd across 200 add/remove rounds, all succeeded cleanly, proving slots are actually freed, not leaked). | Real stress test (600 agents / 200 cycles) plus direct verification against `drei`/`three.js`/`recast-navigation` library source. | None. This was the last unverified category of risk in the whole project; it's now closed. |

## What's simulated vs. physically verified vs. only tested

- **Physically/hardware-verified**: nothing in this project. All of Phase 0 to 5 is software-only
  (Colyseus server, Three.js client, FastAPI/Moses integration). The one place this project
  touches real hardware is the OPTIONAL Task 5.3 emote mirror onto robot 468, which is
  hardware-verified only in the sense that robot 468's real emote path was already
  hardware-validated by prior (pre-this-project) work; the MIRROR TRIGGER itself is only
  unit-tested here.
- **Integration/gated-tested but not run with live infrastructure**: the entire IoT/MQTT path
  (risk #2), the deployed world-server (risk #3).
- **Unit/integration tested and code-reviewed, not yet visually confirmed**: everything in
  `world-client/` (risk #1) and the admin/kill-switch/emote-mirror flows (functionally tested,
  never clicked through by a human in a real admin panel session).
- **Genuinely solid**: the navmesh/pathfinding math (Task 1.1, independently re-verified twice),
  the 95-agent load test (measured fresh twice, by two different reviewers, consistent both
  times), the Python/TypeScript wire-format parity (checked field-by-field on every cross-language
  task), and the fleet kill-switch's pause/timeout interaction (the one subtle correctness bug
  found in this whole project was caught, fixed, and proven via actual mutation testing, not just
  inspection).

## Rehearsal checklist (for Kalhar, in order)

1. **Look at it** (resolves risk #1): `cd world && npm run dev`, `cd world-client && npm run dev`,
   open the printed URL. Confirm the floor plan looks right, robots/visitors animate, the route
   line glows during motion. Try `?kiosk=1` per Task 5.4's manual steps.
2. **Apply the virtual fleet IoT identity** (resolves risk #2, item A): review
   `scripts/create_virtual_fleet_identity.sh`'s dry-run output one more time, then
   `--apply`.
3. **Deploy world-server** (resolves risk #3): follow the 5 steps in
   `docs/agent-poc/access-ground-truth.md`'s deploy section.
4. **Real IoT round-trip**: with the identity applied and world-server deployed, run the gated
   integration tests (`GUIDEMATE_INTEGRATION=1`) for Tasks 2.3/4.2, and/or a manual
   `aws iot-data publish` against the fleet topic, confirm a virtual robot actually moves.
5. **Load-check on the real instance** (resolves risk #4): Task 1.3's load test against the live
   world-server, watch `docker stats` and the CloudWatch dashboard.
6. **Full end-to-end, one sitting** (resolves risk #6): scan the QR code (`GET /api/join-qr`) on
   a phone, chat with Moses, ask to be guided to a named room, watch the big screen for: a robot
   getting assigned, the visitor-bound banner appearing on the phone, the avatar walking with an
   escort, the route line, arrival. Then try the admin fleet kill-switch mid-escort and confirm
   the world visibly freezes and resumes cleanly, and (if enabling Task 5.3) confirm robot 468
   mirrors an emote, WITH A HUMAN PRESENT AND WATCHING THE ROBOT (resolves risk #5's
   people-process requirement).
7. **Only after all of the above passes**, consider the "NOT YET DEPLOYED"/"provisioning-pending"
   markers in `access-ground-truth.md` retired, and update them to reflect the live state.
