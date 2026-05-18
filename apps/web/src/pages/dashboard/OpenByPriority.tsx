import { PriorityDot, type Priority } from '../../components/task-bits';

import { Card } from './Card';
import type { PersonalDashboard } from './types';

export function OpenByPriority({ stats }: { stats: PersonalDashboard }): JSX.Element {
  return (
    <Card title={'My open work by priority'}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(['Critical', 'High', 'Medium', 'Low'] as Priority[]).map((p) => {
          const row = stats.openByPriority.find((x) => x.priority === p);
          const count = row?.count ?? 0;
          return (
            <div
              key={p}
              className="rounded-md bg-secondary/40 p-4 flex flex-col gap-2 transition-colors hover:bg-secondary/70"
            >
              <div className="flex items-center gap-2 nockta-eyebrow text-muted-foreground">
                <PriorityDot priority={p} />
                {p}
              </div>
              <div className="display-heading text-foreground tabular-nums leading-none" style={{ fontSize: 'clamp(1.6rem, 2.4vw, 2.2rem)' }}>
                {count}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
