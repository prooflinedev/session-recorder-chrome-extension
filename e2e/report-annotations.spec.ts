import { SessionBuilder } from '../lib/fixtures/session-builder';
import { test, expect, extUrl, seedReport } from './support';

test('jumps to each annotation in the report across export levels', async ({
  context, extensionId,
}) => {
  const empty = new SessionBuilder({ id: 'empty' }).build();
  const annotated = new SessionBuilder({ id: 'annotated' })
    .note('First checkpoint')
    .marker('Second checkpoint')
    .build();
  for (const event of annotated.events) event.t = 500;

  const report = await context.newPage();
  await seedReport(report, extensionId, [empty, annotated]);
  await report.goto(extUrl(extensionId, 'report.html?session=empty'));
  await expect(report.getByRole('heading', { level: 1 })).toBeVisible();
  const navigation = report.getByRole('navigation', { name: 'Annotations' });
  await expect(navigation).toHaveCount(0);

  await report.goto(extUrl(extensionId, 'report.html?session=annotated'));
  const first = navigation.getByRole('link', { name: /First checkpoint/ });
  const second = navigation.getByRole('link', { name: /Second checkpoint/ });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  const firstAnchor = await first.getAttribute('href');
  const secondAnchor = await second.getAttribute('href');
  expect(firstAnchor).not.toBe(secondAnchor);

  await second.click();
  await expect(report.locator(':target')).toContainText('Second checkpoint');
  await expect(report.locator(':target')).toBeFocused();

  await report.getByRole('button', { name: 'Minimal', exact: true }).click();
  await expect(first).toHaveAttribute('href', firstAnchor!);
  await first.click();
  await expect(report.locator(':target')).toContainText('First checkpoint');
});
