import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTriageDefaults, rememberTriage, TRIAGE_DEFAULTS_KEY } from './triage';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Asynchronous storage, as in Chrome, plus a Web Locks fake that queues by name. */
function storage(initial: Record<string, unknown> = {}) {
  const stored: Record<string, unknown> = { ...initial };
  vi.stubGlobal('chrome', { storage: { local: {
    get: vi.fn(async (key: string) => {
      await tick();
      return key in stored ? { [key]: structuredClone(stored[key]) } : {};
    }),
    set: vi.fn(async (value: Record<string, unknown>) => {
      await tick();
      Object.assign(stored, value);
    }),
  } } });
  const queues = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', { locks: {
    request: vi.fn((name: string, callback: () => Promise<unknown>) => {
      const run = (queues.get(name) ?? Promise.resolve()).then(() => callback());
      queues.set(name, run.catch(() => {}));
      return run;
    }),
  } });
  return stored;
}
afterEach(() => vi.unstubAllGlobals());

describe('remembered issue triage', () => {
  it('round-trips a choice for each repository regardless of URL or case', async () => {
    const stored = storage();
    expect(await loadTriageDefaults()).toEqual({});
    await rememberTriage('https://github.com/Owner/Repo', {
      labels: ['bug'],
      assignees: ['octocat'],
    });
    expect(Object.keys(stored[TRIAGE_DEFAULTS_KEY] as object)).toEqual(['owner/repo']);
    await rememberTriage('OWNER/repo', { labels: ['bug', 'checkout'], assignees: [] });
    expect(await loadTriageDefaults()).toEqual({
      'owner/repo': { labels: ['bug', 'checkout'], assignees: [] },
    });
  });
  it('keeps other repositories and forgets an empty choice', async () => {
    storage({
      [TRIAGE_DEFAULTS_KEY]: {
        'owner/repo': { labels: ['bug'], assignees: [] },
        'team/web': { labels: [], assignees: ['hubot'] },
      },
    });
    await rememberTriage('team/web', { labels: ['checkout'], assignees: ['hubot'] });
    await rememberTriage('Owner/Repo', { labels: [], assignees: [] });
    expect(await loadTriageDefaults()).toEqual({
      'team/web': { labels: ['checkout'], assignees: ['hubot'] },
    });
  });
  it('keeps both repositories when two tabs remember a choice at once', async () => {
    storage();
    await Promise.all([
      rememberTriage('owner/repo', { labels: ['bug'], assignees: [] }),
      rememberTriage('team/web', { labels: [], assignees: ['hubot'] }),
    ]);
    expect(await loadTriageDefaults()).toEqual({
      'owner/repo': { labels: ['bug'], assignees: [] },
      'team/web': { labels: [], assignees: ['hubot'] },
    });
  });
});
