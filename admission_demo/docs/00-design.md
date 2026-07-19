# Design — L0 Admission Control: Rotating QR Check-in (Demo)

- **Owner:** han.faz@northeastern.edu
- **Date:** 2026-07-17
- **Course / Project:** CS7980 — Voice-LLM-driven wayfinding robot
- **Scope:** Work Package B/C (security workstream) — a standalone interactive demo of an
  **admission-control layer ("L0")** that sits in front of the L1–L5 guardrail pipeline
  demonstrated in `security_demo/`
- **Status:** BUILT & VERIFIED (2026-07-17) — design approved; demo implemented and all
  acceptance criteria in section 7 exercised end-to-end against the live broker

---

## 1. The single thesis

> **Presence is a credential.** A rotating QR code on a kiosk screen turns "I am
> physically standing here" into a short-lived, verifiable token — filtering the open
> internet out of the robot's dispatch API before a single LLM token is spent.

Supporting point (the honest closer): L0 shrinks the attacker population from "the
internet" to "people physically on site." It does **not** replace L1–L5 — an on-site
attacker walks through L0 and still meets the deterministic guardrails. L0 and L3 are
the same design philosophy at two ends of the pipe: cheap deterministic checks beat
heavyweight trust.

## 2. Decided (owner sign-off 2026-07-17)

| Item | Decision |
|---|---|
| Form | **Standalone demo** (`admission-demo/`), does not touch `security_demo/` |
| Audience interaction | **Single-screen simulation only** — kiosk + phone rendered as panes in one browser window; no real phone scanning path |
| Docs | English from the start; light set (this file + `01-demo-script.md`); design system reused from `security_demo/docs/02-design-system.md` |
| Token issuance | **Server-issued signed nonce** (not shared-secret TOTP): simpler, revocable, easier to narrate; the kiosk needs connectivity anyway |
| LLM | **None.** L0 is pre-LLM and fully deterministic; the demo runs offline with zero credentials — no `.env` at all |

## 3. Threat model delta (extends guardrail-design-2026-07-03)

**Addressed by L0:**

| Threat | Mechanism |
|---|---|
| Internet bots / random scanners hitting `/api/dispatch` | No session → 401 before any pipeline work |
| Replay of a photographed QR | Nonce expires with the rotation window (60 s + 15 s grace); a stale code is rejected |
| Robot hogging / request flooding by one visitor | Per-session rate limit (3 dispatches/min) + single active dispatch per session |
| Anonymous abuse with no audit trail | Every dispatch is attributable to a session id + issuance timestamp |

A companion **network-origin control (L0a)** narrows the admitted population further at
zero UX cost — see §9.

**Explicitly NOT addressed (residual — say so on stage and in the paper):**

| Residual threat | Why it remains | Mitigation posture |
|---|---|---|
| Live token relay (on-site accomplice forwards a fresh session to a remote attacker) | Presence is only proven at check-in time | 15-min session + rate limits bound the damage; accept and document |
| On-site attacker (prankster passes L0 legitimately) | L0 is admission, not intent | Hand off to L1–L5 — this is the bridge to `security_demo` |
| QR-swap phishing (attacker replaces the kiosk QR to phish visitors) | Attacks the user, not the robot | Kiosk QR lives on an official display, not paper; domain printed under the code; HTTPS |
| Network-level DoS | Requests still reach the socket | Out of scope; L0 keeps the rejection path O(1) cheap (one HMAC verify) |

**Privacy stance (WP B):** sessions are anonymous. L0 proves *presence*, never *identity*
— no accounts, no PII, nothing to breach.

## 4. Token mechanism (normative)

- **Kiosk nonce.** Broker mints `code = base64url(payload || sig)` where
  `payload = { iat }` and `sig = HMAC-SHA256(K, payload)` truncated to 96 bits. `K` is a
  random in-memory key generated at broker boot (demo scope; production note: KMS-backed,
  rotated). A new code is minted every **60 s**; a code verifies iff
  `now − iat ≤ 75 s` (60 s window + 15 s grace so a scan at the rotation boundary
  doesn't fail).
- **QR content.** The QR encodes `https://<host>/checkin?c=<code>` — a real, scannable
  payload (honesty: the QR is real; only the phone is simulated).
- **Check-in.** `POST /api/checkin { code }` → verify HMAC + freshness → mint session
  `token = base64url({ sid, iat, exp: iat+900 } || HMAC)` (15-min TTL). Broker keeps an
  in-memory session table for rate/concurrency bookkeeping.
- **Dispatch gate.** `POST /api/dispatch` requires `Authorization: Bearer <token>`;
  verify signature + expiry, then enforce **3 dispatches/min per session** and
  **one active dispatch per session**.
- **Timing.** Verification cost is measured with `performance.now()` and shown in the
  UI (expected: tens of µs — the same "deterministic checks are almost free" motif as
  L3 in `security_demo`).
- **Demo deviation, documented:** production would carry the session in an HttpOnly
  cookie; the demo carries it in a per-pane `Authorization` header because several
  simulated devices (visitor phone, attacker terminal) share one real browser.

## 5. Architecture

Same skeleton as `security_demo` (proven in class 2026-07-08):

```
React + Vite + Tailwind v4 + Motion + Tabler Icons + qrcode (SVG render)
Broker = Vite configureServer middleware — REAL logic, same process, one `npm run dev`
  /api/kiosk/nonce   GET  → { code, issuedAt, rotateInSeconds, serverNow }   (kiosk polls)
  /api/checkin       POST { code } → 200 { token, sessionId, expiresAt }
                                   | 401 { error: BAD_CODE | STALE_CODE }
  /api/dispatch      POST Bearer { destinationId } → 200 { dispatchId, etaSeconds }
                                   | 401 { error: NO_SESSION | SESSION_EXPIRED }
                                   | 429 { error: RATE_LIMITED | DISPATCH_IN_PROGRESS }
  /api/metrics       GET  → counters (filtered_401, sessions_issued, rate_limited, dispatches_ok)
  /api/demo/expired-nonce  GET → a deliberately stale code — DEMO-ONLY fallback helper,
                                 labeled as such in the UI (see script scene 3)
```

**What is real vs simulated (honest framing, same discipline as `security_demo`):**

- REAL: nonce minting/rotation, HMAC verification, session issuance/expiry, rate
  limiting, concurrency gate, all timings, the QR image itself.
- SIMULATED: the phone (a rendered pane, "Scan kiosk QR" button reads the currently
  displayed code), the attacker terminal (scripted requests — but they are real HTTP
  requests to the real broker), the robot (a status card; no map, no path planning —
  that story belongs to `security_demo` and is not re-argued here).

## 6. UI (one dark engineering-console screen, four regions)

Reuses the `security_demo` design system verbatim (tokens, Geist/Geist Mono, double-bezel
panels, emerald/red state colors with text+icon, one electric-blue accent). New layouts:

1. **KIOSK pane** — large QR, rotation countdown ring, "GuideMate check-in" header,
   domain line under the QR (the anti-phishing posture, made visible).
2. **VISITOR PHONE pane** — phone-shaped frame: scan → session chip (id + TTL countdown)
   → destination buttons (closed enum of 4) → dispatch status card. Includes a
   **camera-roll slot**: "photograph" the current QR now, replay it later (drives the
   killer scene).
3. **ATTACKER TERMINAL pane** — monospace log; three scripted plays (direct hit,
   stale replay, token relay) each firing real requests and printing real responses.
4. **EVENT LOG + METRICS strip** — broker-side view: every request, verdict, µs timing;
   counters for filtered/issued/limited.

All user-visible copy is English; full copy inventory lives in `01-demo-script.md` §B.

## 7. Acceptance criteria

1. `npm install && npm run dev` → whole demo at `localhost:5173`, zero credentials/config.
2. Kiosk QR visibly rotates every 60 s with an accurate countdown; the QR decodes to the
   real check-in URL.
3. Scan → session → dispatch happy path works; session chip counts down 15 min.
4. A code photographed ≥ 75 s ago is rejected with `STALE_CODE` (natural-time path), and
   the demo-only helper produces the same rejection instantly (fallback path).
5. Direct un-sessioned `/api/dispatch` → 401, metrics increment; 4th dispatch inside a
   minute → 429 `RATE_LIMITED`; overlapping dispatch → 429 `DISPATCH_IN_PROGRESS`.
6. Token-relay play passes L0 and the UI says so honestly, pointing at L1–L5.
7. Verification timings displayed in µs, really measured.
8. `npm run typecheck` and `vite build` pass.

## 8. Non-goals / later

- No real-phone scan path (decided: simulation only). The QR is nonetheless real; a
  real-scan mode is a natural v2 if the demo is ever hosted.
- No integration into `agent_service/` (production path — needs team coordination; the
  API contract above is written so the broker could be lifted into `agent_service` later).
- No Bedrock, no floor map, no L1–L5 re-implementation.
- Paper/threat-model-doc updates happen after the demo is validated, as a separate edit.

---

## 9. L0a — network-origin check (NUwave allowlist), companion control

*Added 2026-07-19, proposed by the course instructor: only clients on NUwave
(Northeastern's campus network) should be able to reach the robot.*

This splits L0 into two orthogonal, composable deterministic checks:

| | **L0a — network origin** | **L0b — rotating QR (this demo)** |
|---|---|---|
| Proves | *Affiliation-ish*: the client egresses from the campus network (NUwave login is 802.1X with an NEU account) | *Presence-now*: the client read the kiosk screen within the last 75 s |
| UX cost | Zero (no kiosk interaction) | One scan |
| Granularity | Coarse — all campus traffic NATs through a few egress IPs | Per-visitor anonymous session (rate limit, single active dispatch, audit) |
| Check cost | One CIDR match, O(1) | One HMAC verify, tens of µs |

**Mechanism.** The production dispatch service (`agent_service/`) runs on EC2 behind
Caddy; NUwave clients hold private `10.x/19` addresses (measured in
`docs/network/ros2-over-nuwave.md`) and reach it through Northeastern's public NAT
egress. L0a is therefore an **allowlist of NEU public egress CIDRs at the service
edge** — implemented as FastAPI middleware in `agent_service` (separate PR), shipped
dark: `off → log → enforce`, CIDRs env-configurable. A Security-Group-only variant was
rejected because closing 80/443 to the world breaks Let's Encrypt issuance for the
Caddy-managed certificate.

**Honest residuals (same discipline as §3):**

- **NEU VPN defeats "physically on campus"** — GlobalProtect users egress from NEU IP
  space from anywhere. L0a proves network affiliation, not presence; presence stays
  L0b's job.
- **Visitor-access tension** — the guide robot's target users are campus *visitors*,
  who lack NEU accounts and cannot join NUwave proper. Either the NUwave-guest egress
  range is also allowlisted (needs measurement) or the service is scoped to
  NEU-affiliated users. This is a product decision, not a technical one.
- **NAT aggregation** — thousands of users share a few egress IPs, so per-IP rate
  limiting is meaningless behind L0a; per-session limits (L0b) remain necessary.
- **Enforcement is gated on two on-campus measurements** (not yet done): the actual
  NUwave egress IP(s) observed by the service, and whether NUwave-guest / NEU VPN
  share that range.

**Not implemented in this demo** — the demo runs on localhost, so source IPs would be
simulated, and simulating the input of a *network*-layer check would prove nothing.
The real control lives in `agent_service`; this section exists so the L0 threat model
reads as one story: L0a shrinks *which networks* can speak, L0b makes presence
*fresh*, L1–L5 constrain *what an admitted speaker can do*.
