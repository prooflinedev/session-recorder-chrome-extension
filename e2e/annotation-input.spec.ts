import { test, expect, dispatch, tabIdForUrl, extUrl } from './support';
import type { Page, Worker } from '@playwright/test';

type Ev = { id: string; type: string; t: number; payload: any };
const eventsOf = async (background: Worker, sessionId: string) =>
  (await dispatch<{ events: Ev[] }>(background, { kind: 'events/get', sessionId })).events;
const pointHost = (page: Page) => page.locator('#__session_recorder_point_annotation_host__');

/** Personal OpenAI-compatible transcription served from fixtures; no provider is called. */
async function useFixtureTranscription(background: Worker, mode: 'auto' | 'held') {
  await background.evaluate(async (mode) => {
    await chrome.storage.local.set({
      micGranted: true,
      transcription: { provider: 'openai', apiKey: 'test-only', model: 'fixture', baseUrl: 'http://localhost:5319/v1' },
    });
    const g = globalThis as any;
    g.__stt = { calls: 0, waiting: [] as Array<(reply: { text?: string; error?: boolean }) => void>, repliedAt: 0 };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (!String(input).includes('localhost:5319/v1/audio/transcriptions')) return realFetch(input, init);
      g.__stt.calls += 1;
      const reply = mode === 'auto'
        ? { text: `segment ${g.__stt.calls}` }
        : await new Promise<{ text?: string; error?: boolean }>((resolve) => g.__stt.waiting.push(resolve));
      g.__stt.repliedAt = Date.now();
      if (reply.error) return new Response('fixture provider unavailable', { status: 503 });
      return new Response(JSON.stringify({ text: reply.text }), { headers: { 'Content-Type': 'application/json' } });
    };
  }, mode);
}

/** Answer the oldest held transcription request; returns when one was waiting. */
async function reply(background: Worker, answer: { text?: string; error?: boolean }) {
  await expect.poll(() => background.evaluate(() => (globalThis as any).__stt.waiting.length)).toBeGreaterThan(0);
  await background.evaluate((a) => (globalThis as any).__stt.waiting.shift()(a), answer);
}

test('annotation mode keeps incidental pointer, scroll and typing out of page activity', async ({ context, background }) => {
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{ session: { id: string; settings: { hoverDwellMs: number } } }>(background, { kind: 'session/start', tabId });
  expect(started.session.settings.hoverDwellMs).toBe(700);
  const get = (await page.locator('#btn-get').boundingBox())!;

  // Passing over a button on the way out of the page is not a hover.
  await page.mouse.move(get.x + 4, get.y + 4);
  await page.waitForTimeout(100);
  await page.locator('#btn-get').dispatchEvent('mouseout', { relatedTarget: null });
  await page.waitForTimeout(1000);

  // Typing still settling when annotation starts is recorded, not lost.
  await page.locator('#f-user').scrollIntoViewIfNeeded();
  const formY = await page.evaluate(() => scrollY);
  await page.waitForTimeout(600);
  await page.locator('#f-user').fill('ada');
  await dispatch(background, { kind: 'point-annotation/toggle', on: true });
  const host = pointHost(page);
  await expect(host.getByRole('button', { name: 'Turn off annotations' })).toBeVisible();

  // Typing a comment and scrolling while annotation owns input, then leaving
  // before the scroll settles.
  const email = (await page.locator('#f-email').boundingBox())!;
  await page.mouse.click(email.x + 4, email.y + 4);
  const comment = host.getByRole('textbox', { name: 'Comment', exact: true });
  await comment.pressSequentially('Draft');
  await comment.press('Escape');
  await page.mouse.move(300, 300);
  await page.mouse.wheel(0, -200);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeLessThan(formY);
  await page.keyboard.press('Escape');
  await expect(host).toHaveCount(0);
  await page.waitForTimeout(1000);

  // Normal capture resumes with the configured dwell.
  await page.mouse.wheel(0, -5000);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  const settled = (await page.locator('#btn-get').boundingBox())!;
  await page.mouse.move(settled.x + 6, settled.y + 6);
  await page.waitForTimeout(1200);
  await dispatch(background, { kind: 'session/stop' });

  const events = await eventsOf(background, started.session.id);
  const page_ = events.filter((e) => ['hover', 'scroll', 'click', 'key', 'input', 'text-select'].includes(e.type));
  expect(page_.map((e) => [e.type, e.payload.descriptor?.id ?? `to ${e.payload.to?.y}`])).toEqual([
    ['scroll', `to ${formY}`],
    ['input', 'f-user'],
    ['scroll', 'to 0'],
    ['hover', 'btn-get'],
  ]);
  expect(page_.at(-1)!.payload.dwellMs).toBe(700);
});

test('batch dictation fills the open comment promptly and stays out of narration', async ({ context, background, extensionId }) => {
  const media = await context.newPage();
  await media.goto(extUrl(extensionId, 'offscreen.html'));
  await background.evaluate(() => {
    // Run the real offscreen recorder in an inspectable page (see annotation-dictation.spec.ts).
    chrome.offscreen.createDocument = async () => {};
    chrome.offscreen.closeDocument = async () => {};
  });
  await useFixtureTranscription(background, 'auto');
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{ session: { id: string } }>(background, { kind: 'session/start', tabId });
  expect(await dispatch<{ micOn: boolean }>(background, { kind: 'mic/toggle', on: true })).toMatchObject({ micOn: true });
  await page.waitForTimeout(1500); // narration before the comment

  await dispatch(background, { kind: 'point-annotation/toggle', on: true });
  const host = pointHost(page);
  const get = (await page.locator('#btn-get').boundingBox())!;
  await page.mouse.click(get.x + 4, get.y + 4);
  const comment = host.getByRole('textbox', { name: 'Comment', exact: true });
  await expect(comment).toBeVisible();
  const openedAt = Date.now();
  // The session microphone keeps running; no mic toggle is needed to dictate.
  await expect(comment).toHaveValue(/segment \d+/, { timeout: 8000 });
  const firstText = Date.now() - openedAt;
  console.log(`batch dictation: comment opened to first dictated text ${firstText} ms (3 s segment cadence)`);
  await page.screenshot({ path: '.impeccable/review/annotation-batch-dictation.png' });
  const dictated = await comment.inputValue();
  await comment.press('Enter');
  await expect(host.getByRole('status')).toHaveText('Comment added to the recording.');
  await page.keyboard.press('Escape');
  await expect(host).toHaveCount(0);
  await page.waitForTimeout(1500); // narration after the comment
  await dispatch(background, { kind: 'mic/toggle', on: false });
  await expect.poll(async () => (await eventsOf(background, started.session.id))
    .filter((e) => e.type === 'voice-segment').every((e) => e.payload.transcript)).toBe(true);
  await dispatch(background, { kind: 'session/stop' });

  const events = await eventsOf(background, started.session.id);
  const voice = events.filter((e) => e.type === 'voice-segment');
  const spoken = voice.filter((e) => e.payload.dictation).map((e) => e.payload.transcript as string);
  const narration = voice.filter((e) => !e.payload.dictation).map((e) => e.payload.transcript as string);
  expect(narration.length).toBeGreaterThanOrEqual(2);
  for (const words of dictated.split(/(?=segment )/).map((s) => s.trim())) expect(spoken).toContain(words);
  for (const words of narration) expect(dictated).not.toContain(words);
  for (const e of voice) expect(e.payload.assetId).toBeTruthy(); // audio evidence kept
  const annotation = events.find((e) => e.type === 'annotation');
  expect(annotation!.payload.shapes[0].text).toBe(dictated);

  const report = await context.newPage();
  await report.goto(extUrl(extensionId, `report.html?session=${started.session.id}`));
  await expect(report.getByText(dictated, { exact: true })).toBeVisible();
  await expect(report.getByText(new RegExp(`${narration[0]}(?!\\d)`)).first()).toBeVisible();
  // Speech after the comment was saved belongs to no comment and is not narration.
  for (const words of spoken.filter((w) => !dictated.includes(w))) await expect(report.getByText(new RegExp(`${words}(?!\\d)`))).toHaveCount(0);
});

test('pending and failed dictation keep the comment, and late speech stays out of the next one', async ({ context, background }) => {
  await useFixtureTranscription(background, 'held');
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{ session: { id: string; startedAt: number } }>(background, { kind: 'session/start', tabId });
  // An audio segment from the recorder, timed at the current session moment.
  const segment = () => dispatch(background, {
    kind: 'audio/segment', sessionId: started.session.id, tStart: Date.now() - started.session.startedAt,
    tEnd: Date.now() - started.session.startedAt + 1000, dataUrl: 'data:audio/webm;base64,GkXfow==', mime: 'audio/webm',
  });

  await dispatch(background, { kind: 'point-annotation/toggle', on: true });
  const host = pointHost(page);
  const get = (await page.locator('#btn-get').boundingBox())!;
  await page.mouse.click(get.x + 4, get.y + 4);
  const comment = host.getByRole('textbox', { name: 'Comment', exact: true });
  await comment.fill('Typed start.');
  await page.waitForTimeout(50);

  await segment();
  await expect(host.getByRole('status')).toHaveText('Transcribing your speech…');
  await page.screenshot({ path: '.impeccable/review/annotation-dictation-pending.png' });
  await page.evaluate(() => {
    const field = document.querySelector('#__session_recorder_point_annotation_host__')!.shadowRoot!.querySelector('textarea')!;
    const watch = () => (field.value.includes('needs a clear error') ? ((window as any).__renderedAt = Date.now()) : setTimeout(watch, 1));
    watch();
  });
  await reply(background, { text: 'The fetch button needs a clear error.' });
  await expect(comment).toHaveValue('Typed start. The fetch button needs a clear error.');
  await expect(host.getByRole('status')).toBeHidden();
  const latency = (await page.evaluate(() => (window as any).__renderedAt)) - (await background.evaluate(() => (globalThis as any).__stt.repliedAt));
  console.log(`batch dictation: provider response to rendered comment ${latency} ms`);

  await segment();
  await reply(background, { error: true });
  await expect(host.getByRole('status')).toContainText('Transcription failed:');
  await expect(host.getByRole('status')).toContainText('Type the rest of your comment.');
  await expect(comment).toHaveValue('Typed start. The fetch button needs a clear error.');
  await page.screenshot({ path: '.impeccable/review/annotation-dictation-failed.png' });

  // Speech still transcribing when the comment is cancelled never reaches the next one.
  await segment();
  await comment.press('Escape');
  const post = (await page.locator('#btn-post').boundingBox())!;
  await page.mouse.click(post.x + 4, post.y + 4);
  await expect(comment).toHaveValue('');
  await reply(background, { text: 'Words for the cancelled comment.' });
  await expect.poll(async () => (await eventsOf(background, started.session.id))
    .some((e) => e.type === 'voice-segment' && e.payload.transcript === 'Words for the cancelled comment.')).toBe(true);
  await expect(comment).toHaveValue('');
  await expect(host.getByRole('status')).toBeHidden();
  await dispatch(background, { kind: 'session/stop' });

  const voice = (await eventsOf(background, started.session.id)).filter((e) => e.type === 'voice-segment');
  expect(voice.map((e) => [e.payload.dictation, e.payload.transcript ?? e.payload.transcriptionError])).toEqual([
    [true, 'The fetch button needs a clear error.'],
    [true, expect.stringContaining('503')],
    [true, 'Words for the cancelled comment.'],
  ]);
});
