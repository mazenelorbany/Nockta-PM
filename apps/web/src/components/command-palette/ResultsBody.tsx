import { ArrowRight, FileText, Sparkles } from 'lucide-react';

import { StatusPill, TypeBadge } from '../task-bits';

import { ResultRow } from './ResultRow';
import { ResultSection } from './ResultSection';
import type { Hit } from './types';

/* -----------------------------------------------------------------------------
 * Results body — segmented sections with eyebrow group labels. Each item is
 * indexed against the flat `items` array for keyboard nav.
 * -------------------------------------------------------------------------- */

export function ResultsBody({
  items,
  activeIdx,
  setActiveIdx,
  openHit,
  query,
  taskCount,
  docCount,
  routeCount,
  recentCount,
  loading,
}: {
  items: Hit[];
  activeIdx: number;
  setActiveIdx: (i: number) => void;
  openHit: (h: Hit) => void;
  query: string;
  taskCount: number;
  docCount: number;
  routeCount: number;
  recentCount: number;
  loading: boolean;
}): JSX.Element {
  // Empty / loading / no-results states
  if (items.length === 0) {
    if (query.length === 0) {
      return (
        <div className="px-8 py-12 text-center">
          <Sparkles className="h-5 w-5 text-brand/60 mx-auto mb-2" />
          <div className="text-sm font-medium text-foreground">Jump anywhere.</div>
          <p className="text-xs text-muted-foreground mt-1.5 max-w-sm mx-auto leading-relaxed">
            Search any task or doc by keyword, or type the first letter of a destination
            to jump straight there.
          </p>
        </div>
      );
    }
    if (loading && query.length >= 2) {
      return <div className="px-4 py-6 text-xs text-muted-foreground">Searching…</div>;
    }
    return (
      <div className="px-8 py-10 text-center">
        <div className="text-sm text-foreground">No matches for "{query}"</div>
        <p className="text-xs text-muted-foreground mt-1.5">
          Try a key (e.g. NOCKTA-12), an assignee name, or a status.
        </p>
      </div>
    );
  }

  let cursor = 0;
  const sections: JSX.Element[] = [];

  // Recent (only when query is empty)
  if (recentCount > 0) {
    const slice = items.slice(cursor, cursor + recentCount);
    const start = cursor;
    sections.push(
      <ResultSection key="sec-recent" label="Recent">
        {slice.map((hit, i) => {
          const idx = start + i;
          const r = (hit as Extract<Hit, { kind: 'recent' }>).data;
          return (
            <ResultRow
              key={`recent-${r.id}`}
              active={idx === activeIdx}
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => openHit(hit)}
              icon={
                r.type === 'task'
                  ? <TypeBadge type="Task" />
                  : <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              }
              kicker={r.key}
              label={r.label}
            />
          );
        })}
      </ResultSection>,
    );
    cursor += recentCount;
  }

  // Routes (Jump To)
  if (routeCount > 0) {
    const slice = items.slice(cursor, cursor + routeCount);
    const start = cursor;
    sections.push(
      <ResultSection key="sec-routes" label={query ? 'Jump to' : 'Anywhere'}>
        {slice.map((hit, i) => {
          const idx = start + i;
          const r = (hit as Extract<Hit, { kind: 'route' }>).data;
          const Icon = r.icon;
          return (
            <ResultRow
              key={`route-${r.id}`}
              active={idx === activeIdx}
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => openHit(hit)}
              icon={<Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              label={r.label}
              hint={r.description}
              trailing={<ArrowRight className="h-3 w-3 text-muted-foreground/60" />}
            />
          );
        })}
      </ResultSection>,
    );
    cursor += routeCount;
  }

  // Tasks
  if (taskCount > 0) {
    const slice = items.slice(cursor, cursor + taskCount);
    const start = cursor;
    sections.push(
      <ResultSection key="sec-tasks" label="Tasks">
        {slice.map((hit, i) => {
          const idx = start + i;
          const t = (hit as Extract<Hit, { kind: 'task' }>).data;
          return (
            <ResultRow
              key={`task-${t.id}`}
              active={idx === activeIdx}
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => openHit(hit)}
              icon={<TypeBadge type={t.type ?? 'Task'} />}
              kicker={t.key}
              label={t.title}
              trailing={
                <span className="inline-flex items-center gap-2 shrink-0">
                  {t.project && (
                    <span className="text-[10px] nockta-eyebrow text-muted-foreground">
                      {t.project.key}
                    </span>
                  )}
                  <StatusPill status={t.status} />
                </span>
              }
            />
          );
        })}
      </ResultSection>,
    );
    cursor += taskCount;
  }

  // Docs
  if (docCount > 0) {
    const slice = items.slice(cursor, cursor + docCount);
    const start = cursor;
    sections.push(
      <ResultSection key="sec-docs" label="Docs">
        {slice.map((hit, i) => {
          const idx = start + i;
          const d = (hit as Extract<Hit, { kind: 'doc' }>).data;
          return (
            <ResultRow
              key={`doc-${d.id}`}
              active={idx === activeIdx}
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => openHit(hit)}
              icon={<FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              label={d.title}
              trailing={
                <span className="text-[10px] nockta-eyebrow text-muted-foreground shrink-0">
                  {d.projectKey}
                </span>
              }
            />
          );
        })}
      </ResultSection>,
    );
  }

  return <>{sections}</>;
}
