// @vitest-environment jsdom

import { Blob as NodeBlob } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionBuilder } from '@/lib/fixtures/session-builder';
import { getSession, getEvents, getAssets } from '@/lib/storage';

vi.mock('@/lib/storage', () => ({ getSession: vi.fn(), getEvents: vi.fn(), getAssets: vi.fn() }));
vi.mock('@/lib/messaging', () => ({ broadcast: vi.fn(), onBroadcast: vi.fn() }));
vi.mock('@/lib/export/bundle', () => ({ buildBundle: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  document.documentElement.innerHTML = readFileSync('entrypoints/report/index.html', 'utf8');
  history.replaceState(null, '', '?session=sess_fixture');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('downloads a standalone Markdown report at the selected level and handles a failed save', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Blob', NodeBlob);
  const fixture = new SessionBuilder({ name: 'QA report' })
    .marker('Checkout failed')
    .textSelect('Full-only selection')
    .screenshot()
    .build();
  vi.mocked(getSession).mockResolvedValue(fixture.session);
  vi.mocked(getEvents).mockResolvedValue(fixture.events);
  vi.mocked(getAssets).mockResolvedValue(fixture.assets);

  const createObjectURL = vi.fn((_blob: Blob | MediaSource) => 'blob:report');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = createObjectURL;
    static override revokeObjectURL = revokeObjectURL;
  });
  const download = vi.fn().mockResolvedValue(1);
  vi.stubGlobal('chrome', { downloads: { download } });

  await import('@/entrypoints/report/main');
  const button = document.querySelector<HTMLButtonElement>('#download-markdown')!;
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  document.querySelector<HTMLButtonElement>('button[title="Full"]')!.click();
  button.click();
  await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  const full = await (createObjectURL.mock.calls.at(-1)![0] as Blob).text();
  expect(download).toHaveBeenCalledWith({ url: 'blob:report', filename: expect.stringMatching(/^qa-report-.*\.md$/) });
  expect(full).toContain('Checkout failed');
  expect(full).toContain('Full-only selection');
  expect(full).not.toMatch(/\]\(assets\//);

  document.querySelector<HTMLButtonElement>('button[title="Minimal"]')!.click();
  button.click();
  await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(2));
  const minimal = await (createObjectURL.mock.calls.at(-1)![0] as Blob).text();
  expect(minimal).toContain('Checkout failed');
  expect(minimal).not.toContain('Full-only selection');

  download.mockRejectedValueOnce(new Error('Unavailable'));
  button.click();
  await vi.waitFor(() => {
    expect(button.disabled).toBe(false);
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Could not download Markdown');
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(revokeObjectURL).toHaveBeenCalledTimes(3);
});
