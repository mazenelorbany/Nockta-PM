---
name: Nockta Flow
description: Engineering operations platform for Nockta. Dark-first cockpit UI for a 30-engineer org migrating off Jira.
colors:
  hangar-dark: "#0c0c0d"
  console-black: "#131315"
  panel-graphite: "#181819"
  raised-graphite: "#1c1c1e"
  secondary-surface: "#232325"
  hairline: "#28282b"
  telemetry-grey: "#95959a"
  readout-white: "#f5f5f5"
  nockta-violet: "#a78bfa"
  nockta-violet-wash: "#2a1f4a"
  signal-lime: "#d8e64f"
  drift-teal: "#61d0bc"
  alert-coral: "#f86958"
  stop-red: "#ed4a3b"
  inert-grey: "#888892"
typography:
  display:
    fontFamily: "'Plus Jakarta Sans', 'Inter', system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.025em"
    fontFeature: "'ss01' 1"
  title:
    fontFamily: "'Plus Jakarta Sans', 'Inter', system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: "'Inter', system-ui, -apple-system, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
    fontFeature: "'rlig' 1, 'calt' 1, 'ss01' 1, 'cv11' 1"
  label:
    fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace"
    fontSize: "0.65rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.16em"
  mono:
    fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.2
rounded:
  sharp: "0px"
  hairline: "2px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.readout-white}"
    textColor: "{colors.hangar-dark}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    typography: "{typography.body}"
  button-primary-hover:
    backgroundColor: "{colors.telemetry-grey}"
    textColor: "{colors.hangar-dark}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.telemetry-grey}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
    typography: "{typography.body}"
  button-ghost-hover:
    backgroundColor: "{colors.secondary-surface}"
    textColor: "{colors.readout-white}"
  filter-chip:
    backgroundColor: "{colors.secondary-surface}"
    textColor: "{colors.telemetry-grey}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
    typography: "{typography.mono}"
  filter-chip-active:
    backgroundColor: "{colors.nockta-violet-wash}"
    textColor: "{colors.readout-white}"
  card-task:
    backgroundColor: "{colors.console-black}"
    textColor: "{colors.readout-white}"
    rounded: "{rounded.md}"
    padding: "12px"
    typography: "{typography.body}"
  card-task-hover:
    backgroundColor: "{colors.raised-graphite}"
    textColor: "{colors.readout-white}"
  popover:
    backgroundColor: "{colors.panel-graphite}"
    textColor: "{colors.readout-white}"
    rounded: "{rounded.lg}"
    padding: "0px"
  input-text:
    backgroundColor: "{colors.console-black}"
    textColor: "{colors.readout-white}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    typography: "{typography.body}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.telemetry-grey}"
    rounded: "{rounded.md}"
    padding: "6px 8px"
    typography: "{typography.body}"
  nav-item-active:
    backgroundColor: "{colors.nockta-violet-wash}"
    textColor: "{colors.readout-white}"
  dialog:
    backgroundColor: "{colors.panel-graphite}"
    textColor: "{colors.readout-white}"
    rounded: "{rounded.lg}"
    padding: "0px"
---

# Design System: Nockta Flow

## 1. Overview

**Creative North Star: "The Operations Cockpit"**

Nockta Flow is a cockpit. Engineers sit at it for hours. The instrument panel is dim and uncluttered, status reads like indicator lights, every control is reachable without leaving the seat. The interface is calmest when the work is loudest. Surfaces step in luminance, not in colour. A single brand chroma carries identity; everything else is monochrome punctuation.

This system explicitly rejects the four traps that pull most PM tools into category cliché: the dense corporate blue-and-grey of Jira, the cream-and-gradient SaaS template aesthetic that defaults out of every Vercel starter, the feature-shelf maximalism of ClickUp, and the cosy pastel emoji warmth of Notion. None of those would survive a four-hour shift in deep work.

**Key Characteristics:**
- Dark-first, near-monochrome surfaces. Light mode exists but is opt-in.
- One brand chroma (Nockta Violet) carrying identity. Everything else is graphite.
- Status colours used as punctuation, never decoration.
- Tonal layering for depth. No drop shadows on resting surfaces.
- Monospace metadata (ticket keys, timestamps, eyebrows). Geometric sans for titles. Humanist sans for body.
- Hairline borders (1px, `Hairline #28282b`) as type rulers, not as boxes.
- Motion under 200ms, always GPU. Press-feedback on every interactive element.

## 2. Colors

Near-monochrome surfaces tinted toward the brand hue, with one saturated accent and four meaning-carrying status colours.

### Primary
- **Nockta Violet** (`#a78bfa`, `oklch(73% 0.16 285)`): the only persistent chroma in the system. Used on the active brand mark, primary focus ring, in-progress status indicator, active nav item background wash, and bookmark / saved-view accents. Appears on roughly 5 to 10 percent of any given screen. Its rarity is the point.
- **Nockta Violet Wash** (`#2a1f4a`): the desaturated companion. Used for active backgrounds where the foreground text needs to stay readable (active nav row, selected filter chip, hover wash on tappable rows).

### Tertiary (status family)
- **Signal Lime** (`#d8e64f`): in-review state. Reads as "lit, awaiting confirmation".
- **Drift Teal** (`#61d0bc`): done state. Reads as "settled, no longer needing attention".
- **Alert Coral** (`#f86958`): testing / critical-priority state. Reads as "warm, requires inspection".
- **Stop Red** (`#ed4a3b`): blocked state. Reads as "stop now". The only colour in the system that demands action by sight alone.

### Neutral (tonal staircase, dark to less dark)
- **Hangar Dark** (`#0c0c0d`): the deepest layer. Page background. 95 percent of any given pixel.
- **Console Black** (`#131315`): cards, task tiles, inputs at rest. One step up from background.
- **Raised Graphite** (`#1c1c1e`): cards on hover, secondary-surface controls. Two steps up.
- **Panel Graphite** (`#181819`): popovers, menus, dialog bodies. The "things that float" tone.
- **Secondary Surface** (`#232325`): tappable secondary buttons, filter chips, inline pill backgrounds.
- **Hairline** (`#28282b`): every divider, every border. The single border value in the entire system.
- **Telemetry Grey** (`#95959a`): muted-foreground. Labels, metadata, inactive nav items, descriptive copy.
- **Inert Grey** (`#888892`): todo / low-priority status. The colour of "nothing to see here, yet".
- **Readout White** (`#f5f5f5`): primary text. Never `#ffffff`; the warmth matters.

### Named Rules

**The Single-Chroma Rule.** Nockta Violet is the only colour the user sees on a default screen. Status colours appear only when their state is true. If a screen at rest needs more than the violet and the graphite ramp to read, the screen is over-decorated.

**The Status-as-Punctuation Rule.** Status colours are never decorative. A coloured pill in a filter sidebar without state meaning is forbidden. If a colour is on the page, something is in that state.

**The No-White Rule.** Never `#ffffff`. Foreground white is always `Readout White (#f5f5f5)`. Pure white is jarring on `Hangar Dark`; the off-white reads as paper, not as a torch.

## 3. Typography

**Display Font:** Plus Jakarta Sans (geometric sans, fallback Inter)
**Body Font:** Inter (humanist sans, fallback system-ui)
**Label / Mono Font:** JetBrains Mono (monospace, fallback SF Mono)

**Character:** Three voices, sharply separated. Plus Jakarta carries identity in page titles and the wordmark; it is the only place geometric warmth is allowed. Inter carries everything readable: task titles, descriptions, dialog copy. JetBrains Mono carries metadata and eyebrows; it reads as "system label" rather than "title", which is the difference between a label that respects the user and a label that shouts at them.

### Hierarchy
- **Display** (Plus Jakarta Sans, 700, 1.5rem, line-height 1.1, tracking -0.025em): page-level titles ("All tasks", "Settings", project names). Used once per screen.
- **Title** (Plus Jakarta Sans, 600, 1rem, tracking -0.01em): section titles inside a page, modal headers, drawer headers.
- **Body** (Inter, 400, 0.875rem, line-height 1.5): default text. Task titles, comments, descriptions. Body line length is capped at 65 to 75 characters.
- **Label** (JetBrains Mono, 500, 0.65rem, letter-spacing 0.16em, UPPERCASE): the `.nockta-eyebrow` style. Section eyebrows ("SAVED VIEWS", "WORKSPACE"), column headers ("IN PROGRESS"), micro-labels.
- **Mono** (JetBrains Mono, 500, 0.6875rem): ticket keys (`TCC-254`), timestamps, IDs, anything that is data not prose.

### Named Rules

**The Three-Voice Rule.** Three font families, never more. Each has one job: Plus Jakarta for identity, Inter for content, JetBrains Mono for system. Mixing them within a single component is prohibited unless the component is intentionally communicating a hierarchy split (e.g. a task card pairing a mono ticket key with an Inter task title).

**The Eyebrow Discipline.** Eyebrows are uppercase mono with wide letter-spacing. They label a region, not a value. A value never gets the eyebrow treatment; the label above it does.

## 4. Elevation

Depth is conveyed by tonal layering, not shadow. Resting surfaces sit at three luminances: `Hangar Dark` for the page, `Console Black` for cards, `Panel Graphite` for floating elements (popovers, dialogs). The staircase is the depth. Shadows appear only on overlay surfaces (modals, drag overlays) where the surface needs to "lift out" of the page rather than sit on it.

### Shadow Vocabulary
- **Ambient Lift** (`box-shadow: 0 12px 36px -8px hsl(0 0% 0% / 0.5)`): used on dialogs and drawers only. Communicates "this is above the page, dismissible by clicking out."
- **Hover Affordance** (no shadow; `Console Black` shifts to `Raised Graphite`): the only hover treatment for tappable rows / cards. The luminance step replaces the shadow that a less-disciplined system would add.

### Named Rules

**The Flat-At-Rest Rule.** Resting surfaces never carry a drop shadow. If a card has a shadow on rest, the card is fighting for attention with its own content. Shadows are a response to state (overlay, drag, focus glow), never a default.

## 5. Components

### Buttons
- **Shape:** 6px radius (`rounded.md`). Sharper than the SaaS default; soft enough not to read as terminal.
- **Primary:** `Readout White` background, `Hangar Dark` text, 6 by 12 padding. Used for the single primary action per dialog or section.
- **Ghost (default for toolbar / nav):** transparent at rest, `Telemetry Grey` text. Hover swaps background to `Secondary Surface` and text to `Readout White`. This is the dominant button variant; it pulls density down by not announcing itself until hovered.
- **Press feedback:** every button scales to 0.97 on `:active` via `transform`, easing on `--ease-snap` for 100ms. The page acknowledges the click before the network round-trip starts.

### Filter Chips
- **Style:** `Secondary Surface` background, mono typography at 11px, 4 by 8 padding, 6px radius. The chip looks like a small instrument readout.
- **Active state:** `Nockta Violet Wash` background, `Readout White` text. Active count badge appears as a small mono number inside the chip.
- **Compact only:** chips never wrap to a third line. If the toolbar overflows, less-used chips collapse into a "more" menu.

### Cards (task tile on a board)
- **Corner Style:** 6px radius (`rounded.md`).
- **Background:** `Console Black` at rest, `Raised Graphite` on hover.
- **Border:** 1px `Hairline`. The border is the only edge; no shadow, no inner glow.
- **Internal Padding:** 12px (`spacing.md`). Tight enough that 6 to 8 cards fit a column comfortably; loose enough that title and metadata don't collide.
- **Composition:** mono ticket key + type glyph (top-left), priority dot (top-right), body-weight title, optional metadata row (assignee avatar, due chip, label pills), optional bottom row (subtask toggle, blocked badge). Nothing else.

### Inputs / Fields
- **Style:** `Console Black` background, `Hairline` border, 6px radius, 8 by 12 padding, body typography.
- **Focus:** border shifts to `Nockta Violet` at 0.7 opacity; a 3px outer glow at `Nockta Violet / 0.18` confirms focus without flashing. The glow does not animate in; the colour eases for 160ms via `--ease-out`.
- **No labels above; eyebrows above.** Form fields are labelled by an eyebrow (uppercase mono) above the input, not by a sentence-case body label. The label is system, the input is content.

### Navigation (sidebar)
- **Style:** vertical list of ghost buttons, 6 by 8 padding per row, 13px body typography.
- **Default:** `Telemetry Grey` text on transparent background.
- **Hover:** `Telemetry Grey` text on `Hairline / 40%` background; light affordance, not a colour shift.
- **Active:** `Readout White` text on `Nockta Violet Wash` background. The single active wash is the only chromatic moment in the sidebar.
- **Section labels:** `.nockta-eyebrow` (uppercase mono) with an inline count chip in `Hairline / 60%` when the section has children.

### Popovers / Menus
- **Style:** `Panel Graphite` background, 8px radius, no shadow at rest, `Hairline` border, opens via `.animate-popover-in` (scale from 0.97 + translate-y -2px, 180ms `--ease-out`).
- **Transform origin** is set per anchor: top-right for right-aligned triggers, top-left for left-aligned. Never centered; the menu visibly belongs to its trigger.

### Dialogs
- **Style:** `Panel Graphite` body, 8px radius, full-screen scrim at `Background / 70%` with `backdrop-blur-sm`. Header is title + one-line eyebrow hint. Footer is right-aligned, ghost-Cancel + primary action.
- **Behaviour:** Esc closes, Enter submits, the input autofocuses and selects its content. Native `window.prompt()` is forbidden anywhere in the app; this dialog replaces it.

### Signature Component: Status Pill
A 1px-bordered chip carrying a status colour fill on the leading dot and the status name in body typography. Examples: `IN PROGRESS` with a `Nockta Violet` dot, `DONE` with a `Drift Teal` dot, `BLOCKED` with a `Stop Red` dot. The status pill is the only place outside the brand mark where colour is allowed to be definitive. Always paired with an icon or the status word; colour is never the only signal.

## 6. Do's and Don'ts

### Do:
- **Do** use `Nockta Violet` as the only persistent chroma. One brand colour, ≤10% of any screen.
- **Do** step luminance to create depth. `Hangar Dark` → `Console Black` → `Panel Graphite` for the three resting layers.
- **Do** use `JetBrains Mono` for every label, key, timestamp, and eyebrow.
- **Do** use 1px `Hairline` borders for every divider. One border colour, one border weight, everywhere.
- **Do** show focus rings. Every interactive element has a `Nockta Violet / 0.18` outer glow on `:focus-visible`. The focus ring is part of the design.
- **Do** keep motion under 200ms. Use `--ease-out` for enters, `--ease-snap` for press feedback. Animate only `transform` and `opacity`.
- **Do** apply optimistic updates. A click that mutates state shows the new state instantly; the network call follows.
- **Do** pair every status colour with an icon or label. Colour is never the only signal.

### Don't:
- **Don't** use `#ffffff` anywhere. `Readout White (#f5f5f5)` only.
- **Don't** use `#000000` anywhere. `Hangar Dark (#0c0c0d)` only. The cool tint is the brand.
- **Don't** add drop shadows to resting cards. Tonal layering is the only depth language on rest.
- **Don't** use `border-left` greater than 1px as a coloured stripe accent. Replaced by full borders or background tints.
- **Don't** use gradient text (`background-clip: text`). Emphasis is weight and size, never gradient fill.
- **Don't** use glassmorphism decoratively. Backdrop-blur appears on the modal scrim only.
- **Don't** ship a hero-metric card (big number + label + accent stripe). The SaaS cliché is banned by name.
- **Don't** wrap content in nested cards. A card inside a card is always wrong.
- **Don't** use modal as a first thought. Exhaust inline and progressive disclosure first.
- **Don't** introduce a second brand chroma. The system has Nockta Violet. Anything else is a status colour with a specific meaning.
- **Don't** call `window.prompt()` or `window.confirm()` from app code. Use the `NameViewDialog` pattern or an inline equivalent.
- **Don't** drift toward Jira's blue-and-grey palette, Notion's warm pastel tags, ClickUp's feature-shelf chrome, or the gradient-and-glass SaaS template look. All four are anti-references, named explicitly in PRODUCT.md.
- **Don't** congratulate the user. No success toasts on the happy path, no confetti, no "Nice work!" copy. Quiet competence is the brand.
