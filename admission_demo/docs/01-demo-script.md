# Demo Script — L0 Admission Control (≈4 minutes)

- **Owner:** han.faz@northeastern.edu
- **Date:** 2026-07-17
- **Companion:** `00-design.md` (architecture, token mechanism, acceptance criteria)
- **Stage setup:** one browser window, full screen. No network beyond localhost, no
  credentials. Presenter clicks; nothing depends on WiFi or an audience.

---

## A. The four scenes

> Opening line: *"Last time we showed that guardrails around the LLM stop jailbreaks.
> Today we go one layer earlier: who gets to talk to the robot at all?"*

### Scene 0 — Set the trap (15 s, do this FIRST)

Click **"Photograph QR"** on the visitor phone's camera-roll slot. Say nothing about it
yet — just *"a visitor snaps a photo of the front-desk code, we'll come back to that."*
The photo's age counter starts ticking. This makes Scene 3 run on **natural time** — by
the time we return, the code is genuinely expired. (Fallback if running short: the
"expired code (demo helper)" button produces the same rejection instantly and is labeled
as a demo-only helper.)

### Scene 1 — The internet knocks (45 s)

Attacker terminal, play **"Direct API hit"**: a request to `/api/dispatch` with no
session. Real HTTP request, real `401 NO_SESSION` in tens of microseconds — point at the
µs figure in the event log, and at the `filtered` counter climbing.

> *"No account system, no CAPTCHA, no LLM spent. One HMAC check. The entire internet
> is now out of the game."*

### Scene 2 — The visitor walks up (60 s)

Visitor phone, click **"Scan kiosk QR"** → session chip appears (id, 15:00 countdown)
→ pick **Cafe** → dispatch runs → status card: robot en route. Then press dispatch
three more times quickly → `429 RATE_LIMITED`; the robot can't be hogged.

> *"The session is anonymous — we proved presence, not identity. Nothing to breach."*

### Scene 3 — THE KILLER: the photo is a dud (45 s)

Back to the camera roll: the photographed QR, now aged past 75 s. Click **"Use
photographed QR"** → `401 STALE_CODE`.

> *"That photo is on Reddit five minutes after we tape a static code to the desk. A
> rotating code makes the photo worthless — presence has a timestamp."*

This is the scene the audience remembers; do not rush the pause after the red verdict.

### Scene 4 — Honesty: what L0 does NOT do (45 s)

Attacker terminal, play **"Token relay"**: an on-site accomplice checks in and forwards
the fresh session token; the remote attacker's dispatch **succeeds** — shown in amber,
not hidden.

> *"L0 shrinks the attacker population from the internet to people physically here. For
> the ones who walk in — that's the L1–L5 pipeline we showed last time. Same philosophy
> at both ends: cheap deterministic checks, no trust in the perimeter."*

Close on the metrics strip: filtered vs issued vs limited.

---

## B. Copy inventory (all user-visible text — English, verbatim source of truth)

### Kiosk pane
| Element | Copy |
|---|---|
| Header | `GuideMate Check-in` |
| Sub | `Scan to use the guide robot` |
| Countdown label | `Code refreshes in {n}s` |
| Domain line (under QR) | `guidemate.example.edu — verify before you scan` |

### Visitor phone pane
| Element | Copy |
|---|---|
| Title bar | `Visitor phone (simulated)` |
| Scan button | `Scan kiosk QR` |
| Photograph button | `Photograph QR` |
| Camera roll label | `Camera roll — photo age {m:ss}` |
| Replay button | `Use photographed QR` |
| Fallback button | `Expired code (demo helper)` |
| Session chip | `Session {sid} · expires in {mm:ss}` |
| Destination prompt | `Where to?` |
| Destinations (enum) | `Cafe` / `Library` / `Room 468` / `Front desk` |
| Dispatch running | `Robot dispatched — arriving in {n}s` |
| Dispatch done | `Arrived. Follow me!` |
| Errors | `Check-in failed: code expired. Scan the live screen.` / `Too many requests — try again in a moment.` / `A dispatch is already running for this session.` / `Session expired. Please scan again.` |

### Attacker terminal pane
| Element | Copy |
|---|---|
| Title bar | `Attacker terminal (scripted plays, real requests)` |
| Play 1 | `Direct API hit — no session` |
| Play 2 | `Replay a stale code` |
| Play 3 | `Token relay — on-site accomplice` |
| Verdicts | `BLOCKED 401 NO_SESSION` / `BLOCKED 401 STALE_CODE` / `PASSED L0 — presence was borrowed. This is L1–L5's job.` |

### Event log / metrics strip
| Element | Copy |
|---|---|
| Columns | `time · source · endpoint · verdict · verify µs` |
| Counters | `Filtered` / `Sessions issued` / `Rate limited` / `Dispatches OK` |
| Footer note | `All checks real and timed live. Phone and attacker are simulated; the broker is not.` |

---

## C. Cut list (if over time)

1. Scene 2's rate-limit beat (keep the happy path).
2. Scene 4 shortens to one sentence over the metrics strip.
3. Never cut Scene 3 — it is the demo.
