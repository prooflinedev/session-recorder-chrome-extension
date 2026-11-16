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

  const secret = events.find((e) => e.type === 'input' && e.payload.redacted);
  expect(secret, 'the nested password field is captured and redacted').toBeTruthy();
  expect(secret!.payload.descriptor?.selector).toBe('#wc-signup >> demo-password-field >> label > input');
  expect(JSON.stringify(events)).not.toContain('hunter2');

  // No interaction is attributed to a shadow host any more.
  const hostTags = events.map((e) => e.payload.descriptor?.tag).filter((t) => t?.startsWith('demo-'));
  expect(hostTags).toEqual([]);
});
