import { useEffect, useReducer, useRef } from 'react';
import type { CaptureSettings, Session } from '@/lib/session/types';
import {
  STORAGE_KEYS,
  makeDefaultSettings,
  normalizeCaptureSettings,
} from '@/lib/session/settings';
import { PROVIDERS, transcribe, type TranscriptionConfig } from '@/lib/transcription';
import { patchDefaultSettings } from '@/lib/session/settings-storage';
import { deleteSession, listSessions, storageEstimate } from '@/lib/storage';
import { parseLines, silentWavBlob } from './settings-utils';

type RedactionDraft = { headers: string; bodyKeys: string; urlParams: string };
interface State {
  loaded: boolean;
  busy: boolean;
  error: string;
  saved: Record<string, boolean>;
  tx: TranscriptionConfig;
  settings: CaptureSettings;
  videoFromStart: boolean;
  redaction: RedactionDraft;
  storage: { usage: number; quota: number };
  sessions: Session[];
  testState: { status: 'idle' | 'testing' | 'ok' | 'error'; message: string };
}
type Action =
  | { type: 'loaded'; tx: TranscriptionConfig; settings: CaptureSettings; videoFromStart: boolean }
  | { type: 'video'; on: boolean }
  | { type: 'tx'; patch: Partial<TranscriptionConfig> }
  | { type: 'settings'; patch: Partial<CaptureSettings> }
  | { type: 'redaction'; patch: Partial<RedactionDraft> }
  | { type: 'storage'; storage: State['storage']; sessions: Session[] }
  | { type: 'busy'; busy: boolean }
  | { type: 'saved'; section: string }
  | { type: 'error'; message: string }
  | { type: 'test'; result: State['testState'] };
function initial(): State {
  return {
    loaded: false,
    busy: false,
    error: '',
    saved: {},
    tx: { provider: 'openai', apiKey: '' },
    settings: makeDefaultSettings(),
    videoFromStart: false,
    redaction: { headers: '', bodyKeys: '', urlParams: '' },
    storage: { usage: 0, quota: 0 },
    sessions: [],
    testState: { status: 'idle', message: '' },
  };
}
export function captureSettingsReducer(s: State, a: Action): State {
  switch (a.type) {
    case 'loaded': {
      const r = a.settings.customRedaction;
      return {
        ...s,
        loaded: true,
        tx: a.tx,
        settings: a.settings,
        videoFromStart: a.videoFromStart,
        redaction: {
          headers: r.headerNames.join('\n'),
          bodyKeys: r.bodyKeyPatterns.join('\n'),
          urlParams: r.urlParamPatterns.join('\n'),
        },
      };
    }
    case 'video':
      return { ...s, videoFromStart: a.on };
    case 'tx':
      return {
        ...s,
        tx: { ...s.tx, ...a.patch },
        saved: { ...s.saved, transcription: false },
        testState: { status: 'idle', message: '' },
      };
    case 'settings':
      return {
        ...s,
        settings: { ...s.settings, ...a.patch },
        saved: { ...s.saved, capture: false, redaction: false },
      };
    case 'redaction':
      return {
        ...s,
        redaction: { ...s.redaction, ...a.patch },
        saved: { ...s.saved, redaction: false },
      };
    case 'storage':
      return { ...s, storage: a.storage, sessions: a.sessions };
    case 'busy':
      return { ...s, busy: a.busy, error: a.busy ? '' : s.error };
    case 'saved':
      return { ...s, saved: { ...s.saved, [a.section]: true } };
    case 'error':
      return { ...s, error: a.message };
    case 'test':
      return { ...s, testState: a.result };
  }
}
export function useCaptureSettings() {
  const [state, dispatch] = useReducer(captureSettingsReducer, undefined, initial);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    void Promise.all([
      chrome.storage.local.get([
        STORAGE_KEYS.transcription,
        STORAGE_KEYS.defaultSettings,
        STORAGE_KEYS.videoFromStart,
      ]),
      storageEstimate(),
      listSessions(),
    ])
      .then(([stored, storage, sessions]) => {
        if (!active) return;
        const settings = normalizeCaptureSettings(
          stored[STORAGE_KEYS.defaultSettings] as Partial<CaptureSettings> | undefined,
        );
        dispatch({
          type: 'loaded',
          settings,
          videoFromStart: stored[STORAGE_KEYS.videoFromStart] === true,
          tx: { provider: 'openai', apiKey: '', ...stored[STORAGE_KEYS.transcription] },
        });
        dispatch({ type: 'storage', storage, sessions });
      })
      .catch(() => {
        if (active)
          dispatch({
            type: 'error',
            message: 'Could not load settings. Reload this page.',
          });
      });
    const onStorageChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[STORAGE_KEYS.videoFromStart]) {
        dispatch({ type: 'video', on: changes[STORAGE_KEYS.videoFromStart]!.newValue === true });
      }
    };
    chrome.storage.onChanged.addListener(onStorageChange);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onStorageChange);
    };
  }, []);
  const providerMeta = PROVIDERS.find((p) => p.id === state.tx.provider);
  async function run(task: () => Promise<void>) {
    if (lock.current || !state.loaded) return;
    lock.current = true;
    dispatch({ type: 'busy', busy: true });
    try {
      await task();
    } catch (e) {
      dispatch({
        type: 'error',
        message: e instanceof Error ? e.message : 'Could not save settings.',
      });
    } finally {
      lock.current = false;
      dispatch({ type: 'busy', busy: false });
    }
  }
  async function refreshStorage() {
    const [storage, sessions] = await Promise.all([storageEstimate(), listSessions()]);
    dispatch({ type: 'storage', storage, sessions });
  }
  return {
    state,
    providerMeta,
    usagePct: state.storage.quota
      ? Math.min(100, (state.storage.usage / state.storage.quota) * 100)
      : 0,
    actions: {
      patchTx: (patch: Partial<TranscriptionConfig>) => dispatch({ type: 'tx', patch }),
      patchSettings: (patch: Partial<CaptureSettings>) =>
        dispatch({ type: 'settings', patch }),
      patchRedaction: (patch: Partial<RedactionDraft>) =>
        dispatch({ type: 'redaction', patch }),
      refreshStorage: () => run(refreshStorage),
      saveTranscription: () =>
        run(async () => {
          await chrome.storage.local.set({ [STORAGE_KEYS.transcription]: state.tx });
          dispatch({ type: 'saved', section: 'transcription' });
        }),
      persistSettings: (section: string) =>
        run(async () => {
          const customRedaction = {
            headerNames: parseLines(state.redaction.headers).map((h) =>
              h.toLowerCase(),
            ),
            bodyKeyPatterns: parseLines(state.redaction.bodyKeys),
            urlParamPatterns: parseLines(state.redaction.urlParams),
          };
          for (const pattern of [
            ...customRedaction.bodyKeyPatterns,
            ...customRedaction.urlParamPatterns,
          ])
            new RegExp(pattern, 'i');
          const { redactionEnabled, customRedaction: _redaction, ...capture } = state.settings;
          const patch =
            section === 'redaction'
              ? {
                  redactionEnabled,
                  customRedaction,
                }
              : capture;
          await patchDefaultSettings(patch);
          dispatch({ type: 'saved', section });
        }),
      runTest: () =>
        run(async () => {
          dispatch({ type: 'test', result: { status: 'testing', message: '' } });
          try {
            const result = await transcribe(silentWavBlob(), {
              ...state.tx,
              baseUrl: state.tx.baseUrl?.trim() || providerMeta?.defaultBaseUrl,
              model: state.tx.model?.trim() || providerMeta?.defaultModel,
              language: state.tx.language?.trim() || undefined,
            });
            dispatch({
              type: 'test',
              result: {
                status: 'ok',
                message: result.text?.trim()
                  ? `Success: transcript "${result.text.trim()}"`
                  : 'Success: provider reachable (empty transcript for silence).',
              },
            });
          } catch (e) {
            dispatch({
              type: 'test',
              result: {
                status: 'error',
                message: e instanceof Error ? e.message : 'Provider test failed.',
              },
            });
          }
        }),
      deleteAllSessions: () =>
        run(async () => {
          if (
            !state.sessions.length ||
            !window.confirm(
              `Delete all ${state.sessions.length} recorded session(s)? This cannot be undone.`,
            )
          )
            return;
          for (const session of state.sessions) {
            if (session.status !== 'stopped')
              throw new Error('Stop the current recording before deleting sessions.');
          }
          for (const session of state.sessions) await deleteSession(session.id);
          await refreshStorage();
        }),
    },
  };
}
