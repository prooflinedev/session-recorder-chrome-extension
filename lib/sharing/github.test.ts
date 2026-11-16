import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitHubIssue,
  createIssueComment,
  findCreatedComment,
  githubIssueLink,
  issueBody,
  listIssueOptions,
  notApplied,
  repositoryPath,
  type IssueAttempt,
} from './github';
import { cloudflareTokenUrl } from './settings';

describe('issue handoff', () => {
  it('includes a protected report link and encodes Markdown exactly', () => {
    const body = issueBody(
      { title: 'Failure & retry', body: '## Evidence\n500 on checkout' },
      'https://abc.reports.pages.dev',
    );
    const link = githubIssueLink(
      'https://github.com/owner/repo',
      'Failure & retry',
      body,
    );
    expect(new URL(link.url).searchParams.get('body')).toBe(body);
    expect(body).toContain('Cloudflare Access sign-in required');
    expect(link.needsPaste).toBe(false);
  });
  it('uses the clipboard fallback for long and multibyte summaries', () => {
    const link = githubIssueLink('owner/repo', 'Bug', '錯'.repeat(1500));
    expect(link.needsPaste).toBe(true);
    expect(new URL(link.url).searchParams.has('body')).toBe(false);
  });
  it.each([
    'https://evil.example/o/r',
    'owner/repo/issues',
    'owner/..',
    'owner/repo?x=y',
  ])('rejects an invalid destination %s', (value) => {
    expect(() => repositoryPath(value)).toThrow();
  });
  it('preconfigures only Pages Edit and Access Read for the requested account', () => {
    const account = 'a'.repeat(32);
    const url = new URL(cloudflareTokenUrl(account));
    expect(url.searchParams.get('accountId')).toBe(account);
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys')!)).toEqual([
      { key: 'page', type: 'edit' },
      { key: 'access', type: 'read' },
    ]);
  });
});

const attempt: IssueAttempt = {
  id: 'attempt-1',
  repository: 'owner/repo',
  startedAt: '2026-11-17T00:00:00.000Z',
};
const draft = { title: 'Checkout fails', body: 'Evidence' };
const reportUrl = 'https://abc.reports.pages.dev';
function respond(json: unknown, status = 200) {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function stubFetch(handler: (url: string) => Response) {
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    handler(String(input)),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const created = () =>
  respond({ number: 7, html_url: 'https://github.com/owner/repo/issues/7' }, 201);
afterEach(() => vi.unstubAllGlobals());

describe('issue triage', () => {
  it('sends requested labels and assignees with the new issue', async () => {
    const fetch = stubFetch(created);
    await createGitHubIssue(attempt, 'token', draft, reportUrl, undefined, {
      labels: ['bug', 'checkout'],
      assignees: ['octocat'],
    });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.labels).toEqual(['bug', 'checkout']);
    expect(body.assignees).toEqual(['octocat']);
  });
  it('leaves the create request unchanged without a selection', async () => {
    const fetch = stubFetch(created);
    await createGitHubIssue(attempt, 'token', draft, reportUrl, undefined, {
      labels: [],
      assignees: [],
    });
    await createGitHubIssue(attempt, 'token', draft, reportUrl);
    for (const [, init] of fetch.mock.calls) {
      expect(Object.keys(JSON.parse(String(init!.body)))).toEqual(['title', 'body']);
    }
  });
  it('reports the labels and assignees GitHub applied', async () => {
    stubFetch(() =>
      respond(
        {
          number: 7,
          html_url: 'https://github.com/owner/repo/issues/7',
          labels: [{ name: 'bug' }, { name: 3 }, null, 'loose', { name: 'checkout' }],
          assignees: [{ login: 'octocat' }, {}, { login: false }],
        },
        201,
      ),
    );
    const issue = await createGitHubIssue(attempt, 'token', draft, reportUrl);
    expect(issue.labels).toEqual(['bug', 'checkout']);
    expect(issue.assignees).toEqual(['octocat']);
  });
  it.each([
    {},
    { labels: null, assignees: 'octocat' },
    { labels: { name: 'bug' }, assignees: [{ name: 'octocat' }] },
  ])('treats missing or malformed applied values as none: %j', async (extra) => {
    stubFetch(() =>
      respond(
        { number: 7, html_url: 'https://github.com/owner/repo/issues/7', ...extra },
        201,
      ),
    );
    const issue = await createGitHubIssue(attempt, 'token', draft, reportUrl);
    expect(issue.labels).toEqual([]);
    expect(issue.assignees).toEqual([]);
  });
  it('names requested values GitHub did not apply, ignoring case', () => {
    expect(
      notApplied(
        { labels: ['Bug', 'checkout', 'needs-triage'], assignees: ['OctoCat', 'hubot'] },
        {
          number: 7,
          url: 'https://github.com/owner/repo/issues/7',
          repository: 'owner/repo',
          labels: ['bug', 'Checkout'],
          assignees: ['octocat'],
        },
      ),
    ).toEqual({ labels: ['needs-triage'], assignees: ['hubot'] });
  });
});

describe('issue options', () => {
  const label = (name: string, color = 'd73a4a') => ({ name, color });
  function github(routes: {
    repository?: unknown;
    labels?: (page: number) => unknown;
    assignees?: (page: number) => unknown;
  }) {
    return stubFetch((url) => {
      const { pathname, searchParams } = new URL(url);
      const page = Number(searchParams.get('page'));
      if (pathname === '/repos/owner/repo')
        return respond(routes.repository ?? { permissions: { push: true } });
      expect(searchParams.get('per_page')).toBe('100');
      if (pathname === '/repos/owner/repo/labels')
        return respond(routes.labels?.(page) ?? []);
      if (pathname === '/repos/owner/repo/assignees')
        return respond(routes.assignees?.(page) ?? []);
      throw new Error(`Unexpected request ${url}`);
    });
  }
  it('loads write access, every label page and assignable users', async () => {
    const fetch = github({
      labels: (page) =>
        page === 1
          ? Array.from({ length: 100 }, (_, index) => label(`label-${index}`))
          : [label('bug', 'D73A4A'), { name: 4 }, null, label('checkout', '0e8a16')],
      assignees: () => [{ login: 'octocat' }, { login: null }, {}, { login: 'hubot' }],
    });
    const options = await listIssueOptions('https://github.com/owner/repo', 'token');
    expect(options.canTriage).toBe(true);
    expect(options.labels).toHaveLength(102);
    expect(options.labels.slice(-2)).toEqual([
      { name: 'bug', color: 'D73A4A' },
      { name: 'checkout', color: '0e8a16' },
    ]);
    expect(options.assignees).toEqual(['octocat', 'hubot']);
    const pages = fetch.mock.calls
      .map(([url]) => new URL(String(url)))
      .filter((url) => url.pathname.endsWith('/labels'))
      .map((url) => url.searchParams.get('page'));
    expect(pages).toEqual(['1', '2']);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.redirect).toBe('error');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token');
    }
  });
  it('reports missing write access', async () => {
    github({ repository: { permissions: { push: false } } });
    expect((await listIssueOptions('owner/repo', 'token')).canTriage).toBe(false);
    github({ repository: { has_issues: true } });
    expect((await listIssueOptions('owner/repo', 'token')).canTriage).toBe(false);
  });
  it('replaces label colours that are not plain hex', async () => {
    github({
      labels: () => [
        label('styled', 'red;background:url(x)'),
        label('short', 'fff'),
        { name: 'none' },
      ],
    });
    const { labels } = await listIssueOptions('owner/repo', 'token');
    expect(labels.map((entry) => entry.name)).toEqual(['styled', 'short', 'none']);
    for (const entry of labels) expect(entry.color).toMatch(/^[0-9a-f]{6}$/i);
    expect(new Set(labels.map((entry) => entry.color)).size).toBe(1);
  });
  it('stops after ten pages', async () => {
    const fetch = github({
      assignees: (page) =>
        Array.from({ length: 100 }, (_, index) => ({ login: `user-${page}-${index}` })),
    });
    const { assignees } = await listIssueOptions('owner/repo', 'token');
    expect(assignees).toHaveLength(1000);
    expect(
      fetch.mock.calls.filter(([url]) => String(url).includes('/assignees')),
    ).toHaveLength(10);
  });
  it.each(['', '/labels', '/assignees'])(
    'explains a rejected listing request (%s)',
    async (failing) => {
      stubFetch((url) => {
        const { pathname } = new URL(url);
        if (pathname === `/repos/owner/repo${failing}`)
          return respond({ message: 'Forbidden' }, 403);
        return respond(pathname.endsWith('/repo') ? { permissions: { push: true } } : []);
      });
      await expect(listIssueOptions('owner/repo', 'token')).rejects.toThrow(
        'Could not load labels and assignees (403). Check the token in Sharing settings.',
      );
    },
  );
});

describe('error fingerprint line', () => {
  it('adds the fingerprint under the report link only when given', () => {
    const plain = issueBody(draft, reportUrl);
    expect(plain).toBe(
      'Evidence\n\n### Recorded session\n[Open the full report](https://abc.reports.pages.dev/) — Cloudflare Access sign-in required.\n',
    );
    expect(issueBody(draft, reportUrl, undefined)).toBe(plain);
    expect(issueBody(draft, reportUrl, 'sr-7c41e9a2b3d0')).toBe(
      `${plain}Error fingerprint: \`sr-7c41e9a2b3d0\`\n`,
    );
  });
  it('includes the fingerprint in a new issue', async () => {
    const fetch = stubFetch(created);
    await createGitHubIssue(attempt, 'token', draft, reportUrl, undefined, undefined, 'sr-7c41e9a2b3d0');
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.body).toContain('Error fingerprint: `sr-7c41e9a2b3d0`');
    expect(body.body).toContain('<!-- session-recorder:attempt-1 -->');
  });
});

describe('comments on an existing issue', () => {
  const target: IssueAttempt = { ...attempt, issueNumber: 118 };
  const commented = (url = 'https://github.com/owner/repo/issues/118#issuecomment-99') =>
    respond({ id: 99, html_url: url }, 201);
  it('posts the issue body, fingerprint and retry marker as a comment', async () => {
    const fetch = stubFetch(() => commented());
    const result = await createIssueComment(
      target,
      'token',
      draft,
      reportUrl,
      undefined,
      'sr-7c41e9a2b3d0',
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/owner/repo/issues/118/comments');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init!.body))).toEqual({
      body: `${issueBody(draft, reportUrl, 'sr-7c41e9a2b3d0')}\n<!-- session-recorder:attempt-1 -->`,
    });
    expect(result).toEqual({
      number: 118,
      url: 'https://github.com/owner/repo/issues/118',
      repository: 'owner/repo',
      comment: { url: 'https://github.com/owner/repo/issues/118#issuecomment-99' },
    });
  });
  it.each([
    'https://github.com/owner/repo/issues/119#issuecomment-99',
    'https://github.com/other/repo/issues/118#issuecomment-99',
    'https://evil.example/owner/repo/issues/118#issuecomment-99',
    'https://github.com/owner/repo/issues/118',
    undefined,
  ])('rejects an unexpected comment response %s without clearing the attempt', async (url) => {
    stubFetch(() => respond({ id: 99, html_url: url }, 201));
    await expect(createIssueComment(target, 'token', draft, reportUrl)).rejects.toMatchObject({
      message: 'GitHub returned an unexpected comment response. Check the issue before retrying.',
      definitive: false,
    });
  });
  it.each([
    [404, true],
    [422, true],
    [408, false],
    [502, false],
  ])('treats a %s rejection as definitive: %s', async (status, definitive) => {
    stubFetch(() => respond({ message: 'No' }, status));
    await expect(createIssueComment(target, 'token', draft, reportUrl)).rejects.toMatchObject({
      message: `GitHub could not add the comment to #118 (${status}). Check Issues: Write access for this repository.`,
      definitive,
    });
  });
  it('finds the comment with the attempt marker across pages since the attempt started', async () => {
    const fetch = stubFetch((url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return respond(
        page === 1
          ? Array.from({ length: 100 }, (_, index) => ({
              id: index,
              html_url: `https://github.com/owner/repo/issues/118#issuecomment-${index}`,
              body: 'Another comment',
            }))
          : [
              {
                id: 500,
                html_url: 'https://github.com/owner/repo/issues/118#issuecomment-500',
                body: 'Report\n<!-- session-recorder:attempt-1 -->',
              },
            ],
      );
    });
    expect(await findCreatedComment(target, 'token')).toEqual({
      number: 118,
      url: 'https://github.com/owner/repo/issues/118',
      repository: 'owner/repo',
      comment: { url: 'https://github.com/owner/repo/issues/118#issuecomment-500' },
    });
    const urls = fetch.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map((url) => url.pathname)).toEqual([
      '/repos/owner/repo/issues/118/comments',
      '/repos/owner/repo/issues/118/comments',
    ]);
    expect(urls[0]!.searchParams.get('since')).toBe(attempt.startedAt);
    expect(urls[0]!.searchParams.get('per_page')).toBe('100');
    expect(urls.map((url) => url.searchParams.get('page'))).toEqual(['1', '2']);
  });
  it('returns nothing when no comment has the marker', async () => {
    stubFetch(() =>
      respond([
        {
          id: 1,
          html_url: 'https://github.com/owner/repo/issues/118#issuecomment-1',
          body: '<!-- session-recorder:other-attempt -->',
        },
      ]),
    );
    expect(await findCreatedComment(target, 'token')).toBeUndefined();
  });
});
