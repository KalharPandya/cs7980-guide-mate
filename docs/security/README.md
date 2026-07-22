# Security workstream (WP A/B/C)

Design docs for the security/privacy workstream (owner: Fazheng Han,
han.faz@northeastern.edu): **WP A** ROS2/DDS LAN side, **WP B** cloud channel + broker,
**WP C** LLM safety guardrails. The runnable WP C artifact is the guardrail live demo at
[`../../security_demo/`](../../security_demo/README.md).

## Index

- [Guardrail design v2 + threat-model update (2026-07-03)](guardrail-design-2026-07-03.md) —
  **current.** LLM safety guardrail (WP C) redesigned for the landed architecture
  (phone web-app text chat dispatching two TurtleBots), plus the refreshed whole-system
  attack surface. Supersedes v1.
- [Guardrail design v1 (2026-06-13)](guardrail-design-2026-06-13.md) — original design
  note: threat model, prompt-injection defense layers L1–L5, Bedrock/Sonnet 4.6
  constraints. Kept for history; assumed the old "bystander speaks to the robot" voice
  interaction.
- [Demo design spec (2026-06-18)](demo-design-spec-2026-06-18.md) — spec for the first
  (single-file HTML) guardrail demo. The demo itself was replaced by
  [`security_demo/`](../../security_demo/README.md) in July 2026 (design docs in
  [`security_demo/docs/`](../../security_demo/docs/)); the scenario/attack script
  defined here carried over.
