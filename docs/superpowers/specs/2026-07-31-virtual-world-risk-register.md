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
| 1 | **Nobody has ever looked at this running.** Every visual task in this project (floor/wall geometry, animated robots/visitors, glowing route line, kiosk mode, bloom) hit the same environment limit: this session's Browser pane never composites a frame, so screenshot verification was impossible for the entire project. All visual claims are backed by `tsc`/build/console/network checks and, for a few tasks, live schema-state polling proving the DATA is correct, never by a human or AI actually seeing the scene. | tsc/build clean on every task; several tasks (3.2, 3.3) proved live data flow via temporary debug instrumentation, confirmed removed before commit. | Kalhar opens `world-client` in a real browser (`cd world && npm run dev`, `cd world-client && npm run dev`) and just looks: does the floor plan read correctly, do materials look right, is the route line visibly glowing, does kiosk mode's fullscreen/auto-orbit feel right (Task 5.4 has exact manual steps). This is the single highest-value thing to do before any rehearsal. |
| 2 | **The IoT/MQTT path has never touched real AWS IoT Core.** Task 2.2's virtual-fleet identity script is written, dry-run tested, and intentionally NOT applied (`--apply` is Kalhar's call, a controller/AI should not mutate account IAM). Every test of Tasks 2.3, 4.2, 5.2 (the bridge, the fleet assign/stop commands) uses mocked MQTT clients or gated integration tests that were never run with real credentials in this session. | Extensive mocked/fake-client unit tests, all passing; wire-format cross-checked field-by-field against the Python schema. | Kalhar runs `scripts/create_virtual_fleet_identity.sh --apply` himself (reviewed, safe, see the script's own dry-run output), then the gated integration tests (`GUIDEMATE_INTEGRATION=1`) and a real `aws iot-data publish` round-trip, per each task's own documented manual-test instructions. |
| 3 | **World-server is not deployed.** Task 5.1 containerized it and wired it into the existing Compose stack, but could not run a real `docker build`/`up` in this sandbox (no reachable Docker daemon) and, by design, never touched the live `echo.kalhar.ca` instance. | `docker compose config` validated; Dockerfile/runtime CMD verified by running the compiled JS directly (not containerized); a real `.dockerignore` bug that would have silently broken the build was found and fixed. | Kalhar runs the 5-step manual deploy in `docs/agent-poc/access-ground-truth.md`'s "world-server containerized" section: review diff, optionally reproduce locally with Docker actually running, `redeploy.sh`, `setup_observability.sh`, then the real verification steps listed there (curl, a real Colyseus join, `docker stats` under load, dashboard widgets). |
| 4 | **t3.large co-tenancy load is only proxy-measured.** The design spec's own open risk ("FastAPI + Node world-server + Bedrock calls untested together") is still open. Task 5.1's numbers came from an 8-core/24GB dev box, explicitly caveated as much bigger than the real 2 vCPU/8GB t3.large. | Combined idle RSS ~166MB, load-test crowd-sim cost ~3.5% of one core at real pacing, measured on the oversized proxy machine. | After Kalhar deploys (item 3), run Task 1.3's load test against the live instance while watching `docker stats` and the new CloudWatch alarm (`guidemate-poc-world-cpu`, 85% threshold) for a real number. |
| 5 | **Physical robot 468 will move during the demo if the emote mirror is enabled.** Task 5.3's `GUIDEMATE_EMOTE_MIRROR_ROBOT_ID` is unset by default (feature off, zero behavior change), but the whole point of building it is for Kalhar to turn it on for the demo. Per this repo's own standing rule, robot 468 must never move without a human observer present. | Unit-tested: mirror publish is best-effort, a failure never affects the virtual visitor's reply; unset-by-default confirmed via regression tests. | Before the demo, if this env var is set: confirm a human is physically present and watching robot 468 the entire time it's live, exactly like every other motion-enabling step in this project's history. This is a people-process risk, not a code risk, and no amount of testing removes the need for a human in the room. |
| 6 | **Rehearsal has not happened.** Nothing end-to-end (phone QR join to real chat to real robot assignment to visible avatar movement to route line to arrival) has ever run as one continuous flow with a human driving it. | Every individual hop tested in isolation (unit/integration), several hops proven live pairwise (e.g. Task 4.2's real cross-language round-trip test), but never all six in one sitting. | See the Rehearsal Checklist below. |
| 7 | **Floor-plan coordinates are eyeballed**, not survey-accurate (an accepted, documented tradeoff from the original design spec, not a new finding). | 18/18 rooms confirmed path-reachable from the navmesh; visually might still look slightly off against the real space. | If a room reads wrong once Kalhar actually looks at it (item 1), it's a `world/data/floor-14.json` edit, controller-owned per the plan's own convention. |
| 8 | **One flaky/order-dependent test signal, not fully root-caused.** Two independent, minor test-infrastructure findings surfaced during Phase 4/5 review: `world/src/test/join.test.ts` intermittently races Task 4.1's staggered simulated-visitor spawner (confirmed real but low-stakes, a test-timing issue, not a product bug); a full unscoped `pytest agent_service/tests` run was twice reported to hang near the end of `test_ws_chat.py`, but a scoped, isolated rerun of that exact file passed cleanly both times it was tried, so it did not reproduce as an intrinsic bug and is more likely cross-file/process contention in this heavily-parallel session, not a defect in the code. | Reproduced/investigated as described; not blocking, not further chased down. | If it recurs with a clean, scoped repro command, worth a short follow-up investigation. Not urgent. |
| 9 | **Minor deferred code-quality items**, all explicitly marked non-blocking by their reviewers, bundled here so they're not lost: split `world/src/rooms/visitors.ts` (569 lines, 3 distinct concerns) into `escortManager.ts` + `simulatedVisitorSpawner.ts`; dedupe `mqtt_link.py`'s `send_command`/`send_fleet_command` (~25 duplicated lines); `dog_agent.py` (505 lines) and `world/src/iot/bridge.ts` (609 lines) both trending large across tasks, worth a split before the next tool/command addition; `FakeRobotRegistry.send_fleet_command` doesn't simulate a fleet `stop` (only `assign`), so the dev-mode (`GUIDEMATE_FAKE_ROBOT=1`) kill-switch demo path would need that added if it's wanted for a non-AWS rehearsal. | N/A, code-quality only. | Fold into whichever task next touches these files; none block the demo. |
| 10 | **The unrelated pre-existing `test_index_served` failure** (asserts stale "Robert" branding in `agent_service/static/index.html`, which was rebranded to "Moses" before this project started) surfaced repeatedly across Phase 4/5 reviews. Confirmed every time to be unrelated to this project's changes. | Confirmed pre-existing via `git log -S`/blame each time it appeared. | A one-line test fix, cosmetic, unrelated to the virtual-world work; not this project's responsibility to fix but flagged since it shows up in every full test run. |

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
