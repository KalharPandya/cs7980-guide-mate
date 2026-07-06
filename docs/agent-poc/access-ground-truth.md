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

## Sim identity (Turtlebot-Sim) — added 2026-07-05 (Phase 8)
- **Thing:** `Turtlebot-Sim` (`thingId 28f0f996-6acf-4239-b180-9babae1b947a`, ARN `arn:aws:iot:us-west-2:852373397000:thing/Turtlebot-Sim`), us-west-2. Separate from `Turtlebot-468` (the real robot is never touched by any Phase 8 artifact).
- **Cert/key (local, NOT committed):** `~/.aws/guidemate-sim.cert.pem` + `~/.aws/guidemate-sim.key.pem` (chmod 600). Cert ARN `arn:aws:iot:us-west-2:852373397000:cert/e50b6fc6e1be8d2a29ec95166abcb53b080729b3a595e79083c7df23a3eaaefc` — active, attached to the thing and to `guidemate-sim-policy`. Exactly one principal on the thing (idempotent re-run mints no second cert).
- **Policy:** `guidemate-sim-policy` (tag `project=guidemate-poc`) — connect as client `guidemate-*`; publish/subscribe/receive on `guidemate/turtlebotsim/*` and `$aws/things/Turtlebot-Sim/shadow/*` only.
- **Classic shadow:** default-deny `{motion_enabled:false, max_speed:0.15, dry_run:true}`, same as the real robot. Flipped `true` **only** during a sim motion run, then reset to locked.
- **Provisioning:** `scripts/create_sim_identity.sh` (idempotent — re-run skips existing thing/policy and reuses the local cert). **Note:** AWS IoT does not support tagging individual `thing` resources (only thing-groups/types/billing-groups), so the thing itself carries no tag — the script's `tag-resource || true` absorbs the `InvalidRequestException`; the **policy** carries `project=guidemate-poc`. The `sts get-caller-identity` account lookup in the ARN resolves to `852373397000`.
