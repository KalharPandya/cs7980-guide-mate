# security_demo — WP C guardrail live demo

Interactive web demo for **Work Package C (LLM safety guardrails)** of the security/privacy
workstream (owner: Fazheng Han, han.faz@northeastern.edu). Shown in class 2026-07-08.

**The one thesis:** don't try to make the LLM safe — make the *system around it* safe.
A jailbreak can defeat the system prompt, but it cannot defeat a sub-millisecond
deterministic guardrail sitting between the model and the actuators.

## What it shows

A simulated robot-dispatch pipeline where an LLM turns a visitor request into a
navigation goal, wrapped in layered deterministic guardrails:

- **L1** input screening, **L2** strict tool schema (destination is a closed enum),
  **L3** path-geometry check (the planned path is tested against keep-out polygons,
  timing really measured — tens of microseconds), **L4** actuation-side visualization,
  **L5** optional LLM self-check.
- **Killer scene:** "balcony" *is* a valid enum destination, but its path crosses the
  stairwell keep-out polygon — L1/L2 pass it, only L3 blocks it. Attack success across
  configs: baseline 2/2 → +enum 1/2 → +L3 0/2.

Two modes, both load-bearing:

- **Live Bedrock** — real Claude Sonnet 4.6 via `InvokeModel` (strict tool use + forced
  `tool_choice`; also demonstrates real-model over-refusal on the baseline path).
- **Simulated worst-case** — offline, no credentials needed; models a *fully jailbroken*
  LLM so the defense-in-depth story doesn't depend on the live model misbehaving.

## Run it

```bash
cd security_demo
npm install
npm run dev        # → http://localhost:5173 — Simulated mode works with NO credentials
```

Live Bedrock mode needs credentials: copy `.env.example` to `.env` and fill it in
(bearer token for local dev, or SigV4 via the default AWS chain with `BEDROCK_AUTH=sigv4`).
Region must be `us-west-2`. **Never commit `.env`** (repo rule: no credentials).

The Bedrock call runs in a Vite server middleware (`src/server/brokerPlugin.ts`), so one
`npm run dev` serves frontend + broker and the token never enters the browser bundle.

Production build (self-contained node server, e.g. for an EC2 box using an instance role):

```bash
npm run deploy:build   # → dist/ (frontend) + dist-server/server.mjs (bundled server)
npm start              # serves dist/ + /api/dispatch on $PORT (default 80)
```

## Docs

Design docs live in [`docs/`](docs/) (`00-overview` … `04-screens-and-copy`); the full
user-visible UI copy is collected in `04-screens-and-copy.md` for review. The WP C design
history (threat model, guardrail architecture v1/v2) is in
[`../docs/security/`](../docs/security/README.md).

## Layout

```
security_demo/
├── docs/                  # design docs 00-04 (overview, demo script, design system,
│                          #   architecture, screens & copy)
├── src/
│   ├── components/        # React UI (floor map, pipeline trace, results table, ...)
│   ├── lib/               # scene data model, keep-out geometry, types
│   ├── hooks/useDispatch.ts
│   └── server/            # broker: brokerPlugin (dev) / prod-server (hosted),
│                          #   bedrock.ts (SigV4 + bearer), simulated.ts
├── .env.example           # Live-mode credentials template (never commit .env)
└── package.json           # React + Vite + Tailwind v4 + Motion
```
