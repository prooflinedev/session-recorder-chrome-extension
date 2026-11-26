import { SessionBuilder } from '../lib/fixtures/session-builder';
import { test, expect, extUrl, seedReport } from './support';

test('filters saved recordings by title and keeps row actions tied to the recording', async ({
  context, extensionId,
}) => {
  const checkout = new SessionBuilder({
    id: 'checkout', name: 'Checkout failure', startedAt: 1_700_000_000_000,
  }).build();
  const redesign = new SessionBuilder({
    id: 'redesign', name: 'Search redesign', startedAt: 1_700_000_100_000,
  }).build();
  const panel = await context.newPage();
  await seedReport(panel, extensionId, [checkout, redesign]);
  await panel.goto(extUrl(extensionId, 'sidepanel.html'));
  const rows = panel.locator('.session-row__name');
  await expect(rows).toHaveText(['Search redesign', 'Checkout failure']);

  const search = panel.getByRole('searchbox', { name: 'Search recordings' });
  await search.fill(' CHECKOUT ');
  await expect(rows).toHaveText(['Checkout failure']);
  await panel.getByRole('button', { name: 'Delete Checkout failure' }).click();
  await expect(panel.getByText('No matching recordings.')).toBeVisible();

  await search.clear();
  await expect(rows).toHaveText(['Search redesign']);
  const opened = context.waitForEvent('page');
  await panel.getByRole('button', { name: /^Search redesign/ }).click();
  await expect(await opened).toHaveURL(extUrl(extensionId, 'share.html?session=redesign'));
});
