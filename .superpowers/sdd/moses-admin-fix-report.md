# Moses Operator Console — dark-mode design-review fixes

Fixes for the four adversarial-review findings against the merged Moses
admin/operator console (`agent_service/static/admin/`). Dark mode is driven by
`@media (prefers-color-scheme: dark)`, which remaps the token block to the black
"hero" theme. All work verified by booting the app (`GUIDEMATE_FAKE_ROBOT=1`),
logging in through headless Chromium emulating `prefers-color-scheme: dark`, and
re-screenshotting.

## Verification screenshots (dark mode)

- Login (hero): `.superpowers/sdd/moses-admin-fix-login-dark.png`
- Robot tab: `.superpowers/sdd/moses-admin-fix-robot-dark.png`
- Knowledge tab: `.superpowers/sdd/moses-admin-fix-knowledge-dark.png`

(Source PNGs also at `/tmp/moses-admin-fix-{login,robot,knowledge}-dark.png`.)

Computed-style probe from the live page confirms:
`markBorderColor = rgb(200,16,46)` (#C8102E), `killBg = rgb(200,16,46)`,
`killColor = rgb(255,255,255)`.

---

## 1. Mark-frame drift on dark/hero surfaces

**Before:** the login (hero) mark correctly used the RED outline frame via
`.moses-lockup-hero .moses-mark`, but the authenticated dashboard header used the
black/white *app* frame (`.moses-mark { border: 6px solid #000 }`) on the black
`#111` app-bar — the wrong frame for a dark stage.

**After:** inside `@media (prefers-color-scheme: dark)`, the mark frame switches
to `var(--gm-primary)` (#C8102E). Light mode keeps the black app frame (correct
per brief A). Verified in every dark screenshot: red husky frame in the header
and on the hero login.

`admin.css`:
```css
@media (prefers-color-scheme: dark) {
  .moses-mark { border-color: var(--gm-primary); }
}
```

## 2. Dark kill-switch contrast (WCAG fail)

**Before:** `.robot .danger` filled with `var(--gm-danger)` which in dark is the
pale coral `#FF6B6B`; white text on it is ~2:1 — the *lowest*-contrast control on
the page, the opposite of what a kill switch should be.

**After:** in dark mode the kill switch fills with the deep Northeastern red
`#C8102E` and keeps white text — **≈5.9:1** (passes WCAG AA), making it the
highest-contrast, most-urgent control. Hover uses `#E11331` (still >4.5:1).
Light-mode kill switch is unchanged.

```css
@media (prefers-color-scheme: dark) {
  .robot .danger { background: #c8102e; border-color: #c8102e; color: #ffffff; }
  .robot .danger:hover { filter: none; background: #e11331; border-color: #e11331; }
}
```

## 3. Knowledge-tab file input

**Before:** raw `<input type=file class="file-input">` rendered the native OS
"Choose File" button — light-gray system chrome that broke the design language on
the black card in dark mode.

**After:** the input is wrapped in a styled `<label class="file-field">` pill
matching the system button spec (999px radius, 44px min height, token border/
surface). The native input is visually hidden (sr-only clip) but still focusable
and functional — **`id="kb-file"` is unchanged**, so the existing upload wiring is
intact. A `#kb-file-name` label mirrors the chosen filename (updated on `change`,
reset after upload). The red `#C8102E` focus ring shows on the pill via
`:focus-within` (visible in the knowledge screenshot). Verified `kb-file` present
and functional in the live page.

## 4. Card radius

**Audit finding:** the merged CSS already scopes every card surface through
`--gm-radius: 8px` (`.card`, `.robot`, `.flag`, `.list li`, `.holder-strip`,
`.table-scroll`), with the hero login card at the `lg` token max of 12px and the
mark at 6px. `grep border-radius` shows **no value above 12px** — all card
surfaces sit inside the 8–12px range (and app cards at the brief's preferred
≤8px). No change required; confirmed compliant in the screenshots.

## Focus ring confirmation (#C8102E)

The universal `:focus-visible { outline: 3px solid var(--gm-focus) }`
(`--gm-focus: #C8102E` in both themes) renders on the login password field
(screenshot), tabs, buttons, and the approve `<select>` (`approve-robot-select`).
The styled file pill adds an equivalent `:focus-within` ring.

---

## No-regression checks

- `health.js` **untouched** — the `esc()` XSS escaping on every interpolated
  field (`errors[].message`, gates, ids), `stopHealthPolling`, and the polling
  guards are all intact.
- Every id / `.tab` / `data-tab` / `data-testid` preserved:
  `approve-robot-select`, `request-row`, `approve-btn`, the `#health-*-table`
  ids, and the kill-switch `button.danger`.
- `PYTHONPATH= .venv/bin/pytest -q` → **334 passed, 24 skipped** (e2e-gated),
  including the health XSS-guard grep tests
  (`test_health_js_escapes_untrusted_fields`, `test_health_js_stops_polling_on_tab_away`).

## Files changed

- `agent_service/static/admin/admin.css` — dark mark frame, dark kill-switch
  contrast, styled file-picker CSS.
- `agent_service/static/admin/index.html` — file-input wrapped in styled label.
- `agent_service/static/admin/admin.js` — filename mirror for the styled picker
  (change listener + reset after upload).
