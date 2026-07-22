# NUwave origin gate (L0a) — design + rollout runbook

*Added 2026-07-19 (security workstream, Fazheng Han). Instigated by course-instructor
feedback: only clients on NUwave (the campus network) should be able to reach the robot.*

## TL;DR

`agent_service` now carries an **ASGI middleware** (`guidemate_agent/origin_gate.py`)
that can restrict visitor-facing routes to clients whose requests egress from the
campus network. It **ships dark** (`GUIDEMATE_ORIGIN_MODE=off`, a pass-through) because
nobody has measured this campus's real NUwave egress IPs yet. Do not flip `enforce`
before running the measurements below.

| Env var | Default | Meaning |
|---|---|---|
| `GUIDEMATE_ORIGIN_MODE` | `off` | `off` (no-op) / `log` (never blocks, logs would-blocks) / `enforce` (403 / WS close 4403) |
| `GUIDEMATE_ORIGIN_ALLOWLIST` | `155.33.0.0/16,129.10.0.0/16` | Comma-separated CIDRs. The default is Northeastern's **Boston**-registered space — a **placeholder**; this campus (Vancouver) likely egresses elsewhere |
| `GUIDEMATE_ORIGIN_EXEMPT` | `/healthz,/readyz,/admin,/api/admin` | Path prefixes that bypass the gate (deploy probes; admin surface has its own cookie auth and the team works off campus) |

## What it does / does not prove

- L0a proves **network affiliation**: NUwave login is 802.1X with an NEU account, so a
  campus-egress source IP weakly attests "NEU-affiliated (or on campus guest WiFi)". It
  costs the visitor **nothing** (no scan, no login on our side).
- It does **not** prove physical presence: NEU **VPN (GlobalProtect)** users egress from
  NEU IP space from anywhere on Earth. Presence-freshness is the job of the **L0b
  rotating-QR check-in** (`admission_demo/`, design doc §9 covers how L0a and L0b
  compose). And because thousands of campus users share a few NAT egress IPs, **per-IP
  rate limiting is meaningless** behind L0a — per-session limits (L0b) remain necessary.
- **Visitor-access tension (product decision needed):** the guide robot's target users
  are campus *visitors*, who cannot join NUwave proper. Either the NUwave-guest egress
  range is also allowlisted (measure it), or the service is scoped to NEU-affiliated
  users.

## Where the check sits (trust model — read before touching)

```
phone (NUwave, private 10.x/19)
  └─ NAT at the campus border  ->  public egress IP        <- what we allowlist
       └─ EC2: Caddy (TLS, reverse_proxy)                  <- appends the REAL peer to X-Forwarded-For
            └─ FastAPI app  ->  OriginGate middleware       <- trusts ONLY the LAST XFF entry
```

- Exactly **one** trusted proxy (Caddy) fronts the app (`agent_service/Caddyfile`).
  Caddy v2.5+ ignores inbound `X-Forwarded-For` from untrusted clients and appends the
  peer address it actually saw — so the **last** XFF entry is trustworthy and the first
  is attacker-controlled. The middleware never reads the first entry. If a second proxy
  layer (ALB/CloudFront) is ever added, this parsing MUST be revisited.
- A **Security-Group-only** variant (allowlist CIDRs on ports 80/443) was considered and
  rejected: it breaks Let's Encrypt issuance/renewal for the Caddy-managed certificate
  (LE validators must reach the domain), and it can't serve a human-readable
  "connect to NUwave" error page.
- Enforcing with an **empty/invalid allowlist fails closed** (all non-exempt requests
  blocked, loud error log) — a security control with broken config must not become a
  silent no-op. Probes stay exempt so the box still looks healthy to deploys.

## Rollout runbook

1. **Measure (on campus, ~30 min).** Deploy with `GUIDEMATE_ORIGIN_MODE=log` — set it
   in `/etc/guidemate.env` on the instance (`compose.yaml` forwards the three
   `GUIDEMATE_ORIGIN_*` vars into the app container), then run
   `agent_service/deploy/redeploy.sh`. From a
   phone on **NUwave** (WiFi, not cellular), load the chat page and send a message.
   Read the would-block/pass lines in CloudWatch (`/guidemate/agent-service`) — they
   contain the observed client IP. Repeat from: a second building if possible,
   **NUwave-guest**, **NEU VPN**, and cellular (as the negative control). Record the
   IPs/ranges here.
2. **Decide policy.** Visitors (NUwave-guest) in or out? VPN acceptable? (VPN cannot be
   distinguished from on-campus by IP if it shares the egress range.)
3. **Set the real allowlist** (`GUIDEMATE_ORIGIN_ALLOWLIST=<measured CIDRs>`), keep
   `log` for a day, confirm zero false "would block" lines for legitimate users.
4. **Flip `enforce`** (`agent_service/deploy/redeploy.sh` with the env set). Verify:
   campus phone works; cellular phone gets the 403 JSON (`NOT_ON_CAMPUS`); `/admin`
   still reachable off campus; `/healthz` + `/readyz` still green.
5. **Note IPv6:** if the campus egresses IPv6, add those CIDRs too — an IPv4-only
   allowlist silently blocks IPv6 clients in enforce mode.

### Measurement log (step 1 record)

| Date | Network | Vantage point | Local IP | Egress IP | Registered block (RDAP/ARIN) |
|---|---|---|---|---|---|
| 2026-07-22 | NUwave (SSID "NUwave 2") | Fazheng's laptop, Vancouver campus | 10.247.217.171 (GW 10.247.192.1) | 208.98.212.98 | **208.98.212.96/29** — `NET-208-98-212-96-1`, name `NORTHEASTERN-UNIVERSITY`, direct ASSIGNMENT to Northeastern University inside Shaw Communications' 208.98.192.0–208.98.221.255 |

- **Allowlist candidate so far: `208.98.212.96/29`** (8 addresses; the whole campus
  NATs out of this block, consistent with the per-IP-rate-limiting caveat above).
  Confirms the Boston default (`155.33.0.0/16,129.10.0.0/16`) is wrong for this campus.
- **No IPv6 egress observed**: a dual-stack lookup (api64.ipify.org) returned the same
  IPv4, so an IPv4-only allowlist is currently safe here (re-check at enforce time).
- Still pending before `enforce`: repeat samples (different day/building — confirm the
  egress stays inside the /29), **NUwave-guest**, **NEU VPN (GlobalProtect)** — likely
  egresses from the Boston ranges, which would decide whether 155.33/129.10 stay in —
  and cellular as the negative control.

## Relation to the rest of L0

L0a (this gate) shrinks *which networks* can speak; L0b (rotating QR,
`admission_demo/`) makes presence *fresh* and gives per-session rate/concurrency
control; L1–L5 (`security_demo/`) constrain *what an admitted speaker can make the
robot do*. All of them are cheap deterministic checks — the workstream's through-line.

## Tests

`agent_service/tests/test_origin_gate.py` — default-off pass-through, campus/internet
allow/deny, XFF spoof resistance (first entry ignored, last entry wins), malformed XFF,
exemptions, log mode, env config, empty-allowlist fail-closed, and WebSocket
allow/block. Run: `pytest agent_service/tests/test_origin_gate.py`.
