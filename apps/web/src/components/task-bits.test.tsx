// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import {
  AtRiskBadge,
  AvatarCircle,
  BlockedBadge,
  DueDateChip,
  PriorityDot,
  StatusPill,
  TypeBadge,
} from './task-bits';

// =============================================================================
// task-bits — RTL render tests for the small task primitives.
//
// vitest.config.ts is Node-only by default; this file opts into jsdom via the
// `@vitest-environment jsdom` pragma so we only pay the DOM-environment cost
// where it's needed. Together with the few other RTL specs added in this
// pass, this brings the rendering surface of the most-reused chips under
// regression coverage without rewiring the global vitest config.
//
// What we pin:
//   - PriorityDot: each of the four priority levels renders with the
//     priority-specific bg class.
//   - BlockedBadge: only renders when `blocked` is truthy.
//   - AtRiskBadge: only renders when `reason` is non-empty; title attribute
//     carries the reason text.
//   - StatusPill: renders the status string verbatim, mapped to a tone class.
//   - DueDateChip: renders relative labels (today / tomorrow / overdue) and
//     returns null for missing dueDate.
//   - AvatarCircle: unknown user renders the "?" placeholder; known user
//     renders the first initial.
//   - TypeBadge: aria-label matches the type's display name; showLabel
//     prints the label text inline.
// =============================================================================

describe('PriorityDot', () => {
  it('renders the sr-only label for accessibility', () => {
    const { getByText } = render(<PriorityDot priority="High" />);
    expect(getByText(/Priority: High/i)).toBeTruthy();
  });

  it('applies the priority-specific background class per level', () => {
    const classes: Record<string, string> = {
      Critical: 'bg-priority-critical',
      High: 'bg-priority-high',
      Medium: 'bg-priority-medium',
      Low: 'bg-priority-low',
    };
    for (const [p, cls] of Object.entries(classes)) {
      const { container } = render(
        <PriorityDot priority={p as 'Critical' | 'High' | 'Medium' | 'Low'} />,
      );
      // The dot is the inner aria-hidden span — class assertion lives there.
      const dot = container.querySelector('span[aria-hidden="true"]');
      expect(dot).toBeTruthy();
      expect(dot?.className).toContain(cls);
    }
  });

  it('sets the tooltip title with the priority label', () => {
    const { container } = render(<PriorityDot priority="Critical" />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.getAttribute('title')).toBe('Priority: Critical');
  });
});

describe('BlockedBadge', () => {
  it('renders the label when blocked', () => {
    const { getByText } = render(<BlockedBadge blocked={true} />);
    expect(getByText(/Blocked/i)).toBeTruthy();
  });

  it('returns null (renders nothing) when not blocked', () => {
    const { container } = render(<BlockedBadge blocked={false} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('AtRiskBadge', () => {
  it('renders the badge when a reason is provided, with the reason as the title', () => {
    const { container, getByText } = render(
      <AtRiskBadge reason="Two predecessors slipped" />,
    );
    expect(getByText(/At risk/i)).toBeTruthy();
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute('title')).toBe('Two predecessors slipped');
  });

  it('returns null when reason is empty / null', () => {
    expect(render(<AtRiskBadge reason={null} />).container.firstChild).toBeNull();
    expect(render(<AtRiskBadge reason={undefined} />).container.firstChild).toBeNull();
    expect(render(<AtRiskBadge reason="" />).container.firstChild).toBeNull();
  });
});

describe('StatusPill', () => {
  it('renders the status text verbatim', () => {
    const { getByText } = render(<StatusPill status="In Progress" />);
    expect(getByText('In Progress')).toBeTruthy();
  });

  it('applies a known tone for "Done"', () => {
    const { container } = render(<StatusPill status="Done" />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('text-status-done');
  });

  it('falls back to a muted tone for unknown status strings', () => {
    const { container } = render(<StatusPill status="Frozen" />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('text-muted-foreground');
  });
});

describe('DueDateChip', () => {
  it('returns null when no date is supplied', () => {
    const { container } = render(<DueDateChip dueDate={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders "today" when the due date is now', () => {
    const { getByText } = render(<DueDateChip dueDate={new Date()} />);
    expect(getByText('today')).toBeTruthy();
  });

  it('renders the overdue tone when past due and not done', () => {
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const { container } = render(<DueDateChip dueDate={past} />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('text-status-blocked');
    expect(root.textContent).toMatch(/overdue/);
  });

  it('uses the muted "done" tone when done=true even if past due', () => {
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const { container } = render(<DueDateChip dueDate={past} done={true} />);
    const root = container.firstChild as HTMLElement;
    // line-through indicates the "done" override path.
    expect(root.className).toContain('line-through');
  });
});

describe('AvatarCircle', () => {
  it('renders a "?" placeholder when no user is given', () => {
    const { getByText, container } = render(<AvatarCircle user={null} />);
    expect(getByText('?')).toBeTruthy();
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute('title')).toBe('Unassigned');
  });

  it('renders the uppercase first initial of the user name', () => {
    const { getByText } = render(
      <AvatarCircle user={{ id: 'u1', name: 'alice' }} />,
    );
    expect(getByText('A')).toBeTruthy();
  });

  it('falls back to the email when name is missing', () => {
    const { getByText } = render(
      <AvatarCircle user={{ id: 'u2', email: 'bob@example.com' }} />,
    );
    expect(getByText('B')).toBeTruthy();
  });
});

describe('TypeBadge', () => {
  it('exposes the type display name via aria-label', () => {
    const { container } = render(<TypeBadge type="Bug" />);
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute('aria-label')).toBe('Bug');
    expect(root.getAttribute('title')).toBe('Bug');
  });

  it('prints the type label text when showLabel is true', () => {
    const { getByText } = render(<TypeBadge type="Epic" showLabel />);
    expect(getByText('Epic')).toBeTruthy();
  });

  it('uses the right color class per type', () => {
    const { container } = render(<TypeBadge type="Story" />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/text-\[#36B37E\]/);
  });
});
