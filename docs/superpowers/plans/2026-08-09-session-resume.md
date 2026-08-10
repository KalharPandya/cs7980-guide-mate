# Session resume: virtual-world floor-plan + Moses dispatch (2026-08-09)

Living checkpoint so a fresh session can pick up exactly where this one stopped. Read this
top to bottom, then check "In progress" and "Not done" before touching anything.

## Where the work lives
- Branch: **`kalhar-main`** (pushed to origin). Worktree:
  `.claude/worktrees/floor-map-diagon-mirror-alignment-211c3b`.
- Live site: **https://echo.kalhar.ca** (Northeastern SCHOOL account `852373397000`, us-west-2,
  EC2 `i-0e1301c47f73c771c`, `guidemate-agent-profile`). Routes: `/` Moses chat + voice,
  `/world/*` Colyseus world server, `/viz/*` the 3D floor plan.
- Deploy: `GUIDEMATE_BRANCH=kalhar-main AWS_REGION=us-west-2 bash agent_service/deploy/redeploy.sh`
  (SSM `git reset --hard origin/<branch>` + `docker compose up -d --build`; the Windows
  cp1252 error printing the SSM output is cosmetic, the deploy still succeeds, confirm via
  `"Status": "Success"` and by curling the endpoints).

## Two gotchas that cost real time (do not relearn them)
1. **Port 5173 is a DIFFERENT worktree's dev server** (`feat+kalhar-virtual-world`, serving the
   OLD 124-wall data). THIS worktree's client, when its own vite is running, is on 5175. Always
   confirm which worktree a localhost port belongs to before trusting what you see.
2. **The live box runs whatever branch was deployed last**, and redeploy hard-resets. Before any
   deploy, `git merge-base --is-ancestor <live-sha> kalhar-main`; if it fails, MERGE first.
   `kalhar-main` was missing 37 commits of live ElevenLabs voice work at one point and deploying
   would have stripped it. See `[[worktree-port-and-deploy-branch-hazards]]` memory.
3. Windows Git Bash has no `/dev/stdout` and no `&&` in PowerShell; the IoT identity script's
   shadow step failed on `/dev/stdout` and had to be run separately.

## DONE and DEPLOYED (all on kalhar-main, live)

### Moses physical-vs-virtual mode, admin-assignable (added 2026-08-10, commits `ecd4aee`, `4091660`)
The physical/virtual capability split is now an EXPLICIT per-session admin choice and Moses's
behavior follows it. Mode is derived in `dog_agent._resolve_session`: `physical =
robot_for_session(session_id) is not None` (a session holding a physical robot lock is physical;
no lock is virtual). Both `/api/chat` and the WebSocket path funnel through `DogAgent.chat`, so
the gate applies to both.
- **Emotes are now PHYSICAL-only.** `send_emote` and `EMOTE_INSTRUCTION` are gated on `physical`
  in `_enabled_tool_names` / `_system_prompt`. A virtual session gets `guide_to_room` only (no
  emote/motion/status); a physical session gets emote + run_motion/stop/get_status, no
  `guide_to_room`. This closed a real bug: virtual sessions used to emote.
- **Emote-mirror feature REMOVED** (was `GUIDEMATE_EMOTE_MIRROR_ROBOT_ID`, opt-in Task 5.3). It
  echoed a virtual session's emote onto a physical robot; with virtual sessions no longer
  emoting it can never fire, so it plus its env var (compose.yaml) and 6 tests are gone.
- **Admin assignment:** physical assignment already existed (approve/reassign acquires the lock).
  Added the explicit virtual side: `sessions.assign_virtual(session_id, registry)` (releases any
  held robot, docks it, clears the binding, session stays active) and `POST
  /api/admin/session/{id}/assign-virtual`. Admin Sessions tab now shows a MODE label
  (`Physical: <id>` or `Virtual (navigation)`) with "Assign Physical" (robot dropdown) and
  "Assign Virtual (navigation)" buttons.
- **Fleet counts stay hardcoded** (`GUIDE_ROBOT_COUNT=5`, `RESERVED_ROBOTS_FOR_REAL_USERS=2` in
  `world/`); the admin allocates MODE per session, not fleet size. Editing those two numbers +
  redeploy is the way to change fleet capacity (no runtime knob was built, by decision).
- **LIVE E2E, traced on the instance (SSM, real Bedrock), all four checks passed:** virtual
  assigned -> Moses navigates (fleet dispatched `virtual/2`), `emote=None`. Physical assigned
  (throwaway id `phys-e2e-noop`, robot 468 never touched) -> Moses refuses navigation
  ("I cannot walk anywhere since I have no navigation") and emotes (`happy`). Admin flip
  physical->virtual -> Moses navigates again, `emote=None`. Full suite green: 311 passed.

### Operator-approved NAMED virtual guiding + sim toggle (added 2026-08-10, commits `3d8b2d6`, `9eb9a0a`, `54be9de`, `20f9295`, `fc45d0d`)
Root cause a real user's visitor never showed their name on the big screen: the name was
never transmitted. The Colyseus `Agent` schema had NO name field (labels like Ben/Ava are
invented client-side by hashing the id in `world-client/src/scene/agentLabel.ts`), and the
assign carried only a machine `visitor-<hex>` id. Fixed end to end:
- **Named visitor:** added a synced `Agent.name`, threaded the session user's name through the
  assign Command params, the wire schema, and `bridge.addAgent`; the client shows the server
  name when present (else the old id-derived pool name, so sim visitors are unchanged). New
  read-only `GET /world/agents` dumps live agents `{id,kind,name,state,x,z}` for observation
  (this is how the E2E proves a NAMED visitor spawned, not an ack).
- **Operator-approved flow (was auto-dispatch):** `dog_agent._guide_impl` now creates a guide
  REQUEST (`sessions.create_request(kind="guide", from_room, to_room)`) that appears in the
  admin Requests tab; approving it (`POST /api/admin/requests/{id}/approve-guide` ->
  `sessions.approve_guide_request`) fires the named assign that spawns the named visitor + an
  assigned robot and records `guide_robot_id`/from/to on the session. Moses's virtual prompt
  carries that status (`get_guide_status`) so it can tell the visitor which robot is coming.
  The guide reply says the guide was REQUESTED / front desk will approve, not "on its way".
- **Sim toggle:** `POST /api/admin/world/sim-stop` / `sim-resume` publish a scoped fleet stop
  (`params scope=simulated`); the world-server despawns the ambient simulated visitors (freeing
  the robots they booked) and stops spawning, WITHOUT freezing the world (distinct from the
  whole-world `/world/stop`). Robot-tab card drives it. Sessions tab now shows a confirmation
  line after Assign Physical/Virtual.
- **Deploy robustness:** `redeploy.sh` runs `docker system prune -f` before the build (a deploy
  had failed with No space left on device; `-f` only, never `--volumes`, preserves the cert volume).
- **LIVE E2E, observed via /world/agents (no ack loopholes):** chat -> guide request in admin
  (name+from+to) -> approve -> visitor named "Kalhar-P2-Test" spawns at the Wellness Room fetched
  by virtual/1 -> Moses reports "guide robot virtual/1 is on its way". Sim stop: sim-visitor
  count 5 -> 0 -> 5 on resume. All agent_service + world tests green.

Floor plan (`world/data/floor-14.json`, twin `world-client/public/data/floor-14.json`, byte-identical):
- Rebuilt from primitives, 124 -> 84 walls. Root causes fixed: the `elevator-stair-core-upper`
  hole polygon was self-intersecting (broke the drop-walls-inside-a-hole filter, leaving 13
  shaft boxes as a "comb"), and the drawing renders every wall as two face lines (the trace
  captured both as doubles). Now: 0 duplicate pairs, 0 crossings, 0 floating walls, 0 T-gaps.
- Ink threshold raised 130 -> 150 (real thin walls are light grey ~133-140).
- Solid elevator cores (extruded volumes, `Cores.tsx`), wall thickness hierarchy, arcs as
  polylines not chords, Wellness Room anchors moved off a wall into the nook, a sealed washroom
  doorway reopened with a structural guard so no stage can seal an authored door again.
- Furniture: `world/data/floor-14-furniture.json` (96 items) extracted from the drawing's
  light-grey band, rendered by `world-client/src/scene/Furniture.tsx`, RENDER-ONLY (not in the
  navmesh). Over-merged slabs post-split.
- **Doorways widened to 1.20m clear** (`widen_doorways.py`, step 11 of `rebuild_floor_plan.py`):
  sub-1.0m openings 12 -> 1. Delivery held 100%.
- **Glass: 35 walls, HAND-SELECTED by the user** in the glass-marker tool and applied by index
  (geometry untouched). Outer envelope + room walls facing the open perimeter are glass; cores,
  inter-room dividers and the Kitchen cluster are solid. Tools:
  `world-client/tools/glass-marker.html` (interactive) and `world/data/tools/classify_glass.py`
  (auto first-pass). The hand selection supersedes the auto pass.

Rendering / UX (`world-client/src/`):
- The 3D scene was MIRRORED north<->south; fixed with one `<group scale={[1,1,-1]}>` in App.tsx
  (data z=north, top-down three.js puts +z at screen bottom).
- Room labels: constant on-screen size + screen-space collision culling + lifted above the cores
  so the opening frame names all 18.
- **Name tags over agents** (`AgentLabels.tsx` + `agentLabel.ts`): derived names (virtual/5 ->
  "Robot 5", visitors -> stable first names), tracks live position each frame.
- **Route line**: was invisible (sub-pixel AND back-face-culled under the mirror group's negative
  determinant). Fixed with screen-space width + `side: THREE.DoubleSide` in `RouteLine.tsx`.

AI / Moses (`agent_service/`):
- Physical-vs-virtual capability split: the prompt now matches the offered tools (physical =
  emote/tricks, cannot navigate; virtual = navigate/escort, cannot act physically). Bug fixed:
  a virtual session used to be told it had run_motion/stop/get_status it never had.
- `guide_to_room(room, from_room)`: Moses ASKS where the visitor is, then publishes `from_room`
  on the fleet `assign`. Wire schema `from_room` added in `shared/guidemate_msgs/messages.py`
  (source of truth) + `world/src/iot/messages.ts` mirror. Verified live on Bedrock.
- Two-phase escort (fetch then guide) already existed; made observable.
- **Escort bugs found by running it:** (a) escorts reported "completed" at the PICKUP point
  (true delivery was 96%, misreported as 98.6%); (b) the harness measured robot-to-visitor
  separation, blind to it; (c) a crowd deadlock where `separationWeight`(2) > `maxSpeed`(1.4)
  froze robot+person for the full timeout. All fixed. Delivery now 100% (442/442).
  Standing regression harness: `world/scripts/escorttest.ts` (now reports TRUE delivery rate).

Infra:
- `world-client` packaged + served at `/viz` (`world-client/Dockerfile`, compose service, Caddy
  route, base=/viz/ and VITE_WORLD_SERVER_URL=wss://$GUIDEMATE_DOMAIN/world are ONE coupled
  decision). Merged the live voice branch in before deploying.

## E2E TESTED 2026-08-09 (full chat -> delivery, traced live)
Drove the real production chat API (`POST /api/session` then `POST /api/chat`, real Bedrock, real
IoT publish). Single-user run traced meter by meter: Moses asked location, published the assign,
a visitor spawned at Classroom 1425, robot virtual/2 fetched it, then led it to the Kitchen
(distToKitchen 21.7m -> 0.1m). Two bugs found and fixed during E2E:
1. **Room-name resolution** was exact-only, so Moses saying "Classroom 1408" (room is "1408") got
   a failure. `findRoomTarget` (world/src/nav/buildNavMesh.ts) is now a forgiving 4-layer resolver
   (exact, filler-word-stripped, 4-digit-number, unique-keyword), with the Moses prompt nudged to
   pass exact names. All 18 fuzzy phrasings resolve; ambiguous input returns null. Verified live:
   0 room-name failures on the phrasings that broke before.
2. **Robot starvation**: 5 robots were idle only ~33% of the time because ambient simulated
   visitors used them all, so a real request often got `no_idle_robot`. `requestGuide` now RESERVES
   `RESERVED_ROBOTS_FOR_REAL_USERS = 2`: a simulated visitor may only take a robot if >=2 stay
   idle; a real (Moses/bridge-spawned) visitor may take any idle robot. Guarantees up to 2
   concurrent real users always get a robot.
Known ceiling (not a bug): >2 CONCURRENT real users on the 5-robot fleet can still hit
`no_idle_robot`; a class demo has 1. Raise `RESERVED_ROBOTS_FOR_REAL_USERS` / `GUIDE_ROBOT_COUNT`
if many simultaneous users are expected.

## DONE 2026-08-09: Moses dispatches virtual robots in production (IoT bridge LIVE)
Verified end to end on the live instance: published an `assign` (from_room="Classroom 1425",
room="Kitchen") to `guidemate/virtual/fleet/cmd`, joined the live world room, and watched the
visitor spawn AT Classroom 1425 (5.73, 14.45), a robot fetch it, then escort it toward the
Kitchen (state idle -> moving). App is IoT-connected (`/readyz` mqtt:true, real registry via
SigV4 WebSocket signing with the instance role, NOT a cert). World-server bridge connects with
the X.509 Virtual-Fleet cert.

How it was wired (so it can be reproduced / repaired):
- Cert/key/CA live on the host at `/opt/guidemate/certs/{cert,key,AmazonRootCA1}.pem`, bind
  mounted read only into world-server at `/certs` (compose commit ee3bb05). They PERSIST across
  redeploys (host dir, not in the image).
- `/etc/guidemate.env` sets `GUIDEMATE_CERT=/certs/cert.pem GUIDEMATE_KEY=/certs/key.pem
  GUIDEMATE_CA=/certs/AmazonRootCA1.pem` (endpoint was already set).
- The key + cert are backed up in SSM Parameter Store: `/guidemate/fleet/key` (SecureString),
  `/guidemate/fleet/cert` (String). To re-provision after an instance replacement, pull them
  with `aws ssm get-parameter --with-decryption` straight to files (never echo the key), curl
  AmazonRootCA1.pem, chmod 600 the key, set the env, redeploy.
- IoT identity: thing `Virtual-Fleet`, cert 542a66c4..., policy `guidemate-fleet-policy` (scoped
  to `guidemate/virtual/*`, cannot reach the physical robot), shadow default-deny.

### Historical note (this section was "in progress"; kept for the how)
The identity was CREATED (user approved "do it"):
- Thing `Virtual-Fleet`, active cert
  `arn:aws:iot:us-west-2:852373397000:cert/542a66c4174aa28de72931949ceae3bc5021b5c148636f4860bad22c3b38bf8f`,
  policy `guidemate-fleet-policy` (scoped to `guidemate/virtual/*` + this thing's shadow, cannot
  reach the physical robot), shadow set default-deny. IoT endpoint
  `aqc6y1ij55nsq-ats.iot.us-west-2.amazonaws.com` (already in `/etc/guidemate.env` as
  `GUIDEMATE_IOT_ENDPOINT`). Local cert/key at `~/.aws/guidemate-fleet.{cert,key}.pem`.

Still TO DO to make it live (this is the remaining work):
1. The world-server container has NO volume mount for certs, and `/etc/guidemate.env` has no
   `GUIDEMATE_CERT`/`GUIDEMATE_KEY`. `world/src/iot/bridge.ts` `startIotBridgeFromEnv` reads
   those as FILE PATHS (`readFileSync`), CA optional (mqtt.js mTLS; AWS IoT TLS likely needs
   AmazonRootCA1.pem, so also provide `GUIDEMATE_CA`).
2. Add a read-only volume mount to the `world-server` service in `agent_service/compose.yaml`
   (e.g. `/opt/guidemate/certs:/certs:ro`), commit + push.
3. Get cert + key onto the instance SECURELY (do NOT put the private key in an SSM RunShellScript
   parameter, it is logged). Preferred: SSM Parameter Store SecureString (value not logged) or
   Secrets Manager, instance role pulls with decrypt. Check the instance role has
   ssm:GetParameter + kms:Decrypt (or add). Also fetch AmazonRootCA1.pem onto the instance.
4. Set `GUIDEMATE_CERT=/certs/cert.pem GUIDEMATE_KEY=/certs/key.pem GUIDEMATE_CA=/certs/AmazonRootCA1.pem`
   in `/etc/guidemate.env`.
5. Redeploy, then confirm the world-server log shows the bridge STARTED (not the
   "GUIDEMATE_IOT_ENDPOINT/GUIDEMATE_CERT/GUIDEMATE_KEY not all set" line), then E2E: talk to
   Moses, say a room, watch a visitor spawn and a robot deliver in the live 3D scene.

## NOT done / needs the user
- Visual sign-off on the floor plan is the user's call (a Stop-hook goal wanted it; do not
  self-approve).
- The washroom glass walls: the auto-classifier flagged them; the user's hand selection is now
  authoritative, so only revisit if the user asks.

## Verify commands
- `cd world && npm run test:nav` (18/18, no PARTIAL), `npm run test:all`.
- `cd world && npx tsx scripts/escorttest.ts` (TRUE delivery rate, must stay ~100%).
- `cd world-client && npm test && npx tsc --noEmit`.
- `cd agent_service && PYTHONPATH=<this worktree>/shared/guidemate_msgs python -m pytest -q`
  (the editable `guidemate_msgs` may resolve to the OTHER worktree, pin PYTHONPATH).
- Live: `curl -s https://echo.kalhar.ca/{healthz,world/healthz}` both `{"ok":true}`;
  `/viz/` 200; POST `/world/matchmake/joinOrCreate/world` returns a room id.
