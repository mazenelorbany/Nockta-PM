# @nockta/web

The internal Nockta Flow SPA. React 18 + Vite + TanStack Query + Tailwind + Tiptap + dnd-kit + Socket.IO client + Zustand. Lives at `apps/web/`.

See also: [`/README.md`](../../README.md) for the project overview, [`/docs/architecture.md`](../../docs/architecture.md) for the full architecture, [`/docs/adr/0005-tanstack-query-cache.md`](../../docs/adr/0005-tanstack-query-cache.md) for the server-state model, [`/docs/adr/0008-decomposed-task-drawer.md`](../../docs/adr/0008-decomposed-task-drawer.md) for the drawer refactor.

---

## Running

```bash
# Dev server (Vite, HMR enabled)
pnpm --filter @nockta/web dev           # http://localhost:5173

# Production build (typecheck + bundle)
pnpm --filter @nockta/web build         # tsc --noEmit && vite build

# Preview the production bundle locally
pnpm --filter @nockta/web preview
```

The dev server expects the API at `http://localhost:3000` (override with `VITE_API_URL` in `.env`). Auth tokens live in `localStorage` under `nockta.auth`.

---

## Testing

```bash
pnpm --filter @nockta/web test          # vitest run
pnpm --filter @nockta/web lint
pnpm --filter @nockta/web typecheck

# Accessibility (against a running dev server)
pnpm --filter @nockta/web a11y          # axe scan on / /dashboard /settings
```

Conventions:

- **Component tests** with `@testing-library/react` + `jsdom`. Mock the SDK; assert on user-visible behaviour, not implementation details.
- **`@axe-core/react`** is enabled in dev to catch accessibility regressions live.
- Mutation hooks are tested via React Testing Library + a `MockedQueryClient` provider; we assert on cache state after mutation, not on the network call shape.

---

## Component & directory structure

```
apps/web/src/
  api/                       SDK wrappers + TanStack Query keys + hooks
  features/                  Feature-scoped components (board, backlog, drawer, ...)
    task-drawer/             See ADR-0008 — shell + sections/ + tabs/
    board/
    backlog/
    timeline/
    sprints/
    workload/
    notifications/
    ai/
  components/                Cross-feature shared UI (modals, toasts, etc.)
  layouts/                   Top-level layouts (Authenticated, Public, ClientPortal)
  pages/                     Route-level components (mounted via react-router-dom)
  hooks/                     Cross-feature hooks (useFlag, useDebounce, ...)
  store/                     Zustand stores for UI-only state
  i18n/                      i18next config + translations
  lib/                       Utilities (date formatting, formatters, sentry)
  styles/                    Tailwind config inputs + global CSS
  realtime/                  Socket.IO client + invalidation routing
```

### Server vs. local state

- **Server state** (anything that came from the API) → TanStack Query. Keys live in `apps/web/src/api/queryKeys.ts`; mutations live next to their feature in `apps/web/src/api/hooks/`.
- **Local UI state** (open drawers, filter pickers, modal stacks) → Zustand. One store per concern.
- **URL state** (route, query params for shareable views) → react-router-dom `useSearchParams`.

Never put server data in `useState`. The cache is the source of truth.

### Realtime integration

`apps/web/src/realtime/RealtimeProvider.tsx` opens a Socket.IO connection with the access token, joins the user's rooms, and forwards events to a small router that invalidates the affected TanStack Query keys. Components don't subscribe to sockets directly — they just observe the cache. See ADR-0006.

### Optimistic updates

Used for drag-and-drop reorder (fractional indexing makes server-truth recovery safe), checkbox toggles, and inline-edit fields. Pattern: snapshot in `onMutate`, mutate the cache, restore in `onError`. Centralised helpers in `apps/web/src/api/optimistic.ts`.

---

## Design system pointer

UI primitives live in the `@nockta/ui` package (`packages/ui/`):

- Buttons, inputs, dialogs, drawers, dropdowns, tooltips, tabs, command-palette.
- Tailwind tokens + utility classes (`packages/ui/src/styles/tokens.css`).
- Icons via `lucide-react`.
- Charts via `recharts`.
- Rich text via `@tiptap/react` with shared extensions in `packages/ui/src/editor/`.

Component additions: prefer extending `@nockta/ui` if a primitive can be reused; keep feature-specific compositions inside `apps/web/src/features/`.

### Theming

Tailwind config: `apps/web/tailwind.config.ts`. Brand tokens (colors, spacing, type scale) live in `packages/ui/src/styles/tokens.css` and are consumed by both apps. Dark mode is class-based (`html.dark`); the toggle lives in the user menu.

---

## Internationalization (i18n)

Round 5 Pass 3 introduced first-class i18n support powered by `i18next` + `react-i18next` + `i18next-browser-languagedetector`.

### Supported locales

| Code | Label      | Direction |
| ---- | ---------- | --------- |
| `en` | English    | LTR       |
| `es` | Español    | LTR       |
| `ar` | العربية    | RTL       |

The Arabic translation is **placeholder-only** for this pass. The locale is fully wired up — selecting it flips `<html dir>` to `rtl`, exposes the locale-switcher entry in `العربية`, and routes through the same fallback chain as every other locale — but most strings still render in English. RTL layout is functional today (logical `ms-`/`me-`/`ps-`/`pe-`/`text-start`/`text-end`/`border-s`/`border-e` are used in the 30 most-trafficked components), so wiring Arabic translations is a straight content swap rather than a layout migration.

### Setup

- `apps/web/src/i18n/index.ts` initializes i18next, registers all three locales as ESM-imported JSON, applies `<html lang>` / `<html dir>` on boot, and listens for language changes to keep those attributes in sync.
- `apps/web/src/main.tsx` imports `./i18n` BEFORE the root render so the first paint is in the resolved locale.
- The locale switcher lives at **Settings → Profile → Language & region**. Changing it calls `i18n.changeLanguage(code)`, writes to `localStorage['nockta:locale']`, and updates `<html lang>` / `<html dir>` synchronously.

### Adding a translated string

```tsx
import { useTranslation } from 'react-i18next';

function Greeting(): JSX.Element {
  const { t } = useTranslation();
  // Always pass the English literal as the fallback — if a locale file is
  // missing the key, the literal still renders.
  return <h1>{t('greeting.hello', 'Hello, world')}</h1>;
}
```

Then add the key to `apps/web/src/locales/en.json` (source of truth) and any translated locales (`es.json`, `ar.json`). Spanish keys whose translation needs native-speaker review are tracked in `apps/web/src/locales/es.review.md`.

### Date and number formatting

Pass the active locale into Intl APIs so they respect the user's choice:

```tsx
const { i18n } = useTranslation();
new Date().toLocaleDateString(i18n.language, { weekday: 'long' });
new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'EUR' }).format(1234.56);
```

### RTL readiness

Tailwind v3.4 ships logical properties natively. Use them anywhere you used to use directional ones:

| Replace          | With            |
| ---------------- | --------------- |
| `ml-X` / `mr-X`  | `ms-X` / `me-X` |
| `pl-X` / `pr-X`  | `ps-X` / `pe-X` |
| `text-left`      | `text-start`    |
| `text-right`     | `text-end`      |
| `border-l`       | `border-s`      |
| `border-r`       | `border-e`      |

No plugin needed — Tailwind 3.3+ supports these built-in. The Round 5 Pass 3 audit covered the 30 highest-visibility files; new code should follow the same convention.

### i18n testing

`apps/web/src/i18n/i18n.test.ts` covers locale persistence, missing-key fallback, and the RTL direction toggle. Run with `pnpm --filter @nockta/web test`.

---

## Accessibility

Round 5 Pass 4 lifts the in-app accessibility floor to WCAG 2.1 AA. Practices the codebase now enforces:

- A keyboard-only **skip link** (`Skip to main content`) is the first focusable element of every authenticated page; it targets the `<main id="main-content" tabIndex={-1}>` element rendered by `Layout.tsx`.
- A visually-hidden **route announcer** (`RouteAnnouncer.tsx`) writes the new page name into a `role="status" aria-live="polite"` region on every SPA navigation, so screen readers narrate page changes the same way they would on a full reload.
- Every icon-only `<button>` carries an `aria-label`. The shadcn-style `Button` primitive in `@nockta/ui` ships with `focus-visible:ring-2 focus-visible:ring-offset-2`, so custom buttons that bypass the primitive must add the same focus-visible utilities.
- Color tokens defined in `packages/ui/src/styles.css` were audited; findings are documented in `apps/web/docs/a11y-contrast-audit.md`. Tokens were not changed by this pass — the audit is a punch list for design.

### Running axe in CI

`@axe-core/cli` is wired up as `pnpm --filter @nockta/web a11y`. It crawls the dev server's `/`, `/dashboard`, and `/settings` routes against the `wcag2a` + `wcag2aa` rule sets. The `--no-sandbox` flag is required when the script runs inside a containerized CI worker (puppeteer otherwise asks for `CAP_SYS_ADMIN`); on a developer laptop it is harmless.

```bash
# In one terminal
pnpm --filter @nockta/web dev

# In another
pnpm --filter @nockta/web a11y
```

### Component-level a11y tests

`apps/web/src/a11y.test.tsx` renders a handful of high-traffic components through `@testing-library/react` and asserts `expect(await axe(container)).toHaveNoViolations()`. The test file declares `// @vitest-environment jsdom` at the top because `jest-axe` walks a real DOM; the rest of the suite still runs in the default node environment.

---

## Build output & deploy

`vite build` produces a static bundle in `dist/`. The Railway service serves it via nginx (`apps/web/railway.json` + `apps/web/Dockerfile`). `VITE_API_URL` must be set as a **build-time** variable — Vite inlines it into the JS bundle.
