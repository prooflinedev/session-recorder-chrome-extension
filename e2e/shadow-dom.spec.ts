/**
 * Interactions inside web components: clicks, typing and key presses in open
 * shadow roots are recorded against the inner element, not its shadow host.
 *
 * Recording runs in the degraded mode explained in record-export.spec.ts
 * (Playwright holds the tab's CDP session), which leaves interaction capture,
 * the subject of this test, fully working.
 */
import { test, expect, dispatch, tabIdForUrl } from './support';

type StartRes = { ok: boolean; session?: { id: string } };
type Descriptor = { tag?: string; text?: string; selector?: string };
type EventsRes = {
  events: Array<{ type: string; payload: { descriptor?: Descriptor; value?: string; redacted?: boolean; key?: string } }>;
};

test('records clicks, typing and keys inside open shadow roots', async ({ context, background }) => {
  const page = await context.newPage();
  await page.goto('/');
  // Playwright's CSS engine pierces open shadow roots.
  const team = page.locator('#wc-signup input[name="team"]');
  const password = page.locator('#wc-signup demo-password-field input');
  await expect(team).toBeVisible();

  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<StartRes>(background, { kind: 'session/start', tabId });
  expect(started.ok).toBe(true);
  const sessionId = started.session!.id;
  await page.waitForTimeout(800); // let the background activate the content script

  // A normal app can clear the field in its submit key handler. Capture must
  // flush the inner field first, before bubbling reaches that handler.
  await team.evaluate((el) => el.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') (el as HTMLInputElement).value = '';
  }));
  await team.fill('Proofline');
  await team.press('Enter');
  await password.fill('hunter2'); // must be redacted
  await page.locator('#wc-signup button.create').click();
  await page.waitForTimeout(1000); // input debounce (800ms)

  await dispatch(background, { kind: 'session/stop' });
  const { events } = await dispatch<EventsRes>(background, { kind: 'events/get', sessionId });

  const click = events.find((e) => e.type === 'click' && e.payload.descriptor?.text === 'Create team');
  expect(click, 'click names the inner button, not <demo-signup>').toBeTruthy();
  expect(click!.payload.descriptor).toMatchObject({ tag: 'button', selector: '#wc-signup >> button.create' });

  const typed = events.find((e) => e.type === 'input' && e.payload.value === 'Proofline');
  expect(typed, 'the value typed into the shadow-root input is captured').toBeTruthy();
  expect(typed!.payload.descriptor).toMatchObject({ tag: 'input', selector: '#wc-signup >> label > input' });

  const enter = events.find((e) => e.type === 'key' && e.payload.key === 'Enter');
  expect(enter?.payload.descriptor?.tag, 'key press names the focused inner input').toBe('input');
  expect(events.indexOf(typed!)).toBeLessThan(events.indexOf(enter!));
  expect(events.filter((e) => e.type === 'input' && e.payload.value === 'Proofline')).toHaveLength(1);

  const secret = events.find((e) => e.type === 'input' && e.payload.redacted);
  expect(secret, 'the nested password field is captured and redacted').toBeTruthy();
  expect(secret!.payload.descriptor?.selector).toBe('#wc-signup >> demo-password-field >> label > input');
  expect(JSON.stringify(events)).not.toContain('hunter2');

  // No interaction is attributed to a shadow host any more.
  const hostTags = events.map((e) => e.payload.descriptor?.tag).filter((t) => t?.startsWith('demo-'));
  expect(hostTags).toEqual([]);
});


test('annotation entry flushes pending shadow input and excludes comment typing', async ({ context, background }) => {
  const page = await context.newPage();
  await page.goto('/');
  const team = page.locator('#wc-signup input[name="team"]');
  await team.scrollIntoViewIfNeeded();
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<StartRes>(background, { kind: 'session/start', tabId });
  expect(started.ok).toBe(true);
  await page.waitForTimeout(800);

  await team.fill('pending shadow value');
  await dispatch(background, { kind: 'point-annotation/toggle', on: true });
  const host = page.locator('#__session_recorder_point_annotation_host__');
  await expect(host.getByRole('button', { name: 'Turn off annotations' })).toBeVisible();
  const box = (await team.boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + 4);
  const comment = host.getByRole('textbox', { name: 'Comment', exact: true });
  await comment.pressSequentially('annotation-only text');
  await comment.press('Escape');
  await page.keyboard.press('Escape');
  await expect(host).toHaveCount(0);
  await page.waitForTimeout(1000);
  await dispatch(background, { kind: 'session/stop' });

  const { events } = await dispatch<EventsRes>(background, { kind: 'events/get', sessionId: started.session!.id });
  const inputs = events.filter((e) => e.type === 'input');
  expect(inputs).toHaveLength(1);
  expect(inputs[0]!.payload).toMatchObject({ value: 'pending shadow value', redacted: false });
  expect(JSON.stringify(events)).not.toContain('annotation-only text');
});
