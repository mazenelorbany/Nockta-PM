import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, X } from 'lucide-react';
import { cn } from '@nockta/ui';
import { api } from '../../../lib/api';
import { AvatarCircle } from '../../task-bits';
import type { User } from '../types';
import { usePopover } from '../utils';
import { PopoverShell } from './Popover';

/**
 * Reporters picker — shows the primary reporter as a clickable avatar, plus
 * any co-reporters as additional avatars in the chip row. The "+" button at
 * the end opens a user picker that adds a co-reporter via POST.
 */
export function ReportersPicker({
  taskId,
  primary,
  coReporters,
  users,
  onChangePrimary,
}: {
  taskId: string;
  primary: User | null;
  coReporters: User[];
  users: User[];
  onChangePrimary: (id: string) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const pop = usePopover();
  const addPop = usePopover();

  const addCo = useMutation({
    mutationFn: (userId: string) => api.post(`/tasks/${taskId}/reporters/${userId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reporters', taskId] });
    },
  });
  const removeCo = useMutation({
    mutationFn: (userId: string) => api.delete(`/tasks/${taskId}/reporters/${userId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reporters', taskId] });
    },
  });

  // Eligible "add co-reporter" set = everyone except the primary and existing co-reporters.
  const existing = new Set<string>();
  if (primary) existing.add(primary.id);
  for (const c of coReporters) existing.add(c.id);
  const addable = users.filter((u) => !existing.has(u.id));

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {/* Primary reporter — clickable to swap */}
      <button
        type="button"
        onClick={pop.toggle}
        className="tap inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs hover:bg-accent/50 transition-colors"
        title={primary ? `Primary reporter: ${primary.name}` : 'Set reporter'}
      >
        {primary ? (
          <>
            <AvatarCircle user={primary} size={18} />
            <span className="truncate max-w-[120px]">{primary.name}</span>
          </>
        ) : (
          <span className="text-muted-foreground">No reporter</span>
        )}
        <span className="text-[9px] text-muted-foreground uppercase">primary</span>
      </button>

      {/* Co-reporter chips */}
      {coReporters.map((r) => (
        <span
          key={r.id}
          className="group inline-flex items-center gap-1 rounded-full bg-secondary/60 pr-1 pl-0.5 py-0.5"
          title={`Co-reporter: ${r.name}`}
        >
          <AvatarCircle user={r} size={16} />
          <span className="text-[11px] truncate max-w-[80px]">{r.name}</span>
          <button
            type="button"
            onClick={() => removeCo.mutate(r.id)}
            className="ml-0.5 text-muted-foreground/60 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label={`Remove ${r.name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}

      {/* Add co-reporter button */}
      {addable.length > 0 && (
        <div className="relative">
          <button
            type="button"
            onClick={addPop.toggle}
            className="tap inline-flex items-center justify-center w-5 h-5 rounded-full border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
            title="Add co-reporter"
          >
            <Plus className="h-3 w-3" />
          </button>
          <PopoverShell open={addPop.open} onClose={addPop.close} align="left" className="p-1 w-56 max-h-72 overflow-y-auto">
            {addable.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => {
                  addCo.mutate(u.id);
                  addPop.close();
                }}
                className="tap w-full flex items-center gap-2 rounded px-2 py-1.5 text-xs text-left hover:bg-muted/60"
              >
                <AvatarCircle user={u} size={18} />
                <span className="truncate">{u.name}</span>
              </button>
            ))}
          </PopoverShell>
        </div>
      )}

      {/* Primary-swap popover */}
      <PopoverShell open={pop.open} onClose={pop.close} align="left" className="p-1 w-56 max-h-72 overflow-y-auto">
        {users.map((u) => (
          <button
            key={u.id}
            type="button"
            onClick={() => {
              if (u.id !== primary?.id) onChangePrimary(u.id);
              pop.close();
            }}
            className={cn(
              'tap w-full flex items-center gap-2 rounded px-2 py-1.5 text-xs text-left hover:bg-muted/60',
              u.id === primary?.id && 'bg-muted/60',
            )}
          >
            <AvatarCircle user={u} size={18} />
            <span className="truncate">{u.name}</span>
            {u.id === primary?.id && <Check className="h-3 w-3 ml-auto text-primary" />}
          </button>
        ))}
      </PopoverShell>
    </div>
  );
}
