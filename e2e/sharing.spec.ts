import type { BrowserContext, Worker } from '@playwright/test';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

const githubLabels = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'checkout', color: '0e8a16' },
  { name: 'needs-triage', color: 'fbca04' },
];
const githubAssignees = [{ login: 'octocat' }, { login: 'hubot' }];

test('keeps provider credentials separate and restores each provider configuration', async ({
  context,
  background,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, 'options.html#summaries'));
  await page.getByLabel('Summary provider').selectOption('openai');
  await expect(page.getByLabel('Summary model', { exact: true })).toHaveValue('gpt-6.1-sol');
  await expect(page.getByRole('link', { name: 'Set up AI summaries' })).toHaveAttribute(
    'href', 'https://proofline.sh/help/session-recorder-ai-summaries/',
  );
  await page.getByLabel('Summary API key', { exact: true }).fill('test-openai-key');
  await page.getByLabel('Summary model', { exact: true }).fill('test-model');
  await page.getByLabel('Summary provider').selectOption('compatible');
  await page.getByLabel('API base URL').fill('http://localhost:11434/v1');
  await page.getByLabel('Summary model', { exact: true }).fill('local-model');
  await page
    .getByRole('button', { name: 'Save summary settings', exact: true })
    .click();
  await expect(
    page.getByText('Sharing settings saved.', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('API base URL')).toHaveValue(
    'http://localhost:11434/v1',
  );
  await page.getByLabel('Summary provider').selectOption('openai');
  await expect(page.getByLabel('Summary API key', { exact: true })).toHaveValue(
    'test-openai-key',
  );
  await expect(page.getByLabel('Summary model', { exact: true })).toHaveValue('test-model');
  const stored = await background.evaluate(async () =>
    chrome.storage.local.get(['sharingSettings', 'defaultSettings']),
  );
  expect(JSON.stringify(stored.defaultSettings ?? {})).not.toContain('test-openai-key');
  await page.getByRole('link', { name: 'Publishing', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Set up protected publishing' })).toHaveAttribute(
    'href', 'https://proofline.sh/help/session-recorder-cloudflare/',
  );
  await expect(page.locator('.sharing-setup')).toHaveCount(0);
  const tokenLink = new URL(
    (await page
      .getByRole('link', { name: 'Create a preconfigured API token' })
      .getAttribute('href')) as string,
  );
  expect(tokenLink.searchParams.get('permissionGroupKeys')).toContain('page');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: '/tmp/session-recorder-settings-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => {
    const active = await page.getByRole('link', { name: 'Publishing', exact: true }).boundingBox();
    return !!active && active.x >= 0 && active.x + active.width <= 390;
  }).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/session-recorder-settings-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.screenshot({ path: '/tmp/session-recorder-settings-mobile-dark.png', fullPage: true, animations: 'disabled' });
});

test('files an issue in one click with an automatic summary and protected report', async ({
  context,
  background,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto('/');
  const started = await dispatch<{ ok: boolean; session: { id: string } }>(background, {
    kind: 'session/start',
    tabId: await tabIdForUrl(background, 'http://localhost:5319'),
  });
  expect(started.ok).toBe(true);
  await dispatch(background, {
    kind: 'marker/add',
    name: 'Checkout unexpectedly returns an error',
  });
  await dispatch(background, { kind: 'session/stop' });
  const sessionId = started.session.id;
  const accountId = 'a'.repeat(32);
  const appId = '12345678-1234-1234-1234-123456789abc';
  const reportUrl = 'https://abc.reports.pages.dev';
  await background.evaluate(
    async ({ accountId, appId }) => {
      await chrome.storage.local.set({
        sharingSettings: {
          cloudflare: {
            apiToken: 'cloudflare-private-key',
            accountId,
            projectName: 'reports',
            accessAppId: appId,
            teamDomain: 'team.cloudflareaccess.com',
          },
          repository: 'owner/repository',
          githubToken: 'github-private-key',
          provider: 'openai',
          models: {
            openai: {
              apiKey: 'model-private-key',
              model: 'test-model',
              baseUrl: 'https://api.openai.com/v1',
            },
          },
        },
      });
    },
    { accountId, appId },
  );
  let deployments = 0;
  const uploaded: string[] = [];
  await context.route('https://api.cloudflare.com/client/v4/**', async (route) => {
    const url = route.request().url();
    let result: unknown;
    if (url.endsWith('/pages/projects/reports'))
      result = {
        name: 'reports',
        subdomain: 'reports.pages.dev',
        production_branch: 'main',
        deployment_configs: { preview: { fail_open: false } },
      };
    else if (url.endsWith(`/access/apps/${appId}`))
      result = {
        type: 'self_hosted',
        domain: '*.reports.pages.dev',
        aud: 'b'.repeat(64),
      };
    else if (url.includes('/policies?')) result = [{ decision: 'allow' }];
    else if (url.endsWith('/upload-token')) result = { jwt: 'upload-jwt' };
    else if (url.endsWith('/pages/assets/upload')) {
      const payload = route.request().postDataJSON() as { value: string }[];
      uploaded.push(
        ...payload.map((file) => Buffer.from(file.value, 'base64').toString('utf8')),
      );
      result = null;
    } else if (url.endsWith('/pages/assets/upsert-hashes')) result = null;
    else if (url.endsWith('/deployments')) {
      deployments++;
      const body = route.request().postData()!;
      expect(body).toContain('crypto.subtle.verify');
      expect(body).not.toContain('cloudflare-private-key');
      result = {
        id: 'deployment-1',
        url: reportUrl,
        environment: 'preview',
        latest_stage: { name: 'deploy', status: 'success' },
      };
    } else throw new Error(`Unexpected Cloudflare request: ${url}`);
    await route.fulfill({ json: { success: true, result } });
  });
  await context.route(
    'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
    (route) => route.fulfill({ json: { keys: [] } }),
  );
  await context.route('https://api.openai.com/v1/chat/completions', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer model-private-key');
    expect(route.request().postData()).toContain('Checkout unexpectedly');
    await route.fulfill({
      json: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                title: 'Checkout shows an error',
                body: '## Summary\nCheckout fails.\n\n## Evidence\nThe user marked the checkout failure.',
              }),
            },
          },
        ],
      },
    });
  });
  await context.route('https://github.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h1>GitHub issue composer test</h1>',
    }),
  );
  let releaseVerification!: () => void;
  const verificationGate = new Promise<void>((resolve) => {
    releaseVerification = resolve;
  });
  let rejectFirstVerification = true;
  let issues = 0;
  let summaries = 0;
  let githubReads = 0;
  page.on('request', (request) => {
    if (request.url().includes('/chat/completions')) summaries++;
  });
  await context.route('https://api.github.com/**', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer github-private-key');
    if (route.request().method() === 'POST') {
      issues++;
      const payload = route.request().postDataJSON();
      expect(payload.title).toBe('Checkout shows an error');
      expect(payload.body).toContain(reportUrl);
      expect(payload.body).toContain('session-recorder:');
      expect(payload.labels).toEqual(['bug']);
      expect(payload.assignees).toEqual(['octocat']);
      await route.fulfill({
        status: 201,
        json: {
          number: 42,
          html_url: 'https://github.com/owner/repository/issues/42',
          labels: [{ name: 'bug' }],
          assignees: [{ login: 'octocat' }],
        },
      });
    } else if (rejectFirstVerification) {
      rejectFirstVerification = false;
      await verificationGate;
      await route.fulfill({
        status: 403,
        json: { message: 'Resource not accessible by personal access token' },
      });
    } else {
      githubReads++;
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/labels')) await route.fulfill({ json: githubLabels });
      else if (path.endsWith('/assignees')) await route.fulfill({ json: githubAssignees });
      else await route.fulfill({ json: { has_issues: true, permissions: { push: true } } });
    }
  });
  await page.goto(extUrl(extensionId, `share.html?session=${sessionId}&level=L2`));
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '/tmp/session-recorder-file-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Checking GitHub connection…');
  await expect(
    page.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: '/tmp/session-recorder-filing-progress-mobile.png',
    animations: 'disabled',
  });
  releaseVerification();
  await expect(page.getByRole('alert')).toBeInViewport();
  await page.screenshot({
    path: '/tmp/session-recorder-filing-error-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(deployments).toBe(0);
  expect(summaries).toBe(0);
  await page.getByLabel('Labels', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'bug', exact: true }).check();
  await page.getByLabel('Assignees', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'octocat', exact: true }).check();
  await page.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View issue #42' })).toBeVisible();
  const filedDetails = page.getByRole('complementary', { name: 'Report details' });
  await expect(filedDetails.getByText('bug', { exact: true })).toBeVisible();
  await expect(filedDetails.getByText('@octocat', { exact: true })).toBeVisible();
  await expect(page.getByText('GitHub did not apply', { exact: false })).toHaveCount(0);
  expect(issues).toBe(1);
  expect(summaries).toBe(1);
  expect(uploaded.join('\n')).not.toMatch(
    /cloudflare-private-key|model-private-key|github-private-key/,
  );
  await page.reload();
  await expect(page.getByRole('link', { name: 'View issue #42' })).toBeVisible();
  expect(issues).toBe(1);
  expect(deployments).toBe(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: '.impeccable/review/desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1226, height: 609 });
  await page.screenshot({
    path: '.impeccable/review/user-1226.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: '.impeccable/review/desktop-dark.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: '.impeccable/review/mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  // A new draft for the same repository starts with the remembered choice, without a fetch.
  const demo = await context.newPage();
  await demo.goto('/');
  const next = await dispatch<{ ok: boolean; session: { id: string } }>(background, {
    kind: 'session/start',
    tabId: await tabIdForUrl(background, 'http://localhost:5319'),
  });
  expect(next.ok).toBe(true);
  await dispatch(background, {
    kind: 'marker/add',
    name: 'Checkout unexpectedly returns an error again',
  });
  await dispatch(background, { kind: 'session/stop' });
  const readsBefore = githubReads;
  await page.goto(extUrl(extensionId, `share.html?session=${next.session.id}`));
  await expect(page.getByLabel('Issue repository')).toHaveValue('owner/repository');
  await expect(page.getByLabel('Labels', { exact: true })).toContainText('bug');
  await expect(page.getByLabel('Assignees', { exact: true })).toContainText('@octocat');
  expect(githubReads).toBe(readsBefore);
});

/** A stopped recording, personal Cloudflare and GitHub settings, and mocked services. */
async function preparePersonalFiling(
  context: BrowserContext,
  background: Worker,
  github: {
    push: boolean;
    created: (payload: { labels?: string[]; assignees?: string[] }) => object;
  },
) {
  const demo = await context.newPage();
  await demo.goto('/');
  const started = await dispatch<{ ok: boolean; session: { id: string } }>(background, {
    kind: 'session/start',
    tabId: await tabIdForUrl(background, 'http://localhost:5319'),
  });
  await dispatch(background, { kind: 'session/stop' });
  const accountId = 'a'.repeat(32);
  const appId = '12345678-1234-1234-1234-123456789abc';
  await background.evaluate(
    ({ accountId, appId }) =>
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
          githubToken: 'github-private-key',
        },
      }),
    { accountId, appId },
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
        url: 'https://abc.reports.pages.dev',
        environment: 'preview',
        latest_stage: { name: 'deploy', status: 'success' },
      };
    await route.fulfill({ json: { success: true, result } });
  });
  await context.route('https://team.cloudflareaccess.com/cdn-cgi/access/certs', (route) =>
    route.fulfill({ json: { keys: [] } }),
  );
  await context.route('https://github.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>GitHub issue test</h1>' }),
  );
  const created: { labels?: string[]; assignees?: string[] }[] = [];
  await context.route('https://api.github.com/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      const payload = request.postDataJSON();
      created.push(payload);
      await route.fulfill({
        status: 201,
        json: {
          number: 42,
          html_url: 'https://github.com/owner/repository/issues/42',
          ...github.created(payload),
        },
      });
    } else if (path.endsWith('/labels')) await route.fulfill({ json: githubLabels });
    else if (path.endsWith('/assignees')) await route.fulfill({ json: githubAssignees });
    else
      await route.fulfill({
        json: { has_issues: true, permissions: { push: github.push } },
      });
  });
  return { sessionId: started.session.id, created };
}

test('reports labels and assignees GitHub did not apply', async ({
  context,
  background,
  extensionId,
}) => {
  const { sessionId, created } = await preparePersonalFiling(context, background, {
    push: true,
    created: (payload) => ({
      labels: [{ name: 'checkout' }],
      assignees: (payload.assignees ?? []).map((login) => ({ login })),
    }),
  });
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  await page.getByLabel('Labels', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'bug', exact: true }).check();
  await page.getByRole('checkbox', { name: 'checkout', exact: true }).check();
  await page.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View issue #42' })).toBeVisible();
  expect(created).toHaveLength(1);
  expect(created[0]!.labels).toEqual(['bug', 'checkout']);
  const warning = page.getByText(
    'GitHub did not apply bug. Check write access to owner/repository.',
  );
  await expect(warning).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'View issue #42' })).toBeVisible();
  await expect(warning).toBeVisible();
});

test('explains missing write access and still files the issue', async ({
  context,
  background,
  extensionId,
}) => {
  const { sessionId, created } = await preparePersonalFiling(context, background, {
    push: false,
    created: () => ({}),
  });
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  await page.getByLabel('Labels', { exact: true }).click();
  await expect(
    page.getByText('You need write access to owner/repository to set labels or assignees.'),
  ).toBeVisible();
  await expect(page.getByRole('checkbox', { disabled: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View issue #42' })).toBeVisible();
  expect(created).toHaveLength(1);
  expect(Object.keys(created[0]!)).toEqual(['title', 'body']);
});
