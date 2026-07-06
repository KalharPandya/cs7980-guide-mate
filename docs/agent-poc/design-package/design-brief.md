# GuideMate Echo - Design Brief

## One-Line Product Definition

GuideMate is the accessible web interface for a TurtleBot 4 campus guide robot. Echo is the
robot's friendly visual identity inside the webapp.

## Selected Visual Direction

Use **Echo as TurtleBot Pal**:

- Compact robot-dog mascot on a TurtleBot-inspired base.
- Rounded white shell, dark glass face, cyan/teal LED expression.
- Teal-blue ring motif for responsiveness and the "Echo" name.
- Small enough to work as a status avatar, not a giant hero illustration.

Avoid:

- Fur dog styling.
- Amazon/Alexa/Echo hardware resemblance.
- Purple gradients.
- Beige/tan soft SaaS palette.
- Dark sci-fi robot dashboard.
- Toy-store cuteness.

## Brand Roles

| Element | Role |
|---|---|
| GuideMate | Product/system name |
| Echo | Robot mascot and assistant identity |
| TurtleBot Pal | Visual direction for Echo |
| Teal ring | Ready/helpful/privacy-safe state |
| Blue route | Navigation/wayfinding state |
| Red stop | Safety-critical stop/error state |

## Theme

The visual system deliberately keeps Echo friendly but lets GuideMate read as a campus
service. The interface should not look like a toy, a sci-fi robot console, or an Amazon
voice assistant clone.

### Light Theme

- Background: `#F7F9FC`
- Surface: `#FFFFFF`
- Text: `#101828`
- Muted text: `#667085`
- Border: `#D9E2EC`
- Primary: `#129C9C`
- Route: `#1F6FEB`
- Success: `#168A4A`
- Warning: `#B76B00`
- Danger: `#D92D20`

### Dark Theme

- Background: `#0B1220`
- Surface: `#111B2E`
- Soft surface: `#172033`
- Text: `#F7FAFC`
- Muted text: `#D0D7E2`
- Border: `#2E4056`
- Primary: `#7EE7FF`
- Route: `#58A6FF`
- Success: `#6DDC91`
- Warning: `#F5B83D`
- Danger: `#FF9A91`

## Typography

Preferred stack:

```css
Inter, Atkinson Hyperlegible, system-ui, sans-serif
```

Use Inter for product polish when available. Use Atkinson Hyperlegible as the accessibility
reference because its letterforms distinguish similar characters clearly. Use system UI as
the fallback so the webapp still feels native on personal devices.

Type rules:

- Body text: 18 px preferred, 16 px minimum.
- Body line height: 1.5.
- Heading line height: 1.2.
- Left aligned text only.
- No justified paragraphs.
- No icon-only buttons; pair icons with visible labels.

## Why These Choices

### Why TurtleBot Pal

The physical platform is TurtleBot 4, so the mascot should acknowledge the robot's real
shape instead of pretending GuideMate is a humanoid or a furry dog. The TurtleBot Pal
direction makes Echo recognizable as a small mobile robot while still giving it a friendly
face and emote states.

### Why Echo

Echo is the responding doggo inside the webapp. The name fits the interaction pattern:
users ask for help and Echo responds with text, status, routes, and safe robot actions. The
ring motif nods to responsiveness without copying Amazon Echo hardware or Alexa branding.

### Why Teal, Blue, and Red

- Teal is the main GuideMate action color because it reads as calm, helpful, and safe.
- Blue is reserved for route/navigation state so wayfinding has a consistent visual cue.
- Red is reserved for Stop, error, and safety-critical actions.
- Amber is used for warnings such as slow movement, pending approval, or degraded service.

This separates meanings by function instead of decoration. Status should still include text
labels because the UI cannot rely on color alone.

### Why White-First Light Theme

The webapp is expected to run on users' personal phones in public campus spaces. A white,
high-contrast light theme keeps maps, directions, forms, and chat readable under normal
lighting and avoids the heavy "robot dashboard" feel.

### Why Deep Blue-Black Dark Theme

The dark theme uses deep blue-black rather than pure black to reduce glare while preserving
contrast. Cyan replaces teal as the primary action color in dark mode so controls remain
visible and distinct from muted surfaces.

### Why Echo Is Not Always Large

Echo should anchor the product identity, but the core tasks are finding places, reading
directions, stopping motion, and getting human help. The mascot appears large on landing or
empty states, then shrinks to an avatar/status role inside chat and wayfinding.

## Core Screens

### Landing / Consent

Purpose: confirm the user is in the right place, collect minimal session identity, and show
privacy before Start.

Required UI:

- GuideMate logo and Echo avatar.
- Name field.
- Email field if the build requires user memory or staff handoff.
- Privacy strip: cameras help navigation only; no face recognition.
- Optional memory checkbox, unchecked by default.
- Start button.
- Visible pointperson alternative.

### Main Chat

Purpose: complete the interaction by text without requiring voice.

Required UI:

- Persistent text input.
- GuideMate/Echo message history.
- Quick actions: Find a room, Bathrooms, Talk to a person, Stop.
- Inline source/provenance labels for factual answers.
- Live robot status label.

### Wayfinding

Purpose: let users complete directions with or without the robot.

Required UI:

- Static/high-contrast map.
- Turn-by-turn text.
- Self-guided and Robot guide modes.
- Lost Echo action.
- Persistent Stop.
- Clear robot status.

### Robot Status

Purpose: make robot state legible and safety actions obvious.

Required UI:

- Battery.
- Dock state.
- Motion state.
- Dry-run/locked state.
- Stop robot now.
- Self-guided fallback.

### Pointperson Handoff

Purpose: make the human fallback explicit and privacy-respecting.

Required UI:

- Pointperson location.
- What-to-share choices.
- Default option to share nothing.
- Handoff note.
- Back to chat.

### Admin / Operator

Purpose: operational control, not companion branding.

Required UI:

- Robot state.
- Pending requests.
- Active physical session holder.
- Kill switch.
- Stop command.
- Knowledge sync.
- Maps/health/audit access.

## Asset Usage Rules

- Use `guidemate-echo-logo-light.svg` on light backgrounds.
- Use `guidemate-echo-logo-dark.svg` on dark backgrounds.
- Use `echo-mark.svg` for app icon, favicon, small header avatar, and status chips.
- Use `echo-turtlebot-pal.svg` sparingly on landing or empty states.
- Use `echo-emotes.svg` as source material for avatar states.
- Use labelled controls; do not make icon-only buttons.

## Implementation Notes

- Use `tokens.json` as the source for Tailwind/shadcn theme values.
- Use `themes.css` for documentation prototypes or quick static pages.
- Keep radius at 8-16 px for most cards. Larger radius is reserved for phone frames,
  mascot art containers, and app marks.
- Body text should be at least 16 px, preferably 18 px.
- Touch targets should be at least 44 px.
