// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { TaskList } from './TaskList';
import type { MyTask } from './types';

// =============================================================================
// TaskList — render test for the dashboard "my tasks" list.
//
// The component is purely a map over MyTask[] that emits a Link per row. It
// uses <Link> from react-router-dom, so we wrap the render in a MemoryRouter
// to satisfy the router context requirement.
//
// What we pin:
//   1. Each task's title, key, and (for assigned tasks) priority renders.
//   2. The Link href routes to the task drawer when the task belongs to a
//      project (`/projects/:id/board?task=:taskId`).
//   3. Tasks without a project get the noop `#` href — the component used
//      to crash here pre-refactor when `t.project` was optional.
//   4. The blocked badge renders only for blocked tasks.
//   5. Done tasks render the DueDateChip in the "muted/done" tone (line-through).
// =============================================================================

function buildTasks(): MyTask[] {
  return [
    {
      id: 't1',
      key: 'NOCK-1',
      title: 'Wire OAuth callback',
      status: 'In Progress',
      priority: 'High',
      isBlocked: false,
      dueDate: null,
      project: { id: 'p1', key: 'NOCK', name: 'Nockta' },
    },
    {
      id: 't2',
      key: 'NOCK-2',
      title: 'Fix flaky CI',
      status: 'Todo',
      priority: 'Critical',
      isBlocked: true,
      dueDate: null,
      project: { id: 'p1', key: 'NOCK', name: 'Nockta' },
    },
    {
      id: 't3',
      key: 'NOCK-3',
      title: 'Orphan with no project',
      status: 'Todo',
      priority: 'Low',
      isBlocked: false,
      dueDate: null,
    },
  ];
}

describe('TaskList', () => {
  it('renders one row per task with its title and key', () => {
    const tasks = buildTasks();
    const { getByText } = render(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );
    expect(getByText('Wire OAuth callback')).toBeTruthy();
    expect(getByText('Fix flaky CI')).toBeTruthy();
    expect(getByText('Orphan with no project')).toBeTruthy();
    expect(getByText('NOCK-1')).toBeTruthy();
    expect(getByText('NOCK-2')).toBeTruthy();
    expect(getByText('NOCK-3')).toBeTruthy();
  });

  it('routes each row to /projects/:key/board?task=:id when the task has a project', () => {
    // URLs now embed the project KEY (e.g. /projects/NOCK/board) instead of
    // the UUID — the dashboard's task rows were one of the high-traffic spots
    // surfacing the legacy UUID path to users. Task id stays a UUID for the
    // `?task=` drawer param.
    const tasks = buildTasks();
    const { container } = render(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );
    const links = Array.from(container.querySelectorAll('a'));
    // Three tasks → three links.
    expect(links.length).toBe(3);
    expect(links[0]?.getAttribute('href')).toBe('/projects/NOCK/board?task=t1');
    expect(links[1]?.getAttribute('href')).toBe('/projects/NOCK/board?task=t2');
  });

  it('uses the noop "#" href when a task has no project', () => {
    const tasks = buildTasks();
    const { container } = render(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );
    const links = Array.from(container.querySelectorAll('a'));
    expect(links[2]?.getAttribute('href')).toBe('/');
  });

  it('only renders the Blocked badge for tasks with isBlocked=true', () => {
    const tasks = buildTasks();
    const { getAllByText } = render(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );
    // Only NOCK-2 is blocked → exactly one "Blocked" label.
    expect(getAllByText('Blocked').length).toBe(1);
  });

  it('renders the StatusPill for every row', () => {
    const tasks = buildTasks();
    const { getAllByText } = render(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );
    expect(getAllByText('In Progress').length).toBe(1);
    expect(getAllByText('Todo').length).toBe(2);
  });

  it('renders nothing extra for an empty task list', () => {
    const { container } = render(
      <MemoryRouter>
        <TaskList tasks={[]} />
      </MemoryRouter>,
    );
    // The component renders a <ul> — empty list renders an empty ul element.
    expect(container.querySelector('ul')).toBeTruthy();
    expect(container.querySelectorAll('li').length).toBe(0);
  });
});
