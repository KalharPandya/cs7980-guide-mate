# What AWS IoT Core Is — Building Blocks

A managed cloud service that lets **devices** (our TurtleBots) and the **cloud** exchange
messages securely, mostly over **MQTT** (a lightweight publish/subscribe protocol). It is a
secure message broker plus a set of features layered on top.

## Core building blocks

### 1. Things & the Registry
A "Thing" is the cloud's record of a device — e.g. `Turtlebot-468`. The registry stores
metadata, attributes, and group membership. It is bookkeeping only; it does not move data.

### 2. Certificates + Policies (security)
- Each device authenticates with an **X.509 certificate** (cert + private key) instead of a
  password.
- The **root CA** lets the device verify it is really talking to AWS (TLS).
- An **IoT policy** says *what that certificate may do* — which topics it can publish to /
  subscribe to, whether it may connect. Our policy is the narrow quick-start scope: it
  allows only `sdk/test/{python,java,js}` topics and a few client IDs. Anything else (tunnel
  notify topics, shadows, custom telemetry topics) would require widening the policy.

### 3. MQTT message broker (publish / subscribe)
Devices **publish** messages to **topics** (e.g. `turtlebot468/telemetry`) and **subscribe**
to topics to receive them. The broker routes between publishers and subscribers — they never
connect directly. Each AWS account has its own broker endpoint (the **ATS endpoint**,
`<your-ats-endpoint>` of the form `xxxx-ats.iot.<region>.amazonaws.com`).

**QoS** (quality of service) levels: `0` = at most once (fire-and-forget), `1` = at least
once (may duplicate). IoT Core does not support QoS 2.

## Features built on top of the broker

### 4. Device Shadows
A JSON document holding a device's **desired** vs **reported** state. The cloud sets
"desired", the device reconciles when it next connects. Good for state you want to set even
while the device is offline.

### 5. Rules Engine
SQL-like rules that react to messages and forward them to other AWS services. This is the
main integration path — see [service-integration.md](service-integration.md).

### 6. Secure Tunneling
Reach a device behind a firewall/NAT **without opening inbound ports** (e.g. SSH into a robot
on the lab network). Separate from the MQTT broker. See
[secure-tunneling.md](secure-tunneling.md).

### 7. Jobs
Remote operations dispatched to fleets — firmware updates, config changes, "run this
command" — with rollout/success tracking across many devices.

### 8. Fleet Provisioning
Automates onboarding many devices at scale (cert generation, registration). Relevant if the
fleet grows beyond the two lab robots.

### 9. Greengrass
Runs IoT logic **on the device itself** (edge compute) for local processing when cloud
connectivity is poor. Potentially relevant for a robot, where navigation must not depend on
cloud latency.

## How our files map to these concepts
| File on the Pi (gitignored) | IoT Core concept |
|---|---|
| `Turtlebot-468.cert.pem` / `.private.key` | Device identity (X.509 cert) |
| `root-CA.crt` | Verifies AWS's identity (TLS) |
| `Turtlebot-468-Policy` | What the device is allowed to do |
| `aws-iot-device-sdk-python-v2/` | Client library to speak MQTT |
| `start.sh` | Runs the pub/sub MQTT sample (`sdk/test/python`) |
| `*AccessToken.txt` | Secure Tunneling source/destination tokens |

## Mental model
IoT Core itself is mostly the **MQTT broker + security layer**. It does not store or analyze
data on its own — the **Rules Engine routes** messages outward and **Lambda is the glue**.
Device↔broker auth uses **X.509 certs + IoT policy**; AWS-internal compute (Lambda, EC2)
uses **IAM** instead.
