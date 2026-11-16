import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTriageDefaults, rememberTriage, TRIAGE_DEFAULTS_KEY } from './triage';

function storage(initial: Record<string, unknown> = {}) {
  const stored: Record<string, unknown> = { ...initial };
  vi.stubGlobal('chrome', { storage: { local: {
    get: vi.fn(async (key: string) => (key in stored ? { [key]: stored[key] } : {})),
    set: vi.fn(async (value: Record<string, unknown>) => Object.assign(stored, value)),
  } } });
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
});
