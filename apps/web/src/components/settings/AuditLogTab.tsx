import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SkeletonList } from '@nockta/ui';
import { api } from '../../lib/api';
import { AdminGate, SectionTitle } from './primitives';

// =============================================================================
// AuditLogTab — read-only list of every admin-visible event. Server-side this
// table is append-only; the UI never offers a destructive action.
// =============================================================================

interface AuditEvent {
  id: string;
  type: string;
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  visibility: string;
  createdAt: string;
  actor?: { id: string; name: string } | null;
}

export function AuditLogTab({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  const { t, i18n } = useTranslation();
  const auditQuery = useQuery({
    queryKey: ['audit-log'],
    queryFn: () =>
      api.get<{ items: AuditEvent[]; nextCursor: string | null }>(
        '/audit-log?limit=100',
      ),
    enabled: isAdmin,
  });

  if (!isAdmin) return <AdminGate />;

  const events = auditQuery.data?.items ?? [];

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-4xl space-y-4">
      <SectionTitle
        title={t('settings.audit.title', 'Audit log')}
        hint={t('settings.audit.hint', 'Every admin-visible event. Immutable.')}
      />
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="hidden md:grid grid-cols-[180px_180px_1fr_120px] px-4 py-2 bg-secondary/40 border-b border-border text-xs nockta-eyebrow text-muted-foreground">
          <span>{t('settings.audit.when', 'When')}</span>
          <span>{t('settings.audit.actor', 'Actor')}</span>
          <span>{t('settings.audit.event', 'Event')}</span>
          <span>{t('settings.audit.entity', 'Entity')}</span>
        </div>
        {auditQuery.isLoading ? (
          <div className="p-3"><SkeletonList rows={8} rowClassName="h-7" /></div>
        ) : events.length === 0 ? (
          <div className="p-6 text-xs text-muted-foreground text-center">
            {t('settings.audit.empty', 'No audit events.')}
          </div>
        ) : (
          <ul>
            {events.map((ev) => (
              <li
                key={ev.id}
                className="flex flex-col gap-1 md:grid md:grid-cols-[180px_180px_1fr_120px] md:items-baseline md:gap-3 px-4 py-2.5 border-b border-border last:border-b-0 text-xs"
              >
                <span className="font-mono text-muted-foreground">
                  {new Date(ev.createdAt).toLocaleString(i18n.language)}
                </span>
                <span>{ev.actor?.name ?? 'System'}</span>
                <span className="font-medium">{prettyType(ev.type)}</span>
                <span className="text-muted-foreground">{ev.entityType}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function prettyType(t: string): string {
  return t.replace(/[._]/g, ' ').toLowerCase();
}
