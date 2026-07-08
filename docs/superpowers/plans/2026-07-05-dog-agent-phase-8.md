# Dog Agent POC — Phase 8 (Gazebo sim / virtual pets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a **virtual TurtleBot 4** in Ignition Fortress on the Linux box, give it its own AWS IoT identity (`Turtlebot-Sim`) and shadow, point the *unchanged, parameterized* bridge at the sim's ROS graph, build the **one and only real `cmd_vel` publishing path** (env + shadow + dry-run triple-gated) plus `undock`/`dock` as **Create 3 ROS actions**, and prove motion end-to-end — circle closes, kill-switch fires, dock-guard refuses (with the undock/dock/stop exemption), and the full dock lifecycle (undock → drive → dock) round-trips over IoT — with an odometry-asserted headless pytest regression. Then extend the companion flow with a **virtual-pet** grant so a non-lock session can be connected to the sim robot. **Robot 468's identity, shadow, and locks are never touched.**

**Architecture:** Phase 8 is a params-only drop-in on top of the multi-robot foundation. A new one-time script mints the sim's IoT thing + cert + scoped policy + classic shadow (default-deny, identical to the real robot). The bridge gains a real-drive path in `ChoreographyRunner` (a fixed-rate, abort-aware twist loop), a thin rclpy `CmdVelPublisher`, and a `DockActions` rclpy action-client wrapper — `undock`/`dock` motion commands are dispatched as **Create 3 ROS actions** (`/undock` → `irobot_create_msgs/action/Undock`, `/dock` → `irobot_create_msgs/action/Dock`), never twist choreographies; all are wired in `bridge.main` **only** when a hard triple-gate passes (`GUIDEMATE_ENABLE_MOTION=1` AND shadow `motion_enabled=true` AND not effective-dry-run), with a belt-and-braces hard refusal if that env is ever set for `turtlebot468`. While docked, the dock guard refuses all motion **except** `undock`, `dock` (no-op-ish → done), and `stop` — the pure exemption matrix `command_permitted` (spec delta "Assignment-triggered dock/undock", commit 91d9bcb). A `sim/` launch helper brings up Ignition + the bridge with sim params. A `GUIDEMATE_SIM=1`-gated pytest drives the sim over real IoT Core and asserts the trajectory from `/odom`. The companion flow gains a robot picker + virtual-pet badge.

**Tech Stack:** Python 3.10, pydantic v2, rclpy (Humble), `geometry_msgs`/`nav_msgs`/`irobot_create_msgs`, Ignition Fortress (`ign gazebo`), `turtlebot4_ignition_bringup` + `irobot_create_ignition_bringup`, awsiotsdk (awscrt MQTT), boto3 + `aws iot` / `aws iot-data`, pytest, Playwright.

## Global Constraints

Every task's requirements implicitly include this section (copied forward verbatim from `2026-07-05-dog-agent-phase-0-1.md`, with the Phase-8 motion-safety additions).

- **Python 3.10-compatible** on both machines — no 3.11+ syntax. `list[...]`/`dict[...]` generics are fine with `from __future__ import annotations`.
- **pydantic v2** (`>=2`); use `model_validate_json` / `model_dump_json` / `model_validate` / `model_dump` / `field_validator` / `model_validator`.
- **TDD**: write the failing test first, run it red, implement the minimum, run it green, then commit — every task.
- **Commit after every task** with a `Kalhar:` message prefix. **NEVER** add any Claude/AI/co-author line or `Co-Authored-By`. Do not push (the user pushes). **Do not run any other git write commands** (parallel agents share the `kalhar/dog-agent-poc` branch).
- **Never `pkill -f`** anything (gotcha #6 — it self-matches the shell). Kill sim/bridge processes by PID or `ps comm`.
- **Robot 468 stays docked, motion-locked, and untouched**: no Phase 8 code, script, env, or test ever writes robot 468's Device Shadow, sets `GUIDEMATE_ENABLE_MOTION` for it, or publishes to `guidemate/turtlebot468/*`. Motion is enabled **only** on the sim shadow (`Turtlebot-Sim`), and only for the duration of a sim run, then reset to locked.
- **Default-deny everywhere**: the sim shadow ships `motion_enabled=false, dry_run=true` exactly like the real robot; missing/unreadable shadow = locked.
- **No credentials or IoT endpoints committed** to the repo. The IoT data endpoint is discovered at runtime via `aws iot describe-endpoint --endpoint-type iot:Data-ATS`. Sim cert/key live at `~/.aws/guidemate-sim.cert.pem` + `~/.aws/guidemate-sim.key.pem` (chmod 600), never committed (already gitignored: `*.pem`, `*.key`).
- **Every new AWS resource** is tagged `guidemate-poc` where the API supports tags and documented in `docs/agent-poc/access-ground-truth.md`.
- **Env-gated live tests**: sim integration tests are `@pytest.mark.sim`, skipped unless `GUIDEMATE_SIM=1`; they need the sim + real IoT Core. UI tests use `GUIDEMATE_FAKE_ROBOT=1`.

**Verified environment facts (do not re-derive):** AWS account `852373397000`, region `us-west-2`; creds via `credential_process` (identity `guidemate-agent-role`). AWS CLI v2 at `~/.local/bin/aws`. This box has ROS 2 Humble + Ignition Fortress (`ign`) + `turtlebot4_ignition_bringup` + `irobot_create_ignition_bringup` + an NVIDIA GPU. The sim brings up an **un-namespaced** robot by default (`/cmd_vel`, `/odom`, `/battery_state`, `/dock_status`) — **Task 2 verifies this before any dependent code trusts it.** Dev venv at `~/cs7980-guide-mate/.venv`.

## Consumed pinned interfaces (from earlier phases — DO NOT build here; flag the dependency per task)

**Phase 0/1 (exists on disk today):**
- `guidemate_msgs.messages`: `Command(type, name, params={}, cmd_id, ts)`, `Ack(cmd_id, state, reason=None, simulated=False, battery=None, ts)` with `state ∈ {received, running, done, failed}`; `cmd_topic(robot_id)`, `status_topic(robot_id)`, `new_cmd_id()`.
- `guidemate_msgs.choreography`: `TwistStep(vx, wz, duration)`, `build(command, max_speed=MAX_LINEAR) -> list[TwistStep]`, constants `MAX_LINEAR=0.15`, `MAX_ANGULAR=1.5`, `MAX_TOTAL_S=30.0`. `circle` = one `TwistStep(0.12, 0.24, ~26.18)`; `stop` = `[TwistStep(0.0, 0.0, 0.0)]`.
- `guide_mate_bridge.executor.ChoreographyRunner(publish_ack, dry_run=True, publish_twist=None)` with `handle(cmd)` — **Phase 8 extends this file.**
- `guide_mate_bridge.bridge.Bridge(client, robot_id, dry_run=True)` with `on_message`, `start`, `_runner`, `_queue`, `_publish_ack`, `_truthy`; `main()` — **Phase 8 extends this file.**
- `guidemate_agent.mqtt_link.RobotRegistry(endpoint, region, robot_ids, client_id_prefix="guidemate-svc", connection=None)` with `connect()`, `send_command(robot_id, cmd, timeout_s=5.0) -> list[Ack]`, `get_status(robot_id) -> dict`.
- `guidemate_agent.config.Config.from_env()` reading `GUIDEMATE_ROBOTS` (comma list, default `turtlebot468`).
- `src/guide_mate_bridge/scripts/install_bridge_on_pi.sh` (Phase 0/1 Task 8) — the Pi installer. **Phase 8 adds a guard to it.**

**Phase 2 (PINNED — assume present at Phase-8 execution time; flag as a dependency, don't re-implement):** the bridge has a shadow-reconcile / safety layer that, at command-handling time, computes `effective_dry_run = truthy(env GUIDEMATE_DRY_RUN) OR shadow.dry_run`, refuses a command (acks `failed` with `Ack.gates`) when `docked` or not `motion_enabled` **before enqueue**, exposes a live `motion_allowed() -> bool` predicate, and fires a **shadow-delta callback** when desired `motion_enabled` flips false. An rclpy telemetry thread runs only when `GUIDEMATE_ROS=1` and owns the process's rclpy `Node` (publishes `/status` + `Heartbeat`). `Heartbeat` is a pydantic model in `guidemate_msgs`.

**Phase 3/4 (PINNED — flag as a dependency):** per-robot lock items `pk="robot_lock#<robot_id>"` in `guidemate-config`; the admin **approve** action binds `session → robot_id` and accepts a `robot_id` argument. `RobotRegistry` is multi-robot (from `GUIDEMATE_ROBOTS`). Chat UI (`static/index.html`) and admin UI (`static/admin.html`) exist with the Requests tab approve control. A `GUIDEMATE_FAKE_ROBOT=1` test mode fakes robot acks for UI tests.

**Phase 4, scope addition (PINNED — spec commit 91d9bcb, "Assignment-triggered dock/undock" delta row):** the `Command` schema's motion names gain `"undock"`/`"dock"` (`_MOTION_NAMES = ("circle", "spin", "undock", "dock")` in `guidemate_msgs/messages.py`; `choreography.build()` still raises `ValueError` for them — they are actions, never twists, and the executor branches before `build()`). The approve-hook fires an automatic `undock` command for the newly bound robot, and unassign/abort fires `dock`. Phase 8 builds the **bridge-side execution** of these commands (Tasks 3–4) and drills the full lifecycle in sim (Task 6); the agent-service hooks are Phase 4's.

---

## File Structure

```
cs7980-guide-mate/
├── scripts/create_sim_identity.sh              # NEW (Task 1) — sim IoT thing+cert+policy+shadow
├── sim/
│   ├── probe_sim_graph.sh                       # NEW (Task 2) — bring up + record ROS graph facts
│   ├── sim_facts.env                            # NEW (Task 2) — verified topic/action names
│   └── launch_sim.sh                            # NEW (Task 5) — Ignition + bridge (sim params)
├── src/guide_mate_bridge/guide_mate_bridge/
│   ├── executor.py                              # MODIFY (Task 3) — real-drive path + dock/undock action dispatch + abort/kill-switch
│   ├── cmd_vel_publisher.py                     # NEW (Task 4) — rclpy Twist publisher
│   ├── dock_actions.py                          # NEW (Task 4) — rclpy action clients for /undock + /dock
│   └── bridge.py                                # MODIFY (Task 4) — motion gating + exemption matrix + robot-id guard + stop/kill wiring
├── src/guide_mate_bridge/scripts/install_bridge_on_pi.sh   # MODIFY (Task 5) — never set GUIDEMATE_ENABLE_MOTION
├── src/guide_mate_bridge/tests/
│   ├── test_executor.py                         # MODIFY (Task 3) — real-drive + action + abort tests
│   ├── test_cmd_vel_publisher.py                # NEW (Task 4)
│   ├── test_dock_actions.py                     # NEW (Task 4) — action-client wrapper with fakes
│   ├── test_bridge.py                           # MODIFY (Task 4) — gating truth table + exemption matrix + robot-id guard
│   ├── test_installer_guard.py                  # NEW (Task 5) — installer omits the motion env
│   └── test_sim_motion.py                       # NEW (Task 6) — GUIDEMATE_SIM=1 odometry regression + dock lifecycle
├── agent_service/guidemate_agent/config.py      # MODIFY (Task 7) — default GUIDEMATE_ROBOTS incl. turtlebotsim
├── agent_service/static/index.html              # MODIFY (Task 7) — virtual-pet badge
├── agent_service/static/admin.html              # MODIFY (Task 7) — approve robot picker
├── agent_service/tests/test_config.py           # MODIFY/NEW (Task 7) — registry lists turtlebotsim
├── agent_service/tests/e2e/test_virtual_pet.py  # NEW (Task 7) — Playwright grant-flow UI
├── pytest.ini                                    # MODIFY (Task 6) — register `sim` marker
├── conftest.py                                   # MODIFY (Task 6) — gate `sim` on GUIDEMATE_SIM=1
└── docs/agent-poc/access-ground-truth.md         # MODIFY (Tasks 1, 2) — sim identity + verified graph
```

---

## Task 1: Sim IoT identity — thing + cert + scoped policy + default-deny shadow

**Files:**
- Create: `scripts/create_sim_identity.sh`
- Modify: `docs/agent-poc/access-ground-truth.md` (append a "Sim identity (Turtlebot-Sim)" section)
- Test: `src/guide_mate_bridge/tests/test_sim_identity.py`

**Interfaces:**
- Consumes: nothing (standalone AWS + shell).
- Produces (runtime artifacts, not code): IoT thing `Turtlebot-Sim`; active cert+key at `~/.aws/guidemate-sim.cert.pem` + `~/.aws/guidemate-sim.key.pem` (chmod 600); policy `guidemate-sim-policy` (client `guidemate-*`, topics `guidemate/turtlebotsim/*` + `$aws/things/Turtlebot-Sim/shadow/*`); classic shadow desired `{motion_enabled:false, max_speed:0.15, dry_run:true}`. The script is **idempotent** (re-running skips existing thing/policy, does not mint a second cert if the local cert files already exist).

**Phase dependencies:** none.

- [ ] **Step 1: Write the failing test (script exists, is executable, passes `bash -n`, references the locked values)**

`src/guide_mate_bridge/tests/test_sim_identity.py`:
```python
import os
import subprocess

HERE = os.path.dirname(__file__)
SCRIPT = os.path.abspath(os.path.join(HERE, "..", "..", "..", "scripts", "create_sim_identity.sh"))


def test_script_exists_and_executable():
    assert os.path.isfile(SCRIPT), SCRIPT
    assert os.access(SCRIPT, os.X_OK), "create_sim_identity.sh must be chmod +x"


def test_script_is_valid_bash():
    # `bash -n` parses without executing — catches syntax errors safely.
    subprocess.run(["bash", "-n", SCRIPT], check=True)


def test_script_pins_the_locked_values():
    text = open(SCRIPT).read()
    assert "Turtlebot-Sim" in text
    assert "guidemate-sim-policy" in text
    assert "guidemate/turtlebotsim/*" in text
    assert "$aws/things/Turtlebot-Sim/shadow/*" in text
    # Default-deny shadow, identical to the real robot.
    assert '"motion_enabled": false' in text
    assert '"dry_run": true' in text
    assert '"max_speed": 0.15' in text
    assert "guidemate-sim.cert.pem" in text and "guidemate-sim.key.pem" in text
    assert "chmod 600" in text
    # Never touch robot 468.
    assert "turtlebot468" not in text
    assert "guidemate-poc" in text  # tagging convention
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_sim_identity.py -q`
Expected: FAIL — `AssertionError` / file does not exist (script not written yet).

- [ ] **Step 3: Write `scripts/create_sim_identity.sh`**

`scripts/create_sim_identity.sh`:
```bash
#!/usr/bin/env bash
# Mint the Gazebo sim's AWS IoT identity — a SEPARATE thing/cert/policy/shadow from robot 468.
# Idempotent: safe to re-run. Never touches turtlebot468's identity, shadow, or policy.
set -euo pipefail

AWS="${AWS:-$HOME/.local/bin/aws}"
REGION="${AWS_REGION:-us-west-2}"
THING="Turtlebot-Sim"
POLICY="guidemate-sim-policy"
CERT_PEM="$HOME/.aws/guidemate-sim.cert.pem"
KEY_PEM="$HOME/.aws/guidemate-sim.key.pem"
TAGS="Key=project,Value=guidemate-poc"

echo "== 1. Thing =="
if "$AWS" iot describe-thing --thing-name "$THING" --region "$REGION" >/dev/null 2>&1; then
  echo "thing $THING already exists — skipping create"
else
  "$AWS" iot create-thing --thing-name "$THING" --region "$REGION" >/dev/null
  "$AWS" iot tag-resource \
    --resource-arn "arn:aws:iot:${REGION}:$("$AWS" sts get-caller-identity --query Account --output text):thing/${THING}" \
    --tags "$TAGS" --region "$REGION" >/dev/null || true
  echo "created thing $THING"
fi

echo "== 2. Policy (scoped to guidemate/turtlebotsim/* + this thing's shadow) =="
POLICY_DOC='{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "iot:Connect",
      "Resource": "arn:aws:iot:'"$REGION"':*:client/guidemate-*" },
    { "Effect": "Allow", "Action": ["iot:Publish", "iot:Receive"],
      "Resource": [
        "arn:aws:iot:'"$REGION"':*:topic/guidemate/turtlebotsim/*",
        "arn:aws:iot:'"$REGION"':*:topic/$aws/things/Turtlebot-Sim/shadow/*" ] },
    { "Effect": "Allow", "Action": "iot:Subscribe",
      "Resource": [
        "arn:aws:iot:'"$REGION"':*:topicfilter/guidemate/turtlebotsim/*",
        "arn:aws:iot:'"$REGION"':*:topicfilter/$aws/things/Turtlebot-Sim/shadow/*" ] }
  ]
}'
if "$AWS" iot get-policy --policy-name "$POLICY" --region "$REGION" >/dev/null 2>&1; then
  echo "policy $POLICY already exists — skipping create"
else
  "$AWS" iot create-policy --policy-name "$POLICY" \
    --policy-document "$POLICY_DOC" \
    --tags "$TAGS" --region "$REGION" >/dev/null
  echo "created policy $POLICY"
fi

echo "== 3. Certificate + private key =="
if [[ -f "$CERT_PEM" && -f "$KEY_PEM" ]]; then
  echo "local cert/key already present at $CERT_PEM — reusing (no new cert minted)"
  CERT_ARN="$("$AWS" iot list-thing-principals --thing-name "$THING" --region "$REGION" \
             --query 'principals[0]' --output text 2>/dev/null || echo None)"
else
  OUT="$("$AWS" iot create-keys-and-certificate --set-as-active \
        --certificate-pem-outfile "$CERT_PEM" \
        --private-key-outfile "$KEY_PEM" \
        --region "$REGION" --output json)"
  CERT_ARN="$(echo "$OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["certificateArn"])')"
  chmod 600 "$CERT_PEM" "$KEY_PEM"
  echo "created cert $CERT_ARN and wrote $CERT_PEM / $KEY_PEM (chmod 600)"
  "$AWS" iot attach-policy --policy-name "$POLICY" --target "$CERT_ARN" --region "$REGION"
  "$AWS" iot attach-thing-principal --thing-name "$THING" --principal "$CERT_ARN" --region "$REGION"
  echo "attached policy + thing to cert"
fi

echo "== 4. Classic shadow — DEFAULT-DENY (identical to the real robot) =="
"$AWS" iot-data update-thing-shadow --thing-name "$THING" --region "$REGION" \
  --cli-binary-format raw-in-base64-out \
  --payload '{"state": {"desired": {"motion_enabled": false, "max_speed": 0.15, "dry_run": true}}}' \
  /dev/stdout >/dev/null
echo "initialized $THING shadow desired = {motion_enabled: false, max_speed: 0.15, dry_run: true}"

echo "DONE. Sim identity ready. Cert: $CERT_PEM  Policy: $POLICY  Shadow: locked."
```

- [ ] **Step 4: `chmod +x` and run the test to verify it passes**

Run:
```bash
cd ~/cs7980-guide-mate
chmod +x scripts/create_sim_identity.sh
.venv/bin/python -m pytest src/guide_mate_bridge/tests/test_sim_identity.py -q
```
Expected: PASS (3 passed).

- [ ] **Step 5: Execute the script against AWS (one-time provisioning)**

Run: `cd ~/cs7980-guide-mate && ./scripts/create_sim_identity.sh`
Expected: prints created/existing thing, policy, cert path, and "shadow: locked". Verify default-deny:
```bash
~/.local/bin/aws iot-data get-thing-shadow --thing-name Turtlebot-Sim --region us-west-2 /dev/stdout | cat
```
Expected: JSON with `"desired": {"motion_enabled": false, "dry_run": true, "max_speed": 0.15}`. Confirm robot 468 untouched (its shadow is a *different* thing — you never named it).

- [ ] **Step 6: Document in `access-ground-truth.md`**

Append a section to `docs/agent-poc/access-ground-truth.md`:
```markdown
## Sim identity (Turtlebot-Sim) — added 2026-07-05 (Phase 8)
- **Thing:** `Turtlebot-Sim` (tag `project=guidemate-poc`), us-west-2. Separate from `Turtlebot-468`.
- **Cert/key (local, NOT committed):** `~/.aws/guidemate-sim.cert.pem` + `~/.aws/guidemate-sim.key.pem` (chmod 600).
- **Policy:** `guidemate-sim-policy` — client `guidemate-*`; publish/subscribe/receive on `guidemate/turtlebotsim/*` and `$aws/things/Turtlebot-Sim/shadow/*` only.
- **Classic shadow:** default-deny `{motion_enabled:false, max_speed:0.15, dry_run:true}`, same as the real robot. Flipped `true` **only** during a sim motion run, then reset to locked.
- **Provisioning:** `scripts/create_sim_identity.sh` (idempotent). Robot 468's identity/shadow are never touched by any Phase 8 artifact.
```

- [ ] **Step 7: Commit**

```bash
cd ~/cs7980-guide-mate
git add scripts/create_sim_identity.sh src/guide_mate_bridge/tests/test_sim_identity.py docs/agent-poc/access-ground-truth.md
git commit -m "Kalhar: sim IoT identity script (Turtlebot-Sim thing+cert+scoped policy+default-deny shadow)"
```

---

## Task 2: Verify the sim ROS graph (probe topics + undock/dock actions + dock-status)

**Files:**
- Create: `sim/probe_sim_graph.sh`, `sim/sim_facts.env`
- Modify: `docs/agent-poc/access-ground-truth.md` (append verified graph facts)
- Test: none (this is a verification task; its deliverable is *verified facts* that Tasks 3–6 trust)

**Interfaces:**
- Produces: `sim/sim_facts.env` — a shell-sourceable file of the **verified** names later tasks depend on: `SIM_CMD_VEL_TOPIC`, `SIM_ODOM_TOPIC`, `SIM_BATTERY_TOPIC`, `SIM_DOCK_STATUS_TOPIC`, `SIM_DOCK_STATUS_TYPE`, `SIM_UNDOCK_ACTION`, `SIM_UNDOCK_ACTION_TYPE`, `SIM_DOCK_ACTION`, `SIM_DOCK_ACTION_TYPE`.

**Phase dependencies:** none (uses this box's Ignition stack). **This is the "VERIFY as an explicit plan step" the environment note requires.**

- [ ] **Step 1: Write `sim/probe_sim_graph.sh`**

`sim/probe_sim_graph.sh`:
```bash
#!/usr/bin/env bash
# Bring up the TB4 Ignition sim HEADLESS, dump the ROS graph, then tear it down.
# Records the un-namespaced topic/action names Phase 8 depends on. Kills by PID (never pkill -f).
set -uo pipefail

source /opt/ros/humble/setup.bash

echo "== launching turtlebot4_ignition_bringup (headless) =="
# -s / headless is passed through to ign gazebo by the bringup's `rviz:=false headless:=true`.
ros2 launch turtlebot4_ignition_bringup turtlebot4_ignition.launch.py \
    rviz:=false headless:=true >/tmp/sim_probe.log 2>&1 &
SIM_PID=$!
echo "sim launch pid=$SIM_PID — waiting up to 90s for /odom"

deadline=$((SECONDS + 90))
until ros2 topic list 2>/dev/null | grep -qx "/odom"; do
  if (( SECONDS > deadline )); then echo "TIMEOUT waiting for /odom"; break; fi
  sleep 3
done

echo "== ros2 topic list =="
ros2 topic list | sort
echo "== types for the four topics Phase 8 uses =="
for t in /cmd_vel /odom /battery_state /dock_status; do
  printf "%-18s -> " "$t"; ros2 topic type "$t" 2>/dev/null || echo "(absent)"
done
echo "== dock-related actions =="
ros2 action list 2>/dev/null | grep -i -E 'dock' || echo "(no dock actions found)"
echo "== undock/dock action types (if present) =="
ros2 action list -t 2>/dev/null | grep -i -E 'dock' || true

echo "== tearing down (kill by PID) =="
kill "$SIM_PID" 2>/dev/null || true
# ign gazebo server sometimes outlives the launcher; find and kill its PID by comm, never -f.
for pid in $(pgrep -x ign 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
for pid in $(pgrep -x ruby 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
echo "DONE. Full log at /tmp/sim_probe.log"
```

- [ ] **Step 2: `chmod +x` and run the probe**

Run:
```bash
cd ~/cs7980-guide-mate
chmod +x sim/probe_sim_graph.sh
./sim/probe_sim_graph.sh
```
Expected: `/odom`, `/cmd_vel`, `/battery_state`, `/dock_status` appear un-namespaced in the topic list; types print (expected: `/cmd_vel -> geometry_msgs/msg/Twist`, `/odom -> nav_msgs/msg/Odometry`, `/battery_state -> sensor_msgs/msg/BatteryState`, `/dock_status -> irobot_create_msgs/msg/DockStatus`), and **both** dock actions appear (expected `/undock` of type `irobot_create_msgs/action/Undock` and `/dock` of type `irobot_create_msgs/action/Dock` — the Create 3 sim ports both; Tasks 3, 4, and 6 dispatch `undock`/`dock` commands to exactly these actions).

**If any name differs from the expected values** (e.g. the bringup namespaces the robot, undock/dock are services not actions, or `/dock` is named `/dock_servo` etc.), record the ACTUAL name — Tasks 3–6 read only `sim/sim_facts.env`, so correcting it here fixes every downstream task.

- [ ] **Step 3: Write the verified facts into `sim/sim_facts.env`**

Fill in with the **observed** values from Step 2 (the block below is the expected default — overwrite any line the probe contradicted):

`sim/sim_facts.env`:
```bash
# Verified TB4 Ignition Fortress ROS graph (Task 2, 2026-07-05). Un-namespaced by default.
SIM_CMD_VEL_TOPIC=/cmd_vel
SIM_ODOM_TOPIC=/odom
SIM_BATTERY_TOPIC=/battery_state
SIM_DOCK_STATUS_TOPIC=/dock_status
SIM_DOCK_STATUS_TYPE=irobot_create_msgs/msg/DockStatus
SIM_UNDOCK_ACTION=/undock
SIM_UNDOCK_ACTION_TYPE=irobot_create_msgs/action/Undock
SIM_DOCK_ACTION=/dock
SIM_DOCK_ACTION_TYPE=irobot_create_msgs/action/Dock
```

- [ ] **Step 4: Document the verified graph in `access-ground-truth.md`**

Append under the Task-1 sim section:
```markdown
### Verified sim ROS graph (Phase 8, Task 2)
Un-namespaced by default: `/cmd_vel` (geometry_msgs/msg/Twist), `/odom` (nav_msgs/msg/Odometry),
`/battery_state` (sensor_msgs/msg/BatteryState), `/dock_status` (irobot_create_msgs/msg/DockStatus,
field `.is_docked`). Undock/dock via actions `/undock` (irobot_create_msgs/action/Undock) and
`/dock` (irobot_create_msgs/action/Dock). Canonical copy: `sim/sim_facts.env`. Bring-up: `ros2 launch turtlebot4_ignition_bringup turtlebot4_ignition.launch.py rviz:=false headless:=true`.
```

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980-guide-mate
git add sim/probe_sim_graph.sh sim/sim_facts.env docs/agent-poc/access-ground-truth.md
git commit -m "Kalhar: verify sim ROS graph (un-namespaced /cmd_vel /odom /battery_state /dock_status + /undock + /dock actions)"
```

---

## Task 3: Executor real-drive path + dock/undock action dispatch + abort / kill-switch

**Files:**
- Modify: `src/guide_mate_bridge/guide_mate_bridge/executor.py`
- Test: `src/guide_mate_bridge/tests/test_executor.py` (append)

**Interfaces:**
- Consumes: `build`, `TwistStep` (Phase 0/1 choreography); `Ack`, `Command`, `log_extra` (Phase 0/1); the Phase-4 schema addition of motion names `"undock"`/`"dock"` (**FLAG Phase 4** — the `_cmd_action` test helper falls back to `model_construct` so these unit tests run even before it lands).
- Produces: `ChoreographyRunner.__init__(publish_ack, dry_run=True, publish_twist=None, publish_hz=10.0, sleep=time.sleep, motion_gate=None, run_action=None)`.
  - `abort(reason="aborted") -> None` (thread-safe, sets a shared `threading.Event`). Each `handle` **clears** the abort event after the `running` ack so a prior stop/kill only kills the command that was in flight when it fired.
  - `motion_gate: Optional[Callable[[Command], tuple[bool, str]]]` — **command-aware** (so the dock-guard exemption matrix, Task 4 `command_permitted`, can allow `undock`/`dock`/`stop` while docked). Returns `(permitted, refusal_reason)`; on refusal the runner publishes a safety zero-twist (if a sink exists) and acks `failed(reason)`.
  - `run_action: Optional[Callable[[str], tuple[bool, str]]]` — invoked for `type=="motion", name in ("undock","dock")`. These are **Create 3 ROS actions, never twist choreographies**: the executor branches BEFORE `build()` (which would raise `ValueError` for them). Real path: gate → `run_action(name)` → ack `done(simulated=False)` or `failed(reason)`. Dry-run path: log `"DRY-RUN action <name>"`, ack `done(simulated=True)`, never call the client. If `run_action` is `None` on the real path, ack `failed("no action client")`.
  - `handle(cmd)` **real twist path** (`not dry_run`, `publish_twist` set): for each `TwistStep`, publish it at `publish_hz` for `duration` seconds, checking the abort event between publishes; on abort, break, **zero the wheels**, ack `failed(reason)`; on clean finish, zero the wheels, ack `done(simulated=False)`. The dry-run twist path is **unchanged** (logs `DRY-RUN twist …`, no sleep, no publish).
  - Limitation (documented): a dispatched dock/undock action is not abort-interruptible mid-action (they are short, self-terminating Create 3 behaviors); abort takes effect for twist choreographies and between commands.

**Phase dependencies:** `motion_gate` is wired to Task 4's `command_permitted` over Phase 2's shadow/dock state (**FLAG Phase 2**); `run_action` is wired to Task 4's `DockActions`. Task 3 itself is pure and self-tested with fakes.

- [ ] **Step 1: Write the failing tests (append to `test_executor.py`)**

Append to `src/guide_mate_bridge/tests/test_executor.py`:
```python
import threading

from guidemate_msgs.choreography import TwistStep
from guidemate_msgs.messages import Command


def _real_runner(acks, published, sleep=lambda _s: None, motion_gate=None, run_action=None):
    return ChoreographyRunner(
        publish_ack=acks.append,
        dry_run=False,
        publish_twist=published.append,
        publish_hz=10.0,
        sleep=sleep,
        motion_gate=motion_gate,
        run_action=run_action,
    )


def _cmd_action(name):
    # Phase 4 (PINNED) adds "undock"/"dock" to _MOTION_NAMES. model_construct keeps
    # these unit tests runnable even if Phase 8 executes before that schema change lands.
    try:
        return Command(type="motion", name=name)
    except Exception:
        return Command.model_construct(
            cmd_id=f"test-{name}", type="motion", name=name, params={}, ts="t"
        )


def test_real_drive_publishes_at_rate_then_zeroes():
    acks, published = [], []
    # spin = one TwistStep; with publish_hz=10 a ~6.98s step -> ~70 publishes + 1 zero.
    _real_runner(acks, published).handle(Command(type="motion", name="spin"))
    assert [a.state for a in acks] == ["received", "running", "done"]
    assert acks[-1].simulated is False
    # last publish must be the zero-twist safety stop.
    assert published[-1] == TwistStep(0.0, 0.0, 0.0)
    assert len(published) > 10  # many in-motion publishes, not one-per-step


def test_abort_mid_step_zeroes_and_acks_failed():
    acks, published = [], []
    runner = _real_runner(acks, published)

    # Abort after the 3rd in-motion publish, from another thread, via the sleep hook.
    calls = {"n": 0}
    def sleeper(_s):
        calls["n"] += 1
        if calls["n"] == 3:
            runner.abort(reason="stopped")
    runner._sleep = sleeper

    runner.handle(Command(type="motion", name="circle"))
    assert [a.state for a in acks] == ["received", "running", "failed"]
    assert acks[-1].reason == "stopped"
    assert published[-1] == TwistStep(0.0, 0.0, 0.0)      # wheels zeroed on abort
    assert len(published) < 5                             # broke out early


def test_motion_gate_refusal_reason_propagates():
    acks, published = [], []
    runner = _real_runner(acks, published, motion_gate=lambda cmd: (False, "docked"))
    runner.handle(Command(type="emote", name="happy"))
    assert [a.state for a in acks] == ["received", "running", "failed"]
    assert acks[-1].reason == "docked"
    # Only the safety zero-twist may be published; no choreography motion.
    assert published == [TwistStep(0.0, 0.0, 0.0)]


def test_abort_does_not_persist_across_commands():
    acks, published = [], []
    runner = _real_runner(acks, published)
    runner.abort(reason="stopped")            # fire before any command
    runner.handle(Command(type="emote", name="yes"))
    # handle() clears the stale abort after 'running', so this command completes.
    assert acks[-1].state == "done"


def test_no_sink_when_not_dry_run_acks_failed():
    acks = []
    ChoreographyRunner(publish_ack=acks.append, dry_run=False, publish_twist=None).handle(
        Command(type="emote", name="happy")
    )
    assert [a.state for a in acks] == ["received", "running", "failed"]
    assert acks[-1].reason == "no cmd_vel sink"


# ---- dock/undock are Create 3 ROS ACTIONS, never twist choreographies ----
def test_undock_dry_run_logs_action_never_calls_client(caplog):
    import logging

    acks, calls = [], []
    runner = ChoreographyRunner(
        publish_ack=acks.append,
        dry_run=True,
        run_action=lambda name: (calls.append(name), (True, ""))[1],
    )
    with caplog.at_level(logging.INFO, logger="guide_mate_bridge.executor"):
        runner.handle(_cmd_action("undock"))
    assert [a.state for a in acks] == ["received", "running", "done"]
    assert acks[-1].simulated is True
    assert calls == []                      # dry-run NEVER touches the action client
    assert any(r.getMessage().startswith("DRY-RUN action undock") for r in caplog.records)


def test_undock_real_runs_action_not_twists():
    acks, published, calls = [], [], []
    runner = _real_runner(
        acks, published, run_action=lambda name: (calls.append(name), (True, ""))[1]
    )
    runner.handle(_cmd_action("undock"))
    assert calls == ["undock"]
    assert published == []                  # actions never publish cmd_vel
    assert acks[-1].state == "done" and acks[-1].simulated is False


def test_dock_action_failure_acks_failed():
    acks, published = [], []
    runner = _real_runner(acks, published, run_action=lambda name: (False, "dock server unavailable"))
    runner.handle(_cmd_action("dock"))
    assert acks[-1].state == "failed"
    assert acks[-1].reason == "dock server unavailable"


def test_action_without_client_acks_failed():
    acks, published = [], []
    runner = _real_runner(acks, published, run_action=None)
    runner.handle(_cmd_action("undock"))
    assert acks[-1].state == "failed"
    assert acks[-1].reason == "no action client"


def test_gate_consulted_for_actions_too():
    # Shadow lock is supreme: even undock is refused when the gate says motion_disabled.
    acks, published, calls = [], [], []
    runner = _real_runner(
        acks, published,
        motion_gate=lambda cmd: (False, "motion_disabled"),
        run_action=lambda name: (calls.append(name), (True, ""))[1],
    )
    runner.handle(_cmd_action("undock"))
    assert acks[-1].state == "failed" and acks[-1].reason == "motion_disabled"
    assert calls == []
    assert published == [TwistStep(0.0, 0.0, 0.0)]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_executor.py -q`
Expected: FAIL — `TypeError` (`ChoreographyRunner` has no `publish_hz`/`sleep`/`motion_gate`/`run_action`) and `AttributeError: 'ChoreographyRunner' object has no attribute 'abort'`.

- [ ] **Step 3: Rewrite `executor.py`**

Replace the entire contents of `src/guide_mate_bridge/guide_mate_bridge/executor.py`:
```python
"""Choreography executor.

Phase 1 dry-run path (logs the would-be twists, never publishes) is preserved.
Phase 8 adds:
- the ONLY real cmd_vel drive path: a fixed-rate, abort-aware loop;
- dock/undock dispatched as Create 3 ROS ACTIONS via `run_action` (never twists);
- a command-aware motion gate (the dock-guard exemption matrix lives upstream in
  bridge.command_permitted: while docked only undock/dock/stop pass).
A shared threading.Event lets a `stop` command or a shadow kill-switch interrupt
an in-flight choreography between publishes and zero the wheels within one period.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Callable, Optional, Tuple

from guidemate_msgs.choreography import TwistStep, build
from guidemate_msgs.jsonlog import log_extra
from guidemate_msgs.messages import Ack, Command

log = logging.getLogger(__name__)

_ZERO = TwistStep(0.0, 0.0, 0.0)
_ACTION_NAMES = ("undock", "dock")   # Create 3 ROS actions, never twist choreographies


def _is_action(cmd: Command) -> bool:
    return cmd.type == "motion" and cmd.name in _ACTION_NAMES


class ChoreographyRunner:
    def __init__(
        self,
        publish_ack: Callable[[Ack], None],
        dry_run: bool = True,
        publish_twist: Optional[Callable[[TwistStep], None]] = None,
        publish_hz: float = 10.0,
        sleep: Callable[[float], None] = time.sleep,
        motion_gate: Optional[Callable[[Command], "Tuple[bool, str]"]] = None,
        run_action: Optional[Callable[[str], "Tuple[bool, str]"]] = None,
    ) -> None:
        self._publish_ack = publish_ack
        self._dry_run = dry_run
        self._publish_twist = publish_twist
        self._publish_hz = publish_hz
        self._sleep = sleep
        self._motion_gate = motion_gate
        self._run_action = run_action
        self._abort = threading.Event()
        self._abort_reason = "aborted"

    def abort(self, reason: str = "aborted") -> None:
        """Interrupt an in-flight choreography (thread-safe: stop path + shadow kill-switch)."""
        self._abort_reason = reason
        self._abort.set()

    def _drive_step(self, step: TwistStep) -> bool:
        """Publish `step` at publish_hz for its duration. Returns False if aborted."""
        period = 1.0 / self._publish_hz
        ticks = max(1, int(round(step.duration * self._publish_hz)))
        for _ in range(ticks):
            if self._abort.is_set():
                return False
            self._publish_twist(step)
            self._sleep(period)
        return True

    def handle(self, cmd: Command) -> None:
        self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="received"))
        is_action = _is_action(cmd)
        steps: Optional[list] = None
        if not is_action:
            try:
                steps = build(cmd)
            except ValueError as exc:
                self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="failed", reason=str(exc)))
                return
        self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="running"))
        # A prior stop/kill only kills the command that was in flight when it fired;
        # every fresh command starts un-aborted.
        self._abort.clear()

        # ---- dry-run path: log, never publish / never act ----
        if self._dry_run:
            if is_action:
                log.info(
                    "DRY-RUN action %s", cmd.name, extra=log_extra(cmd_id=cmd.cmd_id)
                )
            else:
                for step in steps:
                    log.info(
                        "DRY-RUN twist vx=%.3f wz=%.3f dur=%.2fs",
                        step.vx, step.wz, step.duration,
                        extra=log_extra(cmd_id=cmd.cmd_id),
                    )
            self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="done", simulated=True))
            return

        # ---- command-aware gate (shadow lock + dock-guard exemption matrix) ----
        if self._motion_gate is not None:
            permitted, reason = self._motion_gate(cmd)
            if not permitted:
                if self._publish_twist is not None:
                    self._publish_twist(_ZERO)   # safety: make sure the wheels are stopped
                self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="failed", reason=reason))
                return

        # ---- Create 3 ROS action path (undock/dock) — never twists ----
        if is_action:
            if self._run_action is None:
                self._publish_ack(
                    Ack(cmd_id=cmd.cmd_id, state="failed", reason="no action client")
                )
                return
            ok, reason = self._run_action(cmd.name)
            if ok:
                self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="done", simulated=False))
            else:
                self._publish_ack(
                    Ack(
                        cmd_id=cmd.cmd_id,
                        state="failed",
                        reason=reason or f"{cmd.name} action failed",
                    )
                )
            return

        # ---- real cmd_vel path ----
        if self._publish_twist is None:
            self._publish_ack(
                Ack(cmd_id=cmd.cmd_id, state="failed", reason="no cmd_vel sink")
            )
            return

        aborted = False
        for step in steps:
            if not self._drive_step(step):
                aborted = True
                break
        # Always zero the wheels — clean finish OR interrupt.
        self._publish_twist(_ZERO)
        if aborted:
            self._publish_ack(
                Ack(cmd_id=cmd.cmd_id, state="failed", reason=self._abort_reason)
            )
        else:
            self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="done", simulated=False))
```

Note the ordering change vs Phase 1: on the real path the gate now runs **before** the
`no cmd_vel sink` check (the gate must also cover action commands, which have no twist
sink). The Phase-1 `test_no_sink_when_not_dry_run_acks_failed` still passes because it
constructs the runner without a gate.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_executor.py -q`
Expected: PASS (the 4 original Phase-1 tests + the 10 new ones, 14 passed). The `sleep` hook keeps the loop instant.

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980-guide-mate
git add src/guide_mate_bridge/guide_mate_bridge/executor.py src/guide_mate_bridge/tests/test_executor.py
git commit -m "Kalhar: executor real-drive path — fixed-rate twist loop + dock/undock ROS-action dispatch + abort/kill-switch + command-aware gate"
```

---

## Task 4: CmdVelPublisher + DockActions (rclpy) + bridge motion gating + exemption matrix + robot-id hard guard + stop/kill wiring

**Files:**
- Create: `src/guide_mate_bridge/guide_mate_bridge/cmd_vel_publisher.py`, `src/guide_mate_bridge/guide_mate_bridge/dock_actions.py`
- Modify: `src/guide_mate_bridge/guide_mate_bridge/bridge.py`
- Test: `src/guide_mate_bridge/tests/test_cmd_vel_publisher.py` (new), `src/guide_mate_bridge/tests/test_dock_actions.py` (new), `src/guide_mate_bridge/tests/test_bridge.py` (append)

**Interfaces:**
- Consumes: `ChoreographyRunner` incl. `abort`/`motion_gate`/`run_action` (Task 3); `Command`, `Ack`, `cmd_topic`, `status_topic` (Phase 0/1); Phase 2's `SafetyLayer` (**FLAG Phase 2**): `effective_dry_run() -> bool`, `motion_enabled() -> bool`, `docked() -> bool`, `ros_node()`, and a shadow-delta callback registration.
- Produces:
  - `class CmdVelPublisher(node, topic="/cmd_vel", twist_cls=None)` — callable `__call__(step: TwistStep) -> None` publishes a `geometry_msgs/msg/Twist` (`linear.x=step.vx`, `angular.z=step.wz`). `geometry_msgs` is imported lazily; `twist_cls` is injectable for tests.
  - `class DockActions(node, undock_action="/undock", dock_action="/dock", client_factory=None, timeout_s=60.0)` with `run(name: str) -> tuple[bool, str]` — rclpy **action clients** for the Create 3 `/undock` (`irobot_create_msgs/action/Undock`) and `/dock` (`irobot_create_msgs/action/Dock`) actions; blocks until the goal resolves or times out; `client_factory` injectable for tests. Wired as the executor's `run_action`.
  - `bridge.resolve_motion_enabled(env: Mapping, effective_dry_run: bool, shadow_motion_enabled: bool) -> bool` — pure: `True` **only** if `env["GUIDEMATE_ENABLE_MOTION"]` is truthy AND `shadow_motion_enabled` AND `not effective_dry_run`.
  - `bridge.command_permitted(cmd_type: str, cmd_name: str, motion_enabled: bool, docked: bool) -> tuple[bool, str]` — the **dock-guard exemption matrix** (spec delta 91d9bcb): shadow lock is supreme (`(False, "motion_disabled")` for everything when `motion_enabled` is false); while docked, refuse all motion `(False, "docked")` EXCEPT `("motion","undock")`, `("motion","dock")` (no-op-ish → the Create 3 Dock action succeeds immediately when already docked → done ack), and `("stop","stop")`; while undocked, everything is allowed (dock is a normal action).
  - `bridge.assert_motion_identity_safe(env: Mapping) -> None` — **hard guard**: raises `SystemExit` if `GUIDEMATE_ENABLE_MOTION` is truthy while `GUIDEMATE_ROBOT_ID` is `turtlebot468` (or unset, since it defaults to 468).
  - `Bridge.__init__(..., publish_twist=None, publish_hz=10.0, motion_gate=None, run_action=None)` forwards to the runner. `Bridge.on_message` fires `self._runner.abort(reason="stopped")` immediately for a `type=="stop"` command (interrupt in flight) before enqueuing. `Bridge.abort(reason)` delegates to the runner (wired to the shadow kill-switch in `main`).

**Phase dependencies:** `main()` reads `effective_dry_run`/`motion_enabled`/`docked` from Phase 2's `SafetyLayer` and reuses Phase 2's rclpy `Node` (created behind `GUIDEMATE_ROS=1`). **FLAG Phase 2 — including one required change there:** Phase 2's *pre-enqueue* dock-guard refusal must delegate to `command_permitted` (otherwise it would refuse `undock`/`dock`/`stop` before they ever reach the executor while docked); a one-call-site change. The pure functions + `Bridge` behavior below are fully unit-tested here without Phase 2.

- [ ] **Step 1: Write the failing `CmdVelPublisher` test**

`src/guide_mate_bridge/tests/test_cmd_vel_publisher.py`:
```python
from guidemate_msgs.choreography import TwistStep

from guide_mate_bridge.cmd_vel_publisher import CmdVelPublisher


class _Vec:
    def __init__(self):
        self.x = self.y = self.z = 0.0


class FakeTwist:
    def __init__(self):
        self.linear = _Vec()
        self.angular = _Vec()


class FakePub:
    def __init__(self):
        self.msgs = []

    def publish(self, msg):
        self.msgs.append(msg)


class FakeNode:
    def __init__(self):
        self.pub = FakePub()
        self.created = None

    def create_publisher(self, msg_type, topic, depth):
        self.created = (msg_type, topic, depth)
        return self.pub


def test_publishes_twist_with_vx_and_wz():
    node = FakeNode()
    pub = CmdVelPublisher(node, topic="/cmd_vel", twist_cls=FakeTwist)
    assert node.created == (FakeTwist, "/cmd_vel", 10)
    pub(TwistStep(0.12, 0.24, 5.0))
    assert len(node.pub.msgs) == 1
    msg = node.pub.msgs[0]
    assert msg.linear.x == 0.12
    assert msg.angular.z == 0.24
    assert msg.linear.y == 0.0 and msg.linear.z == 0.0
```

- [ ] **Step 2: Run it red**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_cmd_vel_publisher.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guide_mate_bridge.cmd_vel_publisher'`.

- [ ] **Step 3: Implement `cmd_vel_publisher.py`**

`src/guide_mate_bridge/guide_mate_bridge/cmd_vel_publisher.py`:
```python
"""Thin rclpy cmd_vel sink. The ONLY place a geometry_msgs/Twist is ever published."""
from __future__ import annotations

from guidemate_msgs.choreography import TwistStep


class CmdVelPublisher:
    def __init__(self, node, topic: str = "/cmd_vel", twist_cls=None) -> None:
        if twist_cls is None:
            from geometry_msgs.msg import Twist as twist_cls  # lazy: no ROS import in unit tests
        self._twist_cls = twist_cls
        self._pub = node.create_publisher(twist_cls, topic, 10)

    def __call__(self, step: TwistStep) -> None:
        msg = self._twist_cls()
        msg.linear.x = float(step.vx)
        msg.angular.z = float(step.wz)
        self._pub.publish(msg)
```

- [ ] **Step 4: Run it green**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_cmd_vel_publisher.py -q`
Expected: PASS (1 passed).

- [ ] **Step 5: Write the failing `DockActions` test**

`src/guide_mate_bridge/tests/test_dock_actions.py`:
```python
from guide_mate_bridge.dock_actions import DockActions


class FakeFuture:
    def __init__(self, result_value):
        self._result = result_value

    def done(self):
        return True

    def result(self):
        return self._result


class FakeGoalHandle:
    def __init__(self, accepted=True):
        self.accepted = accepted

    def get_result_async(self):
        return FakeFuture(object())


class FakeActionClient:
    def __init__(self, server_up=True, accepted=True):
        self.server_up = server_up
        self.accepted = accepted
        self.sent = 0

    def wait_for_server(self, timeout_sec=None):
        return self.server_up

    def send_goal_async(self, goal):
        self.sent += 1
        return FakeFuture(FakeGoalHandle(accepted=self.accepted))


class FakeGoalCls:
    class Goal:
        pass


def _actions(undock=None, dock=None):
    clients = {"undock": undock or FakeActionClient(), "dock": dock or FakeActionClient()}

    def factory(name):
        return clients[name], FakeGoalCls

    return DockActions(node=None, client_factory=factory), clients


def test_undock_success_sends_one_goal():
    actions, clients = _actions()
    ok, reason = actions.run("undock")
    assert ok and reason == ""
    assert clients["undock"].sent == 1
    assert clients["dock"].sent == 0


def test_dock_success():
    actions, clients = _actions()
    ok, _ = actions.run("dock")
    assert ok
    assert clients["dock"].sent == 1


def test_server_unavailable_fails():
    actions, _ = _actions(dock=FakeActionClient(server_up=False))
    ok, reason = actions.run("dock")
    assert not ok and "unavailable" in reason


def test_goal_rejected_fails():
    actions, _ = _actions(undock=FakeActionClient(accepted=False))
    ok, reason = actions.run("undock")
    assert not ok and "rejected" in reason


def test_unknown_action_name_fails():
    actions, _ = _actions()
    ok, reason = actions.run("teleport")
    assert not ok and "unknown" in reason
```

- [ ] **Step 6: Run it red**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_dock_actions.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'guide_mate_bridge.dock_actions'`.

- [ ] **Step 7: Implement `dock_actions.py`**

`src/guide_mate_bridge/guide_mate_bridge/dock_actions.py`:
```python
"""Create 3 undock/dock as rclpy ACTION clients — the only non-twist motion path.

Assumes the process's rclpy node is being spun by an executor elsewhere (Phase 2's
telemetry thread spins it), so the goal/result futures resolve while we poll here.
`client_factory` is injectable so unit tests never import rclpy/irobot_create_msgs.
"""
from __future__ import annotations

import logging
import time
from typing import Tuple

log = logging.getLogger(__name__)

_NAMES = ("undock", "dock")


class DockActions:
    def __init__(
        self,
        node,
        undock_action: str = "/undock",
        dock_action: str = "/dock",
        client_factory=None,
        timeout_s: float = 60.0,
    ) -> None:
        if client_factory is None:
            from rclpy.action import ActionClient
            from irobot_create_msgs.action import Dock, Undock  # lazy: no ROS in unit tests

            def client_factory(name):
                if name == "undock":
                    return ActionClient(node, Undock, undock_action), Undock
                return ActionClient(node, Dock, dock_action), Dock

        self._factory = client_factory
        self._timeout_s = timeout_s
        self._clients: dict = {}

    def run(self, name: str) -> "Tuple[bool, str]":
        if name not in _NAMES:
            return False, f"unknown action {name!r}"
        if name not in self._clients:
            self._clients[name] = self._factory(name)
        client, action_cls = self._clients[name]
        if not client.wait_for_server(timeout_sec=10.0):
            return False, f"{name} action server unavailable"
        goal_future = client.send_goal_async(action_cls.Goal())
        deadline = time.time() + self._timeout_s
        while not goal_future.done():
            if time.time() > deadline:
                return False, f"{name} goal not accepted in time"
            time.sleep(0.1)
        handle = goal_future.result()
        if not handle.accepted:
            return False, f"{name} goal rejected"
        result_future = handle.get_result_async()
        while not result_future.done():
            if time.time() > deadline:
                return False, f"{name} result timeout"
            time.sleep(0.1)
        log.info("%s action completed", name)
        return True, ""
```

- [ ] **Step 8: Run it green**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_dock_actions.py -q`
Expected: PASS (5 passed).

- [ ] **Step 9: Write the failing bridge tests (append to `test_bridge.py`)**

Append to `src/guide_mate_bridge/tests/test_bridge.py`:
```python
from guide_mate_bridge.bridge import (
    assert_motion_identity_safe,
    command_permitted,
    resolve_motion_enabled,
)


# ---- dock-guard exemption matrix (spec delta 91d9bcb) ----
@pytest.mark.parametrize(
    "cmd_type,cmd_name,motion_enabled,docked,expect_ok,expect_reason",
    [
        # Shadow lock is supreme — nothing passes while motion_enabled is false.
        ("motion", "circle", False, False, False, "motion_disabled"),
        ("motion", "undock", False, True, False, "motion_disabled"),
        ("stop", "stop", False, True, False, "motion_disabled"),
        # Docked: refuse all motion EXCEPT undock, dock, stop.
        ("motion", "circle", True, True, False, "docked"),
        ("motion", "spin", True, True, False, "docked"),
        ("emote", "happy", True, True, False, "docked"),
        ("emote", "yes", True, True, False, "docked"),
        ("motion", "undock", True, True, True, ""),
        ("motion", "dock", True, True, True, ""),  # no-op-ish -> Dock action succeeds -> done
        ("stop", "stop", True, True, True, ""),
        # Undocked: everything allowed; dock is a normal action.
        ("motion", "circle", True, False, True, ""),
        ("motion", "dock", True, False, True, ""),
        ("motion", "undock", True, False, True, ""),
        ("emote", "happy", True, False, True, ""),
    ],
)
def test_dock_guard_exemption_matrix(
    cmd_type, cmd_name, motion_enabled, docked, expect_ok, expect_reason
):
    ok, reason = command_permitted(cmd_type, cmd_name, motion_enabled, docked)
    assert ok is expect_ok
    assert reason == expect_reason


# ---- pure gating truth table ----
def test_resolve_motion_disabled_when_env_off():
    assert resolve_motion_enabled({}, effective_dry_run=False, shadow_motion_enabled=True) is False


def test_resolve_motion_disabled_when_dry_run():
    env = {"GUIDEMATE_ENABLE_MOTION": "1"}
    assert resolve_motion_enabled(env, effective_dry_run=True, shadow_motion_enabled=True) is False


def test_resolve_motion_disabled_when_shadow_locked():
    env = {"GUIDEMATE_ENABLE_MOTION": "1"}
    assert resolve_motion_enabled(env, effective_dry_run=False, shadow_motion_enabled=False) is False


def test_resolve_motion_enabled_all_gates_pass():
    env = {"GUIDEMATE_ENABLE_MOTION": "1"}
    assert resolve_motion_enabled(env, effective_dry_run=False, shadow_motion_enabled=True) is True


# ---- hard robot-id guard (belt + braces) ----
def test_identity_guard_refuses_motion_on_468():
    import pytest
    with pytest.raises(SystemExit):
        assert_motion_identity_safe({"GUIDEMATE_ENABLE_MOTION": "1", "GUIDEMATE_ROBOT_ID": "turtlebot468"})


def test_identity_guard_refuses_motion_when_robot_id_unset_defaults_468():
    import pytest
    with pytest.raises(SystemExit):
        assert_motion_identity_safe({"GUIDEMATE_ENABLE_MOTION": "1"})  # default robot id is 468


def test_identity_guard_allows_motion_on_sim():
    # Must NOT raise.
    assert_motion_identity_safe({"GUIDEMATE_ENABLE_MOTION": "1", "GUIDEMATE_ROBOT_ID": "turtlebotsim"})


def test_identity_guard_noop_when_motion_off():
    assert_motion_identity_safe({"GUIDEMATE_ROBOT_ID": "turtlebot468"})  # no motion env -> fine


# ---- stop command interrupts an in-flight choreography ----
def test_stop_command_aborts_runner():
    bridge, _ = _bridge()
    bridge.start()
    aborted = {"reason": None}
    bridge._runner.abort = lambda reason="aborted": aborted.__setitem__("reason", reason)
    bridge.on_message(cmd_topic("devtest"), Command(type="stop", name="stop").model_dump_json())
    assert aborted["reason"] == "stopped"
```

- [ ] **Step 10: Run them red**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_bridge.py -q`
Expected: FAIL — `ImportError: cannot import name 'assert_motion_identity_safe'` (nor `command_permitted` / `resolve_motion_enabled`).

- [ ] **Step 11: Modify `bridge.py`**

Integrate the following into `src/guide_mate_bridge/guide_mate_bridge/bridge.py`. (Phase 2 may have altered the surrounding `main()`; keep its shadow-reconcile/telemetry pieces and fold these changes in.)

**11a. Add the three pure gating functions** (top-level, after `_truthy`):
```python
from typing import Mapping


def resolve_motion_enabled(
    env: "Mapping[str, str]", effective_dry_run: bool, shadow_motion_enabled: bool
) -> bool:
    """Build the real cmd_vel sink ONLY when the operator opted in via env AND the shadow
    allows motion AND we are not in effective dry-run. Any single lock closed -> no motion."""
    if not _truthy(env.get("GUIDEMATE_ENABLE_MOTION", "0")):
        return False
    return bool(shadow_motion_enabled) and not effective_dry_run


# While docked, only these commands are permitted (spec delta 91d9bcb):
# undock (leave the dock), dock (no-op-ish -> the Create 3 Dock action succeeds
# immediately when already docked -> done ack), and stop (always safe).
_DOCKED_EXEMPT = {("motion", "undock"), ("motion", "dock"), ("stop", "stop")}


def command_permitted(
    cmd_type: str, cmd_name: str, motion_enabled: bool, docked: bool
) -> "tuple[bool, str]":
    """Dock-guard exemption matrix. Shadow lock is supreme: nothing runs while
    motion_enabled is false. While docked, refuse all motion EXCEPT undock/dock/stop.
    While undocked, everything is allowed (dock is a normal action)."""
    if not motion_enabled:
        return False, "motion_disabled"
    if docked and (cmd_type, cmd_name) not in _DOCKED_EXEMPT:
        return False, "docked"
    return True, ""


def assert_motion_identity_safe(env: "Mapping[str, str]") -> None:
    """Hard robot-id guard (belt + braces): GUIDEMATE_ENABLE_MOTION must NEVER be honored for
    robot 468. The Pi installer never sets it; this refuses even if someone does by hand."""
    if _truthy(env.get("GUIDEMATE_ENABLE_MOTION", "0")):
        robot_id = env.get("GUIDEMATE_ROBOT_ID", "turtlebot468")
        if robot_id == "turtlebot468":
            raise SystemExit(
                "refusing GUIDEMATE_ENABLE_MOTION on turtlebot468 — motion is sim/436 only"
            )
```

**11b. Extend `Bridge.__init__`** to forward the motion params and keep the runner reachable:
```python
    def __init__(
        self,
        client: IotClient,
        robot_id: str,
        dry_run: bool = True,
        publish_twist=None,
        publish_hz: float = 10.0,
        motion_gate=None,
        run_action=None,
    ) -> None:
        self._client = client
        self._robot_id = robot_id
        self._seen = collections.deque(maxlen=256)
        self._seen_set: set[str] = set()
        self._dedupe_lock = threading.Lock()
        self._queue: "queue.Queue[Command]" = queue.Queue()
        self._runner = ChoreographyRunner(
            publish_ack=self._publish_ack,
            dry_run=dry_run,
            publish_twist=publish_twist,
            publish_hz=publish_hz,
            motion_gate=motion_gate,
            run_action=run_action,
        )
        self._worker = threading.Thread(target=self._run, daemon=True)
```

**11c. Interrupt-on-stop + expose abort.** Add an early stop-abort in `on_message` (right after the `Command.model_validate_json` parse succeeds, before the dedupe/enqueue block) and an `abort` delegate:
```python
        if cmd.type == "stop":
            # Interrupt any in-flight choreography immediately, off the worker thread.
            self._runner.abort(reason="stopped")
```
```python
    def abort(self, reason: str = "aborted") -> None:
        """Delegate to the runner — wired to the shadow kill-switch in main()."""
        self._runner.abort(reason=reason)
```

**11d. Rewrite `main()`** to gate the real sink + action clients. Replace the existing `main()` body with:
```python
def main() -> None:
    setup("bridge")
    robot_id = os.environ.get("GUIDEMATE_ROBOT_ID", "turtlebot468")

    # HARD GUARD (belt + braces): motion is never honored for robot 468.
    assert_motion_identity_safe(os.environ)

    endpoint = os.environ["GUIDEMATE_IOT_ENDPOINT"]
    cert = os.environ["GUIDEMATE_CERT"]
    key = os.environ["GUIDEMATE_KEY"]
    ca = os.environ.get("GUIDEMATE_CA")
    client = IotClient(
        endpoint=endpoint, cert_filepath=cert, pri_key_filepath=key,
        client_id=f"guidemate-bridge-{robot_id}", robot_id=robot_id, ca_filepath=ca,
    )

    # --- Phase 2 safety layer (PINNED): shadow reconcile provides effective_dry_run,
    # motion_enabled, docked, and a shadow-delta callback. Do NOT reimplement here. ---
    from guide_mate_bridge.safety import SafetyLayer  # Phase 2 module
    safety = SafetyLayer(client=client, robot_id=robot_id)
    safety.start()
    effective_dry_run = safety.effective_dry_run()

    publish_twist = None
    run_action = None
    if resolve_motion_enabled(os.environ, effective_dry_run, safety.motion_enabled()):
        # Build the ONLY real cmd_vel sink + dock/undock action clients.
        # Requires the Phase 2 rclpy node (GUIDEMATE_ROS=1).
        if not _truthy(os.environ.get("GUIDEMATE_ROS", "0")):
            raise SystemExit(
                "motion requires GUIDEMATE_ROS=1 (rclpy node for cmd_vel + dock actions)"
            )
        from guide_mate_bridge.cmd_vel_publisher import CmdVelPublisher
        from guide_mate_bridge.dock_actions import DockActions
        node = safety.ros_node()  # Phase 2 owns the process's single rclpy Node
        topic = os.environ.get("GUIDEMATE_CMD_VEL_TOPIC", "/cmd_vel")
        publish_twist = CmdVelPublisher(node, topic=topic)
        run_action = DockActions(
            node,
            undock_action=os.environ.get("GUIDEMATE_UNDOCK_ACTION", "/undock"),
            dock_action=os.environ.get("GUIDEMATE_DOCK_ACTION", "/dock"),
        ).run
        log.info("MOTION ENABLED", extra=log_extra(robot_id=robot_id, cmd_vel_topic=topic))

    def _motion_gate(cmd):
        # Command-aware gate, evaluated live at dispatch: shadow lock is supreme,
        # dock-guard exemption matrix lets undock/dock/stop through while docked.
        return command_permitted(cmd.type, cmd.name, safety.motion_enabled(), safety.docked())

    bridge = Bridge(
        client=client, robot_id=robot_id, dry_run=effective_dry_run,
        publish_twist=publish_twist, motion_gate=_motion_gate, run_action=run_action,
    )
    # KILL-SWITCH: shadow delta motion_enabled:false -> abort in-flight choreography.
    safety.on_motion_disabled(lambda: bridge.abort(reason="motion_disabled"))
    bridge.start()
    log.info("bridge connected", extra=log_extra(robot_id=robot_id))
    threading.Event().wait()  # block forever
```
Add near the imports: `from guide_mate_bridge.executor import ChoreographyRunner` already present; ensure `resolve_motion_enabled`/`command_permitted`/`assert_motion_identity_safe` are module-level.

> **FLAG (Phase 2 dependency):** `guide_mate_bridge.safety.SafetyLayer` with `start()`, `effective_dry_run()`, `motion_enabled()`, `docked()`, `ros_node()`, `on_motion_disabled(cb)` is delivered by Phase 2. If Phase 2's API names differ at execution time, adapt these call sites only — the gating logic and hard guard are unchanged. **Required Phase-2-side change (exemption matrix):** Phase 2's *pre-enqueue* dock-guard refusal must delegate to `command_permitted` (replace its `if docked: refuse` with a `command_permitted(cmd.type, cmd.name, motion_enabled, docked)` call), otherwise `undock`/`dock`/`stop` would be refused before reaching the executor while docked.

- [ ] **Step 12: Run the bridge tests to verify they pass**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_bridge.py -q`
Expected: PASS (the original Phase-0/1 bridge tests still green + the 24 new ones: 15 exemption-matrix cases + 4 gating truth table + 4 identity guard + 1 stop-abort). Note: the Phase-1 `test_main_refuses_without_dry_run` was removed by Phase 2 (its hard `GUIDEMATE_DRY_RUN` guard is superseded by shadow reconcile); if it is still present and now fails, delete that single obsolete test with a note in the commit.

- [ ] **Step 13: Commit**

```bash
cd ~/cs7980-guide-mate
git add src/guide_mate_bridge/guide_mate_bridge/cmd_vel_publisher.py \
        src/guide_mate_bridge/guide_mate_bridge/dock_actions.py \
        src/guide_mate_bridge/guide_mate_bridge/bridge.py \
        src/guide_mate_bridge/tests/test_cmd_vel_publisher.py \
        src/guide_mate_bridge/tests/test_dock_actions.py \
        src/guide_mate_bridge/tests/test_bridge.py
git commit -m "Kalhar: cmd_vel publisher + dock/undock action clients + exemption matrix + triple-gated motion wiring + robot-468 hard guard + stop/kill-switch abort"
```

---

## Task 5: Sim launch helper + Pi-installer motion guard

**Files:**
- Create: `sim/launch_sim.sh`
- Modify: `src/guide_mate_bridge/scripts/install_bridge_on_pi.sh`
- Test: `src/guide_mate_bridge/tests/test_installer_guard.py`

**Interfaces:**
- Produces: `sim/launch_sim.sh` — brings up Ignition (headless by default, `--gui` for the window), waits for `/odom`, then starts the bridge in-process with sim env: `GUIDEMATE_ROBOT_ID=turtlebotsim`, `GUIDEMATE_THING=Turtlebot-Sim`, sim cert/key, `GUIDEMATE_ROS=1`, `GUIDEMATE_ENABLE_MOTION=1`, `GUIDEMATE_DRY_RUN=0` (allowed **only** because the sim shadow still gates motion, and the robot-id is `turtlebotsim`, so the Task-4 hard guard does not fire).
- Consumes: Task 1 cert (`~/.aws/guidemate-sim.*`), Task 2 `sim/sim_facts.env` (cmd_vel topic + undock/dock action names), Task 4 bridge motion path (`GUIDEMATE_CMD_VEL_TOPIC`, `GUIDEMATE_UNDOCK_ACTION`, `GUIDEMATE_DOCK_ACTION`).

**Phase dependencies:** the Pi installer file is created by Phase 0/1 Task 8 (**FLAG Phase 0/1**); Task 5 only adds a guard + comment to it.

- [ ] **Step 1: Write the failing installer-guard test**

`src/guide_mate_bridge/tests/test_installer_guard.py`:
```python
import os

HERE = os.path.dirname(__file__)
INSTALLER = os.path.abspath(os.path.join(HERE, "..", "scripts", "install_bridge_on_pi.sh"))


def test_installer_never_enables_motion():
    text = open(INSTALLER).read()
    # The Pi installer must NEVER write GUIDEMATE_ENABLE_MOTION into the systemd unit/env.
    # Only an explicit guard/comment mentioning it (to document the ban) is allowed —
    # never an assignment.
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue  # comments may name the var to document the ban
        assert "GUIDEMATE_ENABLE_MOTION=1" not in stripped, line
        assert "GUIDEMATE_ENABLE_MOTION=true" not in stripped, line


def test_installer_documents_the_ban():
    text = open(INSTALLER).read()
    assert "GUIDEMATE_ENABLE_MOTION" in text  # must at least mention it in a comment
    assert "sim" in text.lower()
```

- [ ] **Step 2: Run it red**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_installer_guard.py -q`
Expected: FAIL — `test_installer_documents_the_ban` fails (the installer doesn't mention the var yet). If the installer already accidentally sets it, `test_installer_never_enables_motion` also fails.

- [ ] **Step 3: Add the guard comment to `install_bridge_on_pi.sh`**

Add near the top of `src/guide_mate_bridge/scripts/install_bridge_on_pi.sh` (after the shebang / `set -euo pipefail`):
```bash
# ============================================================================
# MOTION SAFETY INVARIANT — DO NOT REMOVE.
# This installer NEVER sets GUIDEMATE_ENABLE_MOTION. Robot 468 runs dry-run only;
# real cmd_vel publishing exists solely for the Gazebo *sim* (see sim/launch_sim.sh).
# The bridge additionally hard-refuses GUIDEMATE_ENABLE_MOTION when robot_id==turtlebot468
# (bridge.assert_motion_identity_safe). Two independent guards, on purpose.
# ============================================================================
```

- [ ] **Step 4: Run the guard test green**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_installer_guard.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Write `sim/launch_sim.sh`**

`sim/launch_sim.sh`:
```bash
#!/usr/bin/env bash
# Bring up the TB4 Ignition sim + the bridge under the sim identity, with motion ARMED
# (still shadow-gated). Robot 468 is never referenced. Kill by PID (never pkill -f).
set -uo pipefail

REPO="$HOME/cs7980-guide-mate"
AWS="${AWS:-$HOME/.local/bin/aws}"
GUI="${1:-}"   # pass --gui for a window; default headless.

source /opt/ros/humble/setup.bash
source "$REPO/sim/sim_facts.env"     # SIM_CMD_VEL_TOPIC etc. (Task 2, verified)

HEADLESS=true
[[ "$GUI" == "--gui" ]] && HEADLESS=false

echo "== launching turtlebot4_ignition_bringup (headless=$HEADLESS) =="
ros2 launch turtlebot4_ignition_bringup turtlebot4_ignition.launch.py \
    rviz:=false headless:=$HEADLESS >/tmp/sim_run.log 2>&1 &
SIM_PID=$!
echo "sim pid=$SIM_PID — waiting for $SIM_ODOM_TOPIC"
deadline=$((SECONDS + 90))
until ros2 topic list 2>/dev/null | grep -qx "$SIM_ODOM_TOPIC"; do
  if (( SECONDS > deadline )); then echo "TIMEOUT: no $SIM_ODOM_TOPIC"; kill "$SIM_PID"; exit 1; fi
  sleep 3
done
echo "sim up."

echo "== discovering IoT endpoint =="
ENDPOINT="$("$AWS" iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)"

echo "== starting bridge (sim identity; motion armed but shadow-gated) =="
export GUIDEMATE_ROBOT_ID=turtlebotsim
export GUIDEMATE_THING=Turtlebot-Sim
export GUIDEMATE_IOT_ENDPOINT="$ENDPOINT"
export GUIDEMATE_CERT="$HOME/.aws/guidemate-sim.cert.pem"
export GUIDEMATE_KEY="$HOME/.aws/guidemate-sim.key.pem"
export GUIDEMATE_CMD_VEL_TOPIC="$SIM_CMD_VEL_TOPIC"
export GUIDEMATE_UNDOCK_ACTION="$SIM_UNDOCK_ACTION"
export GUIDEMATE_DOCK_ACTION="$SIM_DOCK_ACTION"
export GUIDEMATE_ROS=1
export GUIDEMATE_ENABLE_MOTION=1     # OK: robot_id=turtlebotsim (hard guard passes); shadow still gates.
export GUIDEMATE_DRY_RUN=0           # OK: sim shadow default-deny still holds motion locked until flipped.

trap 'echo "stopping bridge+sim"; kill "$SIM_PID" 2>/dev/null || true' EXIT
"$REPO/.venv/bin/python" -m guide_mate_bridge.bridge
```

- [ ] **Step 6: `chmod +x` and smoke the launch (bridge connects, shadow still locked = dry-run)**

Run:
```bash
cd ~/cs7980-guide-mate
chmod +x sim/launch_sim.sh
timeout 60 ./sim/launch_sim.sh >/tmp/launch_sim_smoke.log 2>&1 || true
grep -E "bridge connected|MOTION ENABLED|refusing" /tmp/launch_sim_smoke.log || true
```
Expected: `bridge connected` appears; **`MOTION ENABLED` does NOT** (the sim shadow still ships `motion_enabled=false`, so `resolve_motion_enabled` returns False → dry-run sink). This proves default-deny holds even with the motion env armed. (Task 6 flips the shadow to actually move.)

- [ ] **Step 7: Commit**

```bash
cd ~/cs7980-guide-mate
git add sim/launch_sim.sh src/guide_mate_bridge/scripts/install_bridge_on_pi.sh \
        src/guide_mate_bridge/tests/test_installer_guard.py
git commit -m "Kalhar: sim launch helper (motion armed, shadow-gated) + Pi-installer motion-ban guard/test"
```

---

## Task 6: Motion validation pytest (GUIDEMATE_SIM=1) — circle / kill-switch / dock-guard / dock lifecycle

**Files:**
- Modify: `pytest.ini` (register `sim` marker), `conftest.py` (gate `sim` on `GUIDEMATE_SIM=1`)
- Test: `src/guide_mate_bridge/tests/test_sim_motion.py`

**Interfaces:**
- Consumes: Task 1 sim identity + shadow; Task 5 `sim/launch_sim.sh` (running externally during the test); `RobotRegistry` (Phase 0/1); Phase 2 dock guard with the Task-4 exemption matrix (`docked` refusal for twists, undock/dock/stop exempt); Task 3/4 undock/dock action dispatch; the Phase-4 schema motion names `"undock"`/`"dock"` (**FLAG Phase 4**). `sim/sim_facts.env` topic/action names (Task 2).
- Produces: the standing sim regression suite. Four assertions: **circle closes** (`<0.15 m`) with `|net yaw| ≥ 5.5 rad`; **kill-switch drill** (flip `motion_enabled:false` mid-circle → `/cmd_vel` zeros within 1 s + ack `failed`); **dock-guard** (docked → twist motion refused reason `docked`; after undock it is allowed); **dock lifecycle via IoT** (`undock` command → `done` + `/dock_status` `is_docked` flips false → circle runs → `dock` command → `done` + re-docks) — this is the sim-side end-to-end proof of the Phase-4 assignment lifecycle (approve-hook fires `undock`, session usable, unassign fires `dock`). Always resets the sim shadow to locked in teardown.

**Phase dependencies:** dock-guard refusal is Phase 2's, updated by Task 4 to delegate to `command_permitted` (**FLAG Phase 2**); `Command(type="motion", name="undock"/"dock")` requires the Phase-4 schema addition (**FLAG Phase 4**). The whole file is `@pytest.mark.sim`, skipped unless `GUIDEMATE_SIM=1`.

- [ ] **Step 1: Register + gate the `sim` marker**

In `pytest.ini`, add under `markers =`:
```ini
    sim: real Gazebo sim + real IoT Core motion validation (set GUIDEMATE_SIM=1 to run)
```
In `conftest.py`, extend `pytest_collection_modifyitems`:
```python
    run_sim = os.environ.get("GUIDEMATE_SIM") == "1"
    skip_sim = pytest.mark.skip(reason="set GUIDEMATE_SIM=1 (needs running sim + IoT) to run")
    for item in items:
        if "sim" in item.keywords and not run_sim:
            item.add_marker(skip_sim)
```
(Place these three lines inside the existing loop/function alongside the integration/live gates.)

- [ ] **Step 2: Write the sim motion test**

`src/guide_mate_bridge/tests/test_sim_motion.py`:
```python
"""GUIDEMATE_SIM=1 motion validation against the running Gazebo sim + real IoT Core.

PRECONDITION: in another terminal run `./sim/launch_sim.sh` (Ignition up + bridge connected).
This test flips the *sim* shadow (Turtlebot-Sim) only, drives via IoT, reads /odom via rclpy,
and always resets the sim shadow to locked in teardown. Robot 468 is never referenced.
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import threading
import time

import pytest

pytestmark = pytest.mark.sim

AWS = os.environ.get("AWS", os.path.expanduser("~/.local/bin/aws"))
REGION = os.environ.get("AWS_REGION", "us-west-2")
THING = "Turtlebot-Sim"
ROBOT_ID = "turtlebotsim"


# ---------- shadow helpers (SIM thing ONLY) ----------
def _set_shadow(motion_enabled: bool, dry_run: bool) -> None:
    payload = json.dumps(
        {"state": {"desired": {"motion_enabled": motion_enabled, "dry_run": dry_run, "max_speed": 0.15}}}
    )
    subprocess.run(
        [AWS, "iot-data", "update-thing-shadow", "--thing-name", THING, "--region", REGION,
         "--cli-binary-format", "raw-in-base64-out", "--payload", payload, "/dev/stdout"],
        check=True, stdout=subprocess.DEVNULL,
    )
    time.sleep(3.0)  # let the bridge's shadow reconcile catch the delta


def _lock_shadow() -> None:
    _set_shadow(motion_enabled=False, dry_run=True)


# ---------- rclpy odom + cmd_vel listeners ----------
def _facts() -> dict:
    facts = {}
    here = os.path.dirname(__file__)
    path = os.path.abspath(os.path.join(here, "..", "..", "..", "sim", "sim_facts.env"))
    for line in open(path):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            facts[k] = v
    return facts


def _wait_for(predicate, timeout_s, desc=""):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.5)
    raise AssertionError(f"timeout waiting for {desc}")


class _RosSpy:
    """Subscribes /odom + /cmd_vel + /dock_status and can drive the /undock action
    directly (test precondition helper), on its own rclpy context."""

    def __init__(self, facts):
        import rclpy
        from rclpy.node import Node
        from nav_msgs.msg import Odometry
        from geometry_msgs.msg import Twist
        from irobot_create_msgs.msg import DockStatus

        rclpy.init(args=None)
        self._rclpy = rclpy
        self.node = Node("sim_motion_spy")
        self.odom = []           # list[(x, y, yaw)]
        self.cmd_vel = []        # list[(t, vx, wz)]
        self.docked = None       # latest /dock_status .is_docked (None until first msg)
        self.node.create_subscription(Odometry, facts["SIM_ODOM_TOPIC"], self._on_odom, 10)
        self.node.create_subscription(Twist, facts["SIM_CMD_VEL_TOPIC"], self._on_cmd, 10)
        self.node.create_subscription(
            DockStatus, facts["SIM_DOCK_STATUS_TOPIC"], self._on_dock, 10
        )
        self._facts = facts
        self._stop = threading.Event()
        self._spin = threading.Thread(target=self._spin_loop, daemon=True)
        self._spin.start()

    def _spin_loop(self):
        while not self._stop.is_set():
            self._rclpy.spin_once(self.node, timeout_sec=0.1)

    @staticmethod
    def _yaw(q):
        return math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))

    def _on_odom(self, msg):
        p = msg.pose.pose
        self.odom.append((p.position.x, p.position.y, self._yaw(p.orientation)))

    def _on_cmd(self, msg):
        self.cmd_vel.append((time.time(), msg.linear.x, msg.angular.z))

    def _on_dock(self, msg):
        self.docked = bool(msg.is_docked)

    def undock(self):
        from rclpy.action import ActionClient
        from irobot_create_msgs.action import Undock
        client = ActionClient(self.node, Undock, self._facts["SIM_UNDOCK_ACTION"])
        assert client.wait_for_server(timeout_sec=15.0), "undock action server missing"
        goal = client.send_goal_async(Undock.Goal())
        deadline = time.time() + 30
        while not goal.done() and time.time() < deadline:
            time.sleep(0.2)

    def close(self):
        self._stop.set()
        self._spin.join(timeout=2.0)
        self.node.destroy_node()
        self._rclpy.shutdown()


@pytest.fixture
def registry():
    from guidemate_agent.mqtt_link import RobotRegistry
    endpoint = subprocess.check_output(
        [AWS, "iot", "describe-endpoint", "--endpoint-type", "iot:Data-ATS",
         "--query", "endpointAddress", "--output", "text"], text=True).strip()
    reg = RobotRegistry(endpoint=endpoint, region=REGION, robot_ids=[ROBOT_ID])
    reg.connect()
    yield reg


@pytest.fixture
def spy():
    s = _RosSpy(_facts())
    yield s
    s.close()


@pytest.fixture(autouse=True)
def _always_lock_shadow_after():
    yield
    _lock_shadow()


# ---------- the four validations ----------
def test_circle_closes_and_turns_full(registry, spy):
    from guidemate_msgs.messages import Command
    spy.undock()                          # leave the dock so motion is permitted
    _set_shadow(motion_enabled=True, dry_run=False)
    start = spy.odom[-1] if spy.odom else (0.0, 0.0, 0.0)
    acks = registry.send_command(ROBOT_ID, Command(type="motion", name="circle"), timeout_s=40.0)
    assert acks and acks[-1].state == "done", [a.state for a in acks]
    end = spy.odom[-1]
    assert math.hypot(end[0] - start[0], end[1] - start[1]) < 0.15   # trajectory closes
    # accumulate unwrapped yaw over the run
    yaws = [o[2] for o in spy.odom]
    net = 0.0
    for a, b in zip(yaws, yaws[1:]):
        d = b - a
        while d > math.pi: d -= 2 * math.pi
        while d < -math.pi: d += 2 * math.pi
        net += d
    assert abs(net) >= 5.5, net                                       # ~full 2π turn


def test_kill_switch_zeros_cmd_vel_within_1s(registry, spy):
    from guidemate_msgs.messages import Command
    spy.undock()
    _set_shadow(motion_enabled=True, dry_run=False)

    acks_out = {}
    def worker():
        acks_out["acks"] = registry.send_command(ROBOT_ID, Command(type="motion", name="circle"), timeout_s=40.0)
    t = threading.Thread(target=worker); t.start()

    time.sleep(3.0)                        # let it drive
    _set_shadow(motion_enabled=False, dry_run=True)   # KILL
    kill_t = time.time()
    t.join(timeout=10.0)

    # cmd_vel must reach zero within 1s of the kill.
    after = [(ct, vx, wz) for (ct, vx, wz) in spy.cmd_vel if ct >= kill_t]
    zero_t = next((ct for (ct, vx, wz) in after if abs(vx) < 1e-3 and abs(wz) < 1e-3), None)
    assert zero_t is not None and (zero_t - kill_t) <= 1.0, after[:5]
    assert acks_out["acks"][-1].state == "failed"


def _ensure_docked(registry, spy):
    """Earlier tests leave the robot undocked; re-dock via the IoT dock command
    (a normal allowed action while undocked) so docked-start tests are order-independent."""
    from guidemate_msgs.messages import Command
    _wait_for(lambda: spy.docked is not None, 30, "first /dock_status message")
    if spy.docked is False:
        acks = registry.send_command(ROBOT_ID, Command(type="motion", name="dock"), timeout_s=120.0)
        assert acks and acks[-1].state == "done", [a.state for a in acks]
        _wait_for(lambda: spy.docked is True, 90, "robot to re-dock")


def test_dock_guard_refuses_until_undock(registry, spy):
    from guidemate_msgs.messages import Command
    # docked -> even with motion+dry_run flipped, dock guard refuses twists.
    _set_shadow(motion_enabled=True, dry_run=False)
    _ensure_docked(registry, spy)
    acks = registry.send_command(ROBOT_ID, Command(type="motion", name="circle"), timeout_s=10.0)
    assert acks and acks[-1].state == "failed"
    assert acks[-1].reason == "docked", acks[-1].reason
    # undock (direct ROS action as a test helper), then the same command is accepted.
    spy.undock()
    _wait_for(lambda: spy.docked is False, 30, "undock to complete")
    acks2 = registry.send_command(ROBOT_ID, Command(type="motion", name="spin"), timeout_s=40.0)
    assert acks2[-1].state == "done", [a.state for a in acks2]


def test_dock_lifecycle_via_iot(registry, spy):
    """The Phase-4 assignment lifecycle, end-to-end in sim, entirely over IoT commands:
    approve -> undock (exempt while docked) -> usable (circle) -> unassign -> dock.
    Requires the Phase-4 schema motion names "undock"/"dock" (FLAG Phase 4)."""
    from guidemate_msgs.messages import Command
    _set_shadow(motion_enabled=True, dry_run=False)
    _ensure_docked(registry, spy)

    # 1. undock via IoT — permitted while docked (exemption matrix).
    acks = registry.send_command(ROBOT_ID, Command(type="motion", name="undock"), timeout_s=60.0)
    assert acks and acks[-1].state == "done", [a.state for a in acks]
    _wait_for(lambda: spy.docked is False, 30, "/dock_status is_docked to flip false")

    # 2. robot is usable: a normal choreography runs.
    acks = registry.send_command(ROBOT_ID, Command(type="motion", name="circle"), timeout_s=40.0)
    assert acks[-1].state == "done", [a.state for a in acks]

    # 3. dock via IoT — a normal allowed action while undocked.
    acks = registry.send_command(ROBOT_ID, Command(type="motion", name="dock"), timeout_s=120.0)
    assert acks and acks[-1].state == "done", [a.state for a in acks]
    _wait_for(lambda: spy.docked is True, 90, "robot to re-dock")
```

- [ ] **Step 3: Verify the suite is skipped by default (no sim needed)**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_sim_motion.py -q`
Expected: `4 skipped` (marker gate holds; nothing runs without `GUIDEMATE_SIM=1`).

- [ ] **Step 4: Run the real validation (sim up in another terminal)**

In terminal A: `cd ~/cs7980-guide-mate && ./sim/launch_sim.sh` (leave running; wait for `bridge connected`).
In terminal B:
```bash
cd ~/cs7980-guide-mate
source /opt/ros/humble/setup.bash
GUIDEMATE_SIM=1 .venv/bin/python -m pytest src/guide_mate_bridge/tests/test_sim_motion.py -q -x
```
Expected: `4 passed` — circle closes + full turn; kill-switch zeros `/cmd_vel` within 1 s and acks `failed`; dock-guard refuses `docked` then permits after undock; dock lifecycle round-trips over IoT (`undock` → `is_docked` false → circle → `dock` → re-docked). The sim shadow is reset to locked afterward (autouse fixture). Confirm: `~/.local/bin/aws iot-data get-thing-shadow --thing-name Turtlebot-Sim --region us-west-2 /dev/stdout | cat` shows `motion_enabled:false, dry_run:true`.

- [ ] **Step 5: Commit**

```bash
cd ~/cs7980-guide-mate
git add pytest.ini conftest.py src/guide_mate_bridge/tests/test_sim_motion.py
git commit -m "Kalhar: GUIDEMATE_SIM=1 motion validation — circle + kill-switch drill + dock-guard exemption + IoT dock lifecycle (sim shadow only)"
```

---

## Task 7: Virtual-pet grant — registry + admin robot picker + user badge + Playwright

**Files:**
- Modify: `agent_service/guidemate_agent/config.py` (default `GUIDEMATE_ROBOTS` includes `turtlebotsim`)
- Modify: `agent_service/static/admin.html` (robot picker on the Requests approve control)
- Modify: `agent_service/static/index.html` (virtual-pet badge when `robot_id == turtlebotsim`)
- Test: `agent_service/tests/test_config.py` (registry lists `turtlebotsim`), `agent_service/tests/e2e/test_virtual_pet.py` (Playwright)

**Interfaces:**
- Consumes: Phase 4 per-robot lock (`pk="robot_lock#<robot_id>"`) + admin approve action that accepts a `robot_id` (**FLAG Phase 4**); the `GUIDEMATE_FAKE_ROBOT=1` UI test harness (**FLAG Phase 4/5**).
- Produces: `Config.from_env()` default `robot_ids == ["turtlebot468", "turtlebotsim"]`. Admin Requests approve control gains `<select data-testid="approve-robot-select">` (options from the registry) so approve binds the session to the chosen `robot_id` (physical `turtlebot468` **or** virtual `turtlebotsim`). Chat UI shows a `data-testid="virtual-pet-badge"` ("Virtual pet") whenever the connected `robot_id == "turtlebotsim"`.

**Phase dependencies:** Phase 3/4 admin + chat UI and the approve endpoint (**FLAG**). Task 7 adds a picker + badge; the lock/approve mechanics are Phase 4's.

- [ ] **Step 1: Write the failing config test**

`agent_service/tests/test_config.py` (create if absent; else append):
```python
from guidemate_agent.config import Config


def test_default_registry_includes_virtual_pet(monkeypatch):
    monkeypatch.delenv("GUIDEMATE_ROBOTS", raising=False)
    cfg = Config.from_env()
    assert "turtlebot468" in cfg.robot_ids
    assert "turtlebotsim" in cfg.robot_ids     # virtual pet available out of the box


def test_env_override_still_wins(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ROBOTS", "turtlebot468")
    assert Config.from_env().robot_ids == ["turtlebot468"]
```

- [ ] **Step 2: Run it red**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_config.py -q`
Expected: FAIL — `assert "turtlebotsim" in cfg.robot_ids` (default is currently `turtlebot468` only).

- [ ] **Step 3: Update the config default**

In `agent_service/guidemate_agent/config.py`, change the default:
```python
        robots = os.environ.get("GUIDEMATE_ROBOTS", "turtlebot468,turtlebotsim")
```

- [ ] **Step 4: Run it green**

Run: `cd ~/cs7980-guide-mate && .venv/bin/python -m pytest agent_service/tests/test_config.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Add the admin robot picker (Requests approve control)**

In `agent_service/static/admin.html`, in the Requests-tab approve control (per pending request row), add a robot selector next to the Approve button and include its value in the approve call. The registry list is already fetched for the robot-status tab; reuse it. Minimal addition:
```html
<!-- inside each pending-request row, beside the Approve button -->
<select data-testid="approve-robot-select" class="approve-robot">
  <option value="turtlebot468">Physical — turtlebot468</option>
  <option value="turtlebotsim">Virtual pet — turtlebotsim</option>
</select>
```
And in the approve handler (the fetch that POSTs to the Phase-4 approve endpoint), send the chosen robot:
```javascript
// robot_id from the row's selector; Phase 4 approve endpoint binds session -> robot_id.
const robotId = row.querySelector('[data-testid="approve-robot-select"]').value;
await fetch(`/admin/api/requests/${requestId}/approve`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({ robot_id: robotId }),
});
```
> **FLAG (Phase 4):** the approve endpoint must accept `{robot_id}` and acquire `robot_lock#<robot_id>` for that robot. If Phase 4 shipped approve without a `robot_id` body, this is the one-line server change to make there; Task 7 only supplies the picker.

> **Integration point (FLAG Phase 4 — "Assignment-triggered dock/undock", spec 91d9bcb):** Phase 4's approve-hook fires an automatic `undock` command for the newly bound robot after acquiring the lock (and unassign/abort fires `dock`). Approving onto `turtlebotsim` therefore undocks the sim robot automatically — permitted while docked by the Task-4 exemption matrix, and executed via the Task-4 `DockActions` path; the bridge-side chain is exactly what Task 6's `test_dock_lifecycle_via_iot` proves. Do NOT re-implement the hook here; with `GUIDEMATE_FAKE_ROBOT=1` the undock ack is faked, so the Playwright test below needs no change.

- [ ] **Step 6: Add the virtual-pet badge (chat UI)**

In `agent_service/static/index.html`, near the robot-connected status chip, add a badge shown only when the connected robot is the sim. The UI already receives the connected `robot_id` over the status WS (Phase 4). Add:
```html
<span data-testid="virtual-pet-badge" class="badge badge-virtual" hidden>🐾 Virtual pet</span>
```
```javascript
// wherever the connected robot_id arrives on the status WS:
function renderRobotBinding(robotId) {
  const badge = document.querySelector('[data-testid="virtual-pet-badge"]');
  badge.hidden = (robotId !== 'turtlebotsim');
}
```

- [ ] **Step 7: Write the Playwright grant-flow test (GUIDEMATE_FAKE_ROBOT=1)**

`agent_service/tests/e2e/test_virtual_pet.py`:
```python
"""Playwright: admin grants a VIRTUAL PET (turtlebotsim) to a session; the physical lock
(turtlebot468) is never touched. Runs against the app with GUIDEMATE_FAKE_ROBOT=1 so no
real robot/MQTT is needed. Env-gated like the other e2e tests (GUIDEMATE_E2E=1)."""
import os

import pytest
from playwright.sync_api import expect, sync_playwright

pytestmark = pytest.mark.skipif(
    os.environ.get("GUIDEMATE_E2E") != "1", reason="set GUIDEMATE_E2E=1 (needs running app) to run"
)

BASE = os.environ.get("GUIDEMATE_BASE_URL", "http://localhost:8000")
ADMIN_PW = os.environ.get("GUIDEMATE_ADMIN_PASSWORD", "devpassword")


def _intake(page, name):
    page.goto(BASE)
    if page.locator('[data-testid="intake-name"]').count():
        page.fill('[data-testid="intake-name"]', name)
        page.click('[data-testid="intake-submit"]')


def test_admin_grants_virtual_pet_and_badge_shows():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        user = browser.new_context()
        admin = browser.new_context()

        upage = user.new_page()
        _intake(upage, "Pat")
        upage.click('[data-testid="request-companion"]')      # user asks for a companion
        expect(upage.locator('[data-testid="request-banner"]')).to_contain_text("pending", ignore_case=True)

        apage = admin.new_page()
        apage.goto(f"{BASE}/admin")
        apage.fill('[data-testid="admin-password"]', ADMIN_PW)
        apage.click('[data-testid="admin-login"]')
        apage.click('[data-testid="tab-requests"]')

        row = apage.locator('[data-testid="request-row"]').first
        row.locator('[data-testid="approve-robot-select"]').select_option("turtlebotsim")  # virtual pet
        row.locator('[data-testid="approve-btn"]').click()

        # The user's UI now shows the virtual-pet badge (connected to turtlebotsim, not 468).
        expect(upage.locator('[data-testid="virtual-pet-badge"]')).to_be_visible(timeout=10000)
        expect(upage.locator('[data-testid="request-banner"]')).to_contain_text("approved", ignore_case=True)

        browser.close()
```

- [ ] **Step 8: Run the Playwright test against the fake-robot app**

Run (app started separately with `GUIDEMATE_FAKE_ROBOT=1`, e.g. `GUIDEMATE_FAKE_ROBOT=1 GUIDEMATE_ROBOTS=turtlebot468,turtlebotsim .venv/bin/uvicorn guidemate_agent.app:app` from `agent_service/`):
```bash
cd ~/cs7980-guide-mate
GUIDEMATE_E2E=1 GUIDEMATE_BASE_URL=http://localhost:8000 \
  .venv/bin/python -m pytest agent_service/tests/e2e/test_virtual_pet.py -q
```
Expected: `1 passed` — the badge appears; the approve bound the session to `turtlebotsim`. Without `GUIDEMATE_E2E=1` it is skipped.
> **FLAG (Phase 4/5):** relies on the `data-testid` hooks (`intake-name`, `request-companion`, `request-banner`, `admin-password`, `admin-login`, `tab-requests`, `request-row`, `approve-btn`) established by Phase 3–5 UI. If any differ, update the selectors here; the new hooks (`approve-robot-select`, `virtual-pet-badge`) are added by this task.

- [ ] **Step 9: Commit**

```bash
cd ~/cs7980-guide-mate
git add agent_service/guidemate_agent/config.py agent_service/static/admin.html \
        agent_service/static/index.html agent_service/tests/test_config.py \
        agent_service/tests/e2e/test_virtual_pet.py
git commit -m "Kalhar: virtual-pet grant — registry default + admin robot picker + user badge + Playwright"
```

---

## Phase 8 exit checklist (spec row 8 / components 29–31)

- [ ] **29 — Sim identity + launch:** `scripts/create_sim_identity.sh` mints `Turtlebot-Sim` + cert + `guidemate-sim-policy` + default-deny shadow (Task 1); `sim/launch_sim.sh` brings up Ignition + the sim-param bridge (Task 5); the bridge connects under its own identity and default-deny holds even with motion armed (Task 5 Step 6).
- [ ] **30 — Sim motion validation:** `GUIDEMATE_SIM=1` suite green — circle closes + full 2π turn, kill-switch zeros `/cmd_vel` within 1 s + acks `failed`, dock-guard refuses `docked` (twists) while the exemption matrix passes `undock`/`dock`/`stop`, and the **IoT dock lifecycle** round-trips (undock → `is_docked` false → circle → dock → re-docked = the Phase-4 assignment lifecycle proven in sim); sim shadow reset to locked (Task 6). Headless (`headless:=true`) standing regression.
- [ ] **31 — Virtual-pet grant:** registry lists `turtlebotsim` (Task 7); admin approves a non-lock session onto `turtlebotsim` while the physical `turtlebot468` lock is untouched; user UI shows the virtual-pet badge (Task 7 Playwright); the Phase-4 approve-hook auto-undock integration point is documented (Task 7).
- [ ] **Scope addition 91d9bcb ("Assignment-triggered dock/undock") intact:** `undock`/`dock` execute as Create 3 ROS **actions** (`/undock`, `/dock` — verified in Task 2, dispatched in Tasks 3–4), never twists; dock-guard exemption matrix (`command_permitted`) unit-tested (Task 4) and drilled in sim (Task 6).
- [ ] **Safety invariants intact:** robot 468's shadow never written; `GUIDEMATE_ENABLE_MOTION` hard-refused for 468 (Task 4) and never set by the Pi installer (Task 5); every motion path — twists AND dock/undock actions — triple-gated (env + shadow `motion_enabled` + not effective-dry-run) with the shadow kill-switch wired to executor abort.

## Self-review notes (from the writing-plans self-review)

- **Spec coverage:** components 29 (Task 1 + Task 5), 30 (Task 6), 31 (Task 7) — all mapped. Locked decisions (a) Task 1, (b) Tasks 3+4+5, (c) Task 5, (d) Task 6, (e) Task 7. The explicit "verify the sim ROS graph" step is Task 2. Scope addition 91d9bcb: action-client execution (Tasks 2–4), exemption matrix + unit tests (Task 4), sim dock-lifecycle drill (Task 6), approve-hook integration note (Task 7).
- **Type consistency:** `ChoreographyRunner(publish_ack, dry_run, publish_twist, publish_hz, sleep, motion_gate, run_action)` + `.abort(reason)` defined in Task 3 and consumed identically in Task 4's `Bridge`/`main`; `motion_gate: Callable[[Command], tuple[bool, str]]` and `run_action: Callable[[str], tuple[bool, str]]` match `command_permitted(...) -> tuple[bool, str]` and `DockActions.run(name) -> tuple[bool, str]` (Task 4). `resolve_motion_enabled`/`assert_motion_identity_safe` signatures match between Task 4 interface block, implementation, and tests. `CmdVelPublisher(node, topic, twist_cls)` consistent across Task 4 impl/test and Task 5 launch env (`GUIDEMATE_CMD_VEL_TOPIC`, `GUIDEMATE_UNDOCK_ACTION`, `GUIDEMATE_DOCK_ACTION`). `sim/sim_facts.env` keys (`SIM_ODOM_TOPIC`, `SIM_CMD_VEL_TOPIC`, `SIM_DOCK_STATUS_TOPIC`, `SIM_UNDOCK_ACTION`, `SIM_DOCK_ACTION`) produced in Task 2 and consumed in Tasks 5 + 6.
- **Phase dependencies flagged:** Phase 2 `SafetyLayer` incl. `docked()` + the required pre-enqueue delegation to `command_permitted` (Task 4, Task 6); Phase 0/1 installer (Task 5); Phase 4 schema motion names `undock`/`dock` (Tasks 3, 6 — `_cmd_action` falls back to `model_construct` in unit tests), approve/lock + approve-hook auto-undock + `GUIDEMATE_FAKE_ROBOT` (Task 7).
- **No robot-468 motion path:** the hard guard (Task 4), installer ban (Task 5), and sim-only shadow writes (Tasks 1, 6) are the three independent guarantees. Dock/undock actions ride the same triple gate: `DockActions` is only constructed when `resolve_motion_enabled` passes, and `command_permitted` refuses everything (`motion_disabled`) while the shadow is locked.
- **Ordering robustness (Task 6):** docked-start tests (`dock_guard`, `dock_lifecycle`) re-dock via `_ensure_docked` (IoT `dock` command) so the suite is order-independent even though earlier tests leave the robot undocked.
