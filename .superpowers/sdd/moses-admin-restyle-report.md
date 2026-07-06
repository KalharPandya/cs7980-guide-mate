# Moses — Admin / Operator Console restyle

Restyle of the dog-agent admin panel to the **Moses** Northeastern Vancouver
design system. Goal per the brief's *Admin / Operator* section: **operational
control, not mascot branding** — a confident, legible operator console.

Scope: `agent_service/static/admin/` only (the admin UI is a `StaticFiles`
mount at `/admin`; assets placed in that dir serve directly, no `docs/` paths at
runtime).

## What changed

| File | Change |
|---|---|
| `index.html` | Full re-layout: black-hero login card, signature identity bar (husky mark + Moses wordmark + Northeastern Vancouver affiliation), disciplined tab nav, one card per tab, table-scroll wrappers, considered empty states. **All ids / `data-tab` / `data-testid` preserved.** |
| `admin.css` | Rewritten to the Moses token system (exact tokens.json colours), light theme primary + black "hero" theme mapped onto `prefers-color-scheme: dark`, status pills, focus rings, 44px targets, reduced-motion, responsive. |
| `admin.js` | Markup-only enhancement of the robot card (presence/battery/dock/gates as label+colour pills, full-weight red kill switch) and richer empty-state copy for requests / sessions / KB. **No control-flow / API logic changed.** |
| `health.js` | Presence + command-mode rendered as label+colour pills. **esc() XSS escaping kept on every untrusted field.** |
| `moses-husky-head.svg`, `northeastern-vancouver-lockup.png` | Brand assets copied in so they SERVE from `/admin/` (no runtime `docs/` reference). |

## Design decisions

- **Colours are exactly tokens.json.** Light app: `#F7F7F7` bg / `#FFFFFF`
  surface / `#000` text / `#C8102E` primary+danger+focus / `#D9D9D9` border /
  `#1F6FEB` route / `#168A4A` success / `#B76B00` warning. Dark maps to the
  black-hero token set. Focus ring is `#C8102E` in both themes.
- **Type:** Lato/Arial body at 18px (14px for dense tables), heavy compact
  `Moses` wordmark (weight 900, tight tracking), uppercase micro-labels for
  section/eyebrow text.
- **Husky mark** appears black-framed on the light app surface (header) and
  red/white-framed on the black login hero — matching the A/B asset rules.
- **Status is never colour-only.** Every pill carries a **text label** beside
  its colour/dot (online, docked, sim/real, gate booleans). This is enforced in
  both the robot cards and — as the brief specifically calls out — the Health
  tab tables.
- **Safety weighting.** The **kill switch** is a full-weight solid-red bar; the
  session-controls card carries a red left rule; *Abort* is red-outlined and
  *Send stop* uses the warning (amber) treatment. Red is reserved for
  safety/brand, not decoration.

## The signature

The **identity bar** (`.app-bar`): black-framed husky head + heavy `Moses`
wordmark + `OPERATOR CONSOLE` eyebrow on the left; `NORTHEASTERN VANCOUVER ·
GUIDE-ROBOT FLEET` context + the university lockup on the right; a 4px
Northeastern-red rule underlining the whole bar. It's the one confident,
branded moment; every panel below it is deliberately restrained (flat cards,
quiet borders, mono logs). The **robot-state row** (presence/battery/dock/gate
pills + kill switch) is the console's second focal point.

## Test-contract preservation

- **Every selector the JS + tests rely on is intact:** `#login-view`,
  `#login-form`, `#password`, `#login-form button[type=submit]`,
  `#login-error`, `#panel[hidden]`; the `.tabs button[data-tab=...]` set
  (flags/prompt/requests/sessions/robot/knowledge/maps/health) with `.active`;
  every `#tab-*` `.tab`; `#flags-list .flag`; prompt `#prompt-text/-save/-clear/
  -status`; `#requests-list` with `data-testid="request-row"`,
  `data-testid="approve-robot-select"`, `data-testid="approve-btn"`;
  `#sessions-list`, `#transcript`; `#robot-list .robot .robot-title .dot
  .robot-meta`, kill `button.danger`, `#robot-holder(-value)`,
  `#robot-abort/-dock/-stop`, `#robot-command-result`, `#assign-event`;
  `#kb-*`, `#kb-table`; `#maps-robot/-timestamp/-image/-empty`, `.map-frame`,
  the `details > summary` "How to refresh this map"; the four `#health-*-table`s.
- **esc() XSS guard kept (security requirement).** `health.js` still defines
  `esc()` and wraps every untrusted field: `esc(r.robot_id)`,
  `esc(gatesTextHealth(r.gates))`, `esc(e.message)`, `esc(e.where)`, etc. The new
  presence/mode pills interpolate only a **fixed literal class** plus the
  esc()'d label. Grep-source guard test (`test_admin_health.py`) verifies no raw
  `${untrusted}` reappeared — all 6 health tests pass.
- `stopHealthPolling` / `clearInterval` on tab-away preserved.
- Bonus correctness fix: the pre-existing merged HTML never closed `#tab-maps`,
  so `#tab-health` was **nested inside it** and could never display (a hidden
  parent hid it). Tabs are now proper siblings — the Health tab renders. Also
  added `[hidden]{display:none!important}` so the `hidden`-attribute visibility
  toggling still wins over the new `display:grid/flex` layout rules.

## Verification

- `PYTHONPATH= .venv/bin/pytest -q` → **334 passed, 24 skipped** (skips are the
  `GUIDEMATE_E2E=1`-gated Playwright suites). Health XSS/grep + polling tests:
  6/6 pass.
- Visual: booted `uvicorn guidemate_agent.app:app` with `GUIDEMATE_FAKE_ROBOT=1`
  + `GUIDEMATE_ADMIN_PASSWORD`, logged in via headless Chromium (Playwright), and
  screenshotted every tab in light **and** dark. Page never scrolls
  horizontally; tables scroll inside their own `overflow-x` container.

### Screenshots
`/tmp/moses-admin-login.png`, `…-robot.png`, `…-health.png`, `…-flags.png`,
`…-prompt.png`, `…-requests.png`, `…-sessions.png`, `…-knowledge.png`,
`…-maps.png`, plus `…-<tab>-dark.png` for the dark-theme variants.
