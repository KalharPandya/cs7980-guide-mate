# NUwave Network Setup — TurtleBot 4 (turtlebot-van-468)

**Status:** ✅ Fully working — robot on NUwave, laptop↔robot ROS 2 verified end to end (2026-06-12).

This documents how the robot was connected to Northeastern's NUwave (WPA2-Enterprise)
network, every problem hit along the way, and exactly what works and what doesn't.

## Topology

| Device | Network | IP | Notes |
|---|---|---|---|
| Robot Pi (turtlebot-van-468) | NUwave (primary) | 10.247.204.21 (DHCP — check robot display) | fallback: ASUS_98 → 10.91.221.14 |
| Laptop | NUwave | 10.247.228.155 (DHCP) | different /19 segment than robot, routed |
| Create 3 base | wired USB only | 192.168.186.2 | cannot do 802.1X; never on WiFi |
| Robot ↔ Create 3 link | usb0 | 192.168.186.3 ↔ .2 | unaffected by any WiFi/NUwave policy |

A second robot ("436", 10.91.221.95 on ASUS_98) exists and has **not** been migrated;
the same steps apply.

## Problem 1 — Robot couldn't see NUwave at all

**Root cause:** the Pi's WiFi regulatory domain was unset (`regdom=00`), which disables
the entire 5 GHz band on the Raspberry Pi 4. The strong nearby NUwave APs are on 5 GHz
channels (36/44/153/157). With regdom unset the robot saw no NUwave BSSIDs at all;
immediately after setting the country, NUwave appeared on both bands (5 GHz at 82–85 %
signal, plus weaker 2.4 GHz channels 1/11).

**Fix (persistent):**
```bash
echo "options cfg80211 ieee80211_regdom=US" | sudo tee /etc/modprobe.d/cfg80211.conf
sudo wpa_cli -i wlan0 set country US     # apply immediately without reboot
```

## Problem 2 — Connecting to WPA2-Enterprise (802.1X)

NUwave needs a NetID login, not a passphrase. NetworkManager profile (credentials are
stored in the profile on the robot, **not** in this repo):

```bash
sudo nmcli connection add type wifi con-name NUwave ifname wlan0 ssid NUwave -- \
  wifi-sec.key-mgmt wpa-eap \
  802-1x.eap peap \
  802-1x.phase2-auth mschapv2 \
  802-1x.identity "<NetID>" \
  802-1x.password "<NetID password>" \
  802-1x.domain-suffix-match "wireless.northeastern.edu" \
  802-1x.ca-cert /etc/ssl/certs/ca-certificates.crt \
  connection.autoconnect no
```

Certificate validation against the system CA bundle worked on the first try — do not
disable it. After verifying, autoconnect was enabled with priority:

```bash
sudo nmcli connection modify NUwave connection.autoconnect yes connection.autoconnect-priority 10
# ASUS_98 (netplan-wlan0-ASUS_98) stays at priority 0 as automatic fallback
```

**Safe-testing pattern used (recommended for the 436 robot too):** before the first
`nmcli connection up NUwave`, arm a detached timer that reverts to the fallback network,
since switching drops your SSH session:
```bash
sudo bash -c 'setsid nohup sh -c "sleep 150 && nmcli con up netplan-wlan0-ASUS_98" >/dev/null 2>&1 &'
```

## Problem 3 — ROS 2 discovery worked, data didn't (the hard one)

Symptoms from the laptop: `ros2 topic list` showed the full graph, but every
`ros2 topic echo` was silent; robot-side `ros2 topic info -v` showed
`Subscription count: 0` for laptop readers; tcpdump on the robot showed zero outgoing
RTPS data during echoes.

**Red herrings eliminated along the way:**
- "NUwave blocks unsolicited inbound UDP" — disproved with a numbered UDP beacon
  robot→laptop:20000 (packets arrived) and laptop→robot:11811 captures.
- Laptop multi-interface DDS locators — laptop has a single interface.
- Laptop ufw — inbound worked with no firewall change.

**Actual root cause:** the FastDDS discovery server on the robot (port 11811) had a
**corrupted discovery database** (likely contributors: long uptime, large NTP clock
steps from the no-RTC boot behavior, and several network changes — exact trigger not
pinned down). Its journal was full of:
```
[DISCOVERY_DATABASE Error] Matching unexisting participant from writer/reader ...
```
It received the laptop's endpoint announcements (confirmed by tcpdump) but failed to
relay them, so robot writers never matched laptop readers → no data was ever sent.

**Fix:**
```bash
sudo systemctl restart discovery && sleep 3 && sudo systemctl restart turtlebot4
```
(~60 s of ROS downtime; the Create 3 re-registers on its own. If base topics stay
silent, re-trigger its app: `curl -X POST http://192.168.186.2/api/restart-app`.)

## Problem 4 — Stale IPs from the previous network (192.168.50.x)

Three leftovers from the old lab network broke or degraded things:

1. **Create 3 discovery server address** was `192.168.50.31:11811` (unreachable) →
   all base topics silent. Fixed via the base's web config
   (`http://192.168.186.2/ros-config`) to `192.168.186.3:11811` + app restart.
2. **Pi's `ROS_DISCOVERY_SERVER`** in `/etc/turtlebot4/setup.bash` listed the same
   stale server → now `"127.0.0.1:11811;"` only.
3. **Chrony preferred NTP server** `192.168.50.146 prefer` in `/etc/chrony/chrony.conf`
   → replaced with `pool pool.ntp.org iburst maxsources 3` (verified NTP/UDP-123 works
   over NUwave; `ntp.ubuntu.com` kept as backup).

**Lesson:** after changing networks, grep configs for the old subnet:
`grep -r "192.168.50" /etc/`

## Laptop ROS 2 environment (the one that works)

```bash
source /opt/ros/humble/setup.bash
export RMW_IMPLEMENTATION=rmw_fastrtps_cpp
export ROS_DOMAIN_ID=0
export ROS_DISCOVERY_SERVER="10.247.204.21:11811"   # robot's current IP
export ROS_SUPER_CLIENT=True
unset FASTRTPS_DEFAULT_PROFILES_FILE
```

Gotchas:
- The **XML super-client profile silently fails to apply** on Humble in our setup —
  use the `ROS_SUPER_CLIENT=True` env var.
- On the robot, `/etc/turtlebot4/setup.bash` force-sets `ROS_SUPER_CLIENT` based on a
  TTY check — in scripts, export it **after** sourcing.
- Discovery takes ~10 s after `ros2 daemon stop`; keep one daemon running with the env
  above. `ros2 topic hz` requires the daemon (`--no-daemon` is not supported for it).

## What works / what doesn't

| Capability | Status | Measured |
|---|---|---|
| Robot on NUwave (802.1X, cert-validated) | ✅ | 82–85 % signal, 5 GHz |
| SSH laptop↔robot over NUwave | ✅ | no client isolation between segments |
| Internet from robot | ✅ | ~8 ms to 8.8.8.8 |
| NTP over NUwave (UDP 123) | ✅ | pool.ntp.org synced, ~1 µs offset |
| ROS 2 topic discovery over NUwave | ✅ | full /turtlebot468/* graph |
| ROS 2 subscribe over NUwave | ✅ | odom ~17.8 Hz, lidar scan ~7.6 Hz (rate-measured); battery verified via echo (16.45 V telemetry; 1 Hz nominal, rate not measured) |
| ROS 2 publish laptop→robot | ✅ | cmd_audio beep confirmed |
| ROS 2 services/params over NUwave | ✅ | param get round-trip |
| Multicast DDS discovery | ❌ by design | segments are routed; Discovery Server (unicast) is required — already configured |
| Create 3 on WiFi | ❌ by design | no 802.1X support; stays on wired usb0 (unaffected by NUwave) |
| Camera image_raw over WiFi | ⚠️ untested | can saturate WiFi; prefer compressed topics |
| OAK-D camera | ⚠️ hardware issue | X_LINK_ERROR communication failures — unrelated to networking |

## Known platform quirks

- **No RTC on the Pi:** it boots with a stale clock (months old) until chrony steps it
  once WiFi connects. Services that start before the step see a huge time jump —
  suspect this in any "worked yesterday" weirdness; check `chronyc tracking`.
- **Time chain:** internet NTP → Pi (chrony) → Create 3 (`allow 192.168.186.0/24`).
- **Robot IP is DHCP** — if `10.247.204.21` stops answering, read the current IP off
  the robot's display, and update `ROS_DISCOVERY_SERVER` on the laptop.
- Discovery server health check:
  `sudo journalctl -u discovery | grep -c "DISCOVERY_DATABASE Error"` — non-zero and
  growing means restart it (Problem 3).
