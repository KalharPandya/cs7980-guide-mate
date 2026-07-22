# Design Doc v2 — LLM Safety Guardrail (Work Package C) and Threat-Model Update

- **Owner:** han.faz@northeastern.edu
- **Date:** 2026-07-03
- **Course / Project:** CS7980 — Voice-LLM-driven wayfinding robot
- **Scope:** robot-interaction security · LLM prompt-injection defense (WP C), plus refreshing the whole-system threat model's attack surfaces in step with the landed architecture
- **LLM platform:** Claude **Sonnet 4.6** on **Amazon Bedrock** (`anthropic.claude-sonnet-4-6`) — fixed by course constraint
- **Supersedes:** [`Fazheng-LLM-guardrail-design-2026-06-13`](guardrail-design-2026-06-13.md) (v1). v1 assumed "a bystander speaks to the robot"; this version, following the landed architecture, switches to "phone web-app text chat + dispatching two TurtleBots".

> **Landed architecture (this version is updated against it)**
> A web app opened in the phone browser, containing a chatbot-style agent; the user chats with the agent at the **campus front desk** to settle on a navigation destination; the agent then **dispatches one of two ROS2 TurtleBots** to walk the user from the front desk to the target waypoint.

> **Summary of changes vs v1**
> 1. **Input channel:** from "robot microphone + ASR speech" to "chat text from the user's phone web app". Voice injection (DolphinAttack / LightCommands) fades out of the main line; **the web app + dispatch API becomes the new front-door attack surface**.
> 2. **Physical consequences escalate:** the robot **walks with a real person**; an unsafe path = leading a person toward stairs / a keep-out zone, not just the robot itself falling. C's safety invariant carries more weight.
> 3. **New attack surfaces:** two TurtleBots + the dispatch layer introduce **availability / DoS**, **mis-dispatch / mid-route hijack**, and **robot-user binding** issues that none of v1's A/B/C covered (see Section 4).
> 4. **The broker becomes concrete:** the broker is the web-app backend, hosting agent orchestration, the L3 deterministic policy, and privacy redaction.

---

## Safety invariant

No matter what happens upstream (a malicious user injecting via chat, a jailbroken LLM, a MITM'd broker, or the LLM hallucinating a dangerous path for a legitimate request), **the robot never leads a person into a keep-out zone or toward a ledge**. The invariant is enforced by deterministic layers **outside** the LLM, and is stated over **outcomes**, not **causes** (it also covers "legitimate request + LLM-hallucinated unsafe path").

> Added in this version (threat-model level, owned mostly by WP A/B): the robot **must not be dispatched to the wrong person, must not be hijacked and re-routed mid-route, and must not be made unavailable to real users by forged requests**. This is **dispatch integrity and availability** (Section 4) — not directly enforced by C's guardrail, but explicitly folded into the threat model under the new architecture.

## Core principles (carried over from v1)

- **Don't make the LLM safe — make the system around it safe.** The LLM's output is **untrusted**, the same trust class as the user's chat text. The real guardrail is the deterministic (non-LLM) validation layer, **not** the system prompt.
- Corollary: a *system-prompt-only* defense is our deliberate **negative baseline** — RoboPAIR / BadRobot-style jailbreaks should beat it; the real defense lives downstream and is deterministic.

## System architecture (landed)

```
  user phone (web app, UNTRUSTED chat text)
        |  HTTPS
        v
  web-app backend  ==  the broker  (agent orchestration)
        |  L1  input isolation: chat messages are data, not instructions
        v
  Claude on Bedrock (UNTRUSTED output)
        |  L2  enum-constrained destination_id (strict tool use, forced tool_choice)
        v
  broker -- L3  allowlist re-check + path keep-out geometry     <-- validated map (TRUSTED)
        |
        |  dispatch: assign one of the 2 TurtleBots (integrity + availability -> see Section 4)
        v
  planner --> controller --> /cmd_vel   (per robot)
        |
        v
  L4  local sensor-grounded safety monitor   <-- cliff / lidar (TRUSTED), doubles as WiFi-loss fail-safe
        |
        v
  TurtleBot walks with a real person
```

- The entire chain crosses **campus WiFi**: phone ↔ web-app backend ↔ Bedrock ↔ TurtleBot. **The WiFi boundary remains the master attack surface** (the original thesis running through A/B/C is unchanged).

## Trust model (updated)

- **Untrusted:**
  - the **chat text** the user types into the web app (the new main entry point, replacing v1's ASR speech);
  - **the web-app client itself** (it runs on a phone the user controls, not us; requests can be forged / tampered with);
  - **dispatch requests** arriving at the broker (who is asking, and for what, is trusted only after authentication);
  - **the LLM's own output**;
  - environmental text / signs (OCR'd text if the camera is in scope — still untrusted).
- **Trusted:** the validated waypoint graph + keep-out map; the deterministic policy code; the robot's local sensors (cliff / lidar).
- The guardrail mediates *untrusted chat / LLM output -> trusted actuation*, adjudicating with *trusted* reference data.

## Attack-surface map (the focus of this version, annotated with WP ownership)

| Attack surface | Description | Owner |
|---|---|---|
| **Front door: web app + auth / session + chat->dispatch path** | Uncontrolled client on the user's phone; the entry point for chat and dispatch commands | **New (cross-cutting, extends A/B)** |
| ROS2 / DDS (LAN side) | `/cmd_vel` injection, topic sniffing, dispatch-command integrity | WP A |
| Cloud channel + device (egress side) | ASR/LLM MITM, broker, on-device API key | WP B |
| Prompt injection | Coaxing the agent, via web chat text, into emitting a dangerous / out-of-privilege destination | WP C |
| **Multi-robot dispatch** | DoS tying up both robots, mis-dispatch, mid-route hijack, robot-user binding | **New (extends A/B, see Section 4)** |
| Privacy | Sensitive destinations, chat logs, travel routes observable by bystanders | Cross-cutting |

## Defense in depth L1–L5 (updated)

- **L1 · Input isolation** — *broker, at prompt assembly.* Trusted constraints go in the `system` channel; **the user's chat messages go in a delimited user turn as untrusted data** (v1 had ASR text here; the semantics are identical, only the source changes to web chat). Camera in scope -> OCR'd sign text joins the same untrusted bucket.
- **L2 · Output shape constraint** — *Bedrock API call.* The LLM may only emit one `destination_id` from a **closed enum generated from the validated map** (strict tool use + forced `tool_choice`). It physically cannot name an off-map destination. **Constrains shape, not intent**; the enum holds only *safe* destinations, and path safety goes to L3. A safety refusal (`stop_reason: "refusal"`) -> no destination -> fail-closed.
- **L3 · Deterministic policy (the real guardrail)** — *broker, non-LLM code.* (1) re-check `destination_id ∈ allowlist`; (2) validate that the planned path does not cross keep-out geometry. A jailbroken LLM still cannot pass this layer (it doesn't parse natural language). ~sub-ms.
- **L4 · Local safety monitor (last line + fail-safe)** — *robot (Pi), sensor-grounded, independent of cloud and broker.* Overrides any `/cmd_vel` heading into a keep-out zone or off a ledge. Doubles as the **WiFi-loss fail-safe**: cloud / broker unreachable -> stop, never coast on stale commands. The LLM never touches `/cmd_vel` directly (LLM -> semantic destination -> trusted planner -> controller), which also shrinks WP A's `/cmd_vel` attack surface.
- **L5 · (optional) LLM-as-judge** — *second Bedrock call.* Defense-in-depth, but itself jailbreakable -> treated as an **experimental control**, never the primary gate.

> L2–L5 are essentially unchanged from v1, because they were never tied to the input channel in the first place; this version's changes concentrate in **L1's input source (web chat)** and the **dispatch layer** in Section 4 below.

## 4. Multi-robot dispatch: integrity and availability (new in this version)

In the new architecture the agent, on the broker, "dispatches one of two TurtleBots" — introducing two threat classes v1 did not cover:

- **Integrity**
  - *Mis-dispatch / mid-route hijack*: can an attacker get a robot dispatched to the wrong person, or change the destination mid-route to lead a real person somewhere else.
  - *Robot-user binding*: the destination produced by a session must be bound to the authenticated user who initiated that session; dispatch tokens must not be replayable / forgeable.
  - Defense: dispatch commands must be **issued by the broker as session-bound, single-use tokens**, and the robot side accepts only authenticated dispatches originating from the broker (sharing mechanisms with WP A's SROS2 / DDS-Security command integrity and WP B's broker trust boundary). **Crucially: even if the destination is rewritten mid-route, it still has to pass L3 / L4**, so the physical safety invariant does not depend on the integrity of the dispatch channel (this is the value of defense in depth).
- **Availability**
  - *DoS*: forged requests tie up the only two robots, so real users cannot get one.
  - Defense: front-door authentication + per-user rate limiting + a dispatch queue with timeout reclamation; treat "both robots busy" as a known state requiring **graceful degradation** (the front desk shows a queue prompt rather than failing silently).
  - Link to the project thesis: this ties C back to "WiFi is the master attack surface" — jamming / DoS'ing the cloud / dispatch loop triggers the L4 fail-safe, which can serve as a measurable experiment.

> Note: dispatch integrity / availability is **owned mostly by WP A (ROS2 command integrity) and WP B (broker / web authentication)**; this version registers it explicitly in the threat model and explains how the guardrail (L3 / L4) still catches physical safety even when dispatch is compromised.

## Privacy (refined for the new architecture)

- Destinations are themselves sensitive ("take me to the counseling office / HR / the dean's office" reveals a visitor's identity and intent): on the broker, apply **minimal retention + destination redaction** to chat logs.
- Routes can be observed: the robot's travel route leaks the destination to bystanders; folded into the privacy discussion (mitigations are limited — registered for now).

## Measurement plan (WP C deliverable: attack success rate + defense overhead on Pi)

| Configuration | Attack success rate | Overhead (Pi-class) |
| --- | --- | --- |
| system-prompt only (baseline) | high (jailbroken) | ~0 |
| + L2 enum output | medium (blocks off-map, not unsafe-valid) | ~0 after schema cache |
| + L3 deterministic path check | -> 0 | sub-ms |
| + L5 LLM-judge | marginal down | ~2x LLM latency / cost |

- **Expected headline (carried over from v1):** the cheapest layer (L3, sub-ms) defeats most injections that bypass the prompt; the most expensive, L5, adds little — evidence for *"lightweight deterministic guardrails > heavyweight LLM guardrails"* on constrained hardware (this project's novel angle).
- **New in this version (qualitative / semi-quantitative):**
  - **Dispatch integrity:** interception rate for forged / replayed dispatch tokens (should be -> 0 getting through).
  - **Availability:** in the DoS scenario with both robots tied up, the degradation behavior and recovery time of the front-door rate limiting + queue.
  - **L4 measured separately:** WiFi-loss -> fail-safe trigger time and stopping distance (when the cloud loop is jammed / DoS'd), tying C back to the WiFi master-attack-surface thesis.

## Decisions / dependencies (updated)

- **Web-app authentication scheme** (the key new open decision in this version): how front-desk users authenticate (one-time QR code / front-desk staff initiates / campus SSO?) — determines the strength of the mis-dispatch and DoS defenses.
- **Camera in scope?** Decides whether L1 must also cover OCR'd sign injection.
- **Where each layer runs:** L3 on broker (the web backend), L4 on robot — recommendation carried over.
- **Trust mechanism for dispatch commands:** the concrete form of SROS2 / DDS-Security + broker-issued single-use tokens (shared across A/B/C).
- **Bedrock vs Claude Platform on AWS:** confirm which AWS path the team provisions.
- **Pinned, reproducible robot build (both TurtleBots):** the measurement target for all WPs.

---

## Backup — refs

OWASP LLM Top-10 (LLM01 prompt injection); RoboPAIR / BadRobot (jailbreaking LLM-controlled
robots); runtime safety-monitor / safety-kernel pattern (safety-critical robotics);
SROS2 / DDS-Security (dispatch-command integrity).
