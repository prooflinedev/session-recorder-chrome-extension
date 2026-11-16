import { describe, expect, it } from 'vitest';
import { mergeStaleEdit, type SavedDraft } from './draft';

const publication = {
  level: 'L1' as const,
  destination: { accountId: 'a', projectName: 'p', accessAppId: 'id', teamDomain: 'team' },
  deployment: { id: '1', environment: 'preview', url: 'https://abc.reports.pages.dev' },
};
const edited: SavedDraft = {
  draft: { title: 'Newer title', body: 'Newer summary' },
  draftSource: 'edited',
  repository: 'team/web',
  labels: ['checkout'],
  assignees: ['hubot'],
};

describe('saving an edit over another tab’s draft', () => {
  it('saves the edit as is when nothing is stored', () => {
    expect(mergeStaleEdit(edited, undefined)).toEqual(edited);
  });
  it('keeps the stored publication and a filed issue’s repository', () => {
    const issue = {
      number: 42,
      url: 'https://github.com/owner/repo/issues/42',
      repository: 'owner/repo',
    };
    const saved = mergeStaleEdit(edited, {
      draft: { title: 'Older', body: 'Older summary' },
      repository: 'owner/repo',
      publication,
      issue,
    });
    expect(saved.draft).toEqual(edited.draft);
    expect(saved.repository).toBe('owner/repo');
    expect(saved.publication).toEqual(publication);
    expect(saved.issue).toEqual(issue);
    expect(saved.attempt).toBeUndefined();
  });
  it('keeps an in-flight attempt and its repository', () => {
    const attempt = { id: 'a', repository: 'owner/repo', startedAt: '2026-11-17T00:00:00Z' };
    const saved = mergeStaleEdit(edited, {
      draft: { title: 'Older', body: 'Older summary' },
      repository: 'owner/repo',
      attempt,
    });
    expect(saved.repository).toBe('owner/repo');
    expect(saved.attempt).toEqual(attempt);
    expect(saved.issue).toBeUndefined();
  });
  it('lets the edit choose the repository before anything was submitted', () => {
    const saved = mergeStaleEdit(edited, {
      draft: { title: 'Older', body: 'Older summary' },
      repository: 'owner/repo',
      labels: ['bug'],
      assignees: [],
    });
    expect(saved.repository).toBe('team/web');
    expect(saved.labels).toEqual(['checkout']);
    expect(saved.assignees).toEqual(['hubot']);
  });
  it.each([
    { issue: { number: 42, url: 'https://github.com/owner/repo/issues/42', repository: 'owner/repo' } },
    { attempt: { id: 'a', repository: 'owner/repo', startedAt: '2026-11-17T00:00:00Z' } },
  ])('keeps the labels and assignees another tab submitted (%#)', (submitted) => {
    const saved = mergeStaleEdit(edited, {
      draft: { title: 'Older', body: 'Older summary' },
      repository: 'owner/repo',
      labels: ['bug'],
      assignees: ['octocat'],
      ...submitted,
    });
    expect(saved.labels).toEqual(['bug']);
    expect(saved.assignees).toEqual(['octocat']);
  });
  it('keeps the issue another tab submitted a comment to', () => {
    const saved = mergeStaleEdit(
      { ...edited, addTo: 97 },
      {
        draft: { title: 'Older', body: 'Older summary' },
        repository: 'owner/repo',
        addTo: 118,
        attempt: { id: 'a', repository: 'owner/repo', startedAt: '2026-11-17T00:00:00Z', issueNumber: 118 },
      },
    );
    expect(saved.addTo).toBe(118);
  });
});
