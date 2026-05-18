// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { DescriptionField } from './DescriptionField';

// =============================================================================
// DescriptionField — RTL click-to-edit test.
//
// The component is markdown-it -> rendered HTML in display mode, and a plain
// textarea in edit mode. It uses `useMutation` from @tanstack/react-query for
// the AI-expand button, so the render tree needs a QueryClientProvider — even
// when we don't trigger the mutation, useMutation's setup pulls from context.
//
// What we pin:
//   1. Display mode renders the markdown as HTML (heading + strong text
//      survive the parse).
//   2. Clicking the rendered content switches to edit mode (textarea
//      mounts).
//   3. Typing + blurring fires onSave with the new draft text.
//   4. Pressing Escape in the textarea cancels — onSave is NOT called.
//   5. The empty-state placeholder button renders for an empty value.
// =============================================================================

function withQuery(node: React.ReactNode): JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

describe('DescriptionField', () => {
  it('renders markdown content as HTML in display mode', () => {
    const md = '# Top heading\n\nWith **bold** text.';
    const { container } = render(
      withQuery(<DescriptionField value={md} onSave={() => {}} />),
    );
    // markdown-it converts `# Top heading` → <h1>Top heading</h1>.
    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toContain('Top heading');
    // **bold** → <strong>bold</strong>.
    const strong = container.querySelector('strong');
    expect(strong?.textContent).toBe('bold');
  });

  it('shows the empty-state placeholder when value is blank', () => {
    const { getByText } = render(
      withQuery(<DescriptionField value="" onSave={() => {}} />),
    );
    expect(getByText(/Add a description/)).toBeTruthy();
  });

  it('switches into edit mode when the rendered content is clicked', () => {
    const md = '## Existing';
    const { container } = render(
      withQuery(<DescriptionField value={md} onSave={() => {}} />),
    );
    // Display node is a role="button" wrapping the markdown render.
    const displayNode = container.querySelector('[role="button"]') as HTMLElement;
    expect(displayNode).toBeTruthy();
    fireEvent.click(displayNode);
    // Now a textarea should be mounted with the original value as draft.
    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();
    expect(textarea?.value).toBe(md);
  });

  it('calls onSave with the edited text on blur when the draft changed', () => {
    const onSave = vi.fn();
    const { container } = render(
      withQuery(<DescriptionField value="old text" onSave={onSave} />),
    );
    fireEvent.click(container.querySelector('[role="button"]') as HTMLElement);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'new text' } });
    fireEvent.blur(textarea);
    expect(onSave).toHaveBeenCalledWith('new text');
  });

  it('does NOT call onSave when the user pressed Escape', () => {
    const onSave = vi.fn();
    const { container } = render(
      withQuery(<DescriptionField value="old text" onSave={onSave} />),
    );
    fireEvent.click(container.querySelector('[role="button"]') as HTMLElement);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'half-typed' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });
    // Escape exits edit mode without calling onSave — draft is restored to
    // the original value the next time we enter display mode.
    expect(onSave).not.toHaveBeenCalled();
  });

  it('does NOT call onSave on blur when the draft is unchanged', () => {
    const onSave = vi.fn();
    const { container } = render(
      withQuery(<DescriptionField value="stable" onSave={onSave} />),
    );
    fireEvent.click(container.querySelector('[role="button"]') as HTMLElement);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.blur(textarea);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('only renders the AI-draft button when a taskId is provided', () => {
    const withoutId = render(
      withQuery(<DescriptionField value="x" onSave={() => {}} />),
    );
    expect(withoutId.queryByText(/AI draft/)).toBeNull();
    withoutId.unmount();

    const withId = render(
      withQuery(<DescriptionField value="x" onSave={() => {}} taskId="task-99" />),
    );
    expect(withId.queryByText(/AI draft/)).toBeTruthy();
  });
});
