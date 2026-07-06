# Moses - Design Brief

## One-Line Product Definition

Moses is a Northeastern Vancouver concierge AI that helps students and visitors
ask questions, find places, request help, and when appropriate use a robot as
one tool in a larger assistance system.

## Selected Visual Direction

Use the accepted **A/B approach**:

- **A: Black-framed Husky + Moses** for app headers, chat surfaces, compact product
  identity, and everyday UI.
- **B: Black hero + red accent** for splash screens, login, onboarding, and
  moments where Moses should feel ceremonial, confident, and King
  Husky-inspired.

The identity should be welcoming and accessible like the earlier companion
direction, but grounded in a concierge expert: capable, campus-aware, calm under
pressure, and knowledgeable about Northeastern history and services.

## Brand Roles

| Element | Role |
|---|---|
| Moses | Product and agent name |
| Husky head mark | Moses-facing app mark and personality signal |
| Northeastern Vancouver lockup | Campus affiliation and credibility layer |
| Red `#C8102E` | Northeastern anchor and primary brand accent |
| Black mark frame | App-header identity treatment on white surfaces |
| Black hero stage | Expert, confident splash/login language |
| Robot/TurtleBot | One physical capability in Moses's toolkit |

## Theme

The system uses official-feeling Northeastern colors without pretending the
student project is an approved public Northeastern product.

### Light App Theme

- Background: `#F7F7F7`
- Surface: `#FFFFFF`
- Text: `#000000`
- Muted text: `#5B6170`
- Border: `#D9D9D9`
- Primary: `#C8102E`
- Primary text: `#FFFFFF`
- Route: `#1F6FEB`
- Success: `#168A4A`
- Warning: `#B76B00`
- Danger: `#C8102E`

### Black Hero Theme

- Background: `#000000`
- Surface: `#111111`
- Soft surface: `#1D1D1D`
- Text: `#FFFFFF`
- Muted text: `#D6D6D6`
- Border: `#343434`
- Primary: `#C8102E`
- Primary text: `#FFFFFF`
- Route: `#58A6FF`
- Success: `#6DDC91`
- Warning: `#F5B83D`
- Danger: `#FF6B6B`

## Typography

Preferred stack:

```css
"Real Head Pro", "FF Real Head", Lato, Arial, sans-serif
```

Use a heavy, compact display treatment for **Moses**. Use Lato/Arial-style body
copy for readable campus-service text. The product should feel bold and
institutional, but not like a dense university policy page.

Type rules:

- Body text: 18 px preferred, 16 px minimum.
- Body line height: 1.5.
- Large Moses wordmark: tight, bold, left-aligned.
- No justified paragraphs.
- No icon-only buttons; pair icons with visible labels.

## Why These Choices

### Why Moses

Moses gives the agent a real name and a campus personality. It connects to the
current King Husky identity while leaving room for a capable AI concierge rather
than a generic helper bot.

### Why A for App Surfaces

The black-framed Husky + Moses treatment is compact, friendly, and legible in
small headers. On white surfaces, the black frame gives the mark better balance
than a red frame, while red remains available for action and affiliation cues.

### Why B for Hero Moments

The black stage makes Moses feel more expert and ceremonial. The red-framed
Husky mark keeps the hero from becoming a generic dark AI dashboard and gives
the splash/login surface a clear Northeastern signal.

### Why the Vancouver Lockup Is Separate

The Northeastern Vancouver mark should establish affiliation and credibility.
Moses should remain the product identity. Keeping them separate avoids a fake
combined university logo and leaves a clearer path for later Brand Review.

## Core Screens

### Landing / Consent

Purpose: confirm the user is in the Northeastern Vancouver context, collect
minimal session identity, and show privacy before Start.

Required UI:

- Black hero treatment with Moses mark and product name.
- Northeastern Vancouver lockup as affiliation.
- Name field.
- Email field if the build requires user memory or staff handoff.
- Privacy strip: cameras help navigation only; no face recognition.
- Optional memory checkbox, unchecked by default.
- Start button.
- Visible human help alternative.

### Main Chat

Purpose: complete the interaction by text without requiring voice.

Required UI:

- Black-framed Husky + Moses app header.
- Persistent text input.
- Moses message history.
- Quick actions: Find a room, Campus services, Talk to a person, Stop.
- Inline source/provenance labels for factual answers.
- Live robot/status label when a physical agent is involved.

### Wayfinding

Purpose: let users complete directions with or without the robot.

Required UI:

- Static/high-contrast map.
- Turn-by-turn text.
- Self-guided and Robot guide modes.
- Lost / need help action.
- Persistent Stop when robot motion can be active.
- Clear robot status.

### Agent Arsenal

Purpose: make clear that Moses is more than the robot.

Required UI:

- Knowledge/search status.
- Map/wayfinding status.
- Human handoff availability.
- Robot availability as one tool.
- Safety/dry-run state.

### Admin / Operator

Purpose: operational control, not mascot branding.

Required UI:

- Robot state.
- Pending requests.
- Active physical session holder.
- Kill switch.
- Stop command.
- Knowledge sync.
- Maps/health/audit access.

## Asset Usage Rules

- Use `assets/logo/moses-husky-head.svg` as the Moses mark in headers and
  status chips.
- Use a black mark frame for app surfaces.
- Use a red outline mark frame on black hero surfaces.
- Use `assets/affiliation/northeastern-vancouver-lockup.png` only as an
  affiliation/context layer.
- Do not create a merged Moses + official Northeastern logo without approval.
- Use labelled controls; do not make icon-only buttons.

## Implementation Notes

- Use `tokens.json` as the source for Tailwind/shadcn theme values.
- Use `themes.css` for documentation prototypes or quick static pages.
- Keep radius at 8 px or less for app cards unless the real UI pattern needs a
  larger touch-friendly pill.
- Body text should be at least 16 px, preferably 18 px.
- Touch targets should be at least 44 px.
