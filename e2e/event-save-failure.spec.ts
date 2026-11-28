/**
 * A recording must survive a temporary IndexedDB write failure (for example a
 * full disk): the side panel says events are not being saved, and once storage
 * recovers, the events recorded during the failure are saved with the rest.
 */
import { test, expect, dispatch, tabIdForUrl, extUrl } from './support';

type StartRes = { ok: boolean; session?: { id: string } };
type EventsRes = { events: Array<{ type: string; payload: any }> };
type StateRes = { error?: string };

type FailureGlobal = typeof globalThis & {
  __failEventWrites?: boolean;
  __realPut?: IDBObjectStore['put'];
};

test('keeps events recorded while saving failed and reports the failure', async ({
  context,
  background,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const panel = await context.newPage();
  await panel.goto(extUrl(extensionId, 'sidepanel.html'));

  // Make every write to the events store fail while the flag is on.
  await background.evaluate(() => {
    const g = globalThis as FailureGlobal;
    if (g.__realPut) return;
    const put = IDBObjectStore.prototype.put;
    g.__realPut = put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (g.__failEventWrites && this.name === 'events') {
        throw new DOMException('The disk is full.', 'QuotaExceededError');
      }
      return put.apply(this, args);
    };
  });
  const failWrites = (on: boolean) =>
    background.evaluate((value) => {
      (globalThis as FailureGlobal).__failEventWrites = value;
    }, on);

  try {
    const started = await dispatch<StartRes>(background, { kind: 'session/start', tabId });
    expect(started.ok).toBe(true);
    const sessionId = started.session!.id;
    await page.waitForTimeout(800);
    await dispatch(background, { kind: 'marker/add', name: 'before failure' });

    await failWrites(true);
    await dispatch(background, { kind: 'marker/add', name: 'during failure' });
    await page.click('#btn-get');
    const alert = panel.getByRole('alert');
    await expect(alert).toContainText('Some recording events could not be saved');
    await expect(alert).toContainText('Retrying');
    await dispatch(background, { kind: 'marker/add', name: 'still failing' });

    // Storage recovers and nothing new is recorded: the writer must retry on
    // its own, well before the 24 s heartbeat would.
    await failWrites(false);
    await expect(alert).toHaveCount(0, { timeout: 15_000 });
    const state = await dispatch<StateRes>(background, { kind: 'session/getState' });
    expect(state.error).toBeUndefined();
    await dispatch(background, { kind: 'marker/add', name: 'after recovery' });

    await dispatch(background, { kind: 'session/stop' });

    const { events } = await dispatch<EventsRes>(background, { kind: 'events/get', sessionId });
    const markers = events.filter((e) => e.type === 'marker').map((e) => e.payload.name);
    expect(markers).toEqual(['before failure', 'during failure', 'still failing', 'after recovery']);
    const clicks = events
      .filter((e) => e.type === 'click')
      .map((e) => e.payload?.descriptor?.text);
    expect(clicks).toContain('GET fetch');
    // Nothing was dropped, so the report must not claim missing events.
    expect(
      events.some((e) => e.type === 'session-note' && /missing from this recording/.test(e.payload?.text ?? '')),
    ).toBe(false);
  } finally {
    await background.evaluate(() => {
      const g = globalThis as FailureGlobal;
      g.__failEventWrites = false;
      if (g.__realPut) IDBObjectStore.prototype.put = g.__realPut;
      delete g.__realPut;
    });
  }
});
