import { normalizeCaptureSettings, STORAGE_KEYS } from './settings';
import type { CaptureSettings } from './types';

/** Serialize read/modify/write across side panels and the options page. */
export async function patchDefaultSettings(patch: Partial<CaptureSettings>): Promise<void> {
  await navigator.locks.request('session-recorder-default-settings', async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.defaultSettings);
    const current = normalizeCaptureSettings(stored[STORAGE_KEYS.defaultSettings]);
    await chrome.storage.local.set({
      [STORAGE_KEYS.defaultSettings]: { ...current, ...patch },
    });
  });
}
