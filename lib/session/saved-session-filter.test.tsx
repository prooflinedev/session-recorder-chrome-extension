// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SessionBuilder } from '@/lib/fixtures/session-builder';
import { SessionList } from '@/entrypoints/sidepanel/components/SessionList';
import { useSessionList } from '@/entrypoints/sidepanel/components/useSessionList';

vi.mock('@/entrypoints/sidepanel/components/useSessionList');

it('matches recording titles, keeps IDs attached to actions, and restores the original order when cleared', async () => {
  const sessions = [
    new SessionBuilder({ id: 'newest', name: 'Search redesign' }).build().session,
    new SessionBuilder({ id: 'earlier', name: 'Checkout failure' }).build().session,
  ];
  const remove = vi.fn().mockResolvedValue(undefined);
  const open = vi.fn();
  vi.mocked(useSessionList).mockReturnValue({ sessions, loading: false, now: Date.now(), remove });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  try {
    await act(() => root.render(<SessionList onOpen={open} />));
    const titles = () => Array.from(container.querySelectorAll('.session-row__name'), (row) => row.textContent);
    expect(titles()).toEqual(['Search redesign', 'Checkout failure']);

    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    const change = async (value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await change(' CHECKOUT ');
    expect(titles()).toEqual(['Checkout failure']);
    await act(() => container.querySelector<HTMLButtonElement>('.session-row__main')!.click());
    await act(() => container.querySelector<HTMLButtonElement>('.session-row__delete')!.click());
    expect(open).toHaveBeenCalledWith('earlier');
    expect(remove).toHaveBeenCalledWith('earlier');

    await change('absent');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('No matching recordings.');
    await change('');
    expect(titles()).toEqual(['Search redesign', 'Checkout failure']);
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
    container.remove();
  }
});
