# Moses — Wave-2 frontend report

Scope: `agent_service/static/` only (`index.html`, `chat.css`, `chat.js`). No backend
`.py` touched. All screens are no-motion. Every existing id / data-testid / asserted
string / WS contract preserved; test suite green (207 passed, 20 skipped).

## What shipped

### 1. In-app navigation (NEW)
A segmented **tablist** (`.view-nav`, `role="tablist"`) added to the top of the chat
shell (below the persistent Stop bar, above the views): **Chat · Wayfinding · Arsenal ·
Map**. Chat is the default active view, so the existing chat DOM (`#chat-form`,
`#messages`, `#avatar`, `#companion-status`, …) is present + visible on load and every
e2e/id contract holds (`#chat:not([hidden])` still resolves immediately).
- Keyboard: tabs are buttons (Enter/Space activate); Left/Right/Up/Down/Home/End move
  between them with roving `tabindex` + `aria-selected`. 44px targets. `#C8102E` focus
  (`:focus-visible`, `outline-offset:-3px` so the ring sits inside the flush tabs).
- Desktop: tabs read as real tabs aligned to the 1180px content band. Mobile: an evenly
  split top segmented control (each tab `flex:1`). The chat DOM is wrapped in
  `#view-chat`; the other three are sibling `<section role="tabpanel">` panels toggled
  via the `hidden` attribute (`.view[hidden]{display:none!important}`).

### 2. KB source / provenance labels (NEW)
`attachSources(bubble, sources)` renders `Source: <title>` chips under a dog reply when
the `reply` frame carries `sources: [{title, url}]`. Reuses the safe-render discipline:
titles/urls set via `textContent`; a chip is a link only when `url` matches
`^https?://` (else a plain `<span>`), `rel="noopener noreferrer"`. No `sources` → nothing
renders. Verified live by injecting a `sources` field into reply frames in the driver.

### 3. Wayfinding screen (NEW, motion-free)
`#view-wayfinding`: campus/robot map (shared fetch, see below; 404 → tasteful
"Map appears once a robot is guiding you" placeholder), a "Where do you want to go?"
input, and **turn-by-turn TEXT directions produced by Moses over the SAME chat/WS turn**
(no new protocol): submit sets `pendingWayfinding`, sends `{type:"text"}`, and the next
`reply` is mirrored into the directions panel (rendered through the existing safe
`renderMarkdown`) while the chat transcript keeps its own copy. A **"Lost? Get help from
a person"** action sends a human-handoff turn and switches to Chat to show the response.
The mandated persistent **Stop** is the global `#stop-bar` sitting above the nav, so it
stays visible across every view when a physical robot is bound.

### 4. Agent Arsenal screen (NEW)
`#view-arsenal`: five labelled capability rows (icon + name + description + a
**label+colour pill, never colour-only**): Knowledge & search, Maps & wayfinding, Human
handoff, Robot companion (bound? which robot?), Safety — dry-run. Driven by
`GET /api/session/{sid}/arsenal`; refreshes on view + polls every 5s while visible +
manual Refresh button. Framing copy: "Everything Moses can do for you. The robot dog is
just one tool in the kit." Graceful: route 404 → every row shows a muted **"Checking…"**
pill (verified live — the route does not exist yet).

### 5. User Map view (NEW)
`#view-map`: `GET /api/session/{sid}/map` (PNG → object URL) with a caption from
`GET .../map/meta` (`{captured_ts, source}`, formatted), a Fit/Actual-size zoom toggle,
and a clean **"No map yet"** empty state when the map (or robot) is absent.

### 6. Two live-review nits fixed
- **(a) mobile empty-chat rail:** `#chat` gets a `has-conversation` class on the first
  bubble; on `<1024px` that collapses the big avatar stage into a compact horizontal
  strip (small avatar + caption) so the thread + composer are reachable in the first
  viewport. The avatar and its emote classes stay in the DOM — emote/audio-sync untouched.
- **(b) desktop empty thread:** an in-thread greeting empty-state (`#thread-empty`: husky
  mark + "Hi, I'm Moses." + lede) fills the previously-empty thread card; `addBubble`
  hides it on the first message.

## Fetch + fallback summary
| Data | Route | Fallback when 404 / field absent |
|---|---|---|
| KB sources | `reply` WS frame `sources[]` | render nothing |
| Arsenal | `GET /api/session/{sid}/arsenal` | all rows → muted "Checking…" pill |
| Map image | `GET /api/session/{sid}/map` | "No map yet" / "Map appears once a robot is guiding you" |
| Map meta | `GET /api/session/{sid}/map/meta` | caption falls back to "Map from your robot" |

Every fetch is wrapped in try/catch and never throws; the app degrades to a clean empty
state. Backend routes were confirmed 404 at test time (parallel agent still building) and
the UI handled it cleanly.

## One bug found + fixed during verification
The map `<img>` used `.map-img{display:block}`, which beats the UA `[hidden]` rule and
leaked the image's `alt` text into the empty state (same gotcha noted in `admin.css`).
Fixed with `.map-img[hidden]{display:none!important}`.

## Preserved contracts
Intake `#name/#comfortable/#start`; `#chat`, `#messages`, `#chat-form`, `#message`,
`#mic`, `#status-chip`, `#request-companion`, `#companion-status`, avatar + `emote-*`
classes, persistent Stop `#stop-btn`/`data-testid="stop-button"`, `virtual-pet-badge`,
companion banner strings, WS protocol (`text`/`transcript`/`reply`/`audio`/`stopped`/
`error`/`stop`/`start_audio`/`stop_audio`), emote↔audio sync (emote still released on the
`<audio>` `play` event), Sound toggle / Replay / SPEAKING surface, safe markdown renderer.
44px / 18px / `#C8102E` focus / reduced-motion all honoured; no horizontal scroll at 360px.

## Verification
- `PYTHONPATH=agent_service pytest agent_service/tests -q` → **207 passed, 20 skipped**.
- Booted `GUIDEMATE_FAKE_ROBOT=1` uvicorn against real AWS, drove with Chromium
  (display :0) at 1440×900 and 390×844. `chat.js` `node --check` unavailable; brace/paren
  balance verified (matches `test_chat_static_assets_served`).

## Screenshots (/tmp)
Desktop (1440×900): `wave2-chat-desktop.png` (source chips visible),
`wave2-chat-empty-desktop.png` (nit b), `wave2-wayfinding-desktop.png`,
`wave2-arsenal-desktop.png`, `wave2-map-desktop.png`.
Mobile (390×844): `wave2-chat-mobile.png` (nit a — collapsed rail),
`wave2-chat-empty-mobile.png`, `wave2-wayfinding-mobile.png`,
`wave2-arsenal-mobile.png`, `wave2-map-mobile.png`.
