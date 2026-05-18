// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

import { GreetingHero } from './GreetingHero';

// =============================================================================
// GreetingHero — render test for the personal-dashboard hero strip.
//
// The component is mostly presentational, but it does two non-obvious things
// we want to pin:
//
//   1. It renders one of four greetings depending on the current hour
//      ("Working late" / "Good morning" / "Good afternoon" / "Good evening").
//      We freeze the system clock with vi.useFakeTimers so the assertion
//      doesn't drift between test runs.
//
//   2. The "New task" button dispatches a synthetic Cmd-K keydown so the
//      command palette opens. We listen on window for that event and assert
//      the modifier + key match what CommandPalette listens for.
//
// We also pin the first-name rendering with the brand-coloured period — the
// hero's signature visual treatment.
// =============================================================================

describe('GreetingHero', () => {
  beforeEach(() => {
    // Pin to 10:00 local time so the greeting deterministically resolves to
    // "Good morning". We use the local-time constructor (no Z) so the freeze
    // matches whatever the running shell's TZ is — the component reads local
    // hour via Date#getHours.
    const morning = new Date(2026, 4, 18, 10, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(morning);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the firstName followed by a brand-coloured period', () => {
    const { getByRole } = render(<GreetingHero firstName="Mazen" />);
    const h1 = getByRole('heading', { level: 1 });
    // textContent flattens children so we see "Mazen." not "Mazen <span>.</span>".
    expect(h1.textContent).toBe('Mazen.');
  });

  it('renders the time-of-day greeting based on the current hour', () => {
    const { getByText } = render(<GreetingHero firstName="Mazen" />);
    expect(getByText('Good morning')).toBeTruthy();
  });

  it('renders the "New task" button with the right aria-label', () => {
    const { getByLabelText } = render(<GreetingHero firstName="Mazen" />);
    const btn = getByLabelText('Create a task');
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('data-tour')).toBe('new-task-button');
  });

  it('dispatches the Cmd+K keydown when "New task" is clicked', () => {
    const listener = vi.fn();
    window.addEventListener('keydown', listener);
    try {
      const { getByLabelText } = render(<GreetingHero firstName="Mazen" />);
      fireEvent.click(getByLabelText('Create a task'));
      expect(listener).toHaveBeenCalled();
      // Last call should be our synthetic Cmd+K event.
      const last = listener.mock.calls.at(-1)?.[0] as KeyboardEvent | undefined;
      expect(last?.key).toBe('k');
      expect(last?.metaKey).toBe(true);
    } finally {
      window.removeEventListener('keydown', listener);
    }
  });

  it('renders the supporting tagline copy', () => {
    const { getByText } = render(<GreetingHero firstName="Mazen" />);
    expect(getByText(/sharpest items first/i)).toBeTruthy();
  });

  it('changes the greeting copy in the evening', () => {
    // Reset and pin to 21:00 → "Good evening".
    vi.setSystemTime(new Date(2026, 4, 18, 21, 0, 0));
    const { getByText } = render(<GreetingHero firstName="Mazen" />);
    expect(getByText('Good evening')).toBeTruthy();
  });
});
