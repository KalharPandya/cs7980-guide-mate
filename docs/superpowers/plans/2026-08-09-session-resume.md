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

## IN PROGRESS (resume here)
**Wiring the IoT bridge so Moses ACTUALLY dispatches virtual robots in production.**
The identity is CREATED (user approved "do it"):
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
