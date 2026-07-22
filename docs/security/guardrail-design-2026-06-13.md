# Design Note — LLM Safety Guardrail (Work Package C)

- **Owner:** han.faz@northeastern.edu
- **Date:** 2026-06-13
- **Course / Project:** CS7980 — Voice-LLM-driven wayfinding robot
- **Scope:** robot-interaction security · LLM prompt-injection defense (Work Package C)
- **LLM platform:** Claude **Sonnet 4.6** on **Amazon Bedrock** (`anthropic.claude-sonnet-4-6`) — fixed by course constraint

> **Design goal (safety invariant).** No matter what happens upstream — a malicious
> bystander, a malicious sign, a jailbroken LLM, or a MITM'd broker — the robot never
> drives into a keep-out zone or off a ledge. The guardrail enforces this *outside* the LLM.

---

## Core principle

- **Don't make the LLM safe — make the system around it safe.** The LLM's output is
  **untrusted**, the same trust class as the bystander's voice. The guardrail is the
  deterministic (non-LLM) validation layer, **not** the system prompt.
- Corollary: a *system-prompt-only* defense is our deliberate **negative baseline** —
  RoboPAIR / BadRobot-style jailbreaks should beat it. The real defense lives downstream
  and is deterministic.
- The invariant is stated over *outcomes*, not *causes*: it also covers the LLM
  hallucinating an unsafe path for a perfectly legitimate request.

## Trust model

- **Untrusted:** bystander speech (ASR text); environmental text / signs (if camera is in
  scope); **the LLM's own output**.
- **Trusted:** the validated waypoint graph + keep-out map; the deterministic policy code;
  local sensor readings (cliff / lidar).
- The guardrail mediates *untrusted LLM output → trusted actuation*, using *trusted* reference data.

## Architecture — defense in depth

```
  bystander voice (UNTRUSTED) --ASR--> Claude on Bedrock (UNTRUSTED output)
        |
        |  L1  input isolation: speech is data, not instructions
        v
  [L2]  enum-constrained destination_id      (strict tool use, forced tool_choice)
        |
        v
  broker -- [L3] allowlist re-check + path keep-out geometry      <-- validated map (TRUSTED)
        |
        v
  planner --> controller --> /cmd_vel
        |
        v
  [L4]  local sensor-grounded safety monitor                      <-- cliff / lidar (TRUSTED)
        |
        v
  motors
```

- **L1 · Input isolation** — *broker, at prompt assembly.* Trusted constraints go in the
  `system` channel; the bystander utterance goes in a delimited user turn as untrusted data.
  (Camera in scope → OCR'd "malicious sign" text joins the untrusted bucket here.)
- **L2 · Output shape constraint** — *Bedrock API call.* The LLM may only emit one
  `destination_id` from a **closed enum** generated from the validated map (strict tool use +
  forced `tool_choice`). It physically cannot name an off-map destination. **Constrains
  shape, not intent** — the enum holds only *safe* destinations; path safety is L3. A safety
  refusal (`stop_reason: "refusal"`) yields no destination → fail-closed.
- **L3 · Deterministic policy — the real guardrail** — *broker, non-LLM code.*
  (1) re-check `destination_id ∈ allowlist`; (2) validate the planned path against keep-out
  geometry. A jailbroken LLM still cannot pass this — it doesn't parse natural language. ~sub-ms.
- **L4 · Local safety monitor — last line + fail-safe** — *robot (Pi), sensor-grounded,
  independent of cloud and broker.* Overrides any `/cmd_vel` heading into a keep-out zone or
  off a cliff. Doubles as the **WiFi-loss fail-safe**: cloud ASR/LLM unreachable → stop, never
  coast on stale commands. Note the LLM never touches raw `/cmd_vel`
  (LLM → semantic destination → trusted planner → controller), which also shrinks the WP A
  `/cmd_vel` attack surface.
- **L5 · (optional) LLM-as-judge** — *second Bedrock call.* Defense-in-depth, but itself
  jailbreakable → treated as an **experimental control**, never the primary gate.

## Why Sonnet 4.6 on Bedrock fits

- **Model is fixed to Sonnet 4.6 (course constraint) — and the design doesn't care.** The
  guardrail's strength is **model-independent by design**: the real defense (L3/L4) is
  downstream and deterministic, so it never depends on Sonnet's own safety training. Since we
  can't swap in a more jailbreak-resistant model, that property is the whole point.
- The one provider-specific lever — **L2 enum-constrained output** (structured outputs / strict
  tool use) — **is supported on Claude Sonnet 4.6** and available on Amazon Bedrock
  (`output_config.format`); the Messages API shape is identical to first-party.
- Bedrock does **not** offer Anthropic server-side tools or Managed Agents — but this design
  needs none of them. L3/L4/L5 are all our own code, so **we own the entire trust boundary**.
- AWS distinction to confirm: **Amazon Bedrock** (partner-operated, `anthropic.`-prefixed IDs —
  assumed here) vs **Claude Platform on AWS** (Anthropic-operated, bare IDs). Either runs the
  guardrail; only server-side-feature availability differs, not the core.

## Measurement plan (WP C deliverable: attack success rate + defense overhead on Pi)

| Configuration                     | Attack success rate              | Overhead (Pi-class)        |
| --------------------------------- | -------------------------------- | -------------------------- |
| system-prompt only (baseline)     | high — jailbroken                | ~0                         |
| + L2 enum output                  | medium — blocks off-map, not unsafe-valid | ~0 after schema cache |
| + L3 deterministic path check     | → 0                              | sub-ms                     |
| + L5 LLM-judge                    | marginal ↓                       | ~2× LLM latency / cost     |

- **Expected headline:** the cheapest layer (L3, sub-ms) defeats most injections that bypass
  the prompt; the most expensive (L5) adds little — evidence for *"lightweight deterministic
  guardrails > heavyweight LLM guardrails"* on constrained hardware (our novel angle).
- **L4 measured separately** as a WiFi-loss → fail-safe experiment: trigger time and stopping
  distance when the cloud loop is jammed/DoS'd (ties C back to the WiFi master-attack-surface thesis).

## Decisions / dependencies needed

- **Camera in scope?** Decides whether L1 must also cover OCR'd "malicious sign" injection
  (extra untrusted input + extra demo).
- **Where the guardrail runs.** Recommended: **L3 on broker** (anti-jailbreak), **L4 on robot**
  (independent of cloud/broker). Needs buy-in — touches WP A/B integrity.
- **Bedrock vs Claude Platform on AWS** — confirm which AWS path the team provisions.
- **Pinned, reproducible robot build** to measure against (shared dependency across all WPs).

---

## Backup — refs

OWASP LLM Top-10 (LLM01 prompt injection); RoboPAIR / BadRobot (jailbreaking LLM-controlled
robots); runtime safety-monitor / safety-kernel pattern from safety-critical robotics.
