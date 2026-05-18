import { useState } from 'react';
import { ArrowRight } from 'lucide-react';

import type { AccessUserOption } from '../types';

// AddGuestInline — pick an existing client user (always at role=Client) OR
// jump to the inline invite dialog if the right person isn't in the list yet.
export function AddGuestInline({
  clientUsers,
  pending,
  onSubmit,
  onInvite,
}: {
  clientUsers: AccessUserOption[];
  pending: boolean;
  onSubmit: (userId: string) => void;
  onInvite: () => void;
}): JSX.Element {
  const [userId, setUserId] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!userId) return;
        onSubmit(userId);
        setUserId('');
      }}
      className="flex flex-wrap items-center gap-2 px-3 py-2 bg-background/40 border-t border-border"
    >
      <select
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        className="flex-1 min-w-[180px] rounded-md border border-input bg-background px-2 py-1.5 text-xs"
      >
        <option value="">
          {clientUsers.length === 0
            ? 'No guests in the workspace yet — invite one →'
            : 'Pick an existing guest…'}
        </option>
        {clientUsers.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name || u.email}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={!userId || pending}
        className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        Add guest
      </button>
      <span className="text-muted-foreground/70 text-xs">or</span>
      <button
        type="button"
        onClick={onInvite}
        className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
      >
        Invite new guest by email
        <ArrowRight className="h-3 w-3" />
      </button>
    </form>
  );
}
