// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// =============================================================================
// NotificationsBell — RTL render test.
//
// The bell pulls data through three TanStack-Query hooks (`unread-count`,
// list, and the projects sidebar list) and subscribes to a socket-io channel
// for realtime invalidation. We mock both modules so the test exercises the
// component logic, not the network.
//
//   - `../lib/api` → returns synchronous canned responses for each endpoint.
//   - `../lib/socket` → resolves to a stub Socket with no-op on/off.
//
// What we pin:
//   - The trigger button has the right accessible name.
//   - The unread count badge surfaces the count from the API.
//   - Clicking the trigger opens the panel (Mark all read is reachable).
//   - Clicking "Mark all read" fires the POST mutation exactly once.
//   - When the API returns 0 unread, the badge does not render.
// =============================================================================

// ---- Module mocks -----------------------------------------------------------
// `vi.mock` calls are hoisted to the very top of the file (above all
// imports). Any module-scope variable they reference must be created via
// `vi.hoisted()` so it is initialised in the same hoisted phase. A plain
// `const apiMock = …` is hoisted only for the binding (TDZ), so the mock
// factory would throw `Cannot access 'apiMock' before initialization`.

const { apiMock, socketMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn<(path: string) => Promise<unknown>>(),
    post: vi.fn<(path: string, body?: unknown) => Promise<unknown>>(),
    patch: vi.fn<(path: string, body?: unknown) => Promise<unknown>>(),
  },
  socketMock: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/socket', () => ({
  getSocket: async () => socketMock,
}));
vi.mock('../lib/query-keys', () => ({
  queryKeys: {
    projects: () => ['projects'],
  },
}));

// Import the component AFTER the mocks are registered.
import { NotificationsBell } from './NotificationsBell';

function buildClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
}

function harness(): JSX.Element {
  return (
    <MemoryRouter>
      <QueryClientProvider client={buildClient()}>
        <NotificationsBell />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe('NotificationsBell', () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    socketMock.on.mockReset();
    socketMock.off.mockReset();

    apiMock.get.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count') return Promise.resolve({ count: 3 });
      if (path.startsWith('/notifications')) {
        return Promise.resolve({
          items: [
            {
              id: 'n1',
              type: 'TaskAssigned',
              payload: { title: 'Implement OAuth refresh' },
              relatedTaskId: 't1',
              relatedProjectId: 'p1',
              readAt: null,
              createdAt: new Date().toISOString(),
            },
            {
              id: 'n2',
              type: 'CommentAdded',
              payload: { title: 'New comment on review' },
              relatedTaskId: 't2',
              relatedProjectId: 'p1',
              readAt: null,
              createdAt: new Date().toISOString(),
            },
          ],
          nextCursor: null,
        });
      }
      if (path === '/projects') {
        return Promise.resolve([{ id: 'p1', key: 'NOCK', name: 'Nockta' }]);
      }
      return Promise.resolve(null);
    });
    apiMock.post.mockResolvedValue({});
    apiMock.patch.mockResolvedValue({});
  });

  it('renders an accessible trigger button labelled "Notifications"', () => {
    const { getByLabelText } = render(harness());
    const trigger = getByLabelText('Notifications');
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the unread count badge once the API resolves', async () => {
    const { findByText } = render(harness());
    expect(await findByText('3')).toBeTruthy();
  });

  it('opens the panel when the trigger is clicked', async () => {
    const { getByLabelText, findByText } = render(harness());
    const trigger = getByLabelText('Notifications');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // The header "Notifications" text appears inside the panel once open.
    expect(await findByText('Notifications', { selector: 'span' })).toBeTruthy();
  });

  it('renders the notification items once loaded', async () => {
    const { getByLabelText, findByText } = render(harness());
    fireEvent.click(getByLabelText('Notifications'));
    expect(await findByText('Implement OAuth refresh')).toBeTruthy();
    expect(await findByText('New comment on review')).toBeTruthy();
  });

  it('invokes the mark-all-read mutation when the button is clicked', async () => {
    const { getByLabelText, findByText } = render(harness());
    fireEvent.click(getByLabelText('Notifications'));
    const markAll = await findByText(/Mark all read/);
    fireEvent.click(markAll);
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/notifications/mark-all-read');
    });
  });

  it('hides the unread badge when the API returns 0 unread', async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count') return Promise.resolve({ count: 0 });
      return Promise.resolve({ items: [], nextCursor: null });
    });
    const { container, getByLabelText } = render(harness());
    // Wait for the query to settle (no badge).
    await waitFor(() => {
      const trigger = getByLabelText('Notifications');
      // The badge would be the only number-bearing span inside the button.
      const text = trigger.textContent ?? '';
      expect(text.trim()).toBe('');
    });
    // Defensive: make sure there's no "99+" overflow either.
    expect(container.textContent).not.toContain('99+');
  });
});
