# admission_demo — L0 admission control (rotating QR check-in)

Interactive web demo for the **admission-control layer ("L0")** of the security/privacy
workstream (owner: Fazheng Han, han.faz@northeastern.edu). It sits *in front of* the
L1–L5 guardrail pipeline shown in the guardrail demo (`security_demo/`).

**The one thesis:** presence is a credential. A rotating QR code on a kiosk screen turns
"I am physically standing here" into a short-lived, verifiable token — filtering the open
internet out of the robot's dispatch API before a single LLM token is spent.

## What it shows

A single screen with four panes, all driven by one real broker:

- **Kiosk** — a rotating QR (60 s window + 15 s grace) that encodes a real check-in URL.
- **Visitor phone (simulated)** — scan → anonymous 15-min session → pick a destination →
  dispatch. Includes a camera-roll slot to "photograph" the current code and replay it
  later (the killer scene: a photographed code expires).
- **Attacker terminal** — three scripted plays that fire **real** requests: direct API hit
  (no session), stale-code replay, and token relay by an on-site accomplice.
- **Broker event log + metrics** — every request with its verdict and measured µs cost.

The honest closer: L0 shrinks the attacker population from "the internet" to "people
physically on site." It does **not** replace L1–L5 — the token-relay play passes L0 and is
shown in amber, handing off to the guardrail pipeline. Same philosophy at both ends of the
pipe: cheap deterministic checks beat heavyweight trust.

## Run it

```bash
cd admission_demo
npm install
npm run dev        # → http://localhost:5173
```

**No credentials, no `.env`, no cloud.** L0 is pre-LLM and fully deterministic; the broker
is a Vite dev-server middleware (`src/server/broker.ts`) that mints HMAC-signed nonces and
sessions in memory. Simulated devices declare themselves via an `x-demo-source` header so
the event log can attribute requests — presentational only, not a security control.

```bash
npm run typecheck
npm run build
```

## What is real vs. simulated

- **Real:** nonce minting/rotation, HMAC verification, session issuance/expiry, per-session
  rate limiting (3 dispatches/min), the single-active-dispatch gate, all timings, and the
  QR image itself.
- **Simulated:** the phone and the attacker terminal are panes in one browser (several
  "devices" share one real browser, so the session rides an `Authorization` header instead
  of an HttpOnly cookie — noted in `docs/00-design.md` §4). The robot is a status card; the
  floor map and the L1–L5 pipeline are **not** re-implemented here — that story lives in
  `security_demo/`.

## Docs

- [`docs/00-design.md`](docs/00-design.md) — thesis, threat-model delta (what L0 does and,
  honestly, does not address), the token mechanism, architecture, and acceptance criteria.
- [`docs/01-demo-script.md`](docs/01-demo-script.md) — the ~4-minute presentation script
  and the full English UI copy inventory.

## Layout

```
admission_demo/
├── docs/                  # 00-design, 01-demo-script
├── src/
│   ├── components/        # KioskPane, PhonePane, AttackerPane, EventLog, Panel
│   ├── lib/               # API contract (types), fetch helper
│   ├── hooks/useNow.ts
│   └── server/            # broker.ts (HMAC nonces + sessions + rate/concurrency),
│                          #   brokerPlugin.ts (Vite middleware)
└── package.json           # React + Vite + Tailwind v4 + Motion + qrcode
```
