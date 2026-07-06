# Moses chat UI — adversarial design-review FAIL fixes

Fixes to the merged user-facing Moses chat surface (`agent_service/static/` +
`agent_service/guidemate_agent/ws_chat.py`) for the FAIL-grade findings.
Design system: `docs/agent-poc/design-package/` (tokens, `#C8102E` primary/danger,
radius 8–12 px, husky mark, "no icon-only buttons").

Verification:
- `PYTHONPATH= .venv/bin/pytest -q` → **336 passed, 24 skipped** (334 baseline +
  2 new stop-path tests). All ids / data-testids / asserted substrings intact.
- Headless Chromium re-screenshots (worktree code served, APIs stubbed, WS allowed
  to fail gracefully):
  - `/tmp/moses-chat-fix-landing.png`
  - `/tmp/moses-chat-fix-main-chat.png`
  - `/tmp/moses-chat-fix-physical-connected.png`
  - `/tmp/moses-chat-fix-virtual-pet.png`

## Findings — before / after

### BLOCKER 1 — Dev label leak ("emote: yes" in answer bubbles)
- **Before:** `addBubble()` appended a `<span class="emote-tag">emote: <name></span>`
  inside every Moses bubble; the raw metadata was printed as production copy.
- **After:** the emote tag is gone from the bubble entirely. The emote is metadata
  only — it drives the avatar animation via `armPendingEmote()` (unchanged) and,
  for assistive tech, an `aria-live` `#emote-label` that is now `.sr-only`
  (visually hidden, id kept for the emote↔audio-sync tests). Removed the dead
  `.bubble .emote-tag` CSS. `test_voice_e2e.py` updated: it waited on
  `.bubble.dog .emote-tag` (the removed dev label); it now waits on `.bubble.dog`
  and still asserts the emote via the avatar animation class (the real sync check).

### BLOCKER 2 — Missing persistent Stop on physical connection
- **Before:** no persistent Stop anywhere; nothing to halt a moving physical robot.
- **After:** a sticky, always-visible danger-red **"Stop the robot"** pill
  (`#stop-bar` / `#stop-btn`, `data-testid="stop-button"`, flat square line icon)
  is revealed by `renderState()` whenever a **real** physical robot is bound
  (`physical && robot_id !== "turtlebotsim"` — the motion-less sim pet does not
  show it). "Talk to a person" (human handoff quick action) stays visible.
- **Wiring (real stop):** the button sends `{type:"stop"}` on the chat WebSocket.
  New `ws_chat._send_stop()` resolves the session's bound robot via the existing
  `_physical_target()` seam and forwards the **same** command the agent's `stop`
  tool uses — `registry.send_command(target, Command(type="stop", name="stop"))`
  (see `dog_agent._stop_impl`). Virtual/unbound sessions ack `{stopped, sent:false}`
  and never name/touch a robot. Client toasts "Stop sent to the robot." New tests
  `test_stop_message_physical_session_forwards_stop_command` (asserts the registry
  published `("turtlebot468","stop")`) and `test_stop_message_virtual_session_publishes_nothing`.

### IMPORTANT 3 — Avatar clash (cartoon "Robert" vs sharp husky mark)
- **Before:** a soft hand-drawn cartoon dog (`.dog-head/.dog-ear/.dog-snout…` SVG)
  under the sharp official husky line-mark = two conflicting dog depictions.
- **After:** the avatar is now a medallion built from the **official**
  `moses-husky-head.svg` (single, brand-coherent husky), framed like the app mark
  but demoted (round soft frame, not the hard black header box) so it reads as a
  companion, not a competing lockup. `#avatar` id and every emote class
  (`emote-happy/yes/no`, `breathe`) are on the container and untouched — visual
  swap only; emote/audio-sync + tests still pass.

### IMPORTANT 4 — Red-as-status + contradictory pills
- **Before:** `.chip-virtual-pet` used `--primary` (red = danger/Stop) and the sim
  showed **both** a green "physical" chip **and** a "Virtual pet" chip at once.
- **After:** `.chip-virtual-pet` is now neutral/muted (`--muted` on
  `--surface-soft`). Single authoritative connection state: when the sim is bound
  the status chip is **hidden** and the "Virtual pet" badge owns the header; the
  banner reads "Connected to turtlebotsim **(virtual pet)**", a real robot reads
  "(physical)". `data-testid="virtual-pet-badge"` + the "Connected to <id>"
  substring preserved.

### IMPORTANT 5 — Emoji clash (🐕 banner, 🎙️ mic)
- **Before:** banner "Connected to <robot> 🐕 (physical)"; glossy 🎙️ on the Talk
  button.
- **After:** banner emoji removed (flat status carried by the banner dot) →
  "Connected to <robot> (physical)"; the mic glyph is a flat monochrome
  `currentColor` line-icon SVG, still paired with the "Talk" label (no icon-only).
  Asserted substrings ("Connected to " + robot_id, "(physical)", "Virtual dog",
  "Request pending", "disconnected by admin") all intact.

### 6 — Low-contrast "Connected" chip → real green success
- **Before:** the bound-state request button showed "Connected" as a faded ghost
  button (opacity 0.5, muted grey).
- **After:** `.banner-btn.is-connected` renders the admin `pill-ok` green success
  treatment (`--success` text, 40% border, 12% surface tint, full opacity),
  toggled in `renderState()` whenever a robot is bound.

### 7 — Truncated composer placeholder
- **Before:** `placeholder="Say something to Robert…"` clipped to "Say something t…".
- **After:** `placeholder="Message Moses…"` — never clips at 430 px. ("Robert" is
  still present in `resp.text` via the stage caption + hero lede, so
  `test_index_served` stays green.)

### 8 — Card radius drift → 8–12 px token range
- **Before:** chat cards read high vs the design preview (which uses 8 px).
- **After:** message `.bubble` and `.stage-card` pulled to `--r-md` (8 px), matching
  `preview.html`; corner tucks stay `--r-sm`. All chat-card radii now in-range.

### 9 — Unify bubble red / CTA red + focus ring
- **Confirmed** `.bubble.you` background and `.btn-primary` background both resolve
  to `var(--primary)` = **#C8102E** (no drift). Keyboard-focus (`:focus-visible`)
  Tab-walk confirmed a **3 px #C8102E (rgb 200,16,46)** ring on the name field,
  message input, mic, Send, New, quick-action chips, and the new Stop button.

## Notes
- Backend/static are loaded from the shared editable install; a throwaway
  `sitecustomize.py` shim redirected `guidemate_agent` to this worktree for the
  test + screenshot runs and was removed before commit (not part of the change).
