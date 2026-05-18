import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  UserCog,
} from 'lucide-react';
import { cn } from '@nockta/ui';

import { AvatarCircle } from '../../task-bits';

import type { CompanyRole, MemberUser, SortDir, SortField } from './types';

// =============================================================================
// PeopleTable — desktop table + mobile stacked-card view of members.
//
// At `md+` we render a real <table> with sortable column headers. Below that
// breakpoint we render the same rows as cards so the user doesn't have to
// horizontally scroll on a phone. Sort buttons stay accessible on mobile
// via a small sort control above the cards.
// =============================================================================

export function PeopleTable({
  rows,
  meId,
  archivedView,
  sortField,
  sortDir,
  onToggleSort,
  onSetSort,
  onOpen,
  onSetRole,
  onArchive,
  onUnarchive,
}: {
  rows: MemberUser[];
  meId: string | undefined;
  archivedView: boolean;
  sortField: SortField;
  sortDir: SortDir;
  onToggleSort: (field: SortField) => void;
  /** Used by the mobile dropdown to set both axes in a single state update. */
  onSetSort: (field: SortField, dir: SortDir) => void;
  onOpen: (id: string) => void;
  onSetRole: (id: string, role: CompanyRole) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
}): JSX.Element {
  return (
    <>
      {/* Mobile: sort control above the stacked cards. */}
      <div className="md:hidden flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{rows.length} rows</span>
        <label className="inline-flex items-center gap-1">
          Sort by
          <select
            value={`${sortField}-${sortDir}`}
            onChange={(e) => {
              const [f, d] = e.target.value.split('-') as [SortField, SortDir];
              onSetSort(f, d);
            }}
            className="rounded-md border border-input bg-background px-1.5 py-0.5 text-xs"
            aria-label="Sort members"
          >
            <option value="name-asc">Name (A–Z)</option>
            <option value="name-desc">Name (Z–A)</option>
            <option value="role-asc">Role (Admin first)</option>
            <option value="role-desc">Role (last)</option>
            <option value="joined-desc">Joined (newest)</option>
            <option value="joined-asc">Joined (oldest)</option>
            <option value="lastSeen-desc">Last seen (recent)</option>
            <option value="lastSeen-asc">Last seen (oldest)</option>
          </select>
        </label>
      </div>

      {/* Mobile: stacked cards. */}
      <ul className="md:hidden space-y-2 mt-2">
        {rows.map((m) => {
          const isMe = m.id === meId;
          const display = displayMember(m);
          const targetRole: CompanyRole = m.companyRole === 'Admin' ? 'Member' : 'Admin';
          return (
            <li
              key={m.id}
              className="rounded-lg border border-border bg-card/60 p-3 flex flex-col gap-2"
            >
              <button
                type="button"
                onClick={() => onOpen(m.id)}
                className="flex items-center gap-3 text-left w-full min-w-0"
              >
                <AvatarCircle user={m} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate flex items-center gap-1.5 flex-wrap">
                    <span className={cn(display.muted && 'text-muted-foreground italic')}>
                      {display.name}
                    </span>
                    {isMe && (
                      <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-px">
                        You
                      </span>
                    )}
                    {m.kind === 'client' && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-brand/15 text-brand font-semibold">
                        Client
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {display.secondary}
                  </div>
                </div>
                <span
                  className={cn(
                    'text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md font-semibold shrink-0',
                    m.companyRole === 'Admin'
                      ? 'bg-brand/15 text-brand'
                      : 'bg-secondary text-muted-foreground',
                  )}
                >
                  {m.companyRole ?? (m.kind === 'client' ? 'Client' : 'Member')}
                </span>
              </button>

              {(m.teams?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1">
                  {(m.teams ?? []).slice(0, 4).map((t) => (
                    <span
                      key={t.id}
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-secondary text-muted-foreground"
                    >
                      {t.name}
                    </span>
                  ))}
                  {(m.teams?.length ?? 0) > 4 && (
                    <span className="text-[10px] text-muted-foreground">
                      +{(m.teams?.length ?? 0) - 4}
                    </span>
                  )}
                </div>
              )}

              <div className="flex items-center gap-1.5 flex-wrap pt-1">
                {archivedView ? (
                  <button
                    type="button"
                    onClick={() => onUnarchive(m.id)}
                    className="tap inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors"
                  >
                    <ArchiveRestore className="h-3 w-3" />
                    Restore
                  </button>
                ) : (
                  <>
                    {m.kind !== 'client' && (
                      <button
                        type="button"
                        onClick={() => onSetRole(m.id, targetRole)}
                        disabled={isMe}
                        className="tap inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors disabled:opacity-40"
                      >
                        <UserCog className="h-3 w-3" />
                        Make {targetRole}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpen(m.id)}
                      className="tap inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors"
                    >
                      <UserCog className="h-3 w-3" />
                      Manage
                    </button>
                    <button
                      type="button"
                      onClick={() => onArchive(m.id)}
                      disabled={isMe}
                      className="tap ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-status-blocked hover:bg-status-blocked/10 transition-colors disabled:opacity-30"
                    >
                      <Archive className="h-3 w-3" />
                      Archive
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Desktop: real table with sortable column headers. */}
      <div className="hidden md:block rounded-lg border border-border bg-card/40 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-secondary/40 text-xs nockta-eyebrow text-muted-foreground">
              <th scope="col" className="px-4 py-2 text-left font-medium">
                <SortHeader
                  label="Member"
                  field="name"
                  sortField={sortField}
                  sortDir={sortDir}
                  onClick={onToggleSort}
                />
              </th>
              <th scope="col" className="px-2 py-2 text-left font-medium">Teams</th>
              <th scope="col" className="px-2 py-2 text-left font-medium">
                <SortHeader
                  label="Role"
                  field="role"
                  sortField={sortField}
                  sortDir={sortDir}
                  onClick={onToggleSort}
                />
              </th>
              <th scope="col" className="px-2 py-2 text-left font-medium">
                <SortHeader
                  label="Joined"
                  field="joined"
                  sortField={sortField}
                  sortDir={sortDir}
                  onClick={onToggleSort}
                />
              </th>
              <th scope="col" className="px-2 py-2 text-left font-medium">
                <SortHeader
                  label="Last seen"
                  field="lastSeen"
                  sortField={sortField}
                  sortDir={sortDir}
                  onClick={onToggleSort}
                />
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((m) => {
              const isMe = m.id === meId;
              const display = displayMember(m);
              const targetRole: CompanyRole = m.companyRole === 'Admin' ? 'Member' : 'Admin';
              return (
                <tr key={m.id} className="row-hover">
                  <td className="px-4 py-3 align-middle">
                    <button
                      type="button"
                      onClick={() => onOpen(m.id)}
                      className="flex items-center gap-3 text-left min-w-0 cursor-pointer w-full"
                    >
                      <AvatarCircle user={m} size={28} />
                      <span className="min-w-0">
                        <span className="text-sm font-medium truncate flex items-center gap-2">
                          <span
                            className={cn(display.muted && 'text-muted-foreground italic')}
                          >
                            {display.name}
                          </span>
                          {isMe && (
                            <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-px">
                              You
                            </span>
                          )}
                          {m.kind === 'client' && (
                            <span className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-brand/15 text-brand font-semibold">
                              Client
                            </span>
                          )}
                          {display.imported && (
                            <span
                              className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-priority-high/15 text-priority-high font-semibold"
                              title={`Original ID: ${m.email}`}
                            >
                              Imported · Jira
                            </span>
                          )}
                        </span>
                        <span className="block text-xs text-muted-foreground truncate">
                          {display.secondary}
                        </span>
                      </span>
                    </button>
                  </td>
                  <td className="px-2 py-3 align-middle">
                    <div className="flex flex-wrap gap-1 max-w-[220px]">
                      {(m.teams ?? []).slice(0, 3).map((t) => (
                        <span
                          key={t.id}
                          className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-secondary text-muted-foreground"
                          title={`Team: ${t.name}`}
                        >
                          {t.name}
                        </span>
                      ))}
                      {(m.teams?.length ?? 0) > 3 && (
                        <span className="text-[10px] text-muted-foreground">
                          +{(m.teams?.length ?? 0) - 3}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-3 align-middle">
                    <span
                      className={cn(
                        'text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md font-semibold',
                        m.companyRole === 'Admin'
                          ? 'bg-brand/15 text-brand'
                          : 'bg-secondary text-muted-foreground',
                      )}
                    >
                      {m.companyRole ?? (m.kind === 'client' ? 'Client' : 'Member')}
                    </span>
                  </td>
                  <td className="px-2 py-3 align-middle text-xs text-muted-foreground tabular-nums">
                    {m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-2 py-3 align-middle text-xs text-muted-foreground tabular-nums">
                    {m.lastSeenAt ? new Date(m.lastSeenAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3 align-middle text-right">
                    <div className="inline-flex items-center gap-1">
                      {archivedView ? (
                        <button
                          type="button"
                          onClick={() => onUnarchive(m.id)}
                          className="tap inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors"
                          title="Restore account"
                        >
                          <ArchiveRestore className="h-3 w-3" />
                          Restore
                        </button>
                      ) : (
                        <>
                          {m.kind !== 'client' && (
                            <button
                              type="button"
                              onClick={() => onSetRole(m.id, targetRole)}
                              disabled={isMe}
                              className="tap inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              title={isMe ? "You can't change your own role" : `Make ${targetRole}`}
                            >
                              <UserCog className="h-3 w-3" />
                              {targetRole}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onOpen(m.id)}
                            className="tap inline-flex items-center justify-center rounded-md w-7 h-7 text-muted-foreground hover:bg-accent transition-colors"
                            title="Manage"
                            aria-label="Manage"
                          >
                            <UserCog className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onArchive(m.id)}
                            disabled={isMe}
                            className="tap inline-flex items-center justify-center rounded-md w-7 h-7 text-muted-foreground hover:bg-status-blocked/10 hover:text-status-blocked transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                            title={isMe ? "You can't archive yourself" : 'Archive account'}
                            aria-label="Archive account"
                          >
                            <Archive className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SortHeader({
  label,
  field,
  sortField,
  sortDir,
  onClick,
}: {
  label: string;
  field: SortField;
  sortField: SortField;
  sortDir: SortDir;
  onClick: (field: SortField) => void;
}): JSX.Element {
  const active = field === sortField;
  return (
    <button
      type="button"
      onClick={() => onClick(field)}
      className={cn(
        'inline-flex items-center gap-1 hover:text-foreground transition-colors',
        active && 'text-foreground',
      )}
      aria-label={`Sort by ${label}`}
    >
      {label}
      {active ? (
        sortDir === 'asc' ? (
          <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowDown className="h-3 w-3" />
        )
      ) : (
        <ChevronsUpDown className="h-3 w-3 opacity-40" />
      )}
    </button>
  );
}

/**
 * Resolve a member into clean display fields. Jira-imported placeholder users
 * (created by scripts/import-from-jira.ts when Jira didn't return a real email)
 * have `email = "<jiraAccountId>@jira-imported.local"` and often `name === email`.
 * We surface them as "Unknown user" + an "Imported · Jira" badge instead of
 * showing the raw placeholder twice.
 */
function displayMember(m: MemberUser): {
  name: string;
  secondary: string;
  imported: boolean;
  muted: boolean;
} {
  const imported = m.email.endsWith('@jira-imported.local');
  if (imported) {
    const nameLooksLikePlaceholder = !m.name || m.name === m.email;
    return {
      name: nameLooksLikePlaceholder ? 'Unknown user' : m.name!,
      secondary: 'Imported placeholder — no real email on file',
      imported: true,
      muted: nameLooksLikePlaceholder,
    };
  }
  return {
    name: m.name || m.email,
    secondary: m.email,
    imported: false,
    muted: false,
  };
}
