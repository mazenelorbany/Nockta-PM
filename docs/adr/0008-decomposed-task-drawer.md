# ADR-0008: Decomposing the 3,902-line TaskDrawer god component

- **Date:** 2026-05-08
- **Status:** Accepted

## Context

The task drawer — the right-side panel that opens when you click a task on the board, backlog, or timeline — had grown to **3,902 lines in a single `TaskDrawer.tsx` file**. It owned:

- Header (title, key, breadcrumbs, status pill, assignee picker, watch / mute buttons).
- Description editor (Tiptap with mention + attachment + image upload).
- Properties panel (assignee, reporter, priority, story points, due date, sprint, labels, custom fields, parent task).
- Subtasks list (CRUD, drag-reorder, conversion).
- Task links (blocks / related / duplicate; cross-project picker).
- Comments thread (Tiptap editor, threading, mention, soft-delete, edit-lock countdown, inline image upload).
- Activity timeline tab (Event rows rendered with type-specific formatters).
- Attachments tab (upload, AV-scan status, thumbnail, signed download URL).
- GitHub tab (linked PRs, auto-status preview).
- AI tab (duplicate suggestions, blocker summary, ask-the-task).
- Realtime presence + typing indicator.
- A dozen mutation hooks and their optimistic update logic.

Symptoms:

- **Merge conflicts on every PR** that touched the drawer.
- **Build / typecheck times** ballooned because Vite reanalyzes the whole file on every edit.
- **Cognitive load** — onboarding a new engineer to "just fix this small bug in the priority dropdown" required scrolling past 2,500 lines of unrelated code.
- **Test coverage** was effectively zero; the file was untestable as a unit.
- **Realtime + optimistic-update race conditions** were hard to reason about because mutation logic was intertwined with rendering logic.

We need a refactor that keeps the user-facing behaviour identical, doesn't break in-flight feature branches, and lets us add the next tab (AI v2) without bloating the file further.

## Decision

Decompose `TaskDrawer.tsx` into a **drawer shell + tab modules + section modules**, with the following shape:

```
apps/web/src/features/task-drawer/
  TaskDrawer.tsx                    ← shell: routing, layout, top-level state
  hooks/
    useTaskDrawerQuery.ts           ← single TanStack Query for the task
    useTaskMutations.ts             ← centralised mutation helpers
    useTaskRealtime.ts              ← subscribes to task:{id} room
  sections/
    Header/
    Description/
    Properties/
      AssigneePicker.tsx
      PriorityPicker.tsx
      DatePicker.tsx
      LabelPicker.tsx
      CustomFields.tsx
      ParentTaskPicker.tsx
    Subtasks/
    TaskLinks/
  tabs/
    CommentsTab.tsx
    ActivityTab.tsx
    AttachmentsTab.tsx
    GithubTab.tsx
    AiTab.tsx
```

Rules:

1. The shell owns layout, the tab router, and the task query. Nothing else.
2. Each section / tab is < 400 lines, owns its own mutations via `useTaskMutations`, and renders against the cached task from `useTaskDrawerQuery`.
3. Mutations always go through `useTaskMutations` — no `useMutation` calls scattered across sections. This centralises optimistic-update logic and makes it testable.
4. Realtime invalidation is a single `useTaskRealtime` hook that subscribes to the `task:{id}` room and invalidates `['task', taskId]` on relevant events. Sections do not handle realtime themselves.
5. Tab modules lazy-load via `React.lazy` — the AI tab is only imported when the user opens it, keeping the initial drawer bundle small.

The migration is incremental: PRs land one section at a time, with the legacy code paths staying live behind a `useFlag('task-drawer-v2')` switch until parity is verified.

## Consequences

- **+** Each file is independently reviewable, testable, and replaceable.
- **+** Lazy-loaded tabs reduce initial drawer JS by ~40%.
- **+** Mutation logic is centralised; race conditions are easier to reason about.
- **+** New tabs (AI v2) add a file, not 500 lines to an existing one.
- **+** Test coverage is now possible — section components can be rendered in isolation with mocked mutations.
- **−** The directory layout is more to navigate. Mitigated by colocating related sections and by `index.ts` re-exports.
- **−** During the migration there are two code paths behind a flag; we must keep both green. The flag is removed once parity tests pass.
- **−** Some props now travel through one extra level (shell → tab → section). Net legibility win even so.
