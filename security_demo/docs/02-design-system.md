# 02 - Visual Design System (taste-skill discipline)

> This file applies the cross-cutting disciplines of `design-taste-frontend` + `high-end-visual-design` to this demo's tokens and components. Every deviation is explicitly flagged.

---

## 0. Design Read (skill §0.B)

> **Reading this as:** an **interactive security research demo** for a CS7980 technical/academic audience (reviewers + teammates), using a **dark-tech engineering-console** visual language, built on **React + Vite + Tailwind v4 + Motion**, icons from **Tabler Icons**, with the taste-skill's cross-cutting disciplines applied on top (not its landing-page-specific structure).

## 1. The Three Dials (with reasoning, skill §1)

| Dial | Value | Rationale |
|---|---|---|
| `DESIGN_VARIANCE` | **5** | Credibility first (technical/academic) keeps this low; but avoid rigid symmetry and "three equal cards". Functional asymmetry: the map dominates (large), the control panel is secondary (narrow). |
| `MOTION_INTENSITY` | **5** | Every motion effect is state-driven (§5): the robot travels along the path / turns red and stops on hitting a keep-out zone / the pipeline lights up layer by layer / the results table fills row by row / the LLM readout shows a skeleton shimmer during Live calls. No decorative loops / marquee / scroll hijacking. `prefers-reduced-motion` degrades everything to instant states. Slightly higher than the 4 used on 06-18, to reflect the polish of the rebuild, but introduces no unmotivated motion. |
| `VISUAL_DENSITY` | **6-7** | This is an "instrument": control panel + pipeline trace + metrics table, denser than a marketing page. Numbers/IDs/latencies/coordinates are always `font-mono`. |

## 2. Aesthetic Family + Design System (honestly labeled, skill §2.B)

- No official design system applies (not Fluent/Carbon/Material/USWDS...). Aesthetic family = **dark-tech / engineering console**, implemented in native CSS + Tailwind, labeled per §2.B **as an "aesthetic direction" rather than an "official system"**.
- **Theme lock (§4.11):** a single dark theme site-wide; no mid-stream color inversion.

## 3. Color Tokens (skill §4.2 + the three locks)

The neutral base is off-black zinc, with **no pure `#000` / pure `#fff`**. 1 brand accent color + 2 colors carrying real semantic states. Semantic colors are **always** paired with text + an icon/shape (colorblind-safe).

```css
/* Neutrals (a single cool-gray family, never mixed with warm grays) */
--bg:        #0b0c0e;  /* page background, near-black zinc */
--surface:   #131519;  /* elevated panel (double-bezel shell) */
--surface-2: #1a1d23;  /* inner core (double-bezel inner core) */
--border:    #262a31;  /* hairline stroke */
--text:      #e7e9ee;  /* primary text (off-white, not #fff) */
--text-dim:  #9aa0ab;  /* secondary */
--text-mute: #6b7280;  /* tertiary / labels (must still pass AA against the background) */

/* 1 accent color: restrained electric-blue, saturation < 80%, no neon glow */
--accent:       #4c8dd6;  /* interaction / focus ring / currently active layer */
--accent-hover: #5b9bde;
--accent-weak:  #4c8dd622; /* light background for the active layer (with alpha) */

/* 2 semantic state colors (carry the demo's core information, allowed by the skill) */
--safe:   #2fbf87;  /* SAFE / REACHED / PASS  (emerald, de-neoned) */
--safe-weak: #2fbf8722;
--danger: #e5484d;  /* UNSAFE / keep-out / BLOCKED (red, de-neoned) */
--danger-weak: #e5484d22;

/* shadows tinted toward the background, no pure-black drop shadows */
--shadow: 0 8px 30px -12px #00000099, inset 0 1px 0 #ffffff0a;
```

- **COLOR CONSISTENCY LOCK:** the accent is `--accent` site-wide; never switch to a different blue/purple in one section.
- **No AI-purple, no neon glow, no gradient slop** (skill 4.2 THE LILA RULE + 9.A).
- **Colorblind safety:** red/green never rely on color alone. `SAFE` pairs a ✓ stroke + emerald; `BLOCKED`/`UNSAFE` pair a ✕/shield icon + red + a text label. See the StatusPill component.

## 4. Typography (skill §4.1 + 4.9G)

- **UI sans:** **Geist** (not Inter/Roboto/Arial). Self-hosted woff2 (`geist` npm package or bundled), system-stack fallback `ui-sans-serif, system-ui`. Offline-safe: no Google Fonts `<link>`.
- **Mono:** **Geist Mono**, used for **all** numbers / `destination_id` / latencies (µs/ms) / coordinates / layer labels / pipeline reason codes / results-table values. Fallback `ui-monospace, "SF Mono", monospace`.
- **No serif** (this is not an editorial/luxury context).
- Restrained headings: build hierarchy with **weight + color**, not oversized type (skill 9.B). Top-bar title about `text-lg font-medium`; panel titles `text-xs uppercase tracking-wide text-mute` (functional section names, not marketing eyebrows - see the explicit deviations).
- **Zero em-dash / zero en-dash separators (§9.G, non-negotiable):** all visible copy site-wide (including tables / tooltips / buttons / alt / error messages) uses a plain hyphen `-` or a colon. Mechanically scan for `—` and `–` before delivery.

## 5. Layout (§4.3 / §4.7)

- A viewport-first **single-page console**, `max-w-[1400px] mx-auto`, `min-h-[100dvh]` (not `h-screen`). CSS Grid; no flex percentage math.
- **Top bar:** title + the safety invariant on one line. Height <= 72px (the skill's nav height cap is 80px). **No version tag / no locale / no weather / no scroll hint** (§9.F).
- **Main area (functional asymmetric split, VARIANCE=5):** left/primary (about 62%) = SVG floor map; right (about 38%) = control panel (double-bezel).
- **Below the map:** Pipeline Trace (L1-L5) + Results Table, side by side or stacked.
- **Mobile (`<768px`) explicit collapse:** single column, map fills the width responsively, panel stacks below, results table scrolls horizontally. Every asymmetric grid falls back to `grid-cols-1 w-full px-4` below `md`.

## 6. Component Inventory

All major containers use **double-bezel** (high-end §4.A): a shell (`--surface` + 1px `--border` + `--shadow` + padding) wrapping an inner core (`--surface-2` + inset highlight); inner-core radius = shell radius - padding (concentric). This creates a "machined hardware" feel that fits an engineering console.

| Component | Description | Key states |
|---|---|---|
| **TopBar** | Title `Robot Wayfinding Guardrail` + the safety invariant on one line (small mono type) | single |
| **FloorMap** (SVG) | Waypoints (safe destinations = in the enum/allowlist) / keep-out polygons (red hatched fill) / planned path / robot avatar + trailing person marker / start point. **Functional data visualization, not decorative SVG** | idle / walking / blocked-at-boundary / fail-safe-stop |
| **ControlPanel** (double-bezel) | Config segmented control (`Baseline`/`+L2 enum`/`+L3 full guardrail`) + 3 scenario buttons + mode toggle (`Live` / `Simulated`) + `Simulate WiFi loss / jam` + `Run full attack suite` | default / disabled while running |
| **LLMReadout** | Shows the source (live/simulated) + the emitted `destination_id` (mono) + the refusal state | idle / awaiting (skeleton shimmer) / emitted / refused |
| **PipelineTrace** | L1-L5 nodes; each layer shows PASS/BLOCK + reason + measured µs (mono). L5 labeled `experimental control` | lights up layer by layer (state transition) |
| **ResultsTable** | `Configuration | Attack success rate | Overhead`. Mono values + honest labels | empty / fills row by row |
| **StatusPill** | `SAFE` (✓ + emerald) / `BLOCKED` (shield + red) / `UNSAFE` (✕ + red). **Triple-encoded: color + icon + text** | three states |

- **Icons:** Tabler Icons (`@tabler/icons-react`), a single family, `strokeWidth={1.5}`. **Never hand-draw SVG icons** (§3.C / 9.E). Map markers are data visualization, not icons, and may be custom-drawn.
- **Card discipline (§4.4):** use cards only where they truly express hierarchy (panels/results table use double-bezel); elsewhere group with `border-t` / `divide-y` / negative space.
- **Shape lock (§4.4, a documented mixing rule, followed site-wide):** containers/panels `rounded-xl` (12px); double-bezel inner core `rounded-lg` (8px, concentric); status chips/pills `rounded-md` (6px); interactive buttons/toggles full pill (`rounded-full`).
- **Buttons (§4.5):** `:active` uses `scale-[0.98]` for physical press feedback. **Button contrast passes AA** (4.5:1); the primary CTA stays on one line. No duplicate-intent CTAs.
- **Form/segmented-control contrast passes AA** (focus ring `--accent`; placeholders/labels all pass AA).

## 7. Motion (§5 / §6.B) - every effect has a stated motive

Use Motion (`motion/react`) for UI/state animation; the robot's travel along the path uses `useMotionValue` + `requestAnimationFrame` tweening (no per-frame React state re-renders).

| Effect | Motive (one line) |
|---|---|
| Robot travels along the planned path | Narrative / state: shows the dispatch in progress |
| Hitting a keep-out zone: that path segment turns red, the robot stops at the zone boundary | Feedback: shows where UNSAFE happened |
| Pipeline trace lights up layer by layer (L1->L5) | State transition: shows the per-layer verdicts |
| Results table fills row by row during Run full suite | State: results accumulate |
| LLM readout skeleton shimmer during Live calls | Loading state (skeleton, not spinner, §4.5) |
| Toggle/button `:active` scale | Tactile feedback |

- Animate only `transform` / `opacity` (§6.A). `will-change: transform` only on elements that actually move.
- **`prefers-reduced-motion` -> jump straight to the end state, no tweening** (§6.B, non-negotiable); rAF handles have cleanup.
- **Forbidden:** marquee, infinite decorative loops, scroll hijacking, `window.addEventListener('scroll')` (§5.D), custom mouse cursors (§9.A).

## 8. Content / Numeric Honesty (§4.9)

- L3 latency is **measured** with `performance.now()` (sub-millisecond, real); the other layers' overheads are labeled "modeled/illustrative (modeled)" rather than pretending to be precise.
- Attack success rates are computed from real scenario outcomes (`2/2 -> 1/2 -> 0/2`), not invented.
- No filler verbs (Elevate/Seamless/Unleash...), no "Acme", no Jane Doe. Real attack utterances.
- All visible strings pass the Copy Self-Audit + the em-dash scan (see `04`).

## 9. Accessibility (§6)

- All text/buttons/tables pass WCAG AA (body 4.5:1, large type 3:1); hero/top-bar copy aims for AAA.
- Wherever red/green carries state, **always** add text + an icon (Section 3).
- Visible focus rings (`--accent`, `outline-offset`). All controls are keyboard-operable (the segmented control uses radiogroup semantics).
- Full reduced-motion coverage; for reduced-transparency, provide a solid-background fallback if backdrop-blur is used (this design uses almost no blur; panels are solid).

## 10. Pre-Flight Check (verified item by item before delivery, adapted)

- [ ] Zero em-dashes / en-dashes (headlines, labels, pills, buttons, tooltips, alt, error messages)
- [ ] Theme lock (a single dark theme site-wide, no mid-stream inversion)
- [ ] Color consistency lock (the same `--accent` site-wide)
- [ ] Shape consistency lock (documented mixing rule: containers 12 / inner core 8 / chips 6 / buttons pill)
- [ ] Button contrast passes AA, primary CTA on one line, no duplicate-intent CTAs
- [ ] Text/table/form contrast passes AA
- [ ] Red/green triple-encoded (color + icon + text), never color alone
- [ ] No decorative dots / no locale / no version tag / no scroll hint bar / no weather bar
- [ ] Every motion effect has a stated motive; no marquee; no scroll hijacking; no `window.addEventListener('scroll')`
- [ ] Only transform/opacity animated; rAF/useEffect have cleanup
- [ ] Full `prefers-reduced-motion` coverage (jump to the end state)
- [ ] `min-h-[100dvh]`, not `h-screen`; explicit mobile collapse below `<768px`
- [ ] No default Inter; Geist + Geist Mono, self-hosted
- [ ] No AI-purple / no neon glow / no gradient slop
- [ ] Icons from Tabler only, `strokeWidth 1.5`, no hand-drawn icons (map data visualization excepted)
- [ ] No fake div screenshots (the map is real data visualization, not fake UI)
- [ ] Numeric honesty: L3 measured, the rest labeled "modeled"; attack success rates come from real results
- [ ] All visible strings in English, passing the Copy Self-Audit

**Landing-specific items removed (not applicable):** hero-stack / logo wall / testimonials / eyebrow cadence counting / premium-consumer palette / real-photo hero. See `00` Section 7 for the rationale.

## 11. Explicit Deviations

| Rule | Deviation | Rationale |
|---|---|---|
| §13 landing structure | No hero/logo wall/testimonials | Interactive technical visualization, not a landing page |
| "eyebrow restraint" | Panels use small text labels to name sections | Functional section names (Control / Pipeline / Results), not marketing eyebrows; each appears only once |
| §4.8 real photos | No real photos; an SVG floor map instead | The map is functional data visualization carrying real geometry; not decorative SVG, not a fake screenshot |
| Hand-drawn SVG ban | Map markers are custom-drawn | Data-visualization elements, explicitly allowed by the skill (the map does not count as decorative SVG) |
