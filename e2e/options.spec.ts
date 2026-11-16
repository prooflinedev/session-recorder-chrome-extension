/**
 * Options persistence: saving the transcription config writes it to
 * chrome.storage.local (the same key the background reads at transcription time).
 */
import { test, expect, extUrl } from './support';

test('persists transcription settings to chrome.storage.local', async ({
  context,
  background,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, 'options.html#transcription'));

  const section = page
    .locator('section.settings__section')
    .filter({ has: page.getByRole('heading', { name: 'Transcription' }) });

  await section.getByRole('combobox').selectOption('deepgram');
  await section.locator('input[type="password"]').fill('test-key-123');
  await section.getByRole('button', { name: 'Save' }).click();

  // Confirmation badge appears.
  await expect(page.getByText(/saved/i).first()).toBeVisible();

  // The background can read it back from storage.
  const stored = await background.evaluate(async () => {
    const got = await chrome.storage.local.get('transcription');
    return got.transcription as { provider?: string; apiKey?: string } | undefined;
  });
  expect(stored?.provider).toBe('deepgram');
  expect(stored?.apiKey).toBe('test-key-123');
});

test('saves vocabulary per repository, starting from its owner and name', async ({
  context,
  background,
  extensionId,
}) => {
  await background.evaluate(() =>
    chrome.storage.local.set({
      sharingSettings: {
        repositories: [
          { id: 'a', repository: 'acme/web-app', token: 'test-a' },
          { id: 'b', repository: 'acme/billing', token: 'test-b' },
        ],
      },
      lastIssueRepository: 'acme/billing',
    }),
  );
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, 'options.html#transcription'));
  const section = page.getByRole('region', { name: 'Vocabulary' });
  const terms = section.getByRole('textbox', { name: 'Terms' });

  // The repository new issues default to is selected and seeded.
  await expect(section.getByRole('combobox', { name: 'Repository' })).toHaveValue(
    'acme/billing',
  );
  await expect(terms).toHaveValue('acme\nbilling');

  await terms.fill('acme\nbilling\nLedger\nhttps://acme.test');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByRole('status')).toHaveText('Saved');
  await expect(section.getByText('Skipped https://acme.test.')).toBeVisible();
  await expect(terms).toHaveValue('acme\nbilling\nLedger');

  // Another repository keeps its own default.
  await section
    .getByRole('combobox', { name: 'Repository' })
    .selectOption('acme/web-app');
  await expect(terms).toHaveValue('acme\nweb-app');

  const stored = await background.evaluate(
    async () =>
      (await chrome.storage.local.get('transcriptionVocabulary'))
        .transcriptionVocabulary,
  );
  expect(stored).toEqual({ 'acme/billing': ['acme', 'billing', 'Ledger'] });
});

test('points to GitHub settings when no repository is configured', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, 'options.html#transcription'));
  const section = page.getByRole('region', { name: 'Vocabulary' });
  await expect(section.getByRole('textbox')).toHaveCount(0);
  await section.getByRole('link', { name: 'GitHub settings' }).click();
  await expect(page.getByRole('heading', { name: 'GitHub' })).toBeVisible();
});

test('keeps vocabulary through repository changes and page switches', async ({
  context,
  background,
  extensionId,
}) => {
  await context.route('https://api.github.com/repos/**', (route) =>
    route.fulfill({ json: { has_issues: true, archived: false } }),
  );
  await background.evaluate(() =>
    chrome.storage.local.set({
      sharingSettings: {
        repositories: [{ id: 'a', repository: 'acme/web-app', token: 'test-a' }],
      },
    }),
  );
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, 'options.html#transcription'));
  const section = page.getByRole('region', { name: 'Vocabulary' });
  const terms = section.getByRole('textbox', { name: 'Terms' });
  const picker = section.getByRole('combobox', { name: 'Repository' });
  const open = (name: string) => page.getByRole('link', { name, exact: true }).click();
  const saveGitHub = async () => {
    await page.getByRole('button', { name: 'Save GitHub settings' }).click();
    await expect(page.getByText('Repositories verified and saved.')).toBeVisible();
  };

  await terms.fill('acme\nweb-app\nLedger');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByRole('status')).toHaveText('Saved');

  // Adding a repository keeps saved terms and seeds the new one.
  await open('GitHub');
  await page.getByRole('button', { name: 'Add repository' }).click();
  const second = page.getByRole('group', { name: 'Repository 2' });
  await second.getByRole('textbox', { name: 'GitHub repository' }).fill('acme/billing');
  await second.getByLabel('GitHub API token').fill('test-b');
  await saveGitHub();
  await open('Transcription');
  await expect(picker).toHaveValue('acme/web-app');
  await expect(terms).toHaveValue('acme\nweb-app\nLedger');
  await picker.selectOption('acme/billing');
  await expect(terms).toHaveValue('acme\nbilling');

  // Renaming a repository carries its terms and adds the new name.
  await open('GitHub');
  await page
    .getByRole('group', { name: 'Repository 1' })
    .getByRole('textbox', { name: 'GitHub repository' })
    .fill('acme/storefront');
  await saveGitHub();
  await open('Transcription');
  await picker.selectOption('acme/storefront');
  await expect(terms).toHaveValue('acme\nweb-app\nLedger\nstorefront');

  // Unsaved terms survive switching settings pages.
  await terms.fill('acme\nstorefront\nDraft term');
  await open('GitHub');
  await open('Transcription');
  await expect(terms).toHaveValue('acme\nstorefront\nDraft term');

  const stored = await background.evaluate(
    async () =>
      (await chrome.storage.local.get('transcriptionVocabulary'))
        .transcriptionVocabulary,
  );
  expect(stored).toEqual({
    'acme/storefront': ['acme', 'web-app', 'Ledger', 'storefront'],
  });
});
