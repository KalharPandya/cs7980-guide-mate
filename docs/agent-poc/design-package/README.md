# GuideMate Echo Design Package

This package contains the product-facing identity and UI assets for the current
GuideMate webapp direction.

## Direction

**Selected direction:** Echo as **TurtleBot Pal**.

Echo should feel like a compact campus-service robot companion, not a toy dog and not a
voice assistant. The mascot supports the interface; accessibility, directions, status,
privacy, stop, and human handoff remain the product priorities.

## Files

| File | Purpose |
|---|---|
| `design-brief.md` | Design-doc-ready summary of the brand, UI direction, screens, and rationale |
| `tokens.json` | Source design tokens for light and dark themes |
| `themes.css` | Drop-in CSS variables and base component styles |
| `preview.html` | Visual preview of logos, mascot, themes, and sample UI components |
| `assets/logo/echo-mark.svg` | Square app/logo mark |
| `assets/logo/guidemate-echo-logo-light.svg` | Full logo lockup for light backgrounds |
| `assets/logo/guidemate-echo-logo-dark.svg` | Full logo lockup for dark backgrounds |
| `assets/logo/echo-wordmark.svg` | Echo wordmark |
| `assets/mascot/echo-turtlebot-pal.svg` | Main Echo mascot |
| `assets/mascot/echo-emotes.svg` | Echo ready/thinking/happy/stopped emote states |
| `assets/icons/guidemate-ui-icons.svg` | Labelled icon set for key actions |

## Theme Summary

The color system intentionally avoids the earlier purple, beige, and dark-dashboard
directions.

- Light theme: white surfaces, pale blue-gray background, near-black text, teal primary.
- Dark theme: deep blue-black surfaces, high-contrast text, cyan primary.
- Route state: blue.
- Privacy and safe system state: teal/green.
- Warning: amber.
- Stop and error: red.

## Accessibility Commitments

- Body text starts at 18 px in the design language.
- Controls target 44 px minimum height.
- Status is never color-only: use labels plus color.
- Echo is decorative unless the avatar state conveys status, in which case expose the
  state as text.
- Preserve a persistent Stop action whenever robot motion can be active.
- Keep pointperson handoff visible; do not hide it behind an accessibility menu.
