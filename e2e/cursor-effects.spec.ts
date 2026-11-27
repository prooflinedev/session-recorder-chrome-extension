import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import {
  test,
  expect,
  extUrl,
  dispatch,
  tabIdForUrl,
  EXT_PATH,
} from './support';
import type { Page, Worker } from '@playwright/test';
import { CURSOR_OVERLAY_HOST_ID } from '../lib/dom/overlay';
import { MAX_ACTIVE_RIPPLES } from '../lib/dom/cursor-effects';

test.use({ allowTabCapture: true });

type StartRes = {
  ok: boolean;
  session?: {
    id: string;
    settings: { cursorSpotlight: boolean; clickHighlight: boolean };
  };
};
type EventsRes = {
  events: Array<{ type: string; tabId?: number; payload: any }>;
};

async function overlayState(page: Page): Promise<{
  hostCount: number;
  connected: boolean;
  spotlightVisible: boolean;
  spotlightCenter: { x: number; y: number } | null;
  rippleCount: number;
  rippleAnimationName: string | null;
  rippleCoords: Array<{ x: string; y: string }>;
  hostStyles: { opacity: string; pointerEvents: string; position: string } | null;
  popoverOpen: boolean;
}> {
  return page.evaluate((hostId) => {
    const hosts = document.querySelectorAll(`#${hostId}`);
    const host = hosts[0] as HTMLElement | undefined;
    if (!host || !host.shadowRoot) {
      return {
        hostCount: hosts.length,
        connected: false,
        spotlightVisible: false,
        spotlightCenter: null,
        rippleCount: 0,
        rippleAnimationName: null,
        rippleCoords: [],
        hostStyles: null,
        popoverOpen: false,
      };
    }
    const root = host.shadowRoot;
    const spotlight = root.querySelector('.spotlight') as HTMLElement | null;
    const spotlightRect = spotlight && !spotlight.hidden ? spotlight.getBoundingClientRect() : null;
    const ripples = Array.from(root.querySelectorAll('.ripple')) as HTMLElement[];
    const cs = getComputedStyle(host);
    let popoverOpen = false;
    try {
      popoverOpen = host.matches(':popover-open');
    } catch {
      popoverOpen = false;
    }
    return {
      hostCount: hosts.length,
      connected: host.isConnected,
      spotlightVisible: !!spotlight && !spotlight.hidden && !!spotlightRect && spotlightRect.width > 0,
      spotlightCenter: spotlightRect
        ? {
            x: spotlightRect.left + spotlightRect.width / 2,
            y: spotlightRect.top + spotlightRect.height / 2,
          }
        : null,
      rippleCount: ripples.length,
      rippleAnimationName: ripples[0] ? getComputedStyle(ripples[0]).animationName : null,
      rippleCoords: ripples.map((r) => ({
        x: r.style.getPropertyValue('--sr-x'),
        y: r.style.getPropertyValue('--sr-y'),
      })),
      hostStyles: {
        opacity: cs.opacity,
        pointerEvents: cs.pointerEvents,
        position: cs.position,
      },
      popoverOpen,
    };
  }, CURSOR_OVERLAY_HOST_ID);
}

test('defaults off, toggles independently, persists, and normalizes legacy settings', async ({
  context,
  background,
  extensionId,
}) => {
  // Seed legacy stored defaults without cursor effect keys -> backward compatible false.
  await background.evaluate(async () => {
    await chrome.storage.local.set({
      defaultSettings: { screenshotPolicy: 'key-moments', redactionEnabled: false },
    });
  });

  const panel = await context.newPage();
  await panel.setViewportSize({ width: 390, height: 844 });
  await panel.goto(extUrl(extensionId, 'sidepanel.html'));
  await panel.getByRole('button', { name: 'Capture options', exact: true }).click();

  const dialog = panel.getByRole('dialog', { name: 'Capture options' });
  const spotlightSwitch = dialog.getByRole('switch', { name: /Cursor spotlight/i });
  const clickSwitch = dialog.getByRole('switch', { name: /Highlight clicks/i });

  await expect(spotlightSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(clickSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(spotlightSwitch).toBeDisabled();
  await expect(clickSwitch).toBeDisabled();
  await dialog.getByRole('switch', { name: /^Video/ }).click();
  await expect(spotlightSwitch).toBeEnabled();
  await expect(dialog.getByText(/embedded permanently in captured video and screenshots/i)).toBeVisible();
  await expect(dialog).toBeInViewport();

  // Toggle spotlight on independently.
  await spotlightSwitch.click();
  await expect(spotlightSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(clickSwitch).toHaveAttribute('aria-checked', 'false');

  await expect
    .poll(async () =>
      background.evaluate(async () => {
        const s = await chrome.storage.local.get('defaultSettings');
        return s.defaultSettings;
      }),
    )
    .toMatchObject({
      screenshotPolicy: 'key-moments',
      redactionEnabled: false,
      cursorSpotlight: true,
      clickHighlight: false,
    });

  // Verify options page reflects state, persists independent toggle across reload.
  const options = await context.newPage();
  await options.goto(extUrl(extensionId, 'options.html#capture'));
  const spotlightCheck = options.getByLabel('Cursor spotlight');
  const clickCheck = options.getByLabel('Highlight clicks');

  await expect(spotlightCheck).toBeChecked();
  await expect(clickCheck).not.toBeChecked();
  await expect(options.getByText(/Embedded permanently into captured video and screenshots/i).first()).toBeVisible();

  await spotlightCheck.uncheck();
  await clickCheck.check();
  await options.getByRole('button', { name: 'Save' }).click();
  await expect(options.getByText(/Saved/i)).toBeVisible();

  await options.reload();
  await expect(options.getByLabel('Cursor spotlight')).not.toBeChecked();
  await expect(options.getByLabel('Highlight clicks')).toBeChecked();

  // Back in sidepanel, re-opening shows persisted independent state.
  await panel.reload();
  await panel.getByRole('button', { name: 'Capture options', exact: true }).click();
  await expect(panel.getByRole('switch', { name: /Cursor spotlight/i })).toHaveAttribute('aria-checked', 'false');
  await expect(panel.getByRole('switch', { name: /Highlight clicks/i })).toHaveAttribute('aria-checked', 'true');
  await panel.getByRole('switch', { name: /^Video/ }).click();
  await expect(panel.getByRole('switch', { name: /Cursor spotlight/i })).toBeDisabled();
  await expect(panel.getByRole('switch', { name: /Highlight clicks/i })).toBeDisabled();
  await expect(options.getByLabel('Cursor spotlight')).toBeDisabled();
  await expect(options.getByLabel('Highlight clicks')).toBeDisabled();
});

test('does not mount overlay or alter capture when disabled by default', async ({
  context,
  background,
}) => {
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');

  const started = await dispatch<StartRes>(background, { kind: 'session/start', tabId });
  expect(started.ok).toBe(true);
  expect(started.session?.settings.cursorSpotlight).toBe(false);
  expect(started.session?.settings.clickHighlight).toBe(false);
  await page.waitForTimeout(400);

  await page.mouse.move(180, 180);
  await page.click('#btn-get');
  await page.waitForTimeout(200);

  expect((await overlayState(page)).hostCount).toBe(0);

  await dispatch(background, { kind: 'session/stop' });
  const { events } = await dispatch<EventsRes>(background, {
    kind: 'events/get',
    sessionId: started.session!.id,
  });
  expect(events.some((e) => e.type === 'click' && e.payload.descriptor?.id === 'btn-get')).toBe(true);
});

test('keeps simultaneous cursor option changes after reloading', async ({ context, extensionId, background }) => {
  const panel = await context.newPage();
  await panel.goto(extUrl(extensionId, 'sidepanel.html'));
  await panel.getByRole('button', { name: 'Capture options', exact: true }).click();
  await panel.getByRole('switch', { name: /^Video/ }).click();
  await expect(panel.getByRole('switch', { name: /Cursor spotlight/i })).toHaveAttribute('aria-checked', 'false');
  await panel.evaluate(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[role="switch"]')) {
      if (/Cursor spotlight|Highlight clicks/.test(button.textContent ?? '')) button.click();
    }
  });
  await expect.poll(() => background.evaluate(async () => (await chrome.storage.local.get('defaultSettings')).defaultSettings))
    .toMatchObject({ cursorSpotlight: true, clickHighlight: true });
  await panel.reload();
  await panel.getByRole('button', { name: 'Capture options', exact: true }).click();
  await expect(panel.getByRole('switch', { name: /Cursor spotlight/i })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('switch', { name: /Highlight clicks/i })).toHaveAttribute('aria-checked', 'true');
});

test('centers rendered ripples on trusted clicks and ignores page-generated input', async ({ context, background }) => {
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  await dispatch(background, { kind: 'session/start', tabId, media: { video: true, mic: false }, settings: { cursorSpotlight: true, clickHighlight: true } });
  const captureState = await dispatch<{ videoOn: boolean; error?: string }>(background, { kind: 'session/getState' });
  expect(captureState.error).toBeUndefined();
  expect(captureState.videoOn).toBe(true);
  await expect.poll(async () => (await overlayState(page)).hostCount).toBe(1);
  await page.mouse.click(240, 220);
  const center = await page.evaluate((id) => {
    const ripple = document.getElementById(id)!.shadowRoot!.querySelector<HTMLElement>('.ripple')!;
    for (const animation of ripple.getAnimations()) animation.pause();
    const rect = ripple.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, CURSOR_OVERLAY_HOST_ID);
  expect(center.x).toBeCloseTo(240, 1);
  expect(center.y).toBeCloseTo(220, 1);
  await expect.poll(async () => (await overlayState(page)).rippleCount).toBe(0);
  await page.evaluate(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600, clientY: 400 }));
    document.dispatchEvent(new MouseEvent('click', { clientX: 600, clientY: 400, detail: 1 }));
    document.querySelector<HTMLButtonElement>('#btn-get')!.click();
  });
  await page.waitForTimeout(50);
  expect((await overlayState(page)).rippleCount).toBe(0);
  expect((await overlayState(page)).spotlightCenter).toEqual({ x: 240, y: 220 });
  await page.locator('#btn-log').focus();
  await page.keyboard.press('Enter');
  expect((await overlayState(page)).rippleCount).toBe(0);
  await dispatch(background, { kind: 'session/stop' });
});

test('preserves focus, drag, zoom and modal hit testing with cursor effects enabled', async ({ context, background }) => {
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  await dispatch(background, { kind: 'session/start', tabId, media: { video: true, mic: false }, settings: { cursorSpotlight: true, clickHighlight: true } });
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = '<button id="modal-btn">Modal action</button>';
    document.body.append(dialog);
    dialog.showModal();
  });
  await page.locator('#modal-btn').click();
  await expect(page.locator('#modal-btn')).toBeFocused();
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('DOM.getDocument');
  const { nodeIds } = await cdp.send('DOM.getTopLayerElements');
  const topLayer = await Promise.all(nodeIds.map(async (nodeId: number) => {
    const { node } = await cdp.send('DOM.describeNode', { nodeId });
    return node.attributes ?? [];
  }));
  expect(topLayer.at(-1)).toContain(CURSOR_OVERLAY_HOST_ID);
  await cdp.detach();
  await page.evaluate(() => document.querySelector('dialog')!.close());
  for (const zoom of [0.8, 1.25]) {
    await background.evaluate(async ({ tabId, zoom }) => chrome.tabs.setZoom(tabId, zoom), { tabId, zoom });
    await page.mouse.move(240, 220);
    await expect.poll(async () => {
      const center = (await overlayState(page)).spotlightCenter;
      return center ? Math.hypot(center.x - 240, center.y - 220) : Infinity;
    }).toBeLessThan(0.1);
  }
  await background.evaluate(async (id) => chrome.tabs.setZoom(id, 1), tabId);
  await page.evaluate(() => {
    const drag = document.createElement('div');
    drag.id = 'drag';
    drag.draggable = true;
    drag.textContent = 'Drag me';
    document.body.prepend(drag);
  });
  await page.locator('#drag').hover();
  await page.mouse.down();
  await page.mouse.move(400, 300, { steps: 10 });
  expect((await overlayState(page)).spotlightVisible).toBe(false);
  await page.mouse.up();
  await page.mouse.move(240, 220);
  await expect.poll(async () => (await overlayState(page)).spotlightVisible).toBe(true);
  await dispatch(background, { kind: 'session/stop' });
});

test('renders spotlight and ripples accurately across scroll, resize, CSS hostility, iframes, shadow DOM, fullscreen, and rapid clicks', async ({
  context,
  background,
}, testInfo) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto('/');

  // Inject hostile CSS, scrollable height, shadow DOM button, same-origin iframe, and fullscreen box.
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = `
      div { opacity: 0.4; }
      ::backdrop { background: red !important; pointer-events: auto !important; }
      #hostile-spacer { height: 1400px; }
      .dark-band { background: #0f172a; color: #f8fafc; padding: 20px; margin: 12px 0; }
    `;
    document.head.appendChild(style);

    const dark = document.createElement('div');
    dark.className = 'dark-band';
    dark.innerHTML = '<button id="dark-btn">Dark button</button>';
    document.body.prepend(dark);

    class DemoShadowBtn extends HTMLElement {
      constructor() {
        super();
        const sr = this.attachShadow({ mode: 'open' });
        sr.innerHTML = '<button id="inner-shadow-btn">Shadow Button</button>';
      }
    }
    customElements.define('demo-cursor-shadow', DemoShadowBtn);
    const wc = document.createElement('demo-cursor-shadow');
    document.body.prepend(wc);

    const iframe = document.createElement('iframe');
    iframe.id = 'child-frame';
    iframe.srcdoc = '<!doctype html><body style="margin:0"><button id="frame-btn" style="margin:24px">Frame Btn</button></body>';
    iframe.style.cssText = 'width: 300px; height: 120px; border: 1px solid #888; display: block;';
    document.body.prepend(iframe);

    const fsBox = document.createElement('div');
    fsBox.id = 'fs-box';
    fsBox.style.cssText = 'padding: 12px; background: #1e293b; color: #fff; opacity: 1;';
    fsBox.innerHTML = '<button id="fs-btn">Fullscreen</button>';
    fsBox.querySelector('#fs-btn')!.addEventListener('click', () => {
      void fsBox.requestFullscreen().catch(() => {});
    });
    document.body.prepend(fsBox);

    const spacer = document.createElement('div');
    spacer.id = 'hostile-spacer';
    document.body.appendChild(spacer);
  });

  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<StartRes>(background, {
    kind: 'session/start',
    tabId,
    media: { video: true, mic: false },
    settings: { cursorSpotlight: true, clickHighlight: true },
  });
  expect(started.ok).toBe(true);

  await expect.poll(async () => (await overlayState(page)).hostCount).toBe(1);

  // Host CSS isolation: opacity remains 1, pointer-events stays none.
  const initState = await overlayState(page);
  expect(initState.hostStyles).toEqual({
    opacity: '1',
    pointerEvents: 'none',
    position: 'fixed',
  });
  expect(initState.spotlightVisible).toBe(false);
  expect(await page.evaluate((id) => getComputedStyle(document.getElementById(id)!, '::backdrop').display,
    CURSOR_OVERLAY_HOST_ID)).toBe('none');

  // High-frequency mouse movement -> single spotlight tracks exact pointer coords.
  await page.mouse.move(260, 210, { steps: 25 });
  await expect
    .poll(async () => (await overlayState(page)).spotlightCenter)
    .toEqual({ x: expect.any(Number), y: expect.any(Number) });
  const moved = await overlayState(page);
  expect(Math.abs(moved.spotlightCenter!.x - 260)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(moved.spotlightCenter!.y - 210)).toBeLessThanOrEqual(1.5);

  // Scroll page -> spotlight stays accurately registered to viewport coordinates.
  await page.evaluate(() => window.scrollBy(0, 320));
  await page.mouse.move(310, 240);
  await expect
    .poll(async () => {
      const s = await overlayState(page);
      return s.spotlightCenter ? Math.round(s.spotlightCenter.x) : 0;
    })
    .toBe(310);
  const scrolled = await overlayState(page);
  expect(Math.abs(scrolled.spotlightCenter!.y - 240)).toBeLessThanOrEqual(1.5);

  // Leave page -> spotlight hides; re-enter -> spotlight returns.
  await page.evaluate(() => {
    document.dispatchEvent(new MouseEvent('mouseout', { relatedTarget: null }));
  });
  await expect.poll(async () => (await overlayState(page)).spotlightVisible).toBe(false);

  await page.mouse.move(140, 120);
  await expect.poll(async () => (await overlayState(page)).spotlightVisible).toBe(true);

  // Resize smaller than cursor position -> hides out-of-bounds spotlight.
  await page.mouse.move(900, 620);
  await expect
    .poll(async () => {
      const s = await overlayState(page);
      return s.spotlightCenter ? Math.round(s.spotlightCenter.x) : 0;
    })
    .toBe(900);
  await page.setViewportSize({ width: 640, height: 480 });
  await expect.poll(async () => (await overlayState(page)).spotlightVisible).toBe(false);
  await page.setViewportSize({ width: 1000, height: 700 });

  // Underlying click & interaction integrity (light button, dark button, shadow button).
  await page.evaluate(() => window.scrollTo(0, 0));
  const darkBox = (await page.locator('#dark-btn').boundingBox())!;
  const clickX = Math.floor(darkBox.x + darkBox.width / 2);
  const clickY = Math.floor(darkBox.y + darkBox.height / 2);
  await page.mouse.click(clickX, clickY);
  const darkClickState = await overlayState(page);
  expect(darkClickState.rippleCount).toBeGreaterThanOrEqual(1);
  expect(darkClickState.rippleCoords[0]).toEqual({
    x: `${clickX}px`,
    y: `${clickY}px`,
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: testInfo.outputPath('cursor-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  // Shadow DOM button click succeeds and records inner element, never overlay host.
  const shadowBtn = page.locator('demo-cursor-shadow #inner-shadow-btn');
  await shadowBtn.click();

  // Rapid consecutive clicks cap DOM ripples at MAX_ACTIVE_RIPPLES and clean up afterward.
  for (let i = 0; i < 15; i++) await page.mouse.click(200 + i * 5, 300);
  const burst = await overlayState(page);
  expect(burst.rippleCount).toBeLessThanOrEqual(MAX_ACTIVE_RIPPLES);
  expect(burst.rippleCount).toBeGreaterThan(0);

  await expect.poll(async () => (await overlayState(page)).rippleCount, { timeout: 2000 }).toBe(0);

  // Same-origin iframe click triggers isolated overlay inside the iframe.
  const frameBox = (await page.locator('#child-frame').contentFrame().locator('#frame-btn').boundingBox())!;
  await page.mouse.click(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
  const frameHasRipple = await page
    .locator('#child-frame')
    .contentFrame()
    .locator('body')
    .evaluate((_b, hostId) => {
      const h = document.getElementById(hostId);
      return !!h?.shadowRoot?.querySelector('.ripple');
    }, CURSOR_OVERLAY_HOST_ID);
  expect(frameHasRipple).toBe(true);
  // A permitted cross-origin frame receives its own isolated content script.
  await context.route('http://127.0.0.1:5319/', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><h1>Cross-origin frame</h1>',
  }));
  await page.locator('#child-frame').evaluate((frame) => {
    frame.removeAttribute('srcdoc');
    (frame as HTMLIFrameElement).src = 'http://127.0.0.1:5319/';
  });
  const crossOrigin = page.locator('#child-frame').contentFrame();
  await crossOrigin.locator('h1').click();
  expect(await crossOrigin.locator('body').evaluate((_body, id) =>
    !!document.getElementById(id)?.shadowRoot?.querySelector('.ripple'), CURSOR_OVERLAY_HOST_ID)).toBe(true);

  // Fullscreen element keeps overlay promoted in top layer.
  await page.locator('#fs-btn').click();
  await expect
    .poll(async () => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true);
  const fsState = await overlayState(page);
  expect(fsState.popoverOpen).toBe(true);
  await page.evaluate(() => document.exitFullscreen().catch(() => {}));

  // Verify text selection + typing underneath overlay work normally.
  await page.fill('#f-user', 'ada');
  await page.locator('h1').selectText();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Demo');

  await dispatch(background, { kind: 'session/stop' });
  expect((await overlayState(page)).hostCount).toBe(0);

  // Overlay host must never appear as a recorded event target.
  const { events } = await dispatch<EventsRes>(background, {
    kind: 'events/get',
    sessionId: started.session!.id,
  });
  expect(JSON.stringify(events)).not.toContain(CURSOR_OVERLAY_HOST_ID);
});

test('manages lifecycle across pause/resume, annotation mode, navigation, multi-tab isolation, repeated sessions, and reduced motion', async ({
  context,
  background,
}) => {
  const page = await context.newPage();
  await page.goto('/');
  const unrelatedTab = await context.newPage();
  await unrelatedTab.goto('/checkout.html');

  const tabId = await tabIdForUrl(background, 'http://localhost:5319/');

  // Session 1 with reduced motion.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const s1 = await dispatch<StartRes>(background, {
    kind: 'session/start',
    tabId,
    media: { video: true, mic: false },
    settings: { cursorSpotlight: true, clickHighlight: true },
  });
  expect(s1.ok).toBe(true);

  await expect.poll(async () => (await overlayState(page)).hostCount).toBe(1);
  // Unrelated tab must stay completely untouched.
  expect((await overlayState(unrelatedTab)).hostCount).toBe(0);

  // Reduced motion click uses non-expanding static animation.
  await page.click('#btn-get');
  const rmState = await overlayState(page);
  expect(rmState.rippleAnimationName).toBe('sr-click-static');
  await expect.poll(async () => (await overlayState(page)).rippleCount, { timeout: 2000 }).toBe(0);

  // Annotation mode suspends cursor overlay, exiting restores it.
  await dispatch(background, { kind: 'point-annotation/toggle', on: true });
  await expect.poll(async () => (await overlayState(page)).hostCount).toBe(0);
  await dispatch(background, { kind: 'point-annotation/toggle', on: false });
  await expect.poll(async () => (await overlayState(page)).hostCount).toBe(1);

  // Pause removes cursor overlay; moves/clicks while paused do not mount it.
  await dispatch(background, { kind: 'session/pause' });
  await expect.poll(async () => (await overlayState(page)).hostCount).toBe(0);
  await page.mouse.move(150, 150);
  await page.click('#btn-log');
  expect((await overlayState(page)).hostCount).toBe(0);

  // Resume restores cursor overlay.
  await dispatch(background, { kind: 'session/resume' });
  await expect.poll(async () => (await overlayState(page)).hostCount).toBe(1);

  // SPA navigation keeps overlay active.
  await page.evaluate(() => history.pushState({}, '', '/spa-step'));
  await page.mouse.move(210, 160);
  await expect.poll(async () => (await overlayState(page)).spotlightVisible).toBe(true);

  // Full-page navigation re-syncs overlay via content/hello.
  await page.goto('/checkout.html');
  await expect.poll(async () => (await overlayState(page)).hostCount).toBe(1);

  // Adopted popup inherits active cursor effects; stop removes from all tabs.
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.evaluate(() => window.open('/?pop=cursor', '_blank', 'noopener')),
  ]);
  await popup.waitForLoadState();
  await expect.poll(async () => (await overlayState(popup)).hostCount).toBe(1);

  await dispatch(background, { kind: 'session/stop' });
  await expect.poll(async () => (await overlayState(page)).hostCount).toBe(0);
  await expect.poll(async () => (await overlayState(popup)).hostCount).toBe(0);
  await popup.close();

  // Session 2 on same tab: no duplicate hosts or duplicate click events.
  await page.goto('/');
  const s2 = await dispatch<StartRes>(background, {
    kind: 'session/start',
    tabId,
    media: { video: true, mic: false },
    settings: { cursorSpotlight: false, clickHighlight: true },
  });
  expect(s2.ok).toBe(true);
  await expect.poll(async () => (await overlayState(page)).hostCount).toBe(1);

  await page.mouse.move(120, 120);
  await page.click('#btn-get');
  const s2State = await overlayState(page);
  expect(s2State.spotlightVisible).toBe(false);
  expect(s2State.rippleCount).toBe(1);

  await dispatch(background, { kind: 'session/stop' });
  await expect.poll(async () => (await overlayState(page)).hostCount).toBe(0);

  const { events } = await dispatch<EventsRes>(background, {
    kind: 'events/get',
    sessionId: s2.session!.id,
  });
  expect(events.filter((e) => e.type === 'click' && e.payload.descriptor?.id === 'btn-get')).toHaveLength(1);
});

test('cleans old instances on reinjection and extension reload', async ({ context, background }) => {
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<StartRes>(background, {
    kind: 'session/start', tabId, media: { video: true, mic: false }, settings: { cursorSpotlight: true, clickHighlight: true },
  });
  await page.fill('#f-user', 'edit pending during reinjection');
  for (let i = 0; i < 3; i++) {
    await background.evaluate(async (tabId) => {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content-scripts/interactions.js'] });
    }, tabId);
    await expect.poll(async () => (await overlayState(page)).hostCount).toBe(1);
  }
  await page.click('#btn-get');
  expect((await overlayState(page)).rippleCount).toBe(1);
  await page.waitForTimeout(1000);
  await dispatch(background, { kind: 'session/stop' });
  const { events } = await dispatch<EventsRes>(background, { kind: 'events/get', sessionId: started.session!.id });
  expect(events.filter((event) => event.type === 'click' && event.payload.descriptor?.id === 'btn-get')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'input' && event.payload.value === 'edit pending during reinjection')).toHaveLength(1);

  await dispatch(background, { kind: 'session/start', tabId, media: { video: true, mic: false }, settings: { cursorSpotlight: true, clickHighlight: true } });
  await expect.poll(async () => (await overlayState(page)).hostCount).toBe(1);
  // Existing documents outlive extension reload. Their old isolated-world overlay must disappear.
  await page.evaluate((id) => { (window as any).__oldCursorHost = document.getElementById(id); }, CURSOR_OVERLAY_HOST_ID);
  await background.evaluate(() => chrome.runtime.reload()).catch((error: Error) => {
    if (!/closed|destroyed|reload/i.test(error.message)) throw error;
  });
  await expect.poll(() => page.evaluate(() => (window as any).__oldCursorHost?.isConnected), { timeout: 5000 }).toBe(false);
  expect((await overlayState(page)).hostCount).toBeLessThanOrEqual(1);
});

test('verifies high-DPI positioning and real captured tabCapture WebM video contains cursor spotlight and click ripples', async ({}, testInfo) => {
  // Determine deterministic unpacked extension ID first.
  const probeCtx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  const probeSw = probeCtx.serviceWorkers()[0] || (await probeCtx.waitForEvent('serviceworker'));
  const extensionId = new URL(probeSw.url()).host;
  await probeCtx.close();

  // Relaunch with --allowlisted-extension-id so chrome.tabCapture works without manual toolbar gesture.
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    deviceScaleFactor: 2,
    viewport: { width: 800, height: 600 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      `--allowlisted-extension-id=${extensionId}`,
    ],
  });

  try {
    const sw: Worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
    const page = await ctx.newPage();
    await page.goto('http://localhost:5319/');
    expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
    // Keep the demo application intact. A neutral strip gives both recordings
    // the same pixel-sampling surface without confusing app colors with effects.
    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;right:0;top:0;width:160px;height:100vh;background:white;z-index:9999';
      document.body.append(probe);
    });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Demo');
    const tabId = await tabIdForUrl(sw, 'http://localhost:5319');

    async function sampleVideoRegion(
      sessionId: string,
      cx: number,
      cy: number,
      radius: number,
      artifactName: string,
    ): Promise<{
      videoWidth: number;
      videoHeight: number;
      maxBlueTint: number;
      minBrightness: number;
      framesSampled: number;
      maxControlBlueTint: number;
      screenshotBlueTint: number | null;
      videoAssetsStored: number;
    }> {
      // Read the recorded WebM video inside an extension page via IndexedDB -> <video> -> <canvas>.
      const viewer = await ctx.newPage();
      await viewer.goto(extUrl(extensionId, 'report.html?session=' + sessionId));
      const result = await viewer.evaluate(
        async ({ sessionId, cx, cy, radius }) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open('session-recorder');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const assets = await new Promise<any[]>((resolve, reject) => {
            const tx = db.transaction('assets', 'readonly');
            const idx = tx.objectStore('assets').index('by-session');
            const req = idx.getAll(sessionId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const events = await new Promise<any[]>((resolve, reject) => {
            const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
            const request = db.transaction('events', 'readonly').objectStore('events').index('by-session').getAll(range);
            request.onsuccess = () => resolve(request.result.sort((a, b) => a.t - b.t));
            request.onerror = () => reject(request.error);
          });
          db.close();
          const videos = assets.filter((a) => a.kind === 'video');
          // IndexedDB asset IDs are random; index order is not capture order.
          const lastVideo = events.filter((event) => event.type === 'video-segment').at(-1);
          const videoAsset = videos.find((asset) => asset.id === lastVideo?.payload.assetId);
          if (!videoAsset) throw new Error('No video asset stored');
          let screenshotBlueTint: number | null = null;
          const lastScreenshot = events.filter((event) => event.type === 'screenshot').at(-1);
          const screenshot = assets.find((asset) => asset.id === lastScreenshot?.payload.assetId);
          if (screenshot) {
            const bitmap = await createImageBitmap(screenshot.blob);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(bitmap, 0, 0);
            bitmap.close();
            const scale = canvas.width / 800;
            const pixels = context.getImageData(Math.round((cx - radius) * scale), Math.round((cy - radius) * scale),
              Math.round(radius * 2 * scale), Math.round(radius * 2 * scale)).data;
            screenshotBlueTint = -255;
            for (let i = 0; i < pixels.length; i += 4) screenshotBlueTint = Math.max(screenshotBlueTint, pixels[i + 2]! - pixels[i]!);
          }

          const url = URL.createObjectURL(videoAsset.blob);
          const video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.style.cssText = 'position:fixed;right:0;bottom:0;width:320px;height:240px;opacity:0.01;pointer-events:none;';
          document.body.append(video);
          video.src = url;
          await new Promise<void>((resolve, reject) => {
            video.oncanplay = () => resolve();
            video.onerror = () => reject(new Error('Video load failed'));
          });
          video.playbackRate = 0.25;

          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx2d = canvas.getContext('2d', { willReadFrequently: true })!;

          const scaleX = video.videoWidth / 800;
          const scaleY = video.videoHeight / 600;
          const sx = Math.max(0, Math.round((cx - radius) * scaleX));
          const sy = Math.max(0, Math.round((cy - radius) * scaleY));
          const sw = Math.min(canvas.width - sx, Math.round(radius * 2 * scaleX));
          const sh = Math.min(canvas.height - sy, Math.round(radius * 2 * scaleY));

          let maxBlueTint = -255;
          let minBrightness = 255;
          let framesSampled = 0;
          let maxControlBlueTint = -255;

          const sampleCurrentFrame = () => {
            if (video.videoWidth === 0 || video.videoHeight === 0) return;
            framesSampled += 1;
            ctx2d.drawImage(video, 0, 0);
            const data = ctx2d.getImageData(sx, sy, sw, sh).data;
            const control = ctx2d.getImageData(sx, Math.round((cy + 120) * scaleY), sw, sh).data;
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i]!;
              const g = data[i + 1]!;
              const b = data[i + 2]!;
              maxBlueTint = Math.max(maxBlueTint, b - r);
              minBrightness = Math.min(minBrightness, (r + g + b) / 3);
              maxControlBlueTint = Math.max(maxControlBlueTint, control[i + 2]! - control[i]!);
            }
          };

          await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              sampleCurrentFrame();
              resolve();
            };
            const onFrame = () => {
              if (done) return;
              sampleCurrentFrame();
              if (!video.ended && typeof (video as any).requestVideoFrameCallback === 'function') {
                (video as any).requestVideoFrameCallback(onFrame);
              }
            };
            video.addEventListener('ended', finish, { once: true });
            video.addEventListener('timeupdate', sampleCurrentFrame);
            if (typeof (video as any).requestVideoFrameCallback === 'function') {
              (video as any).requestVideoFrameCallback(onFrame);
            }
            setTimeout(finish, 6000);
            void video.play().catch(finish);
          });
          video.remove();
          URL.revokeObjectURL(url);
          return {
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            maxBlueTint,
            minBrightness,
            framesSampled,
            maxControlBlueTint,
            screenshotBlueTint,
            videoAssetsStored: videos.length,
            bytes: Array.from(new Uint8Array(await videoAsset.blob.arrayBuffer())),
            screenshotBytes: screenshot ? Array.from(new Uint8Array(await screenshot.blob.arrayBuffer())) : [],
          };
        },
        { sessionId, cx, cy, radius },
      );
      const { bytes, screenshotBytes, ...summary } = result;
      const output = testInfo.outputPath(`${artifactName}.webm`);
      await writeFile(output, new Uint8Array(bytes));
      await testInfo.attach(artifactName, { path: output, contentType: 'video/webm' });
      if (artifactName === 'cursor-spotlight' && screenshotBytes.length) {
        await writeFile(testInfo.outputPath('cursor-spotlight.jpg'), new Uint8Array(screenshotBytes));
      }
      if (artifactName === 'click-highlight') {
        // Use the report's real export button and prove that the captured bytes
        // survive packaging, rather than asserting only that a video path exists.
        await viewer.evaluate(() => {
          (window as any).__cursorZip = null;
          chrome.downloads.download = (async (options: { url: string }) => {
            (window as any).__cursorZip = Array.from(new Uint8Array(await (await fetch(options.url)).arrayBuffer()));
            return 1;
          }) as typeof chrome.downloads.download;
        });
        await viewer.getByRole('button', { name: 'Full', exact: true }).click();
        await viewer.getByRole('button', { name: /Download .zip/i }).click();
        await viewer.waitForFunction(() => (window as any).__cursorZip !== null);
        const zip = new Uint8Array(await viewer.evaluate(() => (window as any).__cursorZip as number[]));
        const files = unzipSync(zip);
        const videos = Object.entries(files).filter(([name]) => name.endsWith('.webm'));
        expect(videos).toHaveLength(3);
        expect(videos.some(([, video]) => Buffer.from(video).equals(Buffer.from(bytes)))).toBe(true);
        await writeFile(testInfo.outputPath('cursor-effects-export.zip'), zip);
      }
      console.log(`${artifactName}: ${JSON.stringify(summary)}`);
      await viewer.close();
      return summary;
    }

    // 1) Baseline disabled video: no blue cursor halo or ripple pixels in captured WebM.
    await page.bringToFront();
    const baseStart = await dispatch<StartRes>(sw, {
      kind: 'session/start',
      tabId,
      settings: { cursorSpotlight: false, clickHighlight: false },
    });
    expect(await dispatch<{ ok: boolean }>(sw, { kind: 'video/toggle', on: true })).toMatchObject({ ok: true });
    await page.mouse.move(720, 220);
    await page.mouse.click(720, 220);
    await page.waitForTimeout(500);
    await dispatch(sw, { kind: 'session/stop' });
    const baseSample = await sampleVideoRegion(baseStart.session!.id, 720, 220, 40, 'cursor-disabled');
    expect(baseSample.videoWidth).toBeGreaterThan(0);
    expect(baseSample.framesSampled).toBeGreaterThan(2);
    expect(baseSample.maxBlueTint).toBeLessThan(6);
    expect(baseSample.minBrightness).toBeGreaterThan(240);

    // 2) Spotlight enabled video (2x high-DPI): halo at the pointer, clear control region.
    await page.bringToFront();
    const spotStart = await dispatch<StartRes>(sw, {
      kind: 'session/start',
      tabId,
      settings: { cursorSpotlight: true, clickHighlight: false },
    });
    expect(await dispatch<{ ok: boolean }>(sw, { kind: 'video/toggle', on: true })).toMatchObject({ ok: true });
    await page.mouse.move(720, 220);
    await page.waitForTimeout(700);
    await dispatch(sw, { kind: 'screenshot/capture' });
    await dispatch(sw, { kind: 'session/stop' });
    const spotSample = await sampleVideoRegion(spotStart.session!.id, 720, 220, 45, 'cursor-spotlight');
    expect(spotSample.framesSampled).toBeGreaterThan(2);
    expect(spotSample.maxBlueTint).toBeGreaterThanOrEqual(10);
    expect(spotSample.minBrightness).toBeLessThan(240);
    expect(spotSample.maxControlBlueTint).toBeLessThan(6);
    expect(spotSample.screenshotBlueTint, 'actual screenshot capture contains the halo').not.toBeNull();
    expect(spotSample.screenshotBlueTint!).toBeGreaterThanOrEqual(10);

    // 3) Click highlight enabled video: ripple at the click, clear control region.
    await page.bringToFront();
    const clickStart = await dispatch<StartRes>(sw, {
      kind: 'session/start',
      tabId,
      settings: { cursorSpotlight: false, clickHighlight: true },
    });
    expect(await dispatch<{ ok: boolean }>(sw, { kind: 'video/toggle', on: true })).toMatchObject({ ok: true });
    await page.waitForTimeout(450);
    await page.mouse.click(720, 220);
    await page.waitForTimeout(550);
    await dispatch(sw, { kind: 'video/toggle', on: false });
    expect((await overlayState(page)).hostCount).toBe(0);
    expect(await dispatch<{ ok: boolean }>(sw, { kind: 'video/toggle', on: true })).toMatchObject({ ok: true });
    await page.mouse.click(720, 220);
    await page.waitForTimeout(550);
    await dispatch(sw, { kind: 'session/pause' });
    await expect.poll(async () => (await overlayState(page)).hostCount).toBe(0);
    await dispatch(sw, { kind: 'session/resume' });
    await expect.poll(async () => (await overlayState(page)).hostCount).toBe(1);
    await page.mouse.click(720, 220);
    await page.waitForTimeout(550);
    await dispatch(sw, { kind: 'session/stop' });
    const clickSample = await sampleVideoRegion(clickStart.session!.id, 720, 220, 45, 'click-highlight');
    expect(clickSample.framesSampled).toBeGreaterThan(2);
    expect(clickSample.maxBlueTint).toBeGreaterThanOrEqual(12);
    expect(clickSample.minBrightness).toBeLessThan(235);
    expect(clickSample.maxControlBlueTint).toBeLessThan(6);
    expect(clickSample.videoAssetsStored).toBe(3);
  } finally {
    await ctx.close();
  }
});
