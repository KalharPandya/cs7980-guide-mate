# AWS IoT Core — Overview

How AWS IoT Core fits the cs7980 guide-robot project, and what we set up on robot **468**.

> ⚠️ **Security:** none of the device credentials live in this repo. The certificate,
> private key, root CA, IoT policy, tunnel access tokens, and the AWS "connect a device"
> package are **gitignored** (see the repo `.gitignore`). Docs below use placeholders such
> as `<account-id>`, `<your-ats-endpoint>`, and `<region>`. The real values for our setup
> are in Claude memory (`aws-iot-setup`), not here.

## TL;DR
- **IoT Core = a managed MQTT message broker + a device security layer**, plus features
  built on top (shadows, rules, jobs, secure tunneling).
- It does **not** store or analyze data itself — the **Rules Engine** routes messages out
  to other AWS services, and **Lambda** is the glue for custom logic.
- For the robots it is **robot ↔ cloud** plumbing. It does **not** replace the on-robot
  ROS 2 / FastDDS networking (that stays node-to-node; see [network docs](../network/README.md)).
- We have the quick-connect MQTT sample working and a **Secure Tunnel** opened, but
  `localproxy` is **not yet installed**, so the tunnel is not usable end-to-end yet.

## Documents
- [What IoT Core is — building blocks](iot-core-overview.md) — things, certs/policies, the MQTT broker, shadows, rules, jobs, Greengrass; and how our files map to each.
- [Talking to other AWS services + EC2 access](service-integration.md) — the Rules Engine, service-to-device, EventBridge, and the three ways EC2 can reach IoT Core.
- [Secure Tunneling — remote SSH to a robot](secure-tunneling.md) — source/destination tokens, `localproxy`, the MQTT auto-delivery path, and why it isn't connected yet.

## What we set up (robot 468)
| Piece | State |
|---|---|
| Thing in the registry | `Turtlebot-468` (region `<region>`) |
| Device cert + private key | downloaded to the Pi (gitignored) |
| IoT policy | quick-start scope — **only `sdk/test/*` topics**; no tunnel/shadow topics yet |
| MQTT pub/sub sample | runs via `start.sh` (publishes to `sdk/test/python`) |
| Secure Tunnel | opened; source + destination tokens downloaded (gitignored) |
| `localproxy` | **not installed** — required to actually use the tunnel |

## Where IoT Core could help the project
| Use case | Feature |
|---|---|
| SSH into a robot behind the lab firewall, no port-forwarding | **Secure Tunneling** |
| Push code/config to both 468 and 436 | **Jobs** |
| Stream battery/status telemetry to a dashboard or alert | **Rules Engine → SNS / DynamoDB / Timestream** |
| Send a command to a robot from a backend | **publish to an MQTT topic** (Lambda/EC2 via IAM) |

See the per-topic docs for detail.
