# ROS 2 over NUwave — What Works and What Doesn't

Compatibility findings for running ROS 2 (Humble, FastDDS) between a **lab laptop** and a **TurtleBot 4** when both are on **NUwave**. Verified June 2026 with `turtlebot468`.

---

## Verdict: ✅ It works (laptop ↔ robot, full ROS 2)
After two fixes (below), a laptop on NUwave can discover, subscribe, publish, and call services on the robot across the network.

| Capability | Status |
|---|---|
| Robot on NUwave, ROS stack healthy | ✅ |
| SSH to robot, run ROS 2 on robot | ✅ |
| Topic **discovery** from laptop | ✅ full `/turtlebot468/*` graph |
| **Subscribe** (battery / odom / scan) | ✅ ~1 Hz / ~17.8 Hz / ~7.6 Hz |
| **Publish** laptop → robot (cmd_audio beep) | ✅ |
| **Service / param** calls | ✅ (`wifi.interface → wlan0`) |

> Motion actions (undock, drive) were intentionally **not** exercised in this verification pass.

---

## The working laptop setup (use this)
ROS 2 default **multicast** discovery does **not** work here (laptop and robot land on different `/19` subnets; multicast is link-local). The robot runs a **FastDDS Discovery Server** (unicast, routable). Configure the laptop as a **super-client via environment variables** — *not* via an XML profile (the XML profile silently fails to apply, see gotchas):

```bash
source /opt/ros/humble/setup.bash
export RMW_IMPLEMENTATION=rmw_fastrtps_cpp
export ROS_DOMAIN_ID=0
export ROS_DISCOVERY_SERVER="10.247.204.21:11811"   # robot Pi IP : 11811 (DHCP — verify on robot display)
export ROS_SUPER_CLIENT=True
unset FASTRTPS_DEFAULT_PROFILES_FILE                 # ensure no stale XML interferes
```
Then:
```bash
ros2 daemon stop && ros2 daemon start && sleep 10    # keep ONE daemon with this env
ros2 topic list | grep -c turtlebot468               # ~28-30 once the stack is up
ros2 topic echo /turtlebot468/battery_state --once   # real data within ~20 s
```
Notes:
- The robot IP is **DHCP** — if `10.247.204.21` stops responding, read the current IP off the robot's display.
- Every fresh CLI context pays ~10 s of discovery. Keep one daemon running with the env above.
- `ros2 topic echo/list/info` support `--no-daemon`; **`ros2 topic hz` does not**.

---

## Network facts (measured)
| | IP | Subnet |
|---|---|---|
| Robot (`turtlebot468`) Pi | `10.247.204.21/19` | `10.247.192.0/19` |
| Laptop | `10.247.228.155/19` | `10.247.224.0/19` |
| Gateway | `10.247.224.1` | routes between them |

- **Different `/19` segments**, routed. ICMP, TCP (SSH), and **UDP both directions** all pass between them.
- **NUwave is NOT doing harmful client isolation** — a raw UDP beacon robot→laptop was received cleanly, and DDS unicast works once configured correctly. (An early "0 / 40 packets" result was a **transient**, not a firewall; a later beacon got 13/13 with no firewall changes.)
- **Multicast** can't cross the two subnets → Discovery Server (unicast) is the only viable model. The robots are already set up this way.

---

## Root causes found & fixed (the debugging trail)
Four separate problems, each masked the next:

1. **Robot couldn't see NUwave at all.** WiFi regulatory domain was unset (`regdom=00`), which disables 5 GHz; the strong nearby NUwave APs are 5 GHz. → Set country to **US**. See [nuwave-connection.md](nuwave-connection.md).

2. **All Create 3 base topics silent** (`battery_state`, `odom`, `dock_status`, every motion command/action) — found robot-side during the compatibility check, *unrelated to NUwave*. The Create 3 was configured to register with a discovery server at **`192.168.50.31:11811`** — a stale IP from the previous lab network, unreachable over its wired link. → Fixed via the base's web config at `http://192.168.186.2/ros-config`: set the discovery server to **`192.168.186.3:11811`** (the Pi's usb0 address), then `curl -X POST http://192.168.186.2/api/restart-app`. Base topics returned within ~2 min.

3. **Discovery worked but zero data — attempt 1.** The laptop super-client was configured via an **XML profile (`FASTRTPS_DEFAULT_PROFILES_FILE`)** that **silently did not apply** (behaved as a plain client → no full graph). → Use the **`ROS_SUPER_CLIENT=True` env var** instead. This restored topic discovery (all 28 topics).

4. **Discovery worked, still zero data — the real bug.** The robot's FastDDS **discovery-server database was corrupted**: it received the laptop's endpoint announcements but **failed to relay them** to the robot's own nodes (confirmed robot-side via tcpdump + `DISCOVERY_DATABASE` error logs; the robot reported `Subscription count: 0` for the laptop's reader, and a new laptop-published topic never appeared in the robot's own graph). → **Restart the discovery server + the full robot ROS stack** (`sudo systemctl restart discovery && sleep 3 && sudo systemctl restart turtlebot4`). After restart, data flowed immediately.

Health check for #4 (run on the robot): `sudo journalctl -u discovery | grep -c "DISCOVERY_DATABASE Error"` — non-zero and growing means restart the discovery service.

### How #4 presented (so you recognize it again)
- `ros2 topic list` from the laptop shows the full graph. ✅
- `ros2 topic echo <topic>` hangs forever, no data. ❌
- On the robot: `ros2 topic info -v <topic>` shows `Subscription count: 0` even while the laptop subscriber is live.
- A topic *published* from the laptop does **not** appear in the robot's own `ros2 topic list`.
- **Fix:** restart the discovery service and robot nodes (interrupts robot ROS ~30 s).

---

## Other findings
- **Clocks: fine once booted and online.** Robot NTP-synced (chrony → `pool.ntp.org`, ~µs off); laptop NTP-synced. Timestamps/TF consistent. (Robot timezone is cosmetically `America/Los_Angeles` — does not affect ROS, which uses UTC epoch.) **Caveat:** the Pi has no RTC and boots with a stale clock until WiFi connects — see [network README](README.md#time-sync).
- **Robot-side scripting gotcha:** `/etc/turtlebot4/setup.bash` force-sets `ROS_SUPER_CLIENT` from a TTY check (`[ -t 0 ]`), so non-interactive shells get `False` and see an empty graph. In scripts on the robot, `export ROS_SUPER_CLIENT=True` **after** sourcing it.
- **Bandwidth caution:** camera `image_raw` topics can saturate WiFi — test last, with `--once`, and prefer `compressed` variants.
- **OAK-D camera (robot 468):** throws recurring `X_LINK_ERROR` communication failures — a hardware/USB issue, unrelated to networking; camera topics exist but the device is unhealthy.
- **Create 3:** stays on the wired USB link (Discovery Server), correctly never on NUwave.

---

## Operational checklist
- [ ] Robot Pi on NUwave (5 GHz enabled, `regdom=US`).
- [ ] Laptop on NUwave; env vars set as above (`ROS_SUPER_CLIENT=True`, `ROS_DISCOVERY_SERVER=<robot-ip>:11811`).
- [ ] One `ros2 daemon` running with that env.
- [ ] If discovery works but data doesn't → restart the robot's discovery server + stack (root cause #4).
- [ ] If base topics (battery/odom/cmd_vel) are silent while Pi topics work → check the Create 3's discovery-server address (root cause #2).
- [ ] Robot IP is DHCP — confirm current IP on the robot display if it changes.

## Reproduce the key tests
```bash
# data flow (the critical one)
ros2 topic echo /turtlebot468/battery_state --once
# sustained rates (hz needs the daemon, NOT --no-daemon)
ros2 topic hz /turtlebot468/odom        # ~18 Hz
ros2 topic hz /turtlebot468/scan        # ~7-8 Hz
# publish laptop -> robot (audible beep)
ros2 topic pub --once /turtlebot468/cmd_audio irobot_create_msgs/msg/AudioNoteVector \
  "{append: false, notes: [{frequency: 660, max_runtime: {sec: 0, nanosec: 500000000}}]}"
# service / param
ros2 param get /turtlebot468/turtlebot4_node wifi.interface     # -> wlan0
```
