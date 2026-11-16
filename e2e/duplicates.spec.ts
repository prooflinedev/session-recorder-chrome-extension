import type { BrowserContext, Page, Worker } from '@playwright/test';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

const message = "TypeError: Cannot read properties of undefined (reading 'total')";
const reportUrl = 'https://abc.reports.pages.dev';
const commentUrl = 'https://github.com/owner/repository/issues/118#issuecomment-1';
const exactQuery = /^repo:owner\/repository is:issue "(sr-[0-9a-f]{12})"$/;

/** Record and stop a session on the demo page. */
async function record(context: BrowserContext, background: Worker): Promise<string> {
  const demo = await context.newPage();
  await demo.goto('/');
  const started = await dispatch<{ ok: boolean; session: { id: string } }>(background, {
    kind: 'session/start',
    tabId: await tabIdForUrl(background, 'http://localhost:5319'),
  });
  expect(started.ok).toBe(true);
  await dispatch(background, { kind: 'marker/add', name: 'Checkout totals break' });
  await dispatch(background, { kind: 'session/stop' });
  return started.session.id;
}

/**
 * Playwright holds the debugger, so capture cannot produce errors. Write an
 * uncaught exception into the recording's IndexedDB events from an extension page.
 */
async function seedException(page: Page, extensionId: string, sessionId: string) {
  await page.goto(extUrl(extensionId, 'options.html'));
  await page.evaluate(
    ({ sessionId, message }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('session-recorder', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction('events', 'readwrite');
          transaction.objectStore('events').put({
            id: 'seeded-exception',
            sessionId,
            t: 250,
            type: 'error',
            importance: 1,
            protected: true,
            payload: {
              origin: 'exception',
              message,
              stack: [
                '    at calculateTotals (http://localhost:5319/assets/cart-Xy12ab34.js:10:20)',
                '    at submitOrder (http://localhost:5319/assets/index-B3k9x2Lq.js:30:40)',
              ].join('\n'),
            },
          });
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    { sessionId, message },
  );
}

interface GitHubLog {
  searches: string[];
  issues: { body: string }[];
  comments: { url: string; body: string }[];
}
/** Personal Cloudflare publishing and a GitHub token for owner/repository. */
async function personalFiling(
  context: BrowserContext,
  background: Worker,
  github: {
    search?: (query: string, attempt: number) => { status: number; json: unknown } | undefined;
    holdComment?: Promise<void>;
    /** Start without a GitHub token for owner/repository. */
    noToken?: boolean;
  } = {},
): Promise<GitHubLog> {
  const accountId = 'a'.repeat(32);
  const appId = '12345678-1234-1234-1234-123456789abc';
  await background.evaluate(
    ({ accountId, appId, githubToken }) =>
      chrome.storage.local.set({
        sharingSettings: {
          cloudflare: {
            apiToken: 'cloudflare-private-key',
            accountId,
            projectName: 'reports',
            accessAppId: appId,
            teamDomain: 'team.cloudflareaccess.com',
          },
          repository: 'owner/repository',
          githubToken,
        },
      }),
    { accountId, appId, githubToken: github.noToken ? '' : 'github-private-key' },
  );
  await context.route('https://api.cloudflare.com/client/v4/**', async (route) => {
    const url = route.request().url();
    let result: unknown = null;
    if (url.endsWith('/pages/projects/reports'))
      result = {
        name: 'reports',
        subdomain: 'reports.pages.dev',
        production_branch: 'main',
        deployment_configs: { preview: { fail_open: false } },
      };
    else if (url.endsWith(`/access/apps/${appId}`))
      result = { type: 'self_hosted', domain: '*.reports.pages.dev', aud: 'b'.repeat(64) };
    else if (url.includes('/policies?')) result = [{ decision: 'allow' }];
    else if (url.endsWith('/upload-token')) result = { jwt: 'upload-jwt' };
    else if (url.endsWith('/deployments'))
      result = {
        id: 'deployment-1',
        url: reportUrl,
        environment: 'preview',
        latest_stage: { name: 'deploy', status: 'success' },
      };
    await route.fulfill({ json: { success: true, result } });
  });
  await context.route('https://team.cloudflareaccess.com/cdn-cgi/access/certs', (route) =>
    route.fulfill({ json: { keys: [] } }),
  );
  await context.route('https://github.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>GitHub test</h1>' }),
  );
  const log: GitHubLog = { searches: [], issues: [], comments: [] };
  await context.route('https://api.github.com/**', async (route) => {
    const request = route.request();
    expect(request.headers().authorization).toBe('Bearer github-private-key');
    const url = new URL(request.url());
    if (url.pathname === '/search/issues') {
      const query = url.searchParams.get('q') ?? '';
      log.searches.push(query);
      const custom = github.search?.(query, log.searches.length);
      if (custom) return route.fulfill(custom);
      const exact = exactQuery.exec(query);
      const items = exact
        ? [
            {
              number: 118,
              title: 'Checkout 500 on Pay',
              state: 'open',
              body: `Report\nError fingerprint: \`${exact[1]}\``,
            },
          ]
        : [
            { number: 118, title: 'Checkout 500 on Pay', state: 'open', body: '' },
            { number: 97, title: 'TypeError on cart totals', state: 'closed', body: '' },
          ];
      return route.fulfill({ json: { total_count: items.length, items } });
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/issues/118/comments')) {
      log.comments.push({ url: url.pathname, body: request.postDataJSON().body });
      await github.holdComment;
      return route.fulfill({ status: 201, json: { id: 1, html_url: commentUrl } });
    }
    if (request.method() === 'POST') {
      log.issues.push(request.postDataJSON());
      return route.fulfill({
        status: 201,
        json: { number: 42, html_url: 'https://github.com/owner/repository/issues/42' },
      });
    }
    return route.fulfill({ json: { has_issues: true, permissions: { push: true } } });
  });
  return log;
}

const duplicatesPanel = (page: Page) =>
  page.getByRole('region', { name: 'Possible duplicates' });

test('shows issues with the same error and possibly related issues', async ({
  context,
  background,
  extensionId,
}) => {
  const sessionId = await record(context, background);
  const log = await personalFiling(context, background);
  const page = await context.newPage();
  await seedException(page, extensionId, sessionId);
  await page.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  const panel = duplicatesPanel(page);
  await expect(panel.getByRole('link', { name: '#118 Checkout 500 on Pay' })).toBeVisible();
  expect(log.searches).toHaveLength(2);
  const fingerprint = exactQuery.exec(log.searches[0]!)?.[1];
  expect(fingerprint).toBeDefined();
  expect(log.searches[1]).toBe(`repo:owner/repository is:issue "${message}"`);
  await expect(panel).toContainText(fingerprint!);
  const same = panel.getByRole('list', { name: 'Same error' });
  const related = panel.getByRole('list', { name: 'Possibly related' });
  await expect(same.getByRole('listitem')).toHaveCount(1);
  await expect(same).toContainText('open');
  await expect(same.getByRole('link', { name: '#118 Checkout 500 on Pay' })).toHaveAttribute(
    'href',
    'https://github.com/owner/repository/issues/118',
  );
  await expect(related.getByRole('listitem')).toHaveCount(1);
  await expect(related).toContainText('closed');
  await expect(related).toContainText('possible regression');
  await expect(related.getByRole('link', { name: '#97 TypeError on cart totals' })).toHaveAttribute(
    'target',
    '_blank',
  );
  await expect(panel.getByRole('button', { name: 'Add to #118' })).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Add to #97' })).toBeEnabled();
  await expect(panel.getByText('Labels and assignees apply only to new issues.')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByRole('button', { name: 'Add to #97' })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test('adds the report to an existing issue as a comment', async ({
  context,
  background,
  extensionId,
}) => {
  const sessionId = await record(context, background);
  let releaseComment!: () => void;
  const log = await personalFiling(context, background, {
    holdComment: new Promise<void>((resolve) => {
      releaseComment = resolve;
    }),
  });
  const page = await context.newPage();
  await seedException(page, extensionId, sessionId);
  await page.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  await duplicatesPanel(page).getByRole('button', { name: 'Add to #118' }).click();
  await expect(page.getByRole('status')).toHaveText('Adding to #118…');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  releaseComment();
  const view = page.getByRole('link', { name: 'View comment on #118' });
  await expect(view).toHaveAttribute('href', commentUrl);
  const fingerprint = exactQuery.exec(log.searches[0]!)![1];
  expect(log.issues).toHaveLength(0);
  expect(log.comments).toHaveLength(1);
  expect(log.comments[0]!.url).toBe('/repos/owner/repository/issues/118/comments');
  expect(log.comments[0]!.body).toContain(reportUrl);
  expect(log.comments[0]!.body).toContain(`Error fingerprint: \`${fingerprint}\``);
  expect(log.comments[0]!.body).toContain('session-recorder:');
  await expect(duplicatesPanel(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('link', { name: 'View comment on #118' })).toHaveAttribute(
    'href',
    commentUrl,
  );
  await expect(duplicatesPanel(page)).toHaveCount(0);
  expect(log.comments).toHaveLength(1);
});

test('explains that labels and assignees apply only to new issues', async ({
  context,
  background,
  extensionId,
}) => {
  const sessionId = await record(context, background);
  const log = await personalFiling(context, background);
  await background.evaluate(() =>
    chrome.storage.local.set({
      issueTriageDefaults: { 'owner/repository': { labels: ['bug'], assignees: ['octocat'] } },
    }),
  );
  const page = await context.newPage();
  await seedException(page, extensionId, sessionId);
  await page.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  const details = page.getByRole('complementary', { name: 'Report details' });
  await expect(details.getByLabel('Labels', { exact: true })).toContainText('bug');
  const panel = duplicatesPanel(page);
  await expect(panel.getByText('Labels and assignees apply only to new issues.')).toBeVisible();
  await panel.getByRole('button', { name: 'Add to #118' }).click();
  await expect(page.getByRole('link', { name: 'View comment on #118' })).toBeVisible();
  expect(log.comments).toHaveLength(1);
  // A comment carries no labels or assignees, so the filed view does not show them.
  await expect(details.getByText('Labels', { exact: true })).toHaveCount(0);
  await expect(details.getByText('Assignees', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('link', { name: 'View comment on #118' })).toBeVisible();
  await expect(details.getByText('Labels', { exact: true })).toHaveCount(0);
  await expect(details.getByText('@octocat', { exact: true })).toHaveCount(0);
});

test('checks for duplicates once a repository token is added and hides them when it is removed', async ({
  context,
  background,
  extensionId,
}) => {
  const sessionId = await record(context, background);
  const log = await personalFiling(context, background, { noToken: true });
  const page = await context.newPage();
  await seedException(page, extensionId, sessionId);
  await page.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  await expect(
    page.getByRole('button', { name: 'File GitHub issue', exact: true }),
  ).toBeEnabled();
  await expect(page.getByText('Possible duplicates')).toHaveCount(0);
  expect(log.searches).toHaveLength(0);
  const saveRepositories = (repositories: { id: string; repository: string; token: string }[]) =>
    background.evaluate(async (repositories) => {
      const { sharingSettings } = await chrome.storage.local.get('sharingSettings');
      await chrome.storage.local.set({ sharingSettings: { ...sharingSettings, repositories } });
    }, repositories);
  await saveRepositories([
    { id: 'main', repository: 'owner/repository', token: 'github-private-key' },
    { id: 'second', repository: 'owner/second', token: 'second-key' },
  ]);
  // The added repository shows the page has applied the new settings.
  await expect(
    page.getByLabel('Issue repository').locator('option', { hasText: 'owner/second' }),
  ).toHaveCount(1);
  const panel = duplicatesPanel(page);
  await expect(panel.getByRole('link', { name: '#118 Checkout 500 on Pay' })).toBeVisible();
  expect(log.searches).toHaveLength(2);
  await saveRepositories([
    { id: 'main', repository: 'owner/repository', token: '' },
    { id: 'third', repository: 'owner/third', token: 'third-key' },
  ]);
  await expect(
    page.getByLabel('Issue repository').locator('option', { hasText: 'owner/third' }),
  ).toHaveCount(1);
  await expect(page.getByText('Possible duplicates')).toHaveCount(0);
  expect(log.searches).toHaveLength(2);
});

test('allows Add to only when the prepared report can be published', async ({
  context,
  background,
  extensionId,
}) => {
  const sessionId = await record(context, background);
  const log = await personalFiling(context, background);
  const page = await context.newPage();
  await seedException(page, extensionId, sessionId);
  // A captured file over Cloudflare Pages' 25 MiB limit blocks publishing, as File issue shows.
  await page.evaluate(
    (sessionId) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('session-recorder', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction(['events', 'assets'], 'readwrite');
          const size = 26 * 1024 * 1024;
          transaction.objectStore('assets').put({
            id: 'oversized-file',
            sessionId,
            kind: 'file',
            mime: 'application/octet-stream',
            size,
            blob: new Blob([new Uint8Array(size)], { type: 'application/octet-stream' }),
          });
          transaction.objectStore('events').put({
            id: 'oversized-file-event',
            sessionId,
            t: 300,
            type: 'file-captured',
            importance: 1,
            payload: {
              assetId: 'oversized-file',
              fileName: 'export.bin',
              mime: 'application/octet-stream',
              size,
            },
          });
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    sessionId,
  );
  await page.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  await expect(page.getByText('exceeds Cloudflare Pages’ 25 MiB file limit', { exact: false })).toBeVisible();
  const add = duplicatesPanel(page).getByRole('button', { name: 'Add to #118' });
  await expect(add).toBeVisible();
  await expect(page.getByRole('button', { name: 'File GitHub issue', exact: true })).toBeDisabled();
  await expect(add).toBeDisabled();
  expect(log.comments).toHaveLength(0);
});

test('includes the error fingerprint in a new issue', async ({
  context,
  background,
  extensionId,
}) => {
  const sessionId = await record(context, background);
  const log = await personalFiling(context, background);
  const page = await context.newPage();
  await seedException(page, extensionId, sessionId);
  await page.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  await expect(duplicatesPanel(page).getByRole('button', { name: 'Add to #118' })).toBeVisible();
  await page.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View issue #42' })).toBeVisible();
  const fingerprint = exactQuery.exec(log.searches[0]!)![1];
  expect(log.comments).toHaveLength(0);
  expect(log.issues).toHaveLength(1);
  expect(log.issues[0]!.body).toContain(
    `sign-in required.\nError fingerprint: \`${fingerprint}\`\n`,
  );
});

test('shows no duplicate check for a recording without errors', async ({
  context,
  background,
  extensionId,
}) => {
  const sessionId = await record(context, background);
  const log = await personalFiling(context, background);
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  await expect(
    page.getByRole('button', { name: 'File GitHub issue', exact: true }),
  ).toBeEnabled();
  await expect(page.getByText('Possible duplicates')).toHaveCount(0);
  await page.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View issue #42' })).toBeVisible();
  expect(log.searches).toHaveLength(0);
  expect(log.issues[0]!.body).not.toContain('Error fingerprint');
});

test('explains a failed duplicate check, retries it and still files the issue', async ({
  context,
  background,
  extensionId,
}) => {
  const sessionId = await record(context, background);
  const log = await personalFiling(context, background, {
    search: (_query, attempt) =>
      attempt <= 2 ? { status: 403, json: { message: 'API rate limit exceeded' } } : undefined,
  });
  const page = await context.newPage();
  await seedException(page, extensionId, sessionId);
  await page.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  const panel = duplicatesPanel(page);
  await expect(panel).toContainText("Couldn't check for duplicates (403).");
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(panel.getByRole('link', { name: '#118 Checkout 500 on Pay' })).toBeVisible();
  expect(log.searches).toHaveLength(4);
  await page.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View issue #42' })).toBeVisible();
  expect(log.issues).toHaveLength(1);
});

test('files through Proofline with the fingerprint and no duplicate check', async ({
  context,
  background,
  extensionId,
}) => {
  const org = '10000000-0000-4000-8000-000000000001';
  const reportId = '20000000-0000-4000-8000-000000000001';
  const sessionId = await record(context, background);
  await background.evaluate(
    ({ org }) =>
      chrome.storage.local.set({
        prooflineSettings: {
          aiMode: 'proofline',
          github: 'proofline',
          publishing: 'proofline',
          model: '',
          connection: {
            accessToken: 'test-proofline-token',
            organizationId: org,
            expiresAt: Date.now() + 3600000,
            account: {
              user: { id: 'u1', login: 'alice' },
              organization: { id: org, login: 'alice', name: 'Personal', is_personal: true },
              organizations: [{ id: org, login: 'alice', name: 'Personal', is_personal: true }],
              default_organization_id: org,
              credits: { balance_microcredits: 10000000000, microcredits_per_credit: 1000000 },
              repositories: [
                {
                  id: '30000000-0000-4000-8000-000000000001',
                  full_name: 'alice/product',
                  github_repository_id: 1,
                },
              ],
            },
          },
        },
      }),
    { org },
  );
  const githubApi: string[] = [];
  await context.route('https://api.github.com/**', async (route) => {
    githubApi.push(route.request().url());
    await route.fulfill({ status: 500, json: {} });
  });
  const issueBodies: string[] = [];
  await context.route('https://proofline.sh/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let json: unknown;
    if (path.endsWith('/ai')) {
      const input = request.postDataJSON();
      json = {
        id: input.request_id,
        status: 'completed',
        result: { title: 'Checkout totals break', markdown: 'Totals throw a TypeError.' },
      };
    } else if (path.endsWith('/reports'))
      json = { id: reportId, url: `https://proofline.sh/recorder/reports/${org}/${reportId}` };
    else if (path.endsWith('/attachments')) json = { id: 'asset' };
    else if (path.endsWith('/issue')) {
      issueBodies.push(request.postDataJSON().body);
      json = {
        request_id: request.postDataJSON().request_id,
        status: 'complete',
        number: 42,
        url: 'https://github.com/alice/product/issues/42',
      };
    } else throw new Error(`Unexpected Proofline request ${path}`);
    await route.fulfill({ json });
  });
  await context.route('https://github.com/alice/product/issues/42', (route) =>
    route.fulfill({ body: 'Issue fixture' }),
  );
  const page = await context.newPage();
  await seedException(page, extensionId, sessionId);
  await page.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  await expect(page.getByLabel('Issue repository')).toHaveValue('alice/product');
  await page.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View issue #42' })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByText('Possible duplicates')).toHaveCount(0);
  expect(githubApi).toHaveLength(0);
  expect(issueBodies).toHaveLength(1);
  expect(issueBodies[0]).toContain('Totals throw a TypeError.');
  expect(issueBodies[0]).toMatch(/\n\nError fingerprint: `sr-[0-9a-f]{12}`\n$/);
});
