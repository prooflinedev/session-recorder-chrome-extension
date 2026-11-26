import { unzipSync } from 'fflate';
import { SessionBuilder } from '../lib/fixtures/session-builder';
import { test, expect, extUrl, seedReport } from './support';

type DownloadWindow = Window & { downloaded?: { filename: string; bytes: number[] } };

test('downloads Markdown at the selected level and still downloads the ZIP', async ({
  context, extensionId,
}) => {
  const recording = new SessionBuilder({ id: 'fixture', name: 'Checkout report' })
    .marker('Checkout failed')
    .textSelect('Full-only selection')
    .build();
  const page = await context.newPage();
  await seedReport(page, extensionId, [recording]);
  await page.goto(extUrl(extensionId, 'report.html?session=fixture'));

  await page.evaluate(() => {
    const state = window as DownloadWindow;
    chrome.downloads.download = (async (options: chrome.downloads.DownloadOptions) => {
      const bytes = await fetch(options.url).then((response) => response.arrayBuffer());
      state.downloaded = { filename: options.filename!, bytes: Array.from(new Uint8Array(bytes)) };
      return 1;
    }) as typeof chrome.downloads.download;
  });

  async function download(button: string) {
    await page.evaluate(() => { delete (window as DownloadWindow).downloaded; });
    await page.getByRole('button', { name: button, exact: true }).click();
    await page.waitForFunction(() => !!(window as DownloadWindow).downloaded);
    const result = await page.evaluate(() => (window as DownloadWindow).downloaded!);
    return { filename: result.filename, bytes: Buffer.from(result.bytes) };
  }

  await page.getByRole('button', { name: 'Full', exact: true }).click();
  const markdown = await download('Download Markdown');
  expect(markdown.filename).toMatch(/^checkout-report-.*\.md$/);
  expect(markdown.bytes.toString()).toContain('Checkout failed');
  expect(markdown.bytes.toString()).toContain('Full-only selection');

  await page.getByRole('button', { name: 'Minimal', exact: true }).click();
  const minimal = await download('Download Markdown');
  expect(minimal.bytes.toString()).toContain('Checkout failed');
  expect(minimal.bytes.toString()).not.toContain('Full-only selection');

  const zip = await download('Download .zip');
  expect(zip.filename).toBe(markdown.filename.replace(/\.md$/, '.zip'));
  expect(Object.keys(unzipSync(zip.bytes)).some((name) => name.endsWith('/report.md'))).toBe(true);
});
