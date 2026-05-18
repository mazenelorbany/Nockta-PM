import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { cn } from '@nockta/ui';
import { useAuth } from '../lib/auth-store';
import { AiSettingsTab } from '../components/settings/AiSettingsTab';
import { AuditLogTab } from '../components/settings/AuditLogTab';
import { ExportsTab } from '../components/settings/ExportsTab';
import { ImportCenterTab } from '../components/settings/ImportCenterTab';
import { IntegrationsTab } from '../components/settings/IntegrationsTab';
import { MembersTab } from '../components/settings/MembersTab';
import { NotificationsTab } from '../components/settings/NotificationsTab';
import { ProfileTab } from '../components/settings/ProfileTab';
import { ProjectsAdminTab } from '../components/settings/ProjectsAdminTab';
import { SecurityTab } from '../components/settings/SecurityTab';
import { TeamsTab } from '../components/settings/TeamsTab';
import { WebhooksTab } from '../components/settings/WebhooksTab';

// =============================================================================
// /settings — tab shell with sub-routes.
//
// This page is intentionally thin: it owns the page chrome (header + side rail)
// and delegates the actual tab content to the components under
// `components/settings/*`. Each tab is in its own file with its own queries,
// state, and types; primitives shared across tabs (SectionTitle, Field,
// EditableField, HelpHint, etc.) live in `components/settings/primitives.tsx`.
//
// Admin-only tabs are still hidden from the nav for non-admin users — the tab
// components themselves also gate via <AdminGate /> as a defence-in-depth.
// =============================================================================

export function SettingsPage(): JSX.Element {
  const { user } = useAuth();
  const location = useLocation();
  const isAdmin = user?.companyRole === 'Admin';

  // We translate labels at render time rather than baking them into the tabs
  // array so a language switch immediately re-labels the rail without a
  // remount. The `group` key is also the i18n key — see the groupOrder map
  // below for its display label.
  type TabDef = { to: string; label: string; group: 'Account' | 'Workspace' };
  const tabs: TabDef[] = [
    { to: '/settings/profile', label: 'Profile', group: 'Account' },
    { to: '/settings/security', label: 'Security & Privacy', group: 'Account' },
    { to: '/settings/notifications', label: 'Notifications', group: 'Account' },

    { to: '/settings/integrations', label: 'Integrations', group: 'Workspace' },
    // AI is readable by anyone (so a Member can see the workspace's current
    // AI knobs); the tab itself gates the write controls on isAdmin.
    { to: '/settings/ai', label: 'AI', group: 'Workspace' },
    ...(isAdmin
      ? ([
          { to: '/settings/members', label: 'Members', group: 'Workspace' },
          { to: '/settings/teams', label: 'Teams', group: 'Workspace' },
          { to: '/settings/projects', label: 'Projects', group: 'Workspace' },
          { to: '/settings/imports', label: 'Import center', group: 'Workspace' },
          // Round 5 Pass 2 — workspace-level outbound webhooks tab. Admin-only.
          { to: '/settings/webhooks', label: 'Webhooks', group: 'Workspace' },
          // Round 6 Pass E — scheduled / on-demand data exports. Sits next to
          // Webhooks because both surface the same "workspace plumbing"
          // affordance (subscribe / fan-out vs schedule / materialise).
          { to: '/settings/exports', label: 'Exports', group: 'Workspace' },
          { to: '/settings/audit', label: 'Audit log', group: 'Workspace' },
        ] as TabDef[])
      : []),
  ];

  // Group tabs for the sidebar — Account first, Workspace second.
  const grouped = tabs.reduce<Record<string, TabDef[]>>((acc, tab) => {
    const k = tab.group;
    (acc[k] ??= []).push(tab);
    return acc;
  }, {});
  const groupOrder: Array<{ key: 'Account' | 'Workspace'; label: string }> = [
    { key: 'Account', label: 'Account' },
    { key: 'Workspace', label: 'Workspace' },
  ];

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 md:px-8 py-4 sm:py-5 border-b border-border">
        <h1 className="text-lg sm:text-xl font-semibold tracking-tight">{'Settings'}</h1>
        <p className="text-xs text-muted-foreground mt-0.5 truncate">{user?.email}</p>
      </header>

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Mobile: horizontal scroll-snap tab strip. Desktop: left rail. */}
        <nav className="md:w-60 md:border-r border-b md:border-b-0 border-border p-2 sm:p-3 md:space-y-4 overflow-x-auto md:overflow-y-auto flex md:block gap-2 md:gap-0 shrink-0">
          {groupOrder.map((g) => {
            const items = grouped[g.key];
            if (!items || items.length === 0) return null;
            return (
              <div key={g.key} className="md:block flex gap-1 shrink-0">
                <div className="hidden md:block nockta-eyebrow text-muted-foreground/60 px-3 mb-1">
                  {g.label}
                </div>
                <div className="flex md:block md:space-y-0.5 gap-1">
                  {/* Renamed local from `t` → `tab` to avoid shadowing the
                      i18n translator helper above. */}
                  {items.map((tab) => (
                    <NavLink
                      key={tab.to}
                      to={tab.to}
                      className={({ isActive }) =>
                        cn(
                          'row-hover whitespace-nowrap md:whitespace-normal md:block px-3 py-1.5 rounded-md text-sm',
                          isActive
                            ? 'bg-accent text-foreground font-medium'
                            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                        )
                      }
                    >
                      {tab.label}
                    </NavLink>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="flex-1 overflow-auto" key={location.pathname}>
          <Routes>
            <Route index element={<Navigate to="/settings/profile" replace />} />
            <Route path="profile" element={<ProfileTab />} />
            <Route path="security" element={<SecurityTab />} />
            <Route path="notifications" element={<NotificationsTab />} />
            <Route path="integrations" element={<IntegrationsTab />} />
            <Route path="ai" element={<AiSettingsTab isAdmin={isAdmin} />} />
            <Route path="members" element={<MembersTab isAdmin={isAdmin} />} />
            <Route path="teams" element={<TeamsTab isAdmin={isAdmin} />} />
            <Route path="projects" element={<ProjectsAdminTab isAdmin={isAdmin} />} />
            <Route path="imports" element={<ImportCenterTab isAdmin={isAdmin} />} />
            {/* Round 5 Pass 2 — outbound webhooks. Kept right above the wildcard so Pass 5 can append more routes here without merge conflicts. */}
            <Route path="webhooks" element={<WebhooksTab isAdmin={isAdmin} />} />
            {/* Round 6 Pass E — scheduled exports. */}
            <Route path="exports" element={<ExportsTab isAdmin={isAdmin} />} />
            <Route path="audit" element={<AuditLogTab isAdmin={isAdmin} />} />
            <Route path="*" element={<Navigate to="/settings/profile" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
