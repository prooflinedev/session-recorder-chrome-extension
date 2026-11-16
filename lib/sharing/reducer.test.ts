import { describe, expect, it } from 'vitest';
import { filingBlocker, initialShareState, shareReducer, type ShareAction } from '@/entrypoints/share/reducer';
import { SessionBuilder } from '@/lib/fixtures/session-builder';
import { defaultSharingSettings } from './settings';
import type { SavedDraft } from './draft';

const session = () => new SessionBuilder().build().session;
const triageDefaults = {
  'owner/repo': { labels: ['bug'], assignees: ['octocat'] },
  'team/web': { labels: ['checkout'], assignees: [] },
};
function settingsFor(repository: string) {
  const settings = defaultSharingSettings();
  settings.repositories = [
    { id: 'a', repository, token: 'token' },
    { id: 'b', repository: 'team/web', token: 'token' },
  ];
  return settings;
}

describe('share workflow state', () => {
  it('preserves a recoverable deployment and edited draft after an operation fails', () => {
    const publication = {
      level: 'L1' as const,
      destination: {
        accountId: 'a',
        projectName: 'p',
        accessAppId: 'id',
        teamDomain: 'team',
      },
      deployment: {
        id: '1',
        environment: 'preview',
        url: 'https://abc.reports.pages.dev',
      },
    };
    let state = shareReducer(initialShareState('L1'), {
      type: 'loaded',
      session: new SessionBuilder().build().session,
      settings: defaultSharingSettings(),
      saved: {
        draft: { title: 'Edited', body: 'My summary' },
        repository: 'owner/repo',
        publication,
      },
    });
    state = shareReducer(state, { type: 'start', operation: 'check' });
    state = shareReducer(state, { type: 'error', message: 'Timeout' });
    state = shareReducer(state, { type: 'finish' });
    expect(state.publication).toEqual(publication);
    expect(state.draft.title).toBe('Edited');
    expect(state.operation).toBe('idle');
  });
  it('prepares new report detail without a review gate', () => {
    const state = shareReducer(initialShareState('L1'), {type: 'prepare', level: 'L2'});
    expect(state.files).toEqual([]);
    expect(state.preparing).toBe(true);
  });
  it('selects saved labels and assignees, else the repository defaults, else none', () => {
    const fromDefaults = shareReducer(initialShareState('L1'), {
      type: 'loaded',
      session: session(),
      settings: settingsFor('Owner/Repo'),
      triageDefaults,
    });
    expect(fromDefaults.triageDefaults).toEqual(triageDefaults);
    expect([fromDefaults.labels, fromDefaults.assignees]).toEqual([['bug'], ['octocat']]);
    const fromDraft = shareReducer(initialShareState('L1'), {
      type: 'loaded',
      session: session(),
      settings: settingsFor('owner/repo'),
      triageDefaults,
      saved: {
        draft: { title: 'Edited', body: 'My summary' },
        repository: 'owner/repo',
        labels: [],
        assignees: ['hubot'],
      },
    });
    expect([fromDraft.labels, fromDraft.assignees]).toEqual([[], ['hubot']]);
    const none = shareReducer(initialShareState('L1'), {
      type: 'loaded',
      session: session(),
      settings: settingsFor('other/repo'),
      triageDefaults,
    });
    expect([none.labels, none.assignees]).toEqual([[], []]);
  });
  it('switches to the chosen repository’s remembered labels and assignees', () => {
    let state = shareReducer(initialShareState('L1'), {
      type: 'loaded',
      session: session(),
      settings: settingsFor('owner/repo'),
      triageDefaults,
    });
    state = shareReducer(state, { type: 'repository', repository: 'https://github.com/Team/Web' });
    expect([state.labels, state.assignees]).toEqual([['checkout'], []]);
    state = shareReducer(state, { type: 'repository', repository: 'other/' });
    expect([state.labels, state.assignees]).toEqual([[], []]);
  });
  it('changes labels and assignees only while the draft is idle and unfiled', () => {
    const loaded = (saved?: SavedDraft) =>
      shareReducer(initialShareState('L1'), {
        type: 'loaded',
        session: session(),
        settings: settingsFor('owner/repo'),
        saved,
      });
    const choose: ShareAction = { type: 'triage', labels: ['bug'], assignees: ['octocat'] };
    const idle = shareReducer(loaded(), choose);
    expect([idle.labels, idle.assignees]).toEqual([['bug'], ['octocat']]);
    const busy = shareReducer(shareReducer(loaded(), { type: 'start', operation: 'github' }), choose);
    expect([busy.labels, busy.assignees]).toEqual([[], []]);
    const draft = { title: 'Edited', body: 'My summary' };
    const attempting = shareReducer(
      loaded({
        draft,
        repository: 'owner/repo',
        attempt: { id: 'a', repository: 'owner/repo', startedAt: '2026-11-17T00:00:00Z' },
      }),
      choose,
    );
    expect([attempting.labels, attempting.assignees]).toEqual([[], []]);
    const filed = shareReducer(
      loaded({
        draft,
        repository: 'owner/repo',
        issue: { number: 1, url: 'https://github.com/owner/repo/issues/1', repository: 'owner/repo' },
      }),
      choose,
    );
    expect([filed.labels, filed.assignees]).toEqual([[], []]);
  });
  it('keeps a new choice when switching repositories away and back', () => {
    let state = shareReducer(initialShareState('L1'), {
      type: 'loaded',
      session: session(),
      settings: settingsFor('owner/repo'),
      triageDefaults,
    });
    state = shareReducer(state, { type: 'triage', labels: ['regression'], assignees: [] });
    state = shareReducer(state, { type: 'repository', repository: 'team/web' });
    state = shareReducer(state, { type: 'repository', repository: 'Owner/Repo' });
    expect([state.labels, state.assignees]).toEqual([['regression'], []]);
  });
  it('keeps a reopened draft’s choice after switching repositories away and back', () => {
    let state = shareReducer(initialShareState('L1'), {
      type: 'loaded',
      session: session(),
      settings: settingsFor('owner/repo'),
      triageDefaults: { ...triageDefaults, 'owner/repo': { labels: ['checkout'], assignees: [] } },
      saved: {
        draft: { title: 'Edited', body: 'My summary' },
        repository: 'owner/repo',
        labels: ['bug'],
        assignees: [],
      },
    });
    state = shareReducer(state, { type: 'repository', repository: 'team/web' });
    state = shareReducer(state, { type: 'repository', repository: 'owner/repo' });
    expect([state.labels, state.assignees]).toEqual([['bug'], []]);
  });
});

describe('duplicate matches', () => {
  const matches = {
    exact: [
      { number: 118, title: 'Checkout 500 on Pay', url: 'https://github.com/owner/repo/issues/118', state: 'open' as const },
    ],
    related: [
      { number: 97, title: 'TypeError on cart totals', url: 'https://github.com/owner/repo/issues/97', state: 'closed' as const },
    ],
  };
  const loaded = (saved?: SavedDraft) =>
    shareReducer(initialShareState('L1'), {
      type: 'loaded',
      session: session(),
      settings: settingsFor('owner/repo'),
      saved,
    });
  it('moves from idle to loading to ready or error for the current repository', () => {
    let state = loaded();
    expect(state.duplicates.status).toBe('idle');
    state = shareReducer(state, {
      type: 'fingerprint',
      fingerprint: { id: 'sr-7c41e9a2b3d0', message: 'TypeError: boom' },
    });
    expect(state.fingerprint?.id).toBe('sr-7c41e9a2b3d0');
    state = shareReducer(state, { type: 'duplicates-loading', repository: 'owner/repo' });
    expect(state.duplicates).toMatchObject({ status: 'loading', repository: 'owner/repo' });
    const ready = shareReducer(state, { type: 'duplicates-ready', repository: 'owner/repo', matches });
    expect(ready.duplicates).toMatchObject({ status: 'ready', ...matches, error: '' });
    const failed = shareReducer(state, {
      type: 'duplicates-failed',
      repository: 'owner/repo',
      message: "Couldn't check for duplicates (403).",
    });
    expect(failed.duplicates).toMatchObject({
      status: 'error',
      error: "Couldn't check for duplicates (403).",
      exact: [],
      related: [],
    });
    // Retry starts loading again and clears the error.
    expect(
      shareReducer(failed, { type: 'duplicates-loading', repository: 'owner/repo' }).duplicates,
    ).toMatchObject({ status: 'loading', error: '' });
  });
  it('drops results for another repository and resets when the repository changes', () => {
    let state = shareReducer(loaded(), { type: 'duplicates-loading', repository: 'owner/repo' });
    state = shareReducer(state, { type: 'repository', repository: 'team/web' });
    expect(state.duplicates.status).toBe('idle');
    state = shareReducer(state, { type: 'duplicates-ready', repository: 'owner/repo', matches });
    expect(state.duplicates.status).toBe('idle');
    state = shareReducer(state, { type: 'duplicates-loading', repository: 'team/web' });
    state = shareReducer(state, { type: 'duplicates-failed', repository: 'owner/repo', message: 'x' });
    expect(state.duplicates.status).toBe('loading');
  });
});

describe('adding to an existing issue', () => {
  const loaded = (saved?: SavedDraft) =>
    shareReducer(initialShareState('L1'), {
      type: 'loaded',
      session: session(),
      settings: settingsFor('owner/repo'),
      saved,
    });
  const draft = { title: 'Edited', body: 'My summary' };
  const choose: ShareAction = { type: 'add-to', target: { repository: 'owner/repo', number: 118 } };
  it('chooses the target only while idle and unfiled', () => {
    expect(shareReducer(loaded(), choose).addTo).toEqual({ repository: 'owner/repo', number: 118 });
    expect(shareReducer(shareReducer(loaded(), choose), { type: 'add-to' }).addTo).toBeUndefined();
    const busy = shareReducer(shareReducer(loaded(), { type: 'start', operation: 'github' }), choose);
    expect(busy.addTo).toBeUndefined();
    const attempting = shareReducer(
      loaded({
        draft,
        repository: 'owner/repo',
        attempt: { id: 'a', repository: 'owner/repo', startedAt: '2026-11-17T00:00:00Z' },
      }),
      choose,
    );
    expect(attempting.addTo).toBeUndefined();
    const filed = shareReducer(
      loaded({
        draft,
        repository: 'owner/repo',
        issue: { number: 1, url: 'https://github.com/owner/repo/issues/1', repository: 'owner/repo' },
      }),
      choose,
    );
    expect(filed.addTo).toBeUndefined();
  });
  it('restores the target saved with the draft', () => {
    expect(loaded({ draft, repository: 'owner/repo', addTo: { repository: 'owner/repo', number: 118 } }).addTo).toEqual({ repository: 'owner/repo', number: 118 });
    const saved = shareReducer(loaded(), {
      type: 'saved',
      saved: { draft, repository: 'owner/repo', addTo: { repository: 'owner/repo', number: 97 } },
    });
    expect(saved.addTo).toEqual({ repository: 'owner/repo', number: 97 });
  });
});

describe('filing readiness', () => {
  const file = { path: 'report.md', text: '# Report' };
  it('blocks filing while the report is preparing or has no files', () => {
    const state = initialShareState('L1');
    expect(filingBlocker({ ...state, preparing: true, files: [file] }, '')).toBe(
      'The report is still preparing.',
    );
    expect(filingBlocker({ ...state, preparing: false, files: [] }, '')).toBe(
      'The report is still preparing.',
    );
  });
  it('blocks filing a report over the publishing limits', () => {
    const state = { ...initialShareState('L1'), preparing: false, files: [file] };
    expect(filingBlocker(state, 'export.bin exceeds the limit.')).toBe('export.bin exceeds the limit.');
    expect(filingBlocker(state, '')).toBe('');
  });
});
