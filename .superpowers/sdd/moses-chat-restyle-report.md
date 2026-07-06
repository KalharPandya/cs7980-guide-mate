# Moses chat restyle — design report

Restyle of the user-facing dog-agent chat app to the **Moses** Northeastern
Vancouver design system (`docs/agent-poc/design-package`). The A/B direction is
implemented faithfully: **Direction B (black hero + red)** for the landing /
consent / intake, **Direction A (black-framed Husky + Moses)** for the everyday
chat app on soft-gray/white.

## Files changed
- `agent_service/static/index.html` — rebuilt markup for the two surfaces; all
  test-contract ids preserved.
- `agent_service/static/chat.css` — full rewrite against `tokens.json` /
  `themes.css` (colors, type, radius, spacing verbatim).
- `agent_service/static/chat.js` — **one** additive block: quick-action chips
  prefill the composer. Every existing handler, the WS protocol, and the
  emote↔audio sync are untouched.
- `agent_service/guidemate_agent/app.py` — two `FileResponse` routes
  (`/brand/moses-husky-head.svg`, `/brand/northeastern-vancouver-lockup.png`)
  mirroring the existing `/chat.css` pattern.
- `agent_service/static/brand/` — husky head mark + Northeastern Vancouver
  lockup copied out of `docs/` so nothing references `docs/` at runtime.

## The signature moment — the black-hero landing
Boldness is spent in one place: the intake becomes a full ceremonial black stage
(`#000` with a red `#C8102E` radial glow), a **red-framed Husky mark**, a heavy
compact **"Moses"** wordmark (weight 900, `-0.055em` tracking), a large balanced
display headline, and a quiet staged reveal (`opacity/translateY`, 3 delayed
steps, disabled under `prefers-reduced-motion`). The intake card sits on
`#111` with a red-accented privacy strip, a red primary **Start with Moses**
button, and a visible **human-help** alternative (per the brief's "visible human
help alternative"). The Northeastern Vancouver lockup rides on a white strip
(the art is dark-on-white, so it needs a light backing on black) as an
affiliation layer, with a "not an official University product" note — honoring
the brand boundary.

Everything else stays deliberately quiet: the chat app is a disciplined light
surface so the hero keeps its impact.

## Direction A — the chat app
- **Black-framed Husky + Moses** app header with a status chip (dot + label, never
  color-only) and the virtual-pet badge.
- Companion banner restyled as a left-accented card; the accent + status dot are
  semantic (muted → virtual, green → connected, amber → pending, red →
  denied/aborted). On narrow widths the request button wraps below the status so
  the string never breaks awkwardly.
- Avatar "Robert" recolored to a **Husky palette** (charcoal head, light snout)
  on a soft red-tinted stage card, captioned as "your Husky companion" — framing
  the robot dog as *one tool*, not the brand.
- User bubbles are Northeastern red with white text; Moses bubbles are soft-gray
  bordered — straight from the design preview.
- Quick-action chips (Find a room / Campus services / Talk to a person) prefill
  the composer.
- Composer controls are all **labelled pills** (🎙 Talk / Send / New) — no
  icon-only buttons, even on mobile (the narrow breakpoint tightens spacing
  rather than dropping the mic label).

## How the two themes coexist
The app is one document. `body:has(#chat:not([hidden]))` flips the page from the
black hero (landing, shown first) to the light app surface once the chat shell is
revealed by the existing JS — no JS theme hook added. The Direction A header is
hidden during intake so the hero owns the full screen. The app/hero split is
fixed (not OS-`prefers-color-scheme`-driven) because the brand mandates specific
surfaces per screen; both are tuned crisp.

## Test contracts kept intact
- All ids the JS + tests depend on are present: `#intake #name #comfortable
  #start #chat #avatar #companion-status #request-companion #messages #chat-form
  #message #mic #status-chip`, the `#player`, `#virtual-pet-badge`
  (`data-testid`), the emote classes, and the `.hidden` pattern.
- `test_index_served`'s `"Robert" in resp.text` still holds — **Moses** is the
  product/brand, **Robert** remains the dog (composer placeholder + captions),
  which is exactly the brief's "robot is one tool, not the whole brand." No test
  string was modified.
- The gated e2e's asserted substrings live in `chat.js` (`"Virtual dog"`,
  `"Request pending"`, `"Connected to " + robot_id + " … (physical)"`,
  `"disconnected by admin"`) and are unchanged — only their containers were
  restyled.
- Emote↔audio sync preserved: emote still armed on the `reply` frame and released
  on the `<audio>` `play` event.

## Verification
- `python3 -m pytest agent_service/tests/test_app.py` → **18 passed** (index
  hooks, `/chat.css` `/chat.js` served, `emote-happy` in CSS, JS brace/paren
  balance + sync-contract asserts).
- Full non-gated suite → **331 passed, 24 skipped**. The only 3 non-green items
  (`test_readyz_not_ready_when_mqtt_and_dynamo_down`, two `test_jsonlog` errors)
  are **pre-existing and environmental** — reproduced identically with my changes
  stashed (this box reaches real DynamoDB so `/readyz` returns 200; the jsonlog
  errors are a pytest-6/nose `TypeError`). None touch the UI.
- Booted `GUIDEMATE_FAKE_ROBOT=1 uvicorn guidemate_agent.app:app` and drove it in
  headless Chrome (Playwright + system Chrome). Verified `/brand/*` assets serve
  (200) and **no horizontal scroll** at 360px on either surface.

## Screenshots (in /tmp)
- `/tmp/moses-chat-landing-mobile.png` — black-hero landing, 390px (the signature).
- `/tmp/moses-chat-landing-wide.png` — landing on desktop width.
- `/tmp/moses-chat-main-mobile.png` — Direction A chat, virtual state.
- `/tmp/moses-chat-connected-mobile.png` — connected/physical state (green chip,
  red virtual-pet badge, green banner).
- `/tmp/moses-composer.png` — labelled composer pills.

## What to look at
Open the landing first (black hero, red-framed Husky, Moses wordmark, campus
lockup) — that's where the design invests. Then start a session to see the light
Direction A app: header lockup, semantic banner, Husky-recolored Robert, red user
bubbles, labelled composer.
