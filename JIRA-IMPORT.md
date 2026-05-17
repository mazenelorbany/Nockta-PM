# Jira → Nockta Flow Import

One-shot importer that reads from your Jira workspace and inserts equivalent entities into the running Nockta Flow database.

## What gets imported

- **Projects** — one Nockta project per Jira project, name preserved, key derived (uppercase, 2–10 chars, collisions resolved automatically).
- **Workflow preset** — inferred from Jira project type: `software → engineering`, names containing "design/creative/marketing → design`, everything else → generic`.
- **Tasks** — one Nockta task per Jira issue, with title, description (ADF → Markdown), status (mapped to the chosen preset), priority, assignee, reporter, due date, creation timestamp, and **issue type** (Epic / Story / Task / Bug / Subtask).
- **Hierarchy** — Subtask `parent` links and Epic Link references (Jira's `customfield_10014`) are preserved as `parentTaskId`. A second pass after the issue scan wires every parent reference, so a Story under Epic A or a Subtask under Story B both land in the right place.
- **Comments** — one Nockta comment per Jira comment, body converted ADF → Markdown, author resolved by email.
- **Labels & components** — Jira labels create per-project Nockta `Label` rows (purple). Jira components also become labels, prefixed with `component:` and colored teal so categorical tags stay distinguishable from free-text labels.
- **Time spent** — Jira worklog entries become Nockta `Worklog` rows: per-user, with `seconds`, `startedAt`/`endedAt`, and the comment ADF→Markdowned into `note`. Zero-second entries are skipped (Nockta treats `endedAt IS NULL` as a live timer).
- **Timestamps** — task `createdAt` and `updatedAt` are both restored from Jira (the import does one raw-SQL pass at the end of the run to overwrite Prisma's auto-`@updatedAt`). Comment `createdAt` and `updatedAt` are preserved the same way. Due dates from `fields.duedate` land on `Task.dueDate`.
- **Users** — the importer pre-fetches the workspace user directory via `/rest/api/3/users/search` so it has the `active` flag and full email on every assignee/reporter/commenter lookup.
  - Only `active === true` human accounts (`accountType === 'atlassian'`) are imported. Inactive accounts and non-human accounts (app / customer) are silently remapped to the admin user so reporter/assignee FK chains stay intact.
  - Users with restricted email visibility still get a `<accountId>@jira-imported.local` placeholder so the schema stays valid.

## What is NOT imported (yet)

- **Attachments** — would require running each file through MinIO + ClamAV. Add later if needed.
- **Issue links** — blocks/related/duplicate links between issues are not preserved.
- **Sprints** — Jira sprint membership is not migrated; all tasks land in the backlog.
- **Custom fields** — Nockta Flow has no custom field system.

## Setup

1. Create a Jira API token at <https://id.atlassian.com/manage-profile/security/api-tokens> — name it something like "Nockta Flow import" and copy the value.

2. Open `apps/api/.env` and fill in:

   ```
   JIRA_DOMAIN=nockta.atlassian.net
   JIRA_EMAIL=you@nockta.com
   JIRA_API_TOKEN=<paste the token here>
   IMPORT_ADMIN_EMAIL=admin@nockta.com
   ```

3. (Optional) Limit to specific projects:

   ```
   IMPORT_PROJECT_KEYS=DEV,MER,PD
   ```

   Leave unset to import every visible Jira project.

## Run

The Nockta Flow database must be up. The api itself doesn't need to be running — the script talks to Postgres directly.

**Dry run first** (lists what would be imported, doesn't write anything):

```bash
pnpm --filter @nockta/api import:jira:dry
```

**Real run:**

```bash
pnpm --filter @nockta/api import:jira
```

You'll see per-project progress and a summary at the end:

```
✅ Done.
   projects created       18
   projects skipped       3
   tasks created          1247
   comments created       3091
   users created          42
   inactive accounts      11 (mapped to admin)
   labels created         87
   label links            624
   worklog entries        2,418
   total time imported    132d 4h 17m
   errors                 5
```

## Behavior details

- **Idempotency at the project level**: any Jira project whose name already exists in Nockta Flow is skipped wholesale. If you want to re-import a specific project, delete it in Nockta Flow first.
- **Per-issue errors don't kill the run**: if a single issue fails to import (e.g. malformed ADF), the script logs the failure and continues. Errors are summarized at the end.
- **Rate limiting**: the script paces itself at ~8 requests/sec to stay well under Jira's per-user rate limit. A full 1k-issue project takes 3–5 minutes including comments.
- **Status mapping**: Jira statuses are normalized to the destination workflow preset by keyword match:
  - Anything containing "done / closed / resolved / completed / cancelled" → `Done`.
  - Engineering preset: "test / qa / uat" → `Testing`, "review" → `In Review`, "progress / doing / development / selected" → `In Progress`, else `Todo`.
  - Design preset: "approv" → `Approved`, "review" → `In Review`, "progress" → `In Progress`, else `Todo`.
  - Generic preset: just `Todo / In Progress / Done`.
- **Priority mapping**: `Highest → Critical`, `High → High`, `Medium → Medium`, `Low / Lowest → Low`.
- **Board position**: tasks are placed sequentially in creation order using fractional-indexing keys, so the board view shows oldest at the top of each column.

## After the import

1. Refresh <http://localhost:5173/projects> — your Jira projects are now listed.
2. Click any project to see its Kanban board with all the issues mapped to columns.
3. New users have been created — their accounts work but won't actually receive notifications until they log in once via the dev-login or Google OAuth.

## Re-running / cleanup

To wipe the imported data without tearing the Docker stack down, use the
in-tree wipe script. It TRUNCATES every Prisma model table (CASCADE), drops
monthly `Event_YYYY_MM` partitions, empties the dev S3 bucket, deletes the
Qdrant `tasks` collection, and flushes Redis:

```bash
WIPE_CONFIRM=YES pnpm --filter @nockta/api wipe:local
pnpm --filter @nockta/api import:jira
```

The wipe refuses to run unless `WIPE_CONFIRM=YES` is set, and refuses outright
when `NODE_ENV=production`. Schema and migrations are untouched — the API
boot path will re-seed Event partitions and the Qdrant collection.

For a more thorough reset that also clears the Postgres / Redis / MinIO
volumes themselves:

```bash
docker compose -f infra/docker-compose.yml down -v
bash scripts/dev.sh
pnpm --filter @nockta/api import:jira
```
