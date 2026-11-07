import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

const KEY = 'lin_api_e2eSecretKey';
const TEAM = 'team-eng-1';
const ISSUE_URL = 'https://linear.app/acme/issue/ENG-12/checkout-fails';

test('files a Linear issue and recovers a lost create response without a duplicate', async ({ context, background, extensionId }) => {
  const bodies: string[] = [];
  let creates = 0;
  let lookups = 0;
  let createdId = '';
  await context.route('https://api.linear.app/graphql', async (route) => {
    const request = route.request();
    expect(request.headers().authorization).toBe(KEY);
    const body = request.postData() ?? '';
    bodies.push(body);
    const { query, variables } = JSON.parse(body);
    if (query.includes('teams(')) {
      await route.fulfill({ json: { data: { teams: { nodes: [{ id: TEAM, key: 'ENG', name: 'Engineering' }] } } } });
    } else if (query.includes('issueCreate')) {
      creates++;
      createdId = variables.input.id;
      expect(variables.input.teamId).toBe(TEAM);
      expect(variables.input.description).toContain('https://existing.reports.pages.dev');
      // Linear accepted the request, but the response never arrives.
      await route.abort('connectionreset');
    } else {
      lookups++;
      expect(variables.id).toBe(createdId);
      await route.fulfill({ json: { data: { issues: { nodes: [
        { id: createdId, identifier: 'ENG-12', number: 12, url: ISSUE_URL, team: { id: TEAM } },
      ] } } } });
    }
  });
  await context.route(ISSUE_URL, (route) => route.fulfill({ body: '<h1>Linear issue</h1>', contentType: 'text/html' }));

  const options = await context.newPage();
  await options.goto(extUrl(extensionId, 'options.html#linear'));
  await options.getByLabel('Linear API key', { exact: true }).fill(KEY);
  await expect(options.getByRole('link', { name: 'Create a Linear personal API key' })).toHaveAttribute('href', /^https:\/\/linear\.app\/settings\//);
  await options.getByRole('button', { name: 'Load teams' }).click();
  await options.getByRole('combobox', { name: 'Linear team', exact: true }).selectOption(TEAM);
  await options.getByRole('button', { name: 'Save Linear settings' }).click();
  await expect(options.getByRole('status')).toHaveText('Linear team ENG verified and saved.');

  const demo = await context.newPage();
  await demo.goto('/');
  const recording = await dispatch<{ session: { id: string } }>(background, {
    kind: 'session/start', tabId: await tabIdForUrl(background, 'http://localhost:5319'),
  });
  await dispatch(background, { kind: 'session/stop' });
  await background.evaluate(async (id) => {
    await chrome.storage.local.set({
      [`shareDraft:${id}`]: {
        repository: '', draft: { title: 'Checkout fails', body: 'Saved summary' }, draftSource: 'edited',
        publication: { level: 'L1', destination: {}, deployment: {
          id: 'existing', url: 'https://existing.reports.pages.dev', environment: 'preview',
          latest_stage: { name: 'deploy', status: 'success' },
        } },
      },
    });
  }, recording.session.id);

  const report = await context.newPage();
  await report.goto(extUrl(extensionId, `share.html?session=${recording.session.id}`));
  const destination = report.getByLabel('Issue repository', { exact: true });
  await expect(destination).toHaveValue(`linear:${TEAM}`);
  await expect(destination.locator('option:checked')).toHaveText('Linear · ENG');
  await report.getByRole('button', { name: 'File Linear issue', exact: true }).click();
  await expect(report.getByRole('alert')).toBeVisible();
  expect(creates).toBe(1);

  await report.getByRole('button', { name: 'Check Linear issue', exact: true }).click();
  await expect(report.getByRole('link', { name: 'View issue ENG-12' })).toBeVisible();
  expect(creates).toBe(1);
  expect(lookups).toBe(1);
  expect(bodies.some((body) => body.includes('https://existing.reports.pages.dev'))).toBe(true);
  for (const body of bodies) expect(body).not.toContain(KEY);
  const drafts = await background.evaluate(async (id) => (await chrome.storage.local.get(`shareDraft:${id}`)), recording.session.id);
  expect(JSON.stringify(drafts)).toContain('ENG-12');
  expect(JSON.stringify(drafts)).not.toContain(KEY);
});

test('while Proofline is connected, hosts the report on Proofline and files it to Linear with the personal key', async ({ context, background, extensionId }) => {
  const org = '10000000-0000-4000-8000-000000000001';
  const reportId = '20000000-0000-4000-8000-000000000001';
  const reportUrl = `https://proofline.sh/recorder/reports/${org}/${reportId}`;
  const account = {
    user: { id: 'u1', login: 'alice' },
    organization: { id: org, login: 'alice', name: 'Personal workspace', is_personal: true },
    organizations: [{ id: org, login: 'alice', name: 'Personal workspace', is_personal: true }],
    default_organization_id: org,
    credits: { balance_microcredits: 10000000000, microcredits_per_credit: 1000000 },
    repositories: [{ id: '30000000-0000-4000-8000-000000000001', full_name: 'alice/product', github_repository_id: 1 }],
  };
  const prooflinePaths: string[] = [];
  await context.route('https://proofline.sh/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    prooflinePaths.push(path);
    if (path.endsWith('/account')) await route.fulfill({ json: account });
    else if (path.endsWith('/reports')) await route.fulfill({ json: { id: reportId, url: reportUrl } });
    else if (path.endsWith('/attachments')) await route.fulfill({ json: { id: 'asset' } });
    else await route.fulfill({ status: 503, json: { detail: 'Fixture: unexpected Proofline call' } });
  });
  const descriptions: string[] = [];
  let createdId = '';
  await context.route('https://api.linear.app/graphql', async (route) => {
    const request = route.request();
    expect(request.headers().authorization).toBe(KEY);
    expect(request.postData()).not.toContain('test-proofline-token');
    const { query, variables } = JSON.parse(request.postData() ?? '{}');
    if (query.includes('teams(')) {
      await route.fulfill({ json: { data: { teams: { nodes: [{ id: TEAM, key: 'ENG', name: 'Engineering' }] } } } });
    } else if (query.includes('issueCreate')) {
      createdId = variables.input.id;
      descriptions.push(variables.input.description);
      await route.fulfill({ json: { data: { issueCreate: { success: true, issue: {
        id: createdId, identifier: 'ENG-12', number: 12, url: ISSUE_URL, team: { id: TEAM },
      } } } } });
    } else {
      throw new Error('Unexpected Linear query');
    }
  });
  await context.route(ISSUE_URL, (route) => route.fulfill({ body: '<h1>Linear issue</h1>', contentType: 'text/html' }));

  const demo = await context.newPage();
  await demo.goto('/');
  const recording = await dispatch<{ session: { id: string } }>(background, {
    kind: 'session/start', tabId: await tabIdForUrl(background, 'http://localhost:5319'),
  });
  await dispatch(background, { kind: 'session/stop' });
  await background.evaluate(async ({ id, account, org }) => {
    await chrome.storage.local.set({
      prooflineSettings: {
        aiMode: 'proofline', github: 'proofline', publishing: 'proofline', model: '',
        connection: { accessToken: 'test-proofline-token', organizationId: org, expiresAt: Date.now() + 3600000, account },
      },
      [`shareDraft:${id}`]: { repository: '', draft: { title: 'Checkout fails', body: 'Saved summary' }, draftSource: 'edited' },
    });
  }, { id: recording.session.id, account, org });

  const options = await context.newPage();
  await options.goto(extUrl(extensionId, 'options.html#linear'));
  await options.getByLabel('Linear API key', { exact: true }).fill(KEY);
  await options.getByRole('button', { name: 'Load teams' }).click();
  await options.getByRole('combobox', { name: 'Linear team', exact: true }).selectOption(TEAM);
  await options.getByRole('button', { name: 'Save Linear settings' }).click();
  await expect(options.getByRole('status')).toHaveText('Linear team ENG verified and saved.');

  const report = await context.newPage();
  await report.goto(extUrl(extensionId, `share.html?session=${recording.session.id}`));
  const destination = report.getByLabel('Issue repository', { exact: true });
  await expect(destination.locator('option')).toHaveText(['alice/product', 'Linear · ENG']);
  await destination.selectOption(`linear:${TEAM}`);
  await report.getByRole('button', { name: 'File Linear issue', exact: true }).click();
  await expect(report.getByRole('link', { name: 'View issue ENG-12' })).toBeVisible();
  expect(descriptions).toHaveLength(1);
  expect(descriptions[0]).toContain(`[Open the full report](${reportUrl})`);
  expect(descriptions[0]).not.toContain('pages.dev');
  expect(prooflinePaths.filter((path) => path.endsWith('/reports'))).toHaveLength(1);
  expect(prooflinePaths.some((path) => path.endsWith('/issue'))).toBe(false);
  const drafts = await background.evaluate(async (id) => (await chrome.storage.local.get(`shareDraft:${id}`)), recording.session.id);
  expect(JSON.stringify(drafts)).toContain(reportUrl);
  expect(JSON.stringify(drafts)).not.toContain(KEY);
});
