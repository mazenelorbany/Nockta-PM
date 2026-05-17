# Product

## Register

product

## Users

Engineers and designers at a 30-person org who keep Nockta Flow open in a side tab while they work. They are technically proficient, drive UI by keyboard when they can, and resent ceremony. They open a task, change its status, leave a comment, log time, and move on. Managers and leads also use it for sprint planning, standup review, and workload triage, but the surface optimises for the first cohort. A small client portal lets external clients file bugs and read status; that surface is intentionally thin.

The job to be done: "show me what I should be working on right now, let me move it forward, get out of my way."

## Product Purpose

Nockta Flow is the internal engineering operations platform for Nockta. It replaces Jira / Linear / ClickUp for the in-house engineering org and exposes a deliberately small portal to clients. Sprints, boards, comments, worklogs, audit / timeline, realtime collaboration, GitHub + Google Chat integration, and an AI assist layer for duplicate detection, blocker summaries, and standups.

Success is measured by the absence of complaint. The team migrated off Jira because Jira had become a tax on shipping. The win condition is that nobody is talking about the PM tool a quarter from now. Quiet competence beats delight. If engineers stop thinking about Nockta Flow at all and just use it, we won.

## Brand Personality

Confident and precise. Three words: sharp, restrained, fast. Voice in microcopy is direct and informed, never cute; no exclamation points, no congratulations, no emoji confetti. The tool reads as though it were made by engineers for engineers who also happen to have taste. Tone aims for the same register as Linear's product copy: an expert peer telling you what just happened, in as few words as possible.

The visual register matches: dark surfaces, monospace metadata, a single saturated brand purple as the only chroma the user sees most of the time, status colours used like punctuation, not decoration.

## Anti-references

This product must not look or feel like any of these, and noticing any of them is a regression:

- **Jira / Atlassian.** No nested modals, no settings hidden behind eight tabs, no dense corporate blue and grey palette, no "Loading…" spinner where an optimistic update would do. The tool we are replacing.
- **Generic AI-SaaS template.** No gradient hero metric cards, no rainbow icon tiles, no glassmorphism panels used decoratively, no abstract 3D illustrations, no "Welcome back, Mazen 👋" greetings. Specifically avoid the SaaS-cream aesthetic that defaults out of every Vercel template.
- **ClickUp "everything everywhere".** No feature shelves that expose every capability on every view. Hide what the current flow does not need.
- **Notion soft / cozy.** No warm off-whites, no rounded pastel tags, no handwritten illustrations, no cosy emoji-led empty states. Nockta is colder and sharper than that.

If a stranger looking at a screenshot can identify the category from the styling alone ("oh, a PM tool"), the styling has not done its job.

## Design Principles

1. **The work is loud, the tool is quiet.** Cards, copy, and tasks carry contrast. Chrome (sidebar, toolbar, headers) sits at low luminance and low chroma so the user's eye lands on content. Every pixel of decoration competes with a task title for attention.

2. **Keyboard parity is non-negotiable.** Every primary action that a mouse can do has a keyboard equivalent. Drag-and-drop is supplementary, not the only path. Focus rings are visible at all times; the focus indicator is part of the design, not an afterthought.

3. **Optimistic by default.** A click that mutates state shows the new state instantly. Network round-trips happen in the background and roll back on failure. No "saving…" toasts on the happy path. The latency budget for any primary action is zero.

4. **Hide capability until summoned.** Power lives one step away: command palette, hover affordances, right-click menus, "more" disclosures. New users see a clean surface, not a feature shelf. Veterans reach for shortcuts.

5. **One brand chroma, status as punctuation.** Nockta purple is the only persistent colour. Status palette (lime / coral / teal) is reserved for state communication and never used decoratively. The default page is near-monochrome; colour earns its place by carrying meaning.

## Accessibility & Inclusion

Target is functional accessibility for the engineer cohort: keyboard-first navigation across every primary surface, visible focus indicators on every interactive element, 4.5:1 contrast minimum on body text, status colours always paired with an icon or label so colour is never the sole signal. Reduced-motion preference is respected by all transitions. Full WCAG AAA conformance is not a goal; AA-equivalent contrast and keyboard reach across the active flows is.
