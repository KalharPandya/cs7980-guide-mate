# IoT Core ↔ Other AWS Services (and EC2 Access)

How messages get from the MQTT broker into the rest of AWS, how services push back to
devices, and how an EC2 instance can talk to IoT Core.

## The Rules Engine (the primary path)
~90% of IoT-Core-to-AWS integration goes through rules. A rule has three parts:

**a) A SQL statement** selecting messages from topics:
```sql
SELECT temperature, battery FROM 'turtlebot468/telemetry' WHERE battery < 12
```
It runs on every matching message, can filter (`WHERE`) and reshape the payload.

**b) One or more Actions** — where the matched message goes:

| Action → Service | What it does |
|---|---|
| **Lambda** | Run arbitrary code (most flexible — can then call anything) |
| **DynamoDB** | Write the message to a NoSQL table |
| **S3** | Store the payload as an object |
| **SNS** | Send a notification (SMS / email / push) |
| **SQS** | Queue the message for a consumer |
| **Kinesis / Firehose** | Stream into analytics / a data lake |
| **CloudWatch** | Push a metric or alarm |
| **Timestream** | Write to a time-series database |
| **republish** | Send it to another MQTT topic |
| **Step Functions** | Start a workflow |

**c) An IAM role** the rule assumes to write to the target. This is the *rule's* permission,
separate from the *device's* IoT policy.

```
Device → MQTT topic → Rule (SQL filter) → Action → AWS service
```

## Lambda as the universal adapter
If no built-in action fits, route to **Lambda**; its code can call any AWS API or external
HTTP endpoint. The escape hatch for custom logic (transform, call a third-party API, write to
a relational DB).

## Service → device (the reverse direction)
Other services push *to* devices by **publishing to MQTT topics** via the IoT Data API
(`iot-data:Publish`) or by updating a **Device Shadow**. So a Lambda can command a robot by
publishing to e.g. `turtlebot468/cmd`.

## EventBridge (lifecycle / control-plane events)
IoT Core emits lifecycle events (device connected/disconnected, registry changes) to
**EventBridge**, which fans out to other services — e.g. "alert when turtlebot468 goes
offline."

## IoT-native consumers
- **IoT Analytics / IoT SiteWise** — managed telemetry pipelines/storage.
- **IoT Events** — detect patterns across messages and trigger.
- **Fleet Indexing** — makes the registry + shadows searchable.

```
                    ┌──→ Lambda ──→ (anything)
Device ──MQTT──→ IoT Core ──Rule──┼──→ DynamoDB / S3 / Timestream
                    │             ├──→ SNS / SQS / Kinesis
                    │             └──→ republish → another topic
                    └──lifecycle──→ EventBridge ──→ ...
```

---

## Accessing IoT Core from EC2
EC2 is a first-class IoT Core client, and because it runs **inside AWS** it has an easier
option than physical devices: **IAM authentication** (no cert files to manage).

### 1. As an MQTT client using IAM (SigV4) — the easy way for AWS compute
Give the instance an **IAM role** (instance profile), then:
- **Publish** with one call, no certs:
  ```bash
  aws iot-data publish --topic 'turtlebot468/cmd' \
    --payload '{"action":"dock"}' --region <region>
  ```
- Or connect over **MQTT-over-WebSocket** signed with the instance's IAM credentials.

The IAM role's permissions (`iot:Connect`, `iot:Publish`, `iot-data:*`, …) replace the
device cert + IoT policy.

### 2. As an MQTT client using X.509 certs — same as a device
You *can* copy the same cert/key onto EC2 and connect exactly like the robot does (the SDK
sample would run unchanged). Usually the wrong choice for EC2 — certs are for devices, IAM is
for AWS compute.

### 3. As a consumer of forwarded data
Often EC2 does not touch IoT Core directly: a rule pushes messages into **SQS / DynamoDB /
Kinesis**, and the EC2 app reads from there. This decouples the backend from the broker.

### Auth model — the key distinction
| Connecting from | Authenticates with |
|---|---|
| TurtleBot (device) | X.509 cert + IoT **policy** |
| EC2 / Lambda (AWS compute) | **IAM** role / credentials (SigV4) |

Both reach the same broker; they just prove identity differently.

### Two practical EC2 uses for this project
- **Secure Tunneling source end:** run `localproxy -s` on EC2 instead of a laptop, for a
  stable cloud host to SSH through to the robot (EC2 needs the source token, or
  `iot:OpenTunnel` to open tunnels itself). See [secure-tunneling.md](secure-tunneling.md).
- **Backend / dashboard:** EC2 publishes commands to the robots and ingests telemetry
  (directly via MQTT, or via SQS fed by a rule).
