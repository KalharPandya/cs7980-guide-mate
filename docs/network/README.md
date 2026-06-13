# Network Overview

This section documents the network setup for the cs7980 TurtleBot 4 robots.

## Documents
- [Connecting a TurtleBot 4 to NUwave](nuwave-connection.md)
- [ROS 2 over NUwave — what works and what doesn't](ros2-over-nuwave.md)

## The two-computer architecture
A TurtleBot 4 is **two networked computers**:

| Component | Role | WiFi capability |
|---|---|---|
| **Raspberry Pi 4** | Runs Ubuntu 22.04 + ROS 2 Humble. The host you SSH into. | 2.4 + 5 GHz (dual-band) |
| **iRobot Create 3 base** | Mobility base (wheels, IMU, bumpers, docking). | 2.4 GHz only, **WPA2-Personal only** |

They are joined by the **USB-C cable**, which carries both power and a **wired Ethernet link** on the `192.168.186.0/24` subnet (Pi = `.3`, Create 3 = `.2`).

### Why the Create 3 never joins NUwave
The Create 3's firmware does **not** support WPA2-Enterprise (802.1X / PEAP) — it can only join a network with a single shared password. NUwave is enterprise, so the Create 3 **cannot** join it. This is fine because the robots use **Discovery Server** mode: the Create 3 keeps WiFi disabled and routes everything through the Pi over the USB-C link. Only the **Pi** connects to NUwave.

## Discovery model: FastDDS Discovery Server
ROS 2's default discovery is **multicast**, which is link-local and **will not cross IP subnets**. On NUwave the Pi and a laptop typically land on **different `/19` segments**, so multicast discovery is a non-starter.

The robots instead run a **FastDDS Discovery Server** on the Pi (`fast-discovery-server -i 0 -p 11811`, listening on `0.0.0.0:11811`). This uses **unicast**, which routes across subnets. Clients (the Pi's own ROS nodes, and any laptop) point at the server via `ROS_DISCOVERY_SERVER`.

Relevant environment on the Pi (`/etc/turtlebot4/setup.bash`):
```
ROS_DOMAIN_ID=0
RMW_IMPLEMENTATION=rmw_fastrtps_cpp
ROS_LOCALHOST_ONLY=0
ROS_DISCOVERY_SERVER=127.0.0.1:11811;
FASTRTPS_DEFAULT_PROFILES_FILE=/etc/turtlebot4/fastdds_rpi.xml
```
> **Cleaned up 2026-06-12:** stale `192.168.50.x` entries from a previous network were
> removed from three places on robot 468: the Pi's `ROS_DISCOVERY_SERVER`
> (`192.168.50.31:11811`), the **Create 3's own discovery-server address** (same stale
> IP — this one was *not* harmless: it silenced every base topic; see
> [ros2-over-nuwave.md](ros2-over-nuwave.md)), and chrony's preferred NTP server
> (`192.168.50.146` → `pool.ntp.org`, verified working over NUwave). After any future
> network change, check for relics: `grep -r "192.168.50" /etc/`
> Robot **436 has not been migrated or cleaned up yet** — same steps apply.

## Time sync
Chain: internet NTP (`pool.ntp.org`, with `ntp.ubuntu.com` backup) → Pi (chrony) →
Create 3 (chrony serves `192.168.186.0/24`). **Gotcha:** the Pi has **no RTC** — it
boots with a stale clock (whatever it was at last shutdown) until chrony steps it once
WiFi connects. Services started before the step see a huge time jump; check
`chronyc tracking` when debugging anything time-related.

## Addressing summary (as configured June 2026)
| Host | NUwave IP (example) | Notes |
|---|---|---|
| `turtlebot468` Pi | `10.247.204.21/19` | DHCP — will change |
| Create 3 (468) | `192.168.186.2` | wired-only, via Pi |
| Lab laptop | `10.247.228.155/19` | different `/19` than the Pi |

> NUwave IPs are DHCP and **change** on reconnect. The robot shows its current IP on its display. On the lab `ASUS_98` network the Pis were previously `10.91.221.14` (468) and `10.91.221.95` (436).
