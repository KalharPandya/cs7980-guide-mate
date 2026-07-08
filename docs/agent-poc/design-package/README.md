# Moses Design Package

This package contains the product-facing identity and UI direction for **Moses**,
the Northeastern Vancouver concierge AI agent.

## Direction

**Selected direction:** A/B hybrid.

- **A: Black-framed Husky + Moses** for the app header, compact identity, and everyday UI.
- **B: Black hero + red accent** for splash, login, and high-emphasis moments.

Moses is the central AI concierge. The TurtleBot/robot is one capability in the
toolkit, not the brand itself. The visual identity should feel expert,
welcoming, campus-aware, and King Husky-inspired without becoming a toy mascot.

## Files

| File | Purpose |
|---|---|
| `design-brief.md` | Design-doc-ready summary of the Moses brand direction |
| `tokens.json` | Source design tokens for Northeastern-informed light and dark themes |
| `themes.css` | Drop-in CSS variables and base component styles |
| `preview.html` | Visual preview of the accepted A/B direction and sample UI components |
| `assets/logo/moses-husky-head.svg` | Moses app/header mark, based on the King Husky head reference |
| `assets/affiliation/northeastern-vancouver-lockup.png` | Northeastern Vancouver affiliation lockup reference |
| `assets/icons/guidemate-ui-icons.svg` | Existing labelled icon set for key actions |

## Theme Summary

- Core identity: Northeastern black, white, and red `#C8102E`.
- Light app surfaces: white, soft gray grid, black text, black-framed Moses mark,
  and red action accents.
- Hero/splash surfaces: black stage, white text, red-framed Moses mark.
- Functional color remains semantic: route blue, success green, warning amber,
  stop/error red.

## Brand Boundary

This is a private class-project design direction. Public use of official
Northeastern marks should go through Brand Review. Until approval, treat the
Northeastern Vancouver lockup as an affiliation/context mark, not as a merged
Moses logo.

## Accessibility Commitments

- Body text starts at 18 px in the design language.
- Controls target 44 px minimum height.
- Status is never color-only: use labels plus color.
- Moses can be expressive, but task controls stay clear and direct.
- Preserve a persistent Stop action whenever robot motion can be active.
- Keep human handoff visible; do not hide it behind an accessibility menu.
