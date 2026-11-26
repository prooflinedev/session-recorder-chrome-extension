import {
  test,
  expect,
  extUrl,
  dispatch,
  tabIdForUrl,
  fromExtension,
  fulfillWebsiteRequest,
} from './support';

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
      // Like GitHub's own page, the issue fixture calls the GitHub API without the token.
      body: '<h1>GitHub issue composer test</h1><script>fetch("https://api.github.com/user")</script>',
    }),
  );
  let releaseVerification!: () => void;
  const verificationGate = new Promise<void>((resolve) => {
    releaseVerification = resolve;
  });
  let rejectFirstVerification = true;
  let issues = 0;
  let summaries = 0;
  page.on('request', (request) => {
    if (request.url().includes('/chat/completions')) summaries++;
  });
  await context.route('https://api.github.com/**', async (route) => {
    if (!fromExtension(route.request())) {
      // The opened issue page is GitHub's own; it must never see the stored token.
      await fulfillWebsiteRequest(route, ['github-private-key']);
      return;
    }
    expect(route.request().headers().authorization).toBe('Bearer github-private-key');
    if (route.request().method() === 'POST') {
      issues++;
      const payload = route.request().postDataJSON();
      expect(payload.title).toBe('Checkout shows an error');
      expect(payload.body).toContain(reportUrl);
      expect(payload.body).toContain('session-recorder:');
      await route.fulfill({
        status: 201,
        json: { number: 42, html_url: 'https://github.com/owner/repository/issues/42' },
      });
    } else if (rejectFirstVerification) {
      rejectFirstVerification = false;
      await verificationGate;
      await route.fulfill({
        status: 403,
        json: { message: 'Resource not accessible by personal access token' },
      });
    } else await route.fulfill({ json: { has_issues: true } });
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
  await page.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View issue #42' })).toBeVisible();
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
});

test('publish preserves concurrent issue and draft updates', async ({
  context,
  background,
  extensionId,
}) => {
  // Record a minimal session for the share page.
  const page = await context.newPage();
  await page.goto('/');
  const started = await dispatch<{ ok: boolean; session: { id: string } }>(background, {
    kind: 'session/start',
    tabId: await tabIdForUrl(background, 'http://localhost:5319'),
  });
  expect(started.ok).toBe(true);
  await dispatch(background, { kind: 'session/stop' });
  const sessionId = started.session.id;
  const draftKey = `shareDraft:${sessionId}`;
  const accountId = 'a'.repeat(32);
  const appId = '12345678-1234-1234-1234-123456789abc';
  const reportUrl = 'https://abc.reports.pages.dev';

  await background.evaluate(
    async ({ accountId, appId }: { accountId: string; appId: string }) => {
      await chrome.storage.local.set({
        sharingSettings: {
          cloudflare: {
            apiToken: 'cf-token',
            accountId,
            projectName: 'reports',
            accessAppId: appId,
            teamDomain: 'team.cloudflareaccess.com',
          },
          repository: 'owner/repo',
          githubToken: 'gh-token',
        },
      });
    },
    { accountId, appId },
  );

  // Gate the Cloudflare deployment-creation step so we can inject issue data into
  // storage while Tab A's publish operation is in-flight, simulating a concurrent
  // Tab B that has just completed a full issue-filing workflow.
  let releaseDeployment!: () => void;
  const deploymentGate = new Promise<void>((resolve) => {
    releaseDeployment = resolve;
  });
  // Resolves the moment the deployment POST actually arrives at the mock, giving
  // a deterministic signal that the request is in flight and storage injection
  // is safe — independent of any UI status text timing.
  let deploymentArrived = false;
  let deployments = 0;

  await context.route('https://api.cloudflare.com/client/v4/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    let result: unknown;
    if (url.endsWith('/pages/projects/reports') && method !== 'POST')
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
    else if (url.endsWith('/pages/assets/upload')) result = null;
    else if (url.endsWith('/pages/assets/upsert-hashes')) result = null;
    else if (url.endsWith('/deployments') && method === 'POST') {
      // Signal that the POST has arrived before waiting, so the test can inject
      // concurrent storage state without racing against UI text propagation.
      deploymentArrived = true;
      await deploymentGate;
      deployments++;
      result = {
        id: 'deployment-1',
        url: reportUrl,
        environment: 'preview',
        latest_stage: { name: 'deploy', status: 'success' },
      };
    } else {
      await route.abort();
      return;
    }
    await route.fulfill({ json: { success: true, result } });
  });
  await context.route(
    'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
    (route) => route.fulfill({ json: { keys: [] } }),
  );

  // Open the share page (Tab A).
  const shareTab = await context.newPage();
  await shareTab.goto(extUrl(extensionId, `share.html?session=${sessionId}`));

  // Open the advanced section and wait for report-file preparation to finish.
  await shareTab.locator('details.advanced-report > summary').click();
  const publishButton = shareTab.getByRole('button', { name: 'Publish report only' });
  await expect(publishButton).toBeEnabled({ timeout: 30_000 });

  // Kick off Tab A's standalone publish.
  try {
    await publishButton.click();

    await expect.poll(() => deploymentArrived, {
      timeout: 10_000,
    }).toBe(true);

    // === Race-condition window ===
    // Simulate Tab B having concurrently completed a full issue-filing workflow.
    const filedIssue = {
      number: 7,
      url: 'https://github.com/owner/repo/issues/7',
      repository: 'owner/repo',
    };
    await background.evaluate(
      async ({ key, issue }: { key: string; issue: { number: number; url: string; repository: string } }) => {
        const stored = await chrome.storage.local.get(key);
        const existing = (stored[key] as Record<string, unknown>) ?? {};
        await chrome.storage.local.set({
          [key]: {
            ...existing,
            issue,
            draft: {
              title: 'Updated in another tab',
              body: 'Concurrent user edits must survive',
            },
            draftSource: 'edited',
          },
        });
      },
      { key: draftKey, issue: filedIssue },
    );

    // Let Tab A's deployment-creation request complete.
    releaseDeployment();

    // Wait for Tab A's publish to report success.
    await expect(shareTab.getByRole('status')).toContainText('Report published', {
      timeout: 30_000,
    });

    // Verify that publication persistence preserves concurrent updates.
    // The publication update must not replace newer persisted issue or draft data.
    const afterPublish = await background.evaluate(
      async (key: string) => chrome.storage.local.get(key),
      draftKey,
    );
    const savedDraft = afterPublish[draftKey] as {
      issue?: { number: number; url: string; repository: string };
      publication?: { deployment?: { id: string; url: string } };
      draft: { title: string; body: string };
      draftSource: string;
    };
    expect(
      savedDraft.issue,
      'issue written by another tab must survive a concurrent publish completing',
    ).toEqual(filedIssue);
    expect(
      savedDraft.publication?.deployment,
      'publication must carry the exact deployment ID and URL returned by the mock',
    ).toMatchObject({ id: 'deployment-1', url: reportUrl });
    expect(savedDraft.draft).toEqual({
      title: 'Updated in another tab',
      body: 'Concurrent user edits must survive',
    });
    expect(savedDraft.draftSource).toBe('edited');
    expect(deployments, 'exactly one deployment must have been created').toBe(1);
  } finally {
    // Always unblock the route handler so the test does not hang on assertion failures.
    releaseDeployment();
  }
});


test('publish cancellation while the session lock is held', async ({
  context,
  background,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto('/');

  const started = await dispatch<{
    ok: boolean;
    session: { id: string };
  }>(background, {
    kind: 'session/start',
    tabId: await tabIdForUrl(background, 'http://localhost:5319'),
  });
  expect(started.ok).toBe(true);
  await dispatch(background, { kind: 'session/stop' });

  const draftKey = `shareDraft:${started.session.id}:operation`;
  const accountId = 'a'.repeat(32);
  const appId = '12345678-1234-1234-1234-123456789abc';

  await background.evaluate(async ({ accountId, appId }) => {
    await chrome.storage.local.set({
      sharingSettings: {
        cloudflare: {
          apiToken: 'cf-token',
          accountId,
          projectName: 'reports',
          accessAppId: appId,
          teamDomain: 'team.cloudflareaccess.com',
        },
        repository: 'owner/repo',
        githubToken: 'gh-token',
      },
    });
  }, { accountId, appId });

  const shareTab = await context.newPage();
  await shareTab.goto(
    extUrl(extensionId, `share.html?session=${started.session.id}`),
  );

  await shareTab.locator('details.advanced-report > summary').click();
  const publish = shareTab.getByRole('button', {
    name: 'Publish report only',
  });
  await expect(publish).toBeEnabled({ timeout: 30_000 });

  // Hold the operation lock from another extension page.
  // This represents a competing publication or issue-filing operation.
  const secondTab = await context.newPage();
  await secondTab.goto(
    extUrl(extensionId, `share.html?session=${started.session.id}`),
  );

  let externalRequests = 0;
  await context.route('https://api.cloudflare.com/client/v4/**', async route => {
    externalRequests++;
    await route.abort();
  });

  // Keep this evaluation running until the test releases the lock.
  const holdingLock = secondTab.evaluate(async ({ draftKey }) => {
    await navigator.locks.request(draftKey, async () => {
      (window as typeof window & {
        __prooflineLockAcquired?: boolean;
      }).__prooflineLockAcquired = true;

      await new Promise<void>(resolve => {
        (window as typeof window & {
          __releaseProoflineLock?: () => void;
        }).__releaseProoflineLock = resolve;
      });
    });
  }, { draftKey });

  try {
    await expect.poll(async () =>
      secondTab.evaluate(() =>
        (window as typeof window & {
          __prooflineLockAcquired?: boolean;
        }).__prooflineLockAcquired === true,
      ),
    ).toBe(true);

    await publish.click();

    await expect.poll(async () =>
      shareTab.evaluate(async key => {
        const locks = await navigator.locks.query();
        return locks.pending?.some(lock => lock.name === key) ?? false;
      }, draftKey),
    ).toBe(true);

    await expect(
      shareTab.getByRole('button', { name: 'Cancel', exact: true }),
    ).toBeVisible();

    await shareTab.getByRole('button', {
      name: 'Cancel',
      exact: true,
    }).click();

    // Cancellation must finish before the competing tab releases its lock.
    await expect(
      shareTab.getByRole('button', { name: 'Cancel', exact: true }),
    ).toHaveCount(0, { timeout: 5000 });

    expect(
      externalRequests,
      'cancelled publication must not contact Cloudflare',
    ).toBe(0);
  } finally {
    await secondTab.evaluate(() => {
      (window as typeof window & {
        __releaseProoflineLock?: () => void;
      }).__releaseProoflineLock?.();
    }).catch(() => {});
    await secondTab.close();
    await holdingLock.catch(() => {});
  }
});

test('draft edits persist from another tab during publication', async ({
  context,
  background,
  extensionId,
}) => {
  // Record a minimal session for the share page.
  const page = await context.newPage();
  await page.goto('/');
  const started = await dispatch<{ ok: boolean; session: { id: string } }>(background, {
    kind: 'session/start',
    tabId: await tabIdForUrl(background, 'http://localhost:5319'),
  });
  expect(started.ok).toBe(true);
  await dispatch(background, { kind: 'session/stop' });
  const sessionId = started.session.id;
  const draftKey = `shareDraft:${sessionId}`;
  const accountId = 'a'.repeat(32);
  const appId = '12345678-1234-1234-1234-123456789abc';
  const reportUrl = 'https://abc.reports.pages.dev';

  await background.evaluate(
    async ({ accountId, appId }: { accountId: string; appId: string }) => {
      await chrome.storage.local.set({
        sharingSettings: {
          cloudflare: {
            apiToken: 'cf-token',
            accountId,
            projectName: 'reports',
            accessAppId: appId,
            teamDomain: 'team.cloudflareaccess.com',
          },
          repository: 'owner/repo',
          githubToken: 'gh-token',
        },
      });
    },
    { accountId, appId },
  );

  // Block deployment creation while a second tab edits the draft.
  let releaseDeployment!: () => void;
  const deploymentGate = new Promise<void>((resolve) => {
    releaseDeployment = resolve;
  });
  // Synchronize the second tab with the deployment POST.
  let deploymentArrived = false;
  let deployments = 0;

  await context.route('https://api.cloudflare.com/client/v4/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    let result: unknown;
    if (url.endsWith('/pages/projects/reports') && method !== 'POST')
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
    else if (url.endsWith('/pages/assets/upload')) result = null;
    else if (url.endsWith('/pages/assets/upsert-hashes')) result = null;
    else if (url.endsWith('/deployments') && method === 'POST') {
      // Signal that publication is in flight before editing in the second tab.
      deploymentArrived = true;
      await deploymentGate;
      deployments++;
      result = {
        id: 'deployment-1',
        url: reportUrl,
        environment: 'preview',
        latest_stage: { name: 'deploy', status: 'success' },
      };
    } else {
      await route.abort();
      return;
    }
    await route.fulfill({ json: { success: true, result } });
  });
  await context.route(
    'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
    (route) => route.fulfill({ json: { keys: [] } }),
  );

  // Open the share page (Tab A).
  const shareTab = await context.newPage();
  await shareTab.goto(extUrl(extensionId, `share.html?session=${sessionId}`));

  // Open the advanced section and wait for report-file preparation to finish.
  await shareTab.locator('details.advanced-report > summary').click();
  const publishButton = shareTab.getByRole('button', { name: 'Publish report only' });
  await expect(publishButton).toBeEnabled({ timeout: 30_000 });

  // Kick off Tab A's standalone publish.
  try {
    await publishButton.click();

    await expect.poll(() => deploymentArrived, {
      timeout: 10_000,
    }).toBe(true);

    const secondTab = await context.newPage();

    try {
      await secondTab.goto(
        extUrl(extensionId, `share.html?session=${sessionId}`),
      );

      await secondTab.getByRole('button', {
        name: 'Edit draft',
        exact: true,
      }).click();

      const editor = secondTab.getByRole('textbox', {
        name: 'Issue summary · Markdown',
        exact: true,
      });

      await expect(editor).toBeEditable({ timeout: 30_000 });
      await editor.fill('Concurrent user edits must survive');

      await expect(editor)
        .toHaveValue('Concurrent user edits must survive');

      // Storage must reflect the edit BEFORE publication completes.
      await expect.poll(async () => {
        return background.evaluate(async key => {
          const stored = await chrome.storage.local.get(key);
          return stored[key]?.draft?.body;
        }, draftKey);
      }, { timeout: 5000 }).toBe('Concurrent user edits must survive');
    } finally {
      await secondTab.close();
    }

    // Let Tab A's deployment-creation request complete.
    releaseDeployment();

    // Wait for Tab A's publish to report success.
    await expect(shareTab.getByRole('status')).toContainText('Report published', {
      timeout: 30_000,
    });

    // Verify that publication persistence preserves concurrent updates.
    // The publication update must not replace newer persisted issue or draft data.
    const afterPublish = await background.evaluate(
      async (key: string) => chrome.storage.local.get(key),
      draftKey,
    );
    const savedDraft = afterPublish[draftKey] as {
      issue?: { number: number; url: string; repository: string };
      publication?: { deployment?: { id: string; url: string } };
      draft: { title: string; body: string };
      draftSource: string;
    };
    expect(
      savedDraft.publication?.deployment,
      'publication must carry the exact deployment ID and URL returned by the mock',
    ).toMatchObject({ id: 'deployment-1', url: reportUrl });
    expect(savedDraft.draft.body)
      .toBe('Concurrent user edits must survive');
    expect(savedDraft.draftSource).toBe('edited');
    expect(deployments, 'exactly one deployment must have been created').toBe(1);
  } finally {
    // Always unblock the route handler so the test does not hang on assertion failures.
    releaseDeployment();
  }
});

test('draft edits persist while Cloudflare deployment is polling', async ({
  context,
  background,
  extensionId,
}) => {
  // Record a minimal session for the share page.
  const page = await context.newPage();
  await page.goto('/');
  const started = await dispatch<{ ok: boolean; session: { id: string } }>(background, {
    kind: 'session/start',
    tabId: await tabIdForUrl(background, 'http://localhost:5319'),
  });
  expect(started.ok).toBe(true);
  await dispatch(background, { kind: 'session/stop' });
  const sessionId = started.session.id;
  const draftKey = `shareDraft:${sessionId}`;
  const accountId = 'a'.repeat(32);
  const appId = '12345678-1234-1234-1234-123456789abc';
  const reportUrl = 'https://abc.reports.pages.dev';

  await background.evaluate(
    async ({ accountId, appId }: { accountId: string; appId: string }) => {
      await chrome.storage.local.set({
        sharingSettings: {
          cloudflare: {
            apiToken: 'cf-token',
            accountId,
            projectName: 'reports',
            accessAppId: appId,
            teamDomain: 'team.cloudflareaccess.com',
          },
          repository: 'owner/repo',
          githubToken: 'gh-token',
        },
      });
    },
    { accountId, appId },
  );

  // Block deployment polling after the recovery checkpoint is saved.
  let releaseDeployment!: () => void;
  const deploymentGate = new Promise<void>((resolve) => {
    releaseDeployment = resolve;
  });
  // Synchronize the second tab with the deployment status request.
  let deploymentArrived = false;
  let deployments = 0;

  await context.route('https://api.cloudflare.com/client/v4/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    let result: unknown;
    if (url.endsWith('/pages/projects/reports') && method !== 'POST')
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
    else if (url.endsWith('/pages/assets/upload')) result = null;
    else if (url.endsWith('/pages/assets/upsert-hashes')) result = null;
    else if (url.endsWith('/deployments') && method === 'POST') {
      deployments++;
      result = {
        id: 'deployment-1',
        url: reportUrl,
        environment: 'preview',
        latest_stage: { name: 'deploy', status: 'active' },
      };
    } else if (
      url.endsWith('/deployments/deployment-1') &&
      method === 'GET'
    ) {
      deploymentArrived = true;
      await deploymentGate;
      result = {
        id: 'deployment-1',
        url: reportUrl,
        environment: 'preview',
        latest_stage: { name: 'deploy', status: 'success' },
      };
    } else {
      await route.abort();
      return;
    }
    await route.fulfill({ json: { success: true, result } });
  });
  await context.route(
    'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
    (route) => route.fulfill({ json: { keys: [] } }),
  );

  // Open the share page (Tab A).
  const shareTab = await context.newPage();
  await shareTab.goto(extUrl(extensionId, `share.html?session=${sessionId}`));

  // Open the advanced section and wait for report-file preparation to finish.
  await shareTab.locator('details.advanced-report > summary').click();
  const publishButton = shareTab.getByRole('button', { name: 'Publish report only' });
  await expect(publishButton).toBeEnabled({ timeout: 30_000 });

  // Kick off Tab A's standalone publish.
  try {
    await publishButton.click();

    await expect.poll(() => deploymentArrived, {
      timeout: 10_000,
    }).toBe(true);

    const checkpoint = await background.evaluate(
      async key => (await chrome.storage.local.get(key))[key],
      draftKey,
    );

    expect(checkpoint.publication.deployment).toMatchObject({
      id: 'deployment-1',
      url: reportUrl,
      latest_stage: { name: 'deploy', status: 'active' },
    });

    const secondTab = await context.newPage();

    try {
      await secondTab.goto(
        extUrl(extensionId, `share.html?session=${sessionId}`),
      );

      await secondTab.getByRole('button', {
        name: 'Edit draft',
        exact: true,
      }).click();

      const editor = secondTab.getByRole('textbox', {
        name: 'Issue summary · Markdown',
        exact: true,
      });

      await expect(editor).toBeEditable({ timeout: 30_000 });
      await editor.fill('Concurrent user edits must survive');

      await expect(editor)
        .toHaveValue('Concurrent user edits must survive');

      // Storage must reflect the edit BEFORE publication completes.
      await expect.poll(async () => {
        return background.evaluate(async key => {
          const stored = await chrome.storage.local.get(key);
          return stored[key]?.draft?.body;
        }, draftKey);
      }, { timeout: 5000 }).toBe('Concurrent user edits must survive');
    } finally {
      await secondTab.close();
    }

    // Let Tab A's deployment status request complete.
    releaseDeployment();

    // Wait for Tab A's publish to report success.
    await expect(shareTab.getByRole('status')).toContainText('Report published', {
      timeout: 30_000,
    });

    // Verify that publication persistence preserves concurrent updates.
    // The publication update must not replace newer persisted issue or draft data.
    const afterPublish = await background.evaluate(
      async (key: string) => chrome.storage.local.get(key),
      draftKey,
    );
    const savedDraft = afterPublish[draftKey] as {
      issue?: { number: number; url: string; repository: string };
      publication?: { deployment?: { id: string; url: string } };
      draft: { title: string; body: string };
      draftSource: string;
    };
    expect(
      savedDraft.publication?.deployment,
      'publication must carry the exact deployment ID and URL returned by the mock',
    ).toMatchObject({ id: 'deployment-1', url: reportUrl });
    expect(savedDraft.draft.body)
      .toBe('Concurrent user edits must survive');
    expect(savedDraft.draftSource).toBe('edited');
    expect(deployments, 'exactly one deployment must have been created').toBe(1);
  } finally {
    // Always unblock the route handler so the test does not hang on assertion failures.
    releaseDeployment();
  }
});

test('recovers a deployment when the publishing tab closes before checkpoint promotion', async ({
  context,
  background,
  extensionId,
}) => {
  // Record a minimal session for the share page.
  const page = await context.newPage();
  await page.goto('/');
  const started = await dispatch<{ ok: boolean; session: { id: string } }>(background, {
    kind: 'session/start',
    tabId: await tabIdForUrl(background, 'http://localhost:5319'),
  });
  expect(started.ok).toBe(true);
  await dispatch(background, { kind: 'session/stop' });
  const sessionId = started.session.id;
  const draftKey = `shareDraft:${sessionId}`;
  const accountId = 'a'.repeat(32);
  const appId = '12345678-1234-1234-1234-123456789abc';
  const reportUrl = 'https://abc.reports.pages.dev';

  await background.evaluate(
    async ({ accountId, appId }: { accountId: string; appId: string }) => {
      await chrome.storage.local.set({
        sharingSettings: {
          cloudflare: {
            apiToken: 'cf-token',
            accountId,
            projectName: 'reports',
            accessAppId: appId,
            teamDomain: 'team.cloudflareaccess.com',
          },
          repository: 'owner/repo',
          githubToken: 'gh-token',
        },
      });
    },
    { accountId, appId },
  );

  // Block deployment creation while a second tab edits the draft.
  let releaseDeployment!: () => void;
  const deploymentGate = new Promise<void>((resolve) => {
    releaseDeployment = resolve;
  });
  // Synchronize the second tab with the deployment POST.
  let deploymentArrived = false;
  let deployments = 0;

  await context.route('https://api.cloudflare.com/client/v4/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    let result: unknown;
    if (url.endsWith('/pages/projects/reports') && method !== 'POST')
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
    else if (url.endsWith('/pages/assets/upload')) result = null;
    else if (url.endsWith('/pages/assets/upsert-hashes')) result = null;
    else if (url.endsWith('/deployments') && method === 'POST') {
      // Signal that publication is in flight before editing in the second tab.
      deploymentArrived = true;
      await deploymentGate;
      deployments++;
      result = {
        id: 'deployment-1',
        url: reportUrl,
        environment: 'preview',
        latest_stage: { name: 'deploy', status: 'success' },
      };
    } else {
      await route.abort();
      return;
    }
    await route.fulfill({ json: { success: true, result } });
  });
  await context.route(
    'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
    (route) => route.fulfill({ json: { keys: [] } }),
  );

  // Open the share page (Tab A).
  const shareTab = await context.newPage();
  await shareTab.goto(extUrl(extensionId, `share.html?session=${sessionId}`));

  // Open the advanced section and wait for report-file preparation to finish.
  await shareTab.locator('details.advanced-report > summary').click();
  const publishButton = shareTab.getByRole('button', { name: 'Publish report only' });
  await expect(publishButton).toBeEnabled({ timeout: 30_000 });

  const recoveryKey = `${draftKey}:publicationRecovery`;
  const lockTab = await context.newPage();

  try {
    await publishButton.click();

    await expect.poll(() => deploymentArrived, {
      timeout: 10_000,
    }).toBe(true);

    await lockTab.goto(
      extUrl(extensionId, `share.html?session=${sessionId}`),
    );

    // Hold the draft lock after the deployment request has started.
    await lockTab.evaluate(async key => {
      await new Promise<void>(resolve => {
        void navigator.locks.request(key, async () => {
          resolve();
          await new Promise<void>(() => {});
        });
      });
    }, draftKey);

    releaseDeployment();

    // The recovery record must be durable even while the draft
    // checkpoint is blocked by another tab.
    await expect.poll(async () => {
      return background.evaluate(async key => {
        const records = await chrome.storage.local.get(key);
        return records[key]?.deployment?.id;
      }, recoveryKey);
    }, { timeout: 5000 }).toBe('deployment-1');

    const interrupted = await background.evaluate(
      async keys => chrome.storage.local.get(keys),
      [draftKey, recoveryKey],
    );

    expect(interrupted[draftKey].publication).toBeUndefined();
    expect(interrupted[recoveryKey].deployment).toMatchObject({
      id: 'deployment-1',
      url: reportUrl,
    });

    // Destroy the publishing document before releasing the lock.
    await shareTab.close();
    await lockTab.close();

    const reopened = await context.newPage();

    try {
      await reopened.goto(
        extUrl(extensionId, `share.html?session=${sessionId}`),
      );

      await reopened.locator('details.advanced-report > summary').click();

      await expect(reopened.getByRole('button', {
        name: 'Publish report only',
        exact: true,
      })).toHaveCount(0);

      const recoveredLink = reopened
        .getByRole('complementary', { name: 'Report details' })
        .getByRole('link', {
          name: /Open published report|Deployment created/,
        });

      await expect(recoveredLink).toBeVisible();
      await expect(recoveredLink).toHaveAttribute('href', reportUrl);

      expect(deployments).toBe(1);

      const recovered = await background.evaluate(
        async keys => chrome.storage.local.get(keys),
        [draftKey, recoveryKey],
      );

      const publication =
        recovered[recoveryKey] ?? recovered[draftKey]?.publication;

      expect(publication?.deployment).toMatchObject({
        id: 'deployment-1',
        url: reportUrl,
      });
    } finally {
      await reopened.close();
    }
  } finally {
    releaseDeployment();
    await shareTab.close();
    await lockTab.close();
  }
});
