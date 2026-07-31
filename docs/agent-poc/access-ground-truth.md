# Access Ground Truth — Verified Probe Results (2026-07-05)

Findings from a read-only, no-motion, 3-way parallel probe run 2026-07-05 (~15:30 UTC) from
the Windows laptop: robot system state, on-Pi Claude/AWS, local AWS permissions. **This file
supersedes older access notes.** Companion: [HANDOFF-2026-07-05.md](HANDOFF-2026-07-05.md)
(mission + decisions), the [design spec](../superpowers/specs/2026-07-05-dog-agent-architecture-design.md).

## TL;DR
Everything needed to build the dog agent POC **works today**: SSH + passwordless sudo to the
Pi, headless on-Pi Claude Code, AWS admin-level permissions from both machines, and a
**verified Bedrock `converse` round-trip on `us.anthropic.claude-sonnet-4-6`**.
**UPDATE 2026-07-05 (later):** the AWS-credential-expiry blocker is **SOLVED** — both the
Pi and the laptop now run permanently as IAM role **`guidemate-agent-role`**
(AdministratorAccess) via X.509-cert exchange; see [Permanent AWS credentials](#permanent-aws-credentials-solved-2026-07-05). Remaining blockers: the **IoT policy
only allows `sdk/test/*`** for MQTT data (must be widened before any robot MQTT), and
**battery/dock state is not remotely verifiable** (physical dock-LED check only).

## Access matrix (all verified)
| From | To | Mechanism | Status |
|---|---|---|---|
| laptop / any machine with the key | Pi (`ubuntu@10.247.204.21`, host `turtlebot-van-468`) | SSH, key `claude-agent-turtlebot-van-468` | ✅ + passwordless sudo |
| Pi | internet (github.com) | wlan0 | ✅ HTTP 200 |
| Pi | Create 3 base | usb0 → `192.168.186.2` webserver (fw H.2.6) | ✅ |
| any | on-Pi Claude Code v2.1.201 | `ssh … 'cd ~/cs7980-guide-mate && claude -p "…"'` | ✅ returned `READY`; `--output-format json` parses (`result`, `is_error`, `total_cost_usd`, `usage`…) |
| laptop + Pi | AWS account `852373397000`, us-west-2 | IAM role `guidemate-agent-role` via X.509 `credential_process` (permanent, 12 h auto-refresh) | ✅ |
| laptop | Bedrock Sonnet 4.6 | `bedrock-runtime converse`, model id `us.anthropic.claude-sonnet-4-6` | ✅ live reply, 13 tokens, ~1.9 s |

## Robot 468 system state (probe snapshot)
| Check | Result |
|---|---|
| Disk | 16 G free of 29 G (45% used) ✅ |
| Memory | 3.7 Gi total, 2.5 Gi available; **no swap configured** ⚠️ |
| CPU | load ~1.0 / 4 cores; 55.5 °C idle; `get_throttled=0x80000` — soft temp limit tripped at least once since boot (not active, never under-voltage) ⚠️ |
| Uptime | 15 days (Pi is dock-powered → strong indirect evidence charging works) |
| Running | `discovery.service` (FastDDS :11811), `turtlebot4.service` bringup, Create-3 webserver forward, `camera_node` (15 days, RGBD/USB2/400p, rgb+imu off, ~57% of a core). **`joy_linux` + `teleop_twist_joy` + diagnostics are running again** (the CPU tax docs said was culled — reappeared with the Jun-19 boot) ⚠️ |
| NOT running | slam_toolbox, Nav2, bfs_explorer, glass_guard, depth_lidar_fusion, `oak_watchdog.sh` ⚠️ (camera wedge would be silent — gotcha #8) |
| OAK-D-LITE | USB `03e7:f63b` (healthy, not bootloader); `usbfs_memory_mb=256` live **and** persisted in cmdline.txt ✅ |
| No motion publishers active; robot idle at base bringup ✅ | |

### Battery / dock state — NOT remotely verifiable (accepted limitation)
- Ad-hoc `ros2 topic echo` gets 0 frames even with `ROS_SUPER_CLIENT=True`, explicit type,
  `--no-daemon` (documented Discovery-Server gotcha; note `/etc/turtlebot4/setup.bash` sets
  `ROS_SUPER_CLIENT=False` for non-tty shells).
- Create 3 webserver renders battery **client-side** via external JS — no scrapeable
  endpoint (`/api/*`, `/battery`, `/telemetry` all 404; `/logs-raw` has no battery lines).
- **Physical dock-LED glance is the only true confirmation.** For the POC this is exactly
  why the bridge node publishes `battery_state`/dock to MQTT — it removes this blind spot.

## On-Pi Claude Code
- v2.1.201 at `~/.local/bin/claude` (also on login-shell PATH). Headless verified both
  text and JSON modes; sample turn: model `claude-opus-4-8[1m]`, $0.039, 1.6 s.
- **Auth = claude.ai OAuth subscription** (kalharpandya38@gmail.com; `~/.claude/.credentials.json`,
  mode 600). No `ANTHROPIC_API_KEY`, no Bedrock auth. ⚠️ Subject to plan usage limits —
  budget `claude -p` frequency in unattended loops; add retry/backoff.
- MCP: `aws-mcp` **Connected** (`uvx mcp-proxy-for-aws==1.6.3`, AWS_REGION=us-west-2) — it
  inherits the same expiring AWS creds as the CLI.

## Permanent AWS credentials (SOLVED 2026-07-05)
The SSO-expiry problem is fixed. The sandbox SCP **denies `iam:CreateUser`** (no long-lived
access keys possible) but **allows roles**, so the setup uses the **AWS IoT credentials
provider**: an X.509 cert is exchanged over TLS for 12-hour role credentials, auto-refreshed
by the CLI/SDK via `credential_process` — permanent, zero human renewal.

**Cloud resources (all created 2026-07-05, us-west-2):**
- IAM role `guidemate-agent-role` — **AdministratorAccess** (deliberate; sandbox account),
  max session 12 h, trusts `credentials.iot.amazonaws.com` + `ec2.amazonaws.com`.
- Instance profile `guidemate-agent-profile` (ready for the future EC2 deployment —
  instances get the same role with zero credential setup).
- IoT role alias `guidemate-agent-alias` → the role, 43200 s credential duration.
- IoT policy `guidemate-credentials-policy` (`iot:AssumeRoleWithCertificate` on the alias),
  attached to **two certs**: the robot's `Turtlebot-468` cert and a new dev-agent cert
  (`aec82bf4…`).

**Per machine (verified working — `sts get-caller-identity` returns
`assumed-role/guidemate-agent-role/…` and a live Bedrock converse succeeded):**
- **Pi:** `~/.aws/iot-credential-process.sh` (curl + robot cert) wired into `~/.aws/config`
  `[default]`. Old config backed up at `~/.aws/config.bak-2026-07-05`. `aws-mcp` inherits it.
- **Laptop (Windows):** `C:/Users/kalha/.aws/iot-credential-process.py` (pure-Python
  urllib/ssl — Windows curl builds can't load PEM client certs) + dev cert/key at
  `~/.aws/guidemate-dev.{cert.pem,private.key}` (key mode 600, **never in the repo**).
  `[default]` uses it; the old SSO login remains available as `--profile kalhar-sso`.
- **Any new machine (e.g. the Linux box):** two options —
  a) copy `~/.aws/guidemate-dev.cert.pem` + `.private.key` + the Python script out-of-band
  and add the same 3-line `[default]`; or b) mint its own cert while any valid creds exist:
  `aws iot create-keys-and-certificate --set-as-active`, then
  `aws iot attach-policy --policy-name guidemate-credentials-policy --target <new cert ARN>`.
  Credentials-provider endpoint (account-specific):
  `aws iot describe-endpoint --endpoint-type iot:CredentialProvider`.

Note: `guidemate-agent-role` has **admin** on a shared sandbox — Kalhar explicitly accepted
this. Revoke path if ever needed: detach `guidemate-credentials-policy` from a cert, or
deactivate the cert (`aws iot update-certificate --new-status INACTIVE`).

## AWS identity & permissions (as probed earlier, pre-fix)
- Both machines previously used the SSO role `AWSReservedSSO_myisb_IsbUsersPS/pandya.kal`,
  account `852373397000`, us-west-2 (`aws login` browser flow) — **now superseded by
  `guidemate-agent-role` above**; the SSO profile still exists for human use.
- Effective permissions: **AdministratorAccess** (+ Bedrock full). No IAM blockers for
  anything in the design. SCP blocks `iam:CreateUser` (discovered 2026-07-05).
- ⚠️ **Shared sandbox account** (Control Tower + another tenant's resources visible:
  `teamgram-*` bucket/tables/logs). Full-admin blast radius; sandbox may be recycled —
  keep all source docs in the repo, treat cloud resources as rebuildable.
- Cleanup note: leftover `~/.aws/credentials` profile `278513762996_myisb_IsbUsersPS`
  (different account, stale session token) on the laptop — unused, safe to delete.

### Per-service verification
| Service | Verified | Notes |
|---|---|---|
| Bedrock models | ✅ | `us.anthropic.claude-sonnet-4-6` **converse round-trip OK** → pin this id. `claude-sonnet-5` is listed but `AccessDeniedException` (model access not granted for the account; request via Bedrock console if wanted). |
| Bedrock KB | ✅ perms | Zero KBs exist. `aws s3vectors` command group present in local CLI 2.33.6 → S3 Vectors store scriptable. |
| IoT Core | ✅ perms | Thing `Turtlebot-468` exists. Data endpoint: discover via `aws iot describe-endpoint --endpoint-type iot:Data-ATS`. **Policy `Turtlebot-468-Policy` is quick-start scope only**: pub/sub on `sdk/test/{java,python,js}`, Connect limited to 3 sample client IDs. `guidemate/*` and shadow topics **will be denied until the policy is extended** — required setup step. |
| Device Shadow | ✅ perms | **No shadow exists yet** (`ResourceNotFoundException`) — first `GetThingShadow` must tolerate this; create via an initial update. |
| S3 / CloudWatch / DynamoDB / EC2 | ✅ | All readable; EC2 empty in us-west-2 (launch permission present, sandbox guardrails untested). |
| IoT device files on Pi | ✅ | `~/cs7980-guide-mate/`: `Turtlebot-468.cert.pem`, `.private.key`, `.public.key`, `start.sh`, `aws-iot-device-sdk-python-v2/` — all gitignored, none tracked. |

## Security findings
| Finding | Status |
|---|---|
| `ssh_keys/` was not gitignored on the laptop | **FIXED** 2026-07-05 (gitignored; never committed) |
| `Turtlebot-468.private.key` on Pi was world-readable (644) | **FIXED** 2026-07-05 → `600` |
| **GitHub PAT (`ghp_…`) embedded in the Pi's git remote URL** | **OPEN** — anyone with Pi/SD-card access gets repo write access. Recommend: rotate the PAT and switch the Pi remote to a fine-grained deploy token or SSH deploy key. Left untouched (the Pi needs pull access for multi-session work; changing it is a user decision). |
| Robot acts as the human's personal admin SSO role | **RESOLVED 2026-07-05** — robot + dev machines now act as the dedicated `guidemate-agent-role`. It carries AdministratorAccess by Kalhar's explicit choice (sandbox account); agent actions are now attributable (session name = cert id), and revocation is one `update-certificate` call. |

## Consolidated 24-hour risks (ranked)
1. ~~AWS credential expiry~~ **RESOLVED** — permanent cert-based `guidemate-agent-role`
   on both machines (see above). Residual: the exchange needs the cert files + network to
   the credentials endpoint; if a cert is deactivated, everything stops.
2. **IoT policy too narrow** for the design's topics/shadow — required setup before any robot MQTT.
3. **Battery/dock unverifiable remotely** — physical glance needed; the bridge node will fix this permanently.
4. On-Pi Claude runs on a subscription with usage caps — sparse `claude -p` calls, backoff on errors.
5. `oak_watchdog.sh` not running + camera 15 days unattended — a silent X_LINK wedge degrades any future fusion to raw lidar.
6. Pi headroom: joy/teleop/diagnostics back (≈25% CPU), no swap, soft-temp flag tripped once — matters only when the full mapping stack runs; kill by PID (never `pkill -f`) per gotcha #6.
7. Pi repo staleness — was 4 commits behind; **pulled to `036356c` during this probe**. Sessions should `git pull` at start.

## Required setup steps — ALL DONE 2026-07-05
1. ✅ IoT MQTT access: new additive policy **`guidemate-robot-policy`** attached to the
   robot cert — `iot:Connect` for client ids `guidemate-*`; Publish/Receive/Subscribe on
   `guidemate/turtlebot468/*` and `$aws/things/Turtlebot-468/shadow/*`. (The old
   quick-start `Turtlebot-468-Policy` was left untouched.) **Bridge client ids must start
   with `guidemate-`.**
2. ✅ Device Shadow initialized (classic shadow, thing `Turtlebot-468`):
   `desired = {motion_enabled: false, max_speed: 0.15, dry_run: true}` — motion is locked
   from birth; the bridge must reconcile and report.
3. ✅ Knowledge Base stack created and **verified end-to-end** (upload → ingest → retrieve
   returned correct chunks):
   | Resource | Id / name |
   |---|---|
   | Docs bucket | `s3://guidemate-kb-docs-852373397000` |
   | S3 Vectors bucket / index | `guidemate-kb-vectors` / `guidemate-kb-index` (1024-dim, cosine, `AMAZON_BEDROCK_TEXT` non-filterable) |
   | KB execution role | `guidemate-kb-role` |
   | **Knowledge Base** | **`A1NIQYZ0KQ`** (`guidemate-kb`, Titan embed v2) |
   | Data source | `OT8JLH57TE` (`guidemate-kb-docs`) |
   | Seed doc | `docs/agent-poc/kb-seed/robert-facts.md` (repo = source of truth; synced to the bucket) |
   Re-ingest after uploads: `aws bedrock-agent start-ingestion-job --knowledge-base-id A1NIQYZ0KQ --data-source-id OT8JLH57TE`.
   Query: `aws bedrock-agent-runtime retrieve --knowledge-base-id A1NIQYZ0KQ --retrieval-query '{"text":"…"}'`.
4. Pin the agent service to `us.anthropic.claude-sonnet-4-6` (still applies).

## Dog-agent POC dev resources (created 2026-07-05, Phase 0-1)
| Resource | Id / name | Notes |
|---|---|---|
| IoT policy `guidemate-dev-policy` | attached to dev cert `aec82bf4…` | Connect `client/guidemate-*`; Pub/Receive `guidemate/devtest/*`; Receive `guidemate/+/status`; Subscribe `guidemate/devtest/*` + `guidemate/+/status`. Additive; robot policy untouched. Tag `project=guidemate-poc`. ARN `arn:aws:iot:us-west-2:852373397000:policy/guidemate-dev-policy`. |
| IAM role `guidemate-iot-logging-role` | trusts `iot.amazonaws.com` | `AWSIoTLogging` managed policy (`arn:aws:iam::aws:policy/service-role/AWSIoTLogging` — note: not `AWSIotLoggingRole`, which does not exist); used by IoT v2 logging (default level WARN). Tag `project=guidemate-poc`. Role ARN `arn:aws:iam::852373397000:role/guidemate-iot-logging-role`. No prior logging role existed. |
| IoT v2 logging | default level `WARN` | Denials land in CloudWatch `AWSIotLogsV2`. |
| DynamoDB tables | `guidemate-sessions`, `guidemate-messages`, `guidemate-requests`, `guidemate-config` | on-demand (`PAY_PER_REQUEST`), tag `project=guidemate-poc`, region us-west-2. Created by `scripts/create_dynamo_tables.py` (idempotent). Phase 3 uses only `guidemate-config` (`pk="flags"` feature flags + `pk="prompt"` admin-set system prompt); the other three are Phase 4 (sessions / chat history / companion requests). |
| S3 bucket `guidemate-maps-852373397000` | us-west-2, private (public access fully blocked), tag `project=guidemate-poc` | Admin Maps tab storage: `maps/<robot_id>/latest.png` + `maps/<robot_id>/meta.json` `{captured_ts, source}`. Populated by `scripts/upload_map_from_pi.sh` (operator-run from the Linux box); served through the service via boto3 (never public). Conversion/key helpers live in `scripts/maps.py` (standalone, not agent_service — Task 5 owns wiring the admin endpoint). Verified 2026-07-05: bucket created + tagged + public-access-blocked; real map found on the Pi (`/home/ubuntu/maps/guide_mate_map.pgm`, newer than `~/my_map.pgm`), converted and uploaded end-to-end to `maps/turtlebot468/{latest.png,meta.json}` (confirmed via `list-objects-v2`). |

**Real IoT Core round-trip verified 2026-07-05:** the gated integration test
(`agent_service/tests/integration/test_roundtrip.py`, `GUIDEMATE_INTEGRATION=1`) runs the
real bridge subprocess (dev cert, `robot_id=devtest`, dry-run) against live IoT Core and
observes the full `received→running→done` (`simulated=True`) round-trip in ~0.16–0.27 s.
**Gotcha:** AWS IoT QoS1 does **not** preserve order across separate publishes — the three
acks can arrive out of order (observed `received → done → running`), so consumers that stop
collecting on the terminal `done` (e.g. `RobotRegistry.send_command`) may return a partial
list. The test asserts on the complete captured set, not on arrival order.

## Pi bridge service — DEPLOYED (2026-07-05, Phase 1)
The dog-agent bridge now runs on robot 468's Pi as a systemd service, **dry-run, additive**.
Installed from the Linux box by `src/guide_mate_bridge/scripts/install_bridge_on_pi.sh`
(SSH-driven, idempotent; `git pull` on the Pi is the transport, renders the unit from
`src/guide_mate_bridge/systemd/guidemate-bridge.service`).
| Item | Value |
|---|---|
| Unit | `/etc/systemd/system/guidemate-bridge.service` — `enable --now`, `active (running)` |
| Identity | robot cert `~/cs7980-guide-mate/Turtlebot-468.{cert.pem,private.key}`, client id `guidemate-bridge-turtlebot468`, `GUIDEMATE_ROBOT_ID=turtlebot468` |
| Safety | `Environment=GUIDEMATE_DRY_RUN=1` in the unit; the bridge **refuses to start** without a truthy dry-run. No motion path exists. |
| Endpoint / CA | `GUIDEMATE_IOT_ENDPOINT` = data-ATS endpoint (rendered at install); `GUIDEMATE_CA=/home/ubuntu/certs/AmazonRootCA1.pem` (fetched by the installer) |
| venv | `~/guidemate-venv` (editable `guidemate_msgs` + `guide_mate_bridge`). **Gotcha:** this Pi image has **no `python3-venv`/`ensurepip`** — the installer creates the venv `--without-pip --system-site-packages` then bootstraps pip in-venv (no apt needed; `awscrt`/`awsiotsdk` come from the user's `~/.local`). |
| Logs | `journalctl -u guidemate-bridge` — startup line `{"msg": "bridge connected", "robot_id": "turtlebot468"}`; online event published to `guidemate/turtlebot468/status` on connect. |

**Phase 1 slice check PASSED (`scripts/slice_check.sh`, checklist items 1 & 3):** local
uvicorn + `POST /api/chat "do a happy wiggle"` → Bedrock (`us.anthropic.claude-sonnet-4-6`)
→ MQTT → Pi bridge. Response `emote="happy"`, acks `received (simulated:false)` +
`done (simulated:true)`; the Pi journal showed the six computed `DRY-RUN twist vx=0.050
wz=±1.200 dur=0.40s` lines and **published no twists**. Robot 468 untouched beyond the
additive unit; shadow not modified. Manage only via `sudo systemctl … guidemate-bridge`
(never `pkill`).

## Phase 2 "robot truth" verification (2026-07-05)
No new AWS resources (shadow + robot policy already existed). Phase-2 bridge
(`bridge_version 0.2.0`) redeployed to the Pi via `scripts/install_bridge_on_pi.sh`
(now renders `GUIDEMATE_THING_NAME`, `GUIDEMATE_ROS`, and a ROS-sourcing `ExecStart`
wrapper: `source /opt/ros/humble/setup.bash && source /etc/turtlebot4/setup.bash &&
export ROS_SUPER_CLIENT=True`). Unit still carries `GUIDEMATE_DRY_RUN=1` (verified in the
rendered unit before and after every restart); robot 468 docked and motionless throughout.

| Check | Result |
|---|---|
| Heartbeats on `guidemate/turtlebot468/status` | every 30 s: `uptime_s` + `gates`, **battery/docked = null** (see telemetry row) |
| Telemetry rclpy layer | node comes **up** (`"telemetry ROS node up", namespace=/turtlebot468, battery_topic=battery_state, dock_topic=dock_status`) but **battery/docked = null (Discovery-Server fallback)**. Topics `/turtlebot468/battery_state` + `/turtlebot468/dock_status` **exist** in the boot graph (visible to an ad-hoc `ROS_SUPER_CLIENT=True` `ros2 topic list`, 29 topics) but `ros2 topic echo` returns **0 frames** for them — the documented ephemeral-super-client "lists but can't receive" limitation. An `/etc/systemd/system/guidemate-bridge.service.d/10-abs-topics.conf` drop-in forcing absolute `GUIDEMATE_BATTERY_TOPIC=/turtlebot468/battery_state` etc. changed **nothing** (relative names already resolve identically under the node namespace); the drop-in was **removed** so the Pi config matches the committed unit. Accepted degradation — heartbeats still prove liveness/uptime/gates. |
| Shadow drill (`desired.max_speed` 0.15→0.10→0.15) | reported followed **both ways within ~6 s** (delta handler: `"shadow delta applied: ['max_speed']"`); `motion_enabled` untouched (`false` in every `get-thing-shadow`) |
| Restart persistence | `systemctl restart` → `"shutting down gracefully"` logged (graceful SIGTERM path) → reported re-converged to `desired` on boot (`reported.max_speed=0.10`, fresh `uptime_s=0.6`) |
| Refusal evidence (item 4, dry-run held) | motion ack `gates={docked: null, motion_enabled: false, dry_run: true}`, `simulated=true`; integration test `test_motion_command_dry_run_ack_carries_gate_state` **PASS** |
| Robot-cert shadow publishes | robot cert `Turtlebot-468` **can** publish `reported` (delta reconcile + reported both work) — unlike the dev cert |
| Integration tests (this box, `GUIDEMATE_INTEGRATION=1`) | `test_robot_truth.py` **2 passed** (heartbeat ≤35 s + refusal gates). Full default suite **134 passed, 6 skipped** |

**Checklist status:** item 2 (shadow) ✅, item 4 (refusals, dry-run-held ack gates) ✅,
item 5 (telemetry liveness/gates ✅; battery/dock null-fallback documented).

**Known issue (not a Phase-2 regression, dev-cert only):** `test_roundtrip.py` (local
dev-cert bridge subprocess) **FAILS** — `[]` acks. Root cause in shared bridge
`shadow.py`: the shadow-denial guard assumes `client.subscribe()` **raises** on a
policy-denied SUBACK, but awscrt reports the denial via SUBACK failure-QoS **without
raising**, so `_subscribed=True` and the bridge publishes `$aws/things/Turtlebot-468/
shadow/get` → **unauthorized publish → AWS IoT drops the whole connection** → command
delivery flaps → the live test command lands in a disconnect window. The dev-cert bridge
never logs `"bridge connected"` (blocks/flaps in `shadow.start()`), yet still executes a
queued command once (proving the cmd subscription). The **robot cert is unaffected**
(it has shadow permissions). Fix belongs to the bridge/shadow owner: detect denied
SUBACK via the returned QoS (`0x80`) rather than relying on an exception.

## Work branch
All POC work happens on branch **`kalhar/dog-agent-poc`** (pushed to origin). Warm-up
instructions for a new machine/session: [linux-agent-warmup.md](linux-agent-warmup.md).

## Phase 7 — production (EC2 + observability)
Launched by `agent_service/deploy/launch_ec2.sh` (idempotent-ish, no console clicking):
| Resource | Name / id | Notes |
|---|---|---|
| EC2 instance | tag `Name=guidemate-poc-ec2`, t3.large, AL2023 | instance profile `guidemate-agent-profile` (zero-cred); user-data brings up the prod Compose stack |
| Security group | `guidemate-poc-sg` | ingress 80/443 from 0.0.0.0/0, 22 from the launcher IP/32 |
| Elastic IP | tag `Name=guidemate-poc-eip` | reused across relaunches; domain `<eip-dashes>.nip.io` |
| Admin password | generated **on the instance** by `user_data.sh` (`openssl rand -hex 16`) | stored in **SSM Parameter Store** `/guidemate/admin-password` (SecureString) **and** `/etc/guidemate.env` (mode 600) on the instance. **Never** passed through EC2 user-data (which is API-readable via `DescribeInstanceAttribute` for the instance lifetime). |
| Manage | `aws ssm start-session --target <iid>` | SSM Session Manager — no SSH key on the instance |

**Retrieve the admin password** (after bootstrap finishes, ~2-3 min):
```bash
aws ssm get-parameter --name /guidemate/admin-password \
  --with-decryption --query Parameter.Value --output text --region us-west-2
```
The `guidemate-agent-profile` instance role has `ssm:PutParameter` so the instance
self-publishes it at first boot. The bootstrap log (`/var/log/guidemate-bootstrap.log`)
is `chmod 640` and the bootstrap runs **without** `set -x`, so the secret never lands in a
world-readable log.

**`launch_ec2.sh --plan`** does a dry run: the read-only discovery/idempotency lookups
(describe instances/SG/addresses, SSM AMI param, launcher-IP) run for real, but the
mutating calls (create-SG, allocate/associate EIP, run-instances) are only printed. No
password is generated or handled by `launch_ec2.sh` at all.
Redeploy without SSH via `agent_service/deploy/redeploy.sh` (one SSM `send-command`);
tear down via `agent_service/deploy/teardown.sh` — **requires `--yes`** (a bare invocation
prints what would be deleted and exits 1); pass `--keep-eip` to retain the address.

**⚠️ No default VPC in us-west-2 (verified 2026-07-05):** the account has only one
non-default VPC (`vpc-0657dd5b506f043a9`); `describe-vpcs Name=isDefault,Values=true`
returns empty. The launch script (and `run-instances`) will need a `--vpc-id` +
`--subnet-id` for that VPC before the real Task-7 launch — resolve at launch time.

### Observability (scripts/setup_observability.sh) — created & verified 2026-07-06
Idempotent (re-runnable), tags what it creates where the API supports tags, no console
clicking. `scripts/setup_observability.sh --clean` deletes everything it created.
| Resource | Name | Notes |
|---|---|---|
| Log groups | `/guidemate/agent-service`, `/guidemate/caddy`, `/guidemate/bridge`, `/guidemate/bedrock` | 30-day retention; EMF auto-extracts metrics in namespace `GuideMate` |
| Bedrock logging | model-invocation logging → `/guidemate/bedrock` | role `guidemate-bedrock-logging-role` (trusts bedrock.amazonaws.com; inline policy `guidemate-bedrock-logging`, tag `project=guidemate-poc`) |
| Metric filters | `guidemate-service-errors` (`$.level=ERROR`→`AgentServiceErrors`), `guidemate-bedrock-throttle` (`ThrottlingException`→`BedrockThrottles`) | on `/guidemate/agent-service`; both `defaultValue=0` |
| Dashboard | `guidemate-poc` | turn latency, ack RTT, tokens, errors/throttles, PiHeartbeat presence, EC2 CPU |
| Alarms (no SNS) | `guidemate-poc-service-errors`, `-bedrock-throttle`, `-bridge-offline` (PiHeartbeat SampleCount<1 for 15 min = breaching), `-ec2-cpu` (>85% avg 10 min) | state visible in console/dashboard; `-ec2-cpu` is created **only when a running `guidemate-poc-ec2` instance exists** — re-run the script after `launch_ec2.sh` to add it |
| Pi log-ship | `guidemate-logship.timer` (5 min) | ships the `guidemate-bridge` journal (via `journalctl --cursor-file`, only new lines) + one `PiHeartbeat` EMF event to `/guidemate/bridge` with the Pi's `credential_process` creds; unit `guidemate-logship.service` (oneshot); installed additively by `src/guide_mate_bridge/scripts/install_bridge_on_pi.sh` (extends the bridge installer, reuses `~/guidemate-venv`) |

**Verified 2026-07-06** (`list-dashboards`→`guidemate-poc`; `describe-alarms guidemate-poc*`→
service-errors/bedrock-throttle/bridge-offline present, ec2-cpu pending instance;
`get-model-invocation-logging-configuration`→cloudWatchConfig on `/guidemate/bedrock`;
4 log groups @ 30-day retention; 2 metric filters on agent-service). Alarms sit
INSUFFICIENT_DATA until traffic (service-errors is OK because its filter has
`defaultValue=0`) — expected pre-launch.

## Production deployment (LIVE) — verified 2026-07-06 (Phase 7 Task 7)
- **URL:** https://echo.kalhar.ca (real Let's Encrypt cert via Caddy; DNS A record → the EIP)
- **Instance:** `i-0e1301c47f73c771c`, t3.large, us-west-2, account `852373397000`, instance profile `guidemate-agent-profile` (Bedrock/DynamoDB/IoT all reachable with zero static creds)
- **Elastic IP:** `52.32.24.152` (tag `Name=guidemate-poc-eip`)
- **Admin password:** SSM Parameter Store `/guidemate/admin-password` (SecureString) — retrieve with:
  ```bash
  aws ssm get-parameter --name /guidemate/admin-password \
    --with-decryption --query Parameter.Value --output text --region us-west-2
  ```
  (never print/commit the value)
- **Redeploy:** `agent_service/deploy/redeploy.sh` — one SSM `send-command` that pulls the branch and rebuilds the prod Compose stack on the instance; no SSH key needed.
- **Teardown:** `agent_service/deploy/teardown.sh --yes` (terminates the instance + releases the EIP; pass `--keep-eip` to retain the address). A bare invocation (no `--yes`) is a dry run.

**Live verification results (2026-07-06):**
| Check | Result |
|---|---|
| `GET /healthz` | `200 {"ok":true}` |
| `GET /readyz` | `200 {"ready":true,"checks":{"mqtt":true,"dynamo":true}}` — both MQTT and DynamoDB up |
| Admin login (`POST /api/admin/login` with SSM password) | `200 {"ok":true}`, `Set-Cookie: guidemate_admin` (HttpOnly, Secure) |
| `GET /api/admin/flags` (with session cookie) | `200` — all flags returned (`dog_muted:false`, `emotes_enabled:true`, `motion_tools_enabled:true`, `persona_enabled:true`, `kb_enabled:true`) |
| `POST /api/chat` (real Bedrock turn, "say hi in one word") | `200` in ~3.1s; `reply_text` present, `emote:"happy"`, robot round-trip acks all `simulated:true` (dry-run, motion disabled) |
| `scripts/prod_slice_check.sh` against `BASE_URL=https://echo.kalhar.ca` | `OK: chat round-trip verified (emote + simulated ack)` |
| Playwright e2e suite (`agent_service/tests/e2e`, marker `e2e`, gated by `GUIDEMATE_E2E=1`) | Harness boots its own uvicorn subprocess (`localhost`) and has no `BASE_URL` override, so it cannot target prod directly — ran the equivalent checks above via curl against prod instead; re-verified the suite itself green locally: `GUIDEMATE_E2E=1 .venv/bin/python -m pytest agent_service/tests/e2e -q` → 8 passed |

No test session/request rows were left behind: the chat calls above used the legacy
session-less `/api/chat` path (no `session_id`), so nothing was written to the
`guidemate-sessions`/`guidemate-messages` DynamoDB tables.

## Sim identity (Turtlebot-Sim) — added 2026-07-05 (Phase 8)
- **Thing:** `Turtlebot-Sim` (`thingId 28f0f996-6acf-4239-b180-9babae1b947a`, ARN `arn:aws:iot:us-west-2:852373397000:thing/Turtlebot-Sim`), us-west-2. Separate from `Turtlebot-468` (the real robot is never touched by any Phase 8 artifact).
- **Cert/key (local, NOT committed):** `~/.aws/guidemate-sim.cert.pem` + `~/.aws/guidemate-sim.key.pem` (chmod 600). Cert ARN `arn:aws:iot:us-west-2:852373397000:cert/e50b6fc6e1be8d2a29ec95166abcb53b080729b3a595e79083c7df23a3eaaefc` — active, attached to the thing and to `guidemate-sim-policy`. Exactly one principal on the thing (idempotent re-run mints no second cert).
- **Policy:** `guidemate-sim-policy` (tag `project=guidemate-poc`) — connect as client `guidemate-*`; publish/subscribe/receive on `guidemate/turtlebotsim/*` and `$aws/things/Turtlebot-Sim/shadow/*` only.
- **Classic shadow:** default-deny `{motion_enabled:false, max_speed:0.15, dry_run:true}`, same as the real robot. Flipped `true` **only** during a sim motion run, then reset to locked.
- **Provisioning:** `scripts/create_sim_identity.sh` (idempotent — re-run skips existing thing/policy and reuses the local cert). **Note:** AWS IoT does not support tagging individual `thing` resources (only thing-groups/types/billing-groups), so the thing itself carries no tag — the script's `tag-resource || true` absorbs the `InvalidRequestException`; the **policy** carries `project=guidemate-poc`. The `sts get-caller-identity` account lookup in the ARN resolves to `852373397000`.

## Virtual fleet identity (Virtual-Fleet), PROVISIONING PENDING (2026-07-27, Phase 2 Task 2.2)
Script written and dry-run verified only. **Not yet applied to AWS**, the controller must
review the policy statement below with the human, then re-run with `--apply`. This is a THIRD
identity, separate from `Turtlebot-468` (real robot) and `Turtlebot-Sim` (single Gazebo sim);
neither is touched by this script.
- **Script:** `scripts/create_virtual_fleet_identity.sh` (clone of `create_sim_identity.sh`,
  same idempotent structure: skip-if-exists thing/policy/cert, `tag-resource || true` for the
  same untaggable-`thing` quirk, default-deny shadow). **Safe by default:** with no flags it is
  a dry run that prints every AWS CLI call plus the exact policy JSON and mutates nothing;
  `--apply` is required to actually create anything. Verified 2026-07-27: default-mode run
  printed the full plan, and a follow-up `aws iot list-things` / `list-policies` confirmed
  nothing new was created (still only `Turtlebot-Sim`/`Turtlebot-468` and the five existing
  policies).
- **Planned thing:** `Virtual-Fleet` (not yet created). **Planned policy:**
  `guidemate-fleet-policy` (tag `project=guidemate-poc`), a NEW additive policy rather than
  widening `guidemate-sim-policy`: cleaner blast radius (one policy per identity, easy to
  revoke independently) and the sim policy's `guidemate/turtlebotsim/*` scope is unrelated to
  the fleet's `guidemate/virtual/*` scope, so there's no shared statement to merge.
- **Planned cert/key (local, not committed):** `~/.aws/guidemate-fleet.cert.pem` +
  `~/.aws/guidemate-fleet.key.pem` (chmod 600 on creation), following the same
  never-in-the-repo convention as the sim and dev certs.
- **Proposed policy scope:** connect as client `guidemate-*` (already covered by the existing
  sim/robot policies, included here too so this policy is self-contained); publish/subscribe/
  receive on `guidemate/virtual/*` and `$aws/things/Virtual-Fleet/shadow/*` only.
- **Topic naming assumption (flag for Task 2.3, the Node MQTT bridge):** the design spec
  writes the fleet scope as `guidemate/virtual/+/*`. The existing
  `shared/guidemate_msgs/guidemate_msgs/messages.py` `cmd_topic()`/`status_topic()` helpers
  build flat topics `guidemate/{robot_id}/cmd|status`, so to land under `guidemate/virtual/...`
  with those helpers unchanged, each virtual robot's `robot_id` needs its own `virtual/`
  namespace, e.g. `robot_id="virtual/1"` → `guidemate/virtual/1/cmd`. The policy scopes to the
  root `guidemate/virtual/*` (one trailing wildcard, matching the sim policy's own
  `guidemate/turtlebotsim/*` granularity) so any id depth under that root is covered. If Task
  2.3 instead uses flat ids like `virtual-1` (topic `guidemate/virtual-1/cmd`), that does **not**
  fall under `guidemate/virtual/*`, and the policy will need a second statement or a broader
  root. Confirm the chosen id scheme before `--apply`.
- **Planned shadow:** default-deny, same shape as the real robot and `Turtlebot-Sim`:
  `desired = {motion_enabled: false, max_speed: 0.15, dry_run: true}`. The virtual fleet has no
  physical motor, so these fields don't gate real hardware here; they exist so a future
  fleet-wide kill switch can reconcile one schema across real/sim/virtual identities.

## world-server containerized as a third Compose service — BUILT, NOT YET DEPLOYED (2026-07-31, Phase 5 Task 5.1)
`world/Dockerfile` (multi-stage: `node:20-slim` build stage runs `npm ci` + `npm run build`
(tsc); runtime stage runs `npm ci --omit=dev --ignore-scripts` + `node dist/index.js`) added as
a **third** service `world-server` in the existing `agent_service/compose.yaml` (same file the
`app`/`caddy` services live in, not a parallel compose project), `agent_service/compose.prod.yaml`
(adds the `awslogs` driver → `/guidemate/world-server`), and routed through the existing
`agent_service/Caddyfile` at `/world/*` (`handle_path` strips the prefix so the Colyseus client's
own root-relative `/matchmake/...` and room-WS paths still resolve — verified against
`@colyseus/sdk`'s `Client.mjs`, which folds a base-URL `pathname` into both the HTTP matchmake
call and the WS room endpoint). Point `world-client`'s `VITE_WORLD_SERVER_URL` at
`wss://echo.kalhar.ca/world` when the client is deployed. Reuses the same `/etc/guidemate.env`
pattern as the `app` service for `GUIDEMATE_IOT_ENDPOINT`/`GUIDEMATE_CERT`/`GUIDEMATE_KEY` (all
empty by default — the Virtual-Fleet IoT identity above is still provisioning-pending, so the
bridge stays gracefully disabled, same as `app`'s `GUIDEMATE_IOT_ENDPOINT` unset case).

**NOT deployed to the live `echo.kalhar.ca` instance.** Everything below was built and validated
locally only, on the controller's Windows dev box, per this task's safety constraint (no
`redeploy.sh`, no `ssm send-command`, no EC2-mutating call against the real instance). Kalhar
runs the actual deploy himself (steps below).

**What was verified locally, and how:**
| Check | Result |
|---|---|
| `docker compose -f agent_service/compose.yaml -f agent_service/compose.prod.yaml config` | Renders cleanly — all three services (`app`, `world-server`, `caddy`), `world-server`'s build context/dockerfile, env vars, `awslogs` logging, and `caddy`'s `depends_on: [app, world-server]` all resolve as expected. |
| `docker build -f world/Dockerfile .` / full `docker compose up --build` | **Could not run** — Docker Desktop's daemon (`com.docker.service`) is installed but stopped on this box, and starting it is denied in this sandboxed session (`Cannot open com.docker.service service`). The CLI/compose binaries exist and answer `--version`, but nothing that needs the daemon (build, up, stats) is reachable here. |
| TypeScript build (the Dockerfile's build-stage command) | `npm run build` (`tsc -p tsconfig.json`) run directly in `world/` — compiles clean, no errors. |
| Runtime CMD (the Dockerfile's `CMD ["node","dist/index.js"]`) | Run directly (not containerized, since the daemon is unreachable): `node dist/index.js` starts, logs `World-server listening on ws://localhost:2599`, and `GET /healthz` → `200 {"ok":true}` — the same check the Dockerfile's `HEALTHCHECK` runs internally. This is the closest available proxy for "the container starts and serves" without a daemon. |
| `agent_service` startup (fake-robot mode) | `agent_service/.venv` created in this worktree, installed per the documented local-run recipe (`pip install -e shared/guidemate_msgs`, `pip install -e agent_service`, `pip install --no-deps amazon-transcribe`), run with `GUIDEMATE_FAKE_ROBOT=1 GUIDEMATE_ADMIN_PASSWORD=test GUIDEMATE_IOT_ENDPOINT=dummy.example.com` → `GET /healthz` → `200 {"ok":true}`. |

**Combined load-check — real measured numbers, not assumed** (proxy: Docker daemon unreachable,
so `agent_service` + `world-server` ran as native local processes, not containers, alongside
Task 1.3's actual 95-agent load test, `node --import tsx scripts/loadtest.ts` in `world/`):
- **This machine's specs** (the caveat that matters): AMD Ryzen 7 5800HS, 8 cores / 16 threads,
  ~24 GB RAM — **much larger than the real t3.large** (2 vCPU, 8 GB RAM) the production instance
  runs on. These numbers are not a like-for-like substitute for an actual t3.large run; they're
  the closest proxy available without provisioning one.
- Sampled `TotalProcessorTime`/`WorkingSet64` every 300ms (Windows `Get-Process`) for all three
  processes across the full ~4.9s, 7500-tick (95 agents × 5 runs × 1500 measured ticks) load-test
  run:
  - `agent_service` (idle, fake-robot mode, no active chat turns): CPU time **flat at 1.812s**
    for the entire run (0% marginal CPU while idle) — RSS **99.75 MB**.
  - `world-server` (idle, no connected Colyseus clients): CPU time **flat at 1.062s→1.109s** for
    the entire run (~0% marginal CPU while idle) — RSS **66.45 MB**.
  - `loadtest` process itself (the actual 95-agent crowd-sim CPU cost, run unpaced/back-to-back —
    a deliberate worst-case stress figure, not the real 60Hz-paced load): CPU time rose from
    0.19s→5.20s over 4.86s wall time, i.e. **~100% of one core saturated** when hammered with no
    pacing between ticks.
  - Per-tick cost from the load test's own output (unchanged by this task, Task 1.3's numbers):
    avg **0.567–0.587ms/tick**, max **1.40ms/tick**, **0/7500 ticks over the 16.6ms 60Hz budget**.
    At real 60Hz pacing (16.6ms between ticks, not back-to-back), that's roughly
    **0.58/16.6 ≈ 3.5% of one core**, sustained, for the crowd-sim work alone — the 100%-of-one-core
    figure above is the unpaced-benchmark ceiling, not what production pacing would show.
  - **Combined idle RSS** (`agent_service` + `world-server`, excluding Caddy/OS): **~166 MB** —
    a small fraction of the t3.large's 8 GB, comfortable headroom on memory.
- **Compared against the existing 85% CPU alarm threshold** (`guidemate-poc-ec2-cpu`,
  `AWS/EC2` `CPUUtilization`): on *this* machine, idle `agent_service`/`world-server` show ~0%
  marginal CPU and the crowd-sim's own 60Hz-paced cost is a well-bounded ~3.5% of one core —
  nowhere near 85%. **Caveat, stated plainly:** a t3.large's 2 vCPUs are a much smaller, and
  burstable-credit, budget than this 8-core box; the 0/7500-over-budget tick result doesn't
  linearly translate to a t3.large's weaker/burst-limited vCPUs, and Bedrock-turn CPU cost
  (JSON/HTTP handling during real chat, not exercised here) is not part of either idle figure.
  **This should be re-verified with real `docker stats`/CloudWatch data once Kalhar deploys and
  the 95-visitor load test is pointed at the live instance** — the number reported here is the
  best available local proxy, not a substitute for that on-instance measurement.

### Manual deploy steps (Kalhar runs these himself — NOT executed by the implementer/controller)
1. Review the diff: `world/Dockerfile` (new), `agent_service/compose.yaml`,
   `agent_service/compose.prod.yaml`, `agent_service/Caddyfile`, `scripts/setup_observability.sh`,
   `agent_service/deploy/user_data.sh` (procstat block — only affects a *future* `launch_ec2.sh`
   run, not the live instance).
2. Optional but recommended first: reproduce the local validation above yourself with Docker
   Desktop actually running — `docker compose -f agent_service/compose.yaml -f
   agent_service/compose.prod.yaml config`, then a throwaway `docker compose up --build` against
   a local `.env` (NOT the real `/etc/guidemate.env`) and confirm `curl localhost/world/healthz`
   (via Caddy) or `curl localhost:2567/healthz` (direct) returns `200`.
3. Redeploy the live instance (same one-command path as every prior phase — this rebuilds all
   three services, `world-server` included, since it's now in the same `compose.yaml`):
   ```bash
   agent_service/deploy/redeploy.sh
   ```
   This SSHes nothing; it's one `aws ssm send-command` that does `git fetch/checkout/reset --hard`
   to the latest `kalhar/dog-agent-poc`-equivalent branch tip on `/opt/guidemate`, then
   `docker compose --env-file /etc/guidemate.env -f compose.yaml -f compose.prod.yaml up -d
   --build` on the instance. No new env vars are *required* in `/etc/guidemate.env` for
   `world-server` to come up (its `GUIDEMATE_IOT_ENDPOINT`/`CERT`/`KEY` default to empty, same
   graceful-degrade as today) — nothing to add there unless the Virtual-Fleet cert/key are ready.
4. Push the new CloudWatch agent config (Node-process CPU/mem metric) onto the *already-running*
   instance — `launch_ec2.sh` only renders `user_data.sh` at first boot, so an existing instance
   needs this pushed explicitly:
   ```bash
   scripts/setup_observability.sh
   ```
   (idempotent — safe to re-run after every redeploy; this is the same script that already
   manages the dashboard/alarms/log groups, now also reconciling the `procstat` block onto the
   instance's `amazon-cloudwatch-agent` config and adding the `guidemate-poc-world-cpu` alarm +
   two new dashboard widgets, all still under the `GuideMate/EC2` namespace).
5. Verify for real (this is the part the implementer could not do — no real instance, no real
   creds, per this task's safety constraint):
   - `curl -s https://echo.kalhar.ca/world/healthz` → expect `{"ok":true}`.
   - Point a `world-client` build's `VITE_WORLD_SERVER_URL` at `wss://echo.kalhar.ca/world` and
     confirm a real Colyseus `joinOrCreate("world")` round-trip.
   - `docker stats` on the instance (via `aws ssm start-session --target <iid>`) while running
     Task 1.3's load test against it, to get the *real* t3.large combined-CPU number this doc's
     local-proxy section above could not produce.
   - CloudWatch dashboard `guidemate-poc` → confirm the two new "world-server process" widgets
     populate within ~5 minutes of the `setup_observability.sh` push.
   - Retire this section's "NOT YET DEPLOYED" heading once confirmed live, and replace the
     local-proxy load numbers above with the real on-instance ones.
