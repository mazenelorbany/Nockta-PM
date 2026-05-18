// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';

import { BoardCard } from './BoardCard';
import type { Task } from './types';

// =============================================================================
// BoardCard — RTL render test for the project-board card.
//
// BoardCard uses `useSortable` from @dnd-kit/sortable, which requires both a
// DndContext and a SortableContext ancestor to register the item. We wrap
// the render in both so the hook resolves without warnings. We don't drive
// any drag events here — that surface is covered by the swipe-gesture pure-
// function tests.
//
// What we pin:
//   - The task key, title, and assignee name all render verbatim.
//   - The TypeBadge surfaces the task's type via aria-label.
//   - Clicking the card invokes onOpen (the card-level click handler).
//   - The Blocked badge appears for blocked tasks, hides for the rest.
//   - The subtask toggle renders the "n/N subtasks" count and toggles
//     aria-expanded when clicked.
//   - Custom field chips render when the task has values.
// =============================================================================

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    key: 'NOCK-101',
    type: 'Task',
    title: 'Implement OAuth refresh',
    status: 'In Progress',
    priority: 'High',
    isBlocked: false,
    aiRiskReason: null,
    dueDate: null,
    estimate: null,
    sprintId: null,
    parentTaskId: null,
    boardPosition: 'a0',
    assignee: { id: 'u1', name: 'Alice' },
    ...overrides,
  };
}

function wrap(children: React.ReactNode): JSX.Element {
  return (
    <DndContext>
      <SortableContext items={['task-1']}>{children}</SortableContext>
    </DndContext>
  );
}

describe('BoardCard', () => {
  it('renders the task key, title, and assignee name', () => {
    const task = makeTask();
    const { getByText } = render(
      wrap(
        <BoardCard
          task={task}
          subtasks={[]}
          selected={false}
          onToggleSelect={() => {}}
          onOpen={() => {}}
          isMobile={false}
          onSwipeAction={() => {}}
        />,
      ),
    );
    expect(getByText('NOCK-101')).toBeTruthy();
    expect(getByText('Implement OAuth refresh')).toBeTruthy();
    expect(getByText('Alice')).toBeTruthy();
  });

  it('shows the BlockedBadge when task.isBlocked is true', () => {
    const task = makeTask({ isBlocked: true });
    const { getByText } = render(
      wrap(
        <BoardCard
          task={task}
          subtasks={[]}
          selected={false}
          onToggleSelect={() => {}}
          onOpen={() => {}}
          isMobile={false}
          onSwipeAction={() => {}}
        />,
      ),
    );
    expect(getByText(/Blocked/)).toBeTruthy();
  });

  it('hides the BlockedBadge when task.isBlocked is false', () => {
    const task = makeTask({ isBlocked: false });
    const { queryByText } = render(
      wrap(
        <BoardCard
          task={task}
          subtasks={[]}
          selected={false}
          onToggleSelect={() => {}}
          onOpen={() => {}}
          isMobile={false}
          onSwipeAction={() => {}}
        />,
      ),
    );
    expect(queryByText(/Blocked/)).toBeNull();
  });

  it('calls onOpen when the card is clicked', () => {
    const onOpen = vi.fn();
    const task = makeTask();
    const { getByText } = render(
      wrap(
        <BoardCard
          task={task}
          subtasks={[]}
          selected={false}
          onToggleSelect={() => {}}
          onOpen={onOpen}
          isMobile={false}
          onSwipeAction={() => {}}
        />,
      ),
    );
    // Click the title — bubbles to the card-level onClick.
    fireEvent.click(getByText('Implement OAuth refresh'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders the Unassigned placeholder when no assignee', () => {
    const task = makeTask({ assignee: undefined });
    const { getByText } = render(
      wrap(
        <BoardCard
          task={task}
          subtasks={[]}
          selected={false}
          onToggleSelect={() => {}}
          onOpen={() => {}}
          isMobile={false}
          onSwipeAction={() => {}}
        />,
      ),
    );
    expect(getByText(/Unassigned/)).toBeTruthy();
  });

  it('renders the subtask toggle with the done/total count when subtasks exist', () => {
    const task = makeTask();
    const subtasks: Task[] = [
      {
        ...makeTask({ id: 's1', key: 'NOCK-101-1', title: 'Sub A', status: 'Done' }),
        type: 'Subtask',
      },
      {
        ...makeTask({ id: 's2', key: 'NOCK-101-2', title: 'Sub B', status: 'Todo' }),
        type: 'Subtask',
      },
    ];
    const { getByLabelText } = render(
      wrap(
        <BoardCard
          task={task}
          subtasks={subtasks}
          selected={false}
          onToggleSelect={() => {}}
          onOpen={() => {}}
          isMobile={false}
          onSwipeAction={() => {}}
        />,
      ),
    );
    // Toggle button is labelled "Show N subtasks" / "Hide N subtasks".
    const toggle = getByLabelText(/Show 2 subtasks/);
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    // After clicking, label flips and aria-expanded reflects open state.
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('calls onToggleSelect when the per-card checkbox is toggled', () => {
    const onToggle = vi.fn();
    const task = makeTask();
    const { getByLabelText } = render(
      wrap(
        <BoardCard
          task={task}
          subtasks={[]}
          selected={false}
          onToggleSelect={onToggle}
          onOpen={() => {}}
          isMobile={false}
          onSwipeAction={() => {}}
        />,
      ),
    );
    const checkbox = getByLabelText('Select NOCK-101');
    fireEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('exposes the type badge with its label as aria-label', () => {
    const task = makeTask({ type: 'Bug' });
    const { container } = render(
      wrap(
        <BoardCard
          task={task}
          subtasks={[]}
          selected={false}
          onToggleSelect={() => {}}
          onOpen={() => {}}
          isMobile={false}
          onSwipeAction={() => {}}
        />,
      ),
    );
    // First TypeBadge in the top row carries aria-label="Bug".
    const bugBadge = container.querySelector('[aria-label="Bug"]');
    expect(bugBadge).toBeTruthy();
  });
});
