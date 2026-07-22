# NUwave origin gate (L0a) — design + rollout runbook

*Added 2026-07-19 (security workstream, Fazheng Han). Instigated by course-instructor
feedback: only clients on NUwave (the campus network) should be able to reach the robot.*

## TL;DR

`agent_service` now carries an **ASGI middleware** (`guidemate_agent/origin_gate.py`)
that can restrict visitor-facing routes to clients whose requests egress from the
campus network. It **ships dark** (`GUIDEMATE_ORIGIN_MODE=off`, a pass-through). The
campus egress **has been measured** (2026-07-22, see the measurement log): NUwave and
NUwave-guest both NAT out of **`208.98.212.96/29`**, which is now the shipped default
allowlist. Before flipping `enforce`, still run a day of `log` mode plus the two cheap
remaining checks (cellular negative control, fresh-lease repeat).

| Env var | Default | Meaning |
|---|---|---|
| `GUIDEMATE_ORIGIN_MODE` | `off` | `off` (no-op) / `log` (never blocks, logs would-blocks) / `enforce` (403 / WS close 4403) |
| `GUIDEMATE_ORIGIN_ALLOWLIST` | `208.98.212.96/29` | Comma-separated CIDRs. Default = the **measured Vancouver campus egress block** (NUwave + NUwave-guest). Boston's `155.33/16`+`129.10/16` are deliberately **not** included — the product is Vancouver-scoped, so NEU-VPN (Boston egress) is blocked by design |
| `GUIDEMATE_ORIGIN_EXEMPT` | `/healthz,/readyz,/admin,/api/admin` | Path prefixes that bypass the gate (deploy probes; admin surface has its own cookie auth and the team works off campus) |

## What it does / does not prove

- L0a proves **network affiliation**: NUwave login is 802.1X with an NEU account, so a
  campus-egress source IP weakly attests "NEU-affiliated (or on campus guest WiFi)". It
  costs the visitor **nothing** (no scan, no login on our side).
- The classic "VPN defeats physical presence" hole is **closed by the scope decision
  (2026-07-22)**: the product is Vancouver-campus-only, so the allowlist carries just the
  Vancouver /29 and NEU **VPN (GlobalProtect)** users — who egress from NEU's *Boston*
  space — are blocked **by design** (403 is working-as-intended, not a bug report).
  Caveat kept honest: we did not measure whether GlobalProtect could egress inside the
  Vancouver /29; no indication it does, and if it did, presence-freshness is still L0b's
  job (`admission_demo/`, design doc §9 covers how L0a and L0b compose).
- Because thousands of campus users share one NAT egress IP, **per-IP rate limiting is
  meaningless** behind L0a — per-session limits (L0b) remain necessary.
- **Visitor access: resolved by measurement (2026-07-22).** The guide robot's target
  users are campus *visitors*, who cannot join NUwave proper — but NUwave-guest turns
  out to share the exact same egress IP as NUwave (see the measurement log), so
  allowlisting the campus /29 includes visitors automatically. The flip side: L0a
  cannot scope the service to NEU-affiliated users only — IP cannot tell an 802.1X
  NUwave login apart from a guest. Affiliation/per-user scoping, if ever wanted, is
  L0b's (or an auth layer's) job.

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

1. **Measure. — ✅ mostly done (2026-07-22, see the measurement log).** NUwave,
   NUwave-guest, and a floor-change repeat all egress from `208.98.212.96/29`.
   Remaining cheap checks: cellular (negative control) and a fresh-lease
   different-day sample. For any future re-measurement: set
   `GUIDEMATE_ORIGIN_MODE=log` in `/etc/guidemate.env` on the instance
   (`compose.yaml` forwards the three `GUIDEMATE_ORIGIN_*` vars into the app
   container), run `agent_service/deploy/redeploy.sh`, then read the
   would-block/pass lines in CloudWatch (`/guidemate/agent-service`).
2. **Decide policy. — ✅ resolved (2026-07-22).** Visitors: **in** (NUwave-guest shares
   the egress IP, included automatically). VPN: **out** — the product is scoped to the
   Vancouver campus, so the Boston ranges are not allowlisted and GlobalProtect users
   are blocked by design.
3. **Validate in `log` mode.** The measured /29 is now the shipped default allowlist —
   run `log` for a day and confirm zero false "would block" lines for legitimate users.
4. **Flip `enforce`** (`agent_service/deploy/redeploy.sh` with the env set). Verify:
   campus phone works; cellular phone gets the 403 JSON (`NOT_ON_CAMPUS`); `/admin`
   still reachable off campus; `/healthz` + `/readyz` still green.
5. **Note IPv6:** if the campus egresses IPv6, add those CIDRs too — an IPv4-only
   allowlist silently blocks IPv6 clients in enforce mode.

### Measurement log (step 1 record)

| Date | Network | Vantage point | Local IP | Egress IP | Registered block (RDAP/ARIN) |
|---|---|---|---|---|---|
| 2026-07-22 | NUwave (SSID "NUwave 2") | Fazheng's laptop, Vancouver campus | 10.247.217.171 (GW 10.247.192.1) | 208.98.212.98 | **208.98.212.96/29** — `NET-208-98-212-96-1`, name `NORTHEASTERN-UNIVERSITY`, direct ASSIGNMENT to Northeastern University inside Shaw Communications' 208.98.192.0–208.98.221.255 |
| 2026-07-22 | **NUwave-guest** | Fazheng's laptop, Vancouver campus | 10.247.147.156 (GW 10.247.128.1 — a different internal subnet) | 208.98.212.98 | same /29 — **guest shares the exact egress IP with NUwave proper** |
| 2026-07-22 | NUwave (reconnect, different floor) | Fazheng's laptop, Vancouver campus | 10.247.217.171 (same lease/GW as row 1 — roaming kept the DHCP lease) | 208.98.212.98 | same — egress stable across reconnect + floor change; NOT an independent lease, the different-day sample below still stands |

- **`208.98.212.96/29` adopted as the shipped default (2026-07-22)** — in
  `origin_gate.py` (`DEFAULT_ALLOWLIST`) and mirrored in `compose.yaml`. The original
  Boston placeholder (`155.33.0.0/16,129.10.0.0/16`) was measured wrong for this campus
  and removed per the Vancouver-only scope decision. (8 addresses; the whole campus NATs
  out of this block, consistent with the per-IP-rate-limiting caveat above.)
- **No IPv6 egress observed**: a dual-stack lookup (api64.ipify.org) returned the same
  IPv4, so an IPv4-only allowlist is currently safe here (re-check at enforce time).
- **NUwave-guest egresses from the same IP as NUwave proper** (measured, same day, same
  laptop): allowlisting the /29 includes visitors automatically — and, symmetrically,
  L0a *cannot* exclude guests or distinguish them from NEU-account users by IP. Per-user
  scoping is L0b's job.
- **NEU VPN measurement dropped (scope decision 2026-07-22):** the product is
  Vancouver-campus-only, so whether GlobalProtect egresses from Boston space no longer
  matters — those clients are outside the allowlist by design.
- Still pending before `enforce`: a **different-day** sample (same-day floor-change
  repeat done, but it kept the same DHCP lease — confirm a fresh lease still egresses
  inside the /29) and **cellular** as the negative control.

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
