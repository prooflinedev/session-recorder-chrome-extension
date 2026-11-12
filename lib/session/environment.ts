/**
 * Where a session was recorded, so a report says which browser, OS and
 * viewport the bug happened in instead of leaving the reader to ask.
 */

import type { SessionEnvironment } from './types';

export interface BrandVersion {
  brand: string;
  version: string;
}

/**
 * Client Hints list several brands for one browser: a deliberately fake
 * "Not A Brand" entry, the Chromium engine, and the product itself. The
 * product is the one worth reporting, with the engine as a fallback.
 */
export function browserName(brands: readonly BrandVersion[]): string | undefined {
  const real = brands.filter(({ brand }) => !/not.?a.?brand/i.test(brand));
  const pick = real.find(({ brand }) => brand !== 'Chromium') ?? real[0];
  return pick ? `${pick.brand} ${pick.version}` : undefined;
}

/** One line for the report header. */
export function describeEnvironment(env: SessionEnvironment): string {
  const viewport = env.viewport
    ? `viewport ${env.viewport.width}×${env.viewport.height} @${env.viewport.devicePixelRatio}x`
    : undefined;
  return [env.browser, env.os, viewport, env.locale, env.timeZone]
    .filter((part): part is string => !!part)
    .join(' · ');
}

interface UADataValues {
  platform?: string;
  platformVersion?: string;
  architecture?: string;
  fullVersionList?: BrandVersion[];
}

interface NavigatorUAData {
  brands: BrandVersion[];
  platform: string;
  getHighEntropyValues(hints: string[]): Promise<UADataValues>;
}

/**
 * Reads the environment from the service worker and, for the viewport, from
 * the recorded tab. Never throws: a field that cannot be read is left out.
 */
export async function collectEnvironment(tabId: number): Promise<SessionEnvironment> {
  const env: SessionEnvironment = {
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  try {
    const ua = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData;
    if (ua) {
      const hints = await ua.getHighEntropyValues([
        'architecture',
        'fullVersionList',
        'platformVersion',
      ]);
      env.browser = browserName(hints.fullVersionList ?? ua.brands);
      env.os =
        [hints.platform ?? ua.platform, hints.platformVersion, hints.architecture]
          .filter(Boolean)
          .join(' ') || undefined;
    } else {
      env.browser = navigator.userAgent;
    }
  } catch {
    /* Client Hints are optional */
  }
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ width: innerWidth, height: innerHeight, devicePixelRatio }),
    });
    if (frame?.result) env.viewport = frame.result;
  } catch {
    /* restricted page (chrome://, the web store): no viewport */
  }
  return env;
}
