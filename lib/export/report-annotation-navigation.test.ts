// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { SessionBuilder } from '@/lib/fixtures/session-builder';
import { getSession, getEvents, getAssets } from '@/lib/storage';

vi.mock('@/lib/storage', () => ({ getSession: vi.fn(), getEvents: vi.fn(), getAssets: vi.fn() }));
vi.mock('@/lib/messaging', () => ({ broadcast: vi.fn(), onBroadcast: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  document.documentElement.innerHTML = readFileSync('entrypoints/report/index.html', 'utf8');
  history.replaceState(null, '', '?session=sess_fixture');
});

it('links notes and markers with repeated timestamps and preserves their links across levels', async () => {
  const fixture = new SessionBuilder().note('First checkpoint').marker('Second checkpoint').build();
  for (const event of fixture.events) event.t = 500;
  vi.mocked(getSession).mockResolvedValue(fixture.session);
  vi.mocked(getEvents).mockResolvedValue(fixture.events);
  vi.mocked(getAssets).mockResolvedValue([]);

  await import('@/entrypoints/report/main');
  const anchors = () => Array.from(document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Annotations"] a'));
  await vi.waitFor(() => expect(anchors()).toHaveLength(2));
  const targets = anchors().map((anchor) => anchor.hash);
  expect(new Set(targets).size).toBe(2);
  for (const anchor of anchors()) {
    const target = document.getElementById(decodeURIComponent(anchor.hash.slice(1)));
    expect(target?.tabIndex).toBe(-1);
    expect(target?.textContent).toContain(anchor.textContent?.includes('First') ? 'First checkpoint' : 'Second checkpoint');
  }
  document.querySelector<HTMLButtonElement>('button[title="Minimal"]')!.click();
  expect(anchors().map((anchor) => anchor.hash)).toEqual(targets);
});
