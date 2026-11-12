import {
  test,
  expect,
  extUrl,
  dispatch,
  tabIdForUrl,
  fromExtension,
  fulfillWebsiteRequest,
} from './support';
const org = '10000000-0000-4000-8000-000000000001';
const reportId = '20000000-0000-4000-8000-000000000001';
// Like the real approval page, the fixture calls the website's own API.
const approvalPage = '<p>Approval fixture</p><script>fetch("/api/v1/me")</script>';
const account = {
  user: { id: 'u1', login: 'alice' },
  organization: {
    id: org,
    login: 'alice',
    name: 'Personal workspace',
    is_personal: true,
  },
  organizations: [
    { id: org, login: 'alice', name: 'Personal workspace', is_personal: true },
  ],
  default_organization_id: org,
  credits: { balance_microcredits: 10000000000, microcredits_per_credit: 1000000 },
  repositories: [
    {
      id: '30000000-0000-4000-8000-000000000001',
      full_name: 'alice/product',
      github_repository_id: 1,
    },
  ],
};
const connected = () => ({
  aiMode: 'proofline',
  github: 'proofline',
  publishing: 'proofline',
  model: '',
  connection: {
    accessToken: 'test-proofline-token',
    organizationId: org,
    expiresAt: Date.now() + 3600000,
    account,
  },
});

test('connects by browser approval and uses Proofline for every service', async ({
  context,
  background,
  extensionId,
}) => {
  await background.evaluate(() =>
    chrome.storage.local.set({
      sharingSettings: { models: { openai: { apiKey: 'existing-key' } } },
    }),
  );
  await context.route('https://proofline.sh/**', async (route) => {
    const url = route.request().url();
    const json = url.endsWith('/auth/device/code')
      ? {
          device_code: 'private-device-code',
          user_code: 'ABCD-EFGH',
          verification_uri_complete: 'https://proofline.sh/auth/device?user_code=ABCD-EFGH',
          expires_in: 600,
          interval: 5,
        }
      : url.endsWith('/auth/device/token')
        ? {
            access_token: 'test-proofline-token',
            organization_id: org,
            expires_in: 3600,
            scope: 'recorder:read recorder:ai recorder:reports recorder:issues',
          }
        : url.endsWith('/account')
          ? account
          : null;
    await route.fulfill(
      json
        ? { json }
        : { contentType: 'text/html', body: '<p>Browser approval fixture</p>' },
    );
  });
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, 'options.html#proofline'));
  const approvalPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Connect to Proofline' }).click();
  const approvalPage = await approvalPromise;
  await approvalPage.waitForURL('https://proofline.sh/auth/device?user_code=ABCD-EFGH');
  await expect(page.getByText('ABCD-EFGH', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change account' })).toBeVisible({ timeout: 20000 });
  await expect.poll(() => approvalPage.isClosed()).toBe(true);
  const active = await background.evaluate(async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url,
  );
  expect(active).toBe(extUrl(extensionId, 'options.html#proofline'));
  await expect(page.getByLabel('AI usage')).toHaveCount(0);
  await page.getByRole('link', { name: 'Services', exact: true }).click();
  await expect(page.getByText('Using Proofline for all AI services, private report hosting and GitHub issues.')).toBeVisible();
  await expect(page.locator('select,input')).toHaveCount(0);
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.screenshot({
    path: 'test-results/recorder-proofline-account-light.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: 'test-results/recorder-proofline-account-dark-narrow.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.getByRole('link', { name: 'Proofline', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Connect to Proofline', exact: true }),
  ).toBeVisible();
  const stored = await background.evaluate(() =>
    chrome.storage.local.get(['sharingSettings', 'prooflineSettings']),
  );
  expect(stored.sharingSettings.models.openai.apiKey).toBe('existing-key');
  expect(stored.prooflineSettings.aiMode).toBe('personal');
  expect(stored.prooflineSettings.connection).toBeUndefined();
  const panel = await context.newPage();
  await panel.goto(extUrl(extensionId, 'sidepanel.html'));
  await panel.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByRole('link', { name: 'Connect to Proofline', exact: true })).toBeVisible();
  await expect(panel.locator('.app__actions .proofline-brand')).toHaveCount(0);
  await panel.screenshot({ path: 'test-results/proofline-connect-panel-light.png', fullPage: true });
});

test('older connected profiles use Proofline without manual setup or service overrides', async ({ context, background, extensionId }) => {
  await background.evaluate((settings) => chrome.storage.local.set({
    prooflineSettings: { ...settings, aiMode: 'personal', github: 'personal', publishing: 'cloudflare', model: 'old-model-override' },
    micFromStart: true,
  }), connected());
  await context.route('https://proofline.sh/**', route => route.fulfill({ status: 503, json: { detail: 'Fixture: no provider calls' } }));
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, 'options.html#services'));
  await expect(page.getByText('Using Proofline for all AI services, private report hosting and GitHub issues.')).toBeVisible();
  await expect(page.locator('#settings-page input,#settings-page select')).toHaveCount(0);
  for (const section of [
    { link: 'AI summaries', message: 'Using Proofline for AI summaries.' },
    { link: 'Publishing', message: 'Using Proofline for private report hosting.' },
    { link: 'GitHub', message: 'Using Proofline for GitHub issues.' },
    { link: 'Transcription', message: 'Using Proofline credits for transcription.' },
  ]) {
    await page.getByRole('link', { name: section.link, exact: true }).click();
    await expect(page.getByText(section.message, { exact: true })).toBeVisible();
    await expect(page.locator('#settings-page input,#settings-page select,#settings-page textarea')).toHaveCount(0);
  }
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.screenshot({ path: 'test-results/proofline-connected-settings-light.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/proofline-connected-settings-dark.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const demo = await context.newPage();
  await demo.goto('/');
  const panel = await context.newPage();
  await panel.goto(extUrl(extensionId, 'sidepanel.html'));
  await expect(panel.locator('.app__actions .proofline-brand')).toHaveCount(0);
  await expect(panel.locator('.proofline-account-link svg')).toHaveCount(1);
  await expect(panel.locator('.proofline-account-link')).toHaveText('alice');
  await panel.setViewportSize({ width: 390, height: 844 });
  await panel.screenshot({ path: 'test-results/proofline-connected-panel-light.png', fullPage: true });
  await panel.emulateMedia({ colorScheme: 'dark' });
  await panel.screenshot({ path: 'test-results/proofline-connected-panel-dark.png', fullPage: true });
  await background.evaluate(id => chrome.tabs.update(id, { active: true }), await tabIdForUrl(background, 'http://localhost:5319'));
  await panel.getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(panel.getByRole('dialog', { name: 'Voice setup' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await dispatch(background, { kind: 'session/stop' });
});

test('connecting Proofline populates and files a saved draft without personal repository tokens', async ({
  context, background, extensionId,
}) => {
  const demo = await context.newPage();
  await demo.goto('/');
  const recording = await dispatch<{ session: { id: string } }>(background, {
    kind: 'session/start', tabId: await tabIdForUrl(background, 'http://localhost:5319'),
  });
  await dispatch(background, { kind: 'session/stop' });
  await background.evaluate((id) => chrome.storage.local.set({
    [`shareDraft:${id}`]: {
      repository: '',
      draft: { title: 'Saved before connecting', body: 'Keep this manually written summary.' },
      draftSource: 'edited',
    },
  }), recording.session.id);
  const paths: string[] = [];
  await context.route('https://proofline.sh/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!fromExtension(request) && path !== '/auth/device') {
      // The approval page may call the website's own API; it never gets the token.
      await fulfillWebsiteRequest(route, ['test-proofline-token', 'repo-test-code']);
      return;
    }
    paths.push(path);
    let json: unknown;
    if (path === '/auth/device/code') json = {
      device_code: 'repo-test-code', user_code: 'REPO-TEST',
      verification_uri_complete: 'https://proofline.sh/auth/device?user_code=REPO-TEST',
      expires_in: 600, interval: 5,
    };
    else if (path === '/auth/device/token') json = {
      access_token: 'test-proofline-token', organization_id: org, expires_in: 3600,
      scope: 'recorder:read recorder:ai recorder:reports recorder:issues',
    };
    else if (path.endsWith('/account')) json = account;
    else if (path.endsWith('/reports')) json = {
      id: reportId, url: `https://proofline.sh/recorder/reports/${org}/${reportId}`,
    };
    else if (path.endsWith('/attachments')) json = { id: 'asset' };
    else if (path.endsWith('/issue')) {
      expect(request.postDataJSON()).toMatchObject({
        repository_id: account.repositories[0]!.id,
        title: 'Saved before connecting', body: 'Keep this manually written summary.',
      });
      json = { request_id: request.postDataJSON().request_id, status: 'complete',
        number: 42, url: 'https://github.com/alice/product/issues/42' };
    } else if (path === '/auth/device') {
      await route.fulfill({ contentType: 'text/html', body: approvalPage });
      return;
    } else if (path.startsWith('/api/') || path.startsWith('/auth/')) {
      throw new Error(`Unexpected request ${path}`);
    } else {
      await route.fulfill({ contentType: 'text/html', body: '<p>Public page fixture</p>' });
      return;
    }
    await route.fulfill({ json });
  });
  await context.route('https://github.com/alice/product/issues/42', route => route.fulfill({ body: 'Issue fixture' }));
  const share = await context.newPage();
  await share.goto(extUrl(extensionId, `share.html?session=${recording.session.id}`));
  await expect(share.getByLabel('Issue repository')).toBeDisabled();
  const options = await context.newPage();
  await options.goto(extUrl(extensionId, 'options.html#proofline'));
  await options.getByRole('button', { name: 'Connect to Proofline', exact: true }).click();
  await expect(options.getByRole('button', { name: 'Change account', exact: true })).toBeVisible({ timeout: 20000 });
  await expect(share.getByLabel('Issue repository')).toHaveValue('alice/product');
  await share.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
  await expect(share.getByRole('link', { name: 'View issue #42' })).toBeVisible();
  expect(paths.filter(path => path.endsWith('/reports'))).toHaveLength(1);
  expect(paths.filter(path => path.endsWith('/issue'))).toHaveLength(1);
  expect(paths.some(path => path.endsWith('/attachments'))).toBe(true);
  expect(paths.some(path => path.endsWith('/ai'))).toBe(false);
  await share.screenshot({ path: 'test-results/connected-repository-filed.png', fullPage: true });
});

test('files through Proofline with managed AI and private attachment uploads', async ({
  context,
  background,
  extensionId,
}) => {
  const demo = await context.newPage();
  await demo.goto('/');
  const started = await dispatch<{ ok: boolean; session: { id: string } }>(background, {
    kind: 'session/start',
    tabId: await tabIdForUrl(background, 'http://localhost:5319'),
  });
  await dispatch(background, {
    kind: 'marker/add',
    name: 'Explain the empty recipes screen',
  });
  await dispatch(background, { kind: 'session/stop' });
  await background.evaluate(
    (settings) => chrome.storage.local.set({ prooflineSettings: settings }),
    connected(),
  );
  const paths: string[] = [];
  let attachmentFailed = false;
  await context.route('https://proofline.sh/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    paths.push(path);
    expect(request.headers().authorization).toBe('Bearer test-proofline-token');
    let json: unknown;
    if (path.endsWith('/ai')) {
      const input = request.postDataJSON();
      expect(input.input.annotations.join('')).not.toContain('test-proofline-token');
      json = {
        id: input.request_id,
        status: 'completed',
        result: {
          title: 'Clarify the recipes empty state',
          markdown: 'Explain how to create the first recipe.',
        },
      };
    } else if (path.endsWith('/reports'))
      json = {
        id: reportId,
        url: `https://proofline.sh/recorder/reports/${org}/${reportId}`,
      };
    else if (path.endsWith('/attachments')) {
      if (!attachmentFailed) {
        attachmentFailed = true;
        await route.fulfill({
          status: 503,
          json: { detail: 'private report storage is not configured' },
        });
        return;
      }
      const body = request.postDataJSON();
      expect(body.name).not.toMatch(/\.html$/);
      json = { id: 'asset' };
    } else if (path.endsWith('/issue'))
      json = {
        request_id: request.postDataJSON().request_id,
        status: 'complete',
        number: 42,
        url: 'https://github.com/alice/product/issues/42',
      };
    else throw new Error(`Unexpected Proofline request ${path}`);
    await route.fulfill({ json });
  });
  await context.route('https://github.com/alice/product/issues/42', (route) =>
    route.fulfill({ body: 'Issue fixture' }),
  );
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, `share.html?session=${started.session.id}`));
  await expect(page.getByLabel('Issue repository')).toHaveValue('alice/product');
  await page.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
  await expect(page.getByText('Upload incomplete', { exact: true })).toHaveCount(2);
  await expect(
    page.getByText('Proofline report storage is unavailable.', { exact: false }),
  ).toBeVisible();
  expect(paths.filter((path) => path.endsWith('/issue'))).toHaveLength(0);
  await page.screenshot({
    path: 'test-results/recorder-upload-incomplete-light.png',
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: 'test-results/recorder-upload-incomplete-dark.png',
    fullPage: true,
  });
  // Reopening must resume the durable checkpoint through File issue itself.
  await page.reload();
  await expect(page.getByText('Upload incomplete', { exact: true })).toHaveCount(2);
  const expired = connected();
  expired.connection.expiresAt = 0;
  await background.evaluate((settings) => chrome.storage.local.set({ prooflineSettings: settings }), expired);
  await page.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
  await expect(page.getByText('Your Proofline connection has expired.', { exact: false })).toBeVisible();
  await background.evaluate((settings) => chrome.storage.local.set({ prooflineSettings: settings }), connected());
  await page.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View issue #42' })).toBeVisible({
    timeout: 30000,
  });
  expect(paths.filter((path) => path.endsWith('/issue'))).toHaveLength(1);
  expect(paths.some((path) => path.endsWith('/attachments'))).toBe(true);
  await expect(page.getByLabel('Issue title')).toHaveValue(
    'Clarify the recipes empty state',
  );
  const panel = await context.newPage();
  await panel.goto(extUrl(extensionId, 'sidepanel.html'));
  await panel.setViewportSize({ width: 380, height: 740 });
  await panel.emulateMedia({ colorScheme: 'dark' });
  await expect(panel.getByRole('button', { name: 'Start recording' })).toBeVisible();
  await expect(panel.locator('.app')).toHaveCount(1);
  await expect(panel.getByRole('link', { name: 'Website', exact: true })).toBeVisible();
  await panel.screenshot({
    path: 'test-results/recorder-proofline-panel-dark.png',
    animations: 'disabled',
  });
});

test('changes the paying workspace only after matching browser approval', async ({
  context,
  background,
  extensionId,
}) => {
  const teamId = '10000000-0000-4000-8000-000000000002';
  const team = {
    id: teamId,
    login: 'team',
    name: 'Team workspace',
    is_personal: false,
  };
  const initial = connected();
  initial.connection.account = {
    ...account,
    organizations: [...account.organizations, team],
  };
  await background.evaluate(
    (settings) => chrome.storage.local.set({ prooflineSettings: settings }),
    initial,
  );
  let approvals = 0;
  await context.route('https://proofline.sh/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/auth/device' && request.isNavigationRequest()) {
      // The extension opens the browser approval page for the current code.
      expect(request.method()).toBe('GET');
      expect(new URL(request.url()).searchParams.get('user_code')).toBe(`APPROVAL-${approvals}`);
      await route.fulfill({ contentType: 'text/html', body: approvalPage });
      return;
    }
    if (!fromExtension(request)) {
      await fulfillWebsiteRequest(route, ['test-proofline-token', 'approved-token-', 'device-']);
      return;
    }
    if (path === '/auth/device/code') {
      expect(request.postDataJSON().organization_id).toBe(teamId);
      approvals++;
      await route.fulfill({
        json: {
          device_code: `device-${approvals}`,
          user_code: `APPROVAL-${approvals}`,
          verification_uri_complete: `https://proofline.sh/auth/device?user_code=APPROVAL-${approvals}`,
          expires_in: 600,
          interval: 5,
        },
      });
    } else if (path === '/auth/device/token') {
      await route.fulfill({
        json: {
          access_token: `approved-token-${approvals}`,
          // The browser can approve a different workspace from the URL hint.
          organization_id: (approvals === 2 || approvals === 4) ? org : teamId,
          expires_in: 3600,
          scope: 'recorder:read recorder:ai recorder:reports recorder:issues',
        },
      });
    } else if (path.endsWith('/account')) {
      const approvedOrg = (approvals === 2 || approvals === 4) ? org : teamId;
      expect(path).toBe(`/api/v1/organizations/${approvedOrg}/recorder/account`);
      expect(request.headers().authorization).toBe(`Bearer approved-token-${approvals}`);
      await route.fulfill({
        json: {
          ...initial.connection.account,
          organization: approvedOrg === org ? account.organization : team,
          repositories: approvedOrg === org ? account.repositories : [],
        },
      });
    } else if (path.startsWith('/auth/') || path.startsWith('/api/')) {
      throw new Error(`Unexpected Proofline request ${request.method()} ${path}`);
    } else {
      await route.fulfill({ contentType: 'text/html', body: '<p>Approval fixture</p>' });
    }
  });
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, 'options.html#proofline'));
  const workspace = page.getByLabel('Workspace paying for usage');
  const storedConnection = () =>
    background.evaluate(async () =>
      (await chrome.storage.local.get('prooflineSettings')).prooflineSettings.connection,
    );

  await workspace.selectOption(teamId);
  await expect(page.getByText('APPROVAL-1', { exact: true })).toBeVisible();
  await expect(workspace).toBeDisabled();
  expect((await storedConnection()).organizationId).toBe(org);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(workspace).toBeEnabled();
  await expect(workspace).toHaveValue(org);
  expect((await storedConnection()).accessToken).toBe('test-proofline-token');

  await workspace.selectOption(teamId);
  await expect(page.getByRole('alert')).toContainText('A different workspace was approved', {
    timeout: 20000,
  });
  await expect(workspace).toHaveValue(org);
  expect((await storedConnection()).accessToken).toBe('test-proofline-token');

  await workspace.selectOption(teamId);
  await expect(workspace).toHaveValue(teamId, { timeout: 20000 });
  await expect(workspace).toBeEnabled();
  const approved = await storedConnection();
  expect(approved.organizationId).toBe(teamId);
  expect(approved.accessToken).toBe('approved-token-3');
  expect(approved.account.repositories).toEqual([]);
  await page.reload();
  await expect(page.getByLabel('Workspace paying for usage')).toHaveValue(teamId);

  // Expiration renews this workspace instead of approving the default personal one.
  const expiredTeam = await background.evaluate(async () =>
    (await chrome.storage.local.get('prooflineSettings')).prooflineSettings,
  );
  expiredTeam.connection.expiresAt = 0;
  await background.evaluate((settings) => chrome.storage.local.set({ prooflineSettings: settings }), expiredTeam);
  await page.reload();
  const renewal = page.waitForRequest(request => new URL(request.url()).pathname === '/auth/device/code');
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  expect((await renewal).postDataJSON().organization_id).toBe(teamId);
  await expect(page.getByRole('alert')).toContainText('A different workspace was approved', { timeout: 20000 });
  expect((await storedConnection()).organizationId).toBe(teamId);
  expect((await storedConnection()).accessToken).toBe('approved-token-3');
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Change account', exact: true })).toBeVisible({ timeout: 20000 });
  expect((await storedConnection()).organizationId).toBe(teamId);
  expect((await storedConnection()).accessToken).toBe('approved-token-5');
});

for (const failure of [
  { name: 'exhausted credits', status: 402, message: 'no credits available' },
  { name: 'revoked access', status: 401, message: 'Reconnect to Proofline' },
  { name: 'expired connection', status: 0, message: 'connection has expired' },
  {
    name: 'workspace retention policy',
    status: 409,
    message: 'This organization requires zero-retention model routing.',
  },
] as const) {
  test(`filing stops on ${failure.name} without spending personal keys or publishing`, async ({
    context,
    background,
    extensionId,
  }) => {
    const demo = await context.newPage();
    await demo.goto('/');
    const recording = await dispatch<{ session: { id: string } }>(background, {
      kind: 'session/start',
      tabId: await tabIdForUrl(background, 'http://localhost:5319'),
    });
    await dispatch(background, { kind: 'session/stop' });
    const settings = connected();
    if (failure.status === 0) settings.connection.expiresAt = 0;
    await background.evaluate(
      (prooflineSettings) => chrome.storage.local.set({
        prooflineSettings,
        sharingSettings: {
          provider: 'openai',
          models: { openai: { apiKey: 'personal-key-must-not-be-used' } },
          repositories: [{ id: 'personal', repository: 'alice/product', token: 'personal-pat' }],
        },
      }),
      settings,
    );
    const requests: string[] = [];
    await context.route('https://**/*', async (route) => {
      const request = route.request();
      requests.push(request.url());
      expect(request.url()).toBe(`https://proofline.sh/api/v1/organizations/${org}/recorder/ai`);
      expect(request.headers().authorization).toBe('Bearer test-proofline-token');
      expect(request.postData()).not.toContain('personal-key-must-not-be-used');
      await route.fulfill({
        status: failure.status || 500,
        json: {
          status: failure.status,
          title: failure.message,
          detail: failure.message,
        },
      });
    });
    const page = await context.newPage();
    await page.goto(extUrl(extensionId, `share.html?session=${recording.session.id}`));
    await page.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(failure.message);
    await expect(page.getByRole('button', { name: 'File GitHub issue', exact: true })).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'Filing your issue' })).toHaveCount(0);
    expect(requests).toHaveLength(failure.status === 0 ? 0 : 1);
    const stored = await background.evaluate(() =>
      chrome.storage.local.get(['prooflineSettings', 'sharingSettings']),
    );
    expect(stored.prooflineSettings.aiMode).toBe('proofline');
    expect(stored.prooflineSettings.publishing).toBe('proofline');
    expect(stored.sharingSettings.models.openai.apiKey).toBe('personal-key-must-not-be-used');
  });
}
