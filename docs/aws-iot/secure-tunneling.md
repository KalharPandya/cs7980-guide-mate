# AWS IoT Secure Tunneling — Remote SSH to a Robot

Reach a robot that sits behind the lab firewall/NAT **without opening any inbound port** —
e.g. SSH into the Pi from home. This is separate from the MQTT broker; it uses a small
program called **`localproxy`** plus a pair of access tokens.

## TL;DR
- A tunnel has **two ends**: a **destination** (the robot) and a **source** (your laptop or
  an EC2 host). Each gets its own single-use **access token**.
- You need the **`localproxy`** binary on **both** ends. The Python device SDK / the
  "connect a device" package **cannot** do tunneling.
- **Status for us:** tunnel opened and both tokens downloaded, but `localproxy` is **not
  installed**, so the tunnel is not yet usable.

## The two ends
| End | Runs where | Token | `localproxy` mode |
|---|---|---|---|
| **destination** | on the **robot Pi** (the thing being reached) | destination token | `-d localhost:22` |
| **source** | on your **laptop / EC2** (where you initiate) | source token | `-s <local-port>` |

The destination forwards inbound tunnel traffic to a local service on the robot (usually
**SSH :22**). The source opens a local port that tunnels to it; you then SSH to that local
port and land on the robot.

## Install `localproxy`
Not bundled with the device SDK. Build from source
(<https://github.com/aws-samples/aws-iot-securetunneling-localproxy>) or use the Docker image,
on **both** ends. On the Pi (ARM64, Ubuntu 22.04) build from source:

```bash
sudo apt update && sudo apt install -y build-essential cmake \
  libboost-all-dev libssl-dev libprotobuf-dev protobuf-compiler zlib1g-dev catch2
cd ~ && git clone https://github.com/aws-samples/aws-iot-securetunneling-localproxy.git
cd aws-iot-securetunneling-localproxy && mkdir build && cd build
cmake .. && make -j2
# binary: ~/aws-iot-securetunneling-localproxy/build/bin/localproxy
```

## Connect — destination side (on the robot Pi)
```bash
export AWSIOT_TUNNEL_ACCESS_TOKEN="$(cat <destination-token-file>)"
localproxy -t "$AWSIOT_TUNNEL_ACCESS_TOKEN" -r <region> -d localhost:22
```

## Connect — source side (on your laptop / EC2)
```bash
export AWSIOT_TUNNEL_ACCESS_TOKEN="$(cat <source-token-file>)"
localproxy -t "$AWSIOT_TUNNEL_ACCESS_TOKEN" -r <region> -s 5555
ssh ubuntu@localhost -p 5555     # lands on the robot
```

`<region>` **must** match the region the tunnel was created in, or the connection is refused.
The tunnel data endpoint defaults to `data.tunneling.iot.<region>.amazonaws.com:443`.

## The MQTT auto-delivery path (optional, "production" style)
When a tunnel is opened with a **destination thing name**, AWS publishes the destination
token to the reserved MQTT topic `$aws/things/<thing>/tunnels/notify`. If the robot runs an
agent subscribed to that topic (e.g. the **AWS IoT Device Client**, or a small listener using
the device SDK), the destination side connects **automatically** — you never paste the
destination token, only run the source side.

**Two prerequisites we do not yet meet:**
1. The robot's **IoT policy** must allow `iot:Subscribe` / `iot:Receive` on
   `$aws/things/<thing>/tunnels/notify` (our quick-start policy only allows `sdk/test/*`).
2. `localproxy` must still be installed — the agent only fetches the token and *launches* it.

Since we already downloaded the destination token to the Pi, the manual `-d` command above is
the simplest way to connect; the MQTT path mainly matters for unattended fleets.

## Gotchas
- **Tokens are single-use.** A failed connect attempt burns them — **rotate/resend** tokens
  from the console to get a fresh pair before retrying.
- **`localproxy` is the missing piece**, not the SDK. Tokens alone do nothing.
- **No inbound ports needed** — both ends dial *out* to AWS over 443; that is the whole point
  versus port-forwarding.

## Status (robot 468)
- ✅ Tunnel opened; source + destination tokens downloaded (gitignored).
- ✅ Region and thing identified (see Claude memory `aws-iot-setup`).
- ❌ `localproxy` not installed on the Pi or laptop → tunnel not usable end-to-end yet.
- ❌ IoT policy does not yet permit the tunnel notify topic (only needed for the auto-delivery
  path).
