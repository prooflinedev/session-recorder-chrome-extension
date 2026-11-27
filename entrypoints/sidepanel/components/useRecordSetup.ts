import { useEffect, useReducer, useRef } from 'react';
import { detailIndexFromSettings, settingsForDetail } from '@/lib/session/settings';
import {
  loadDefaultSettings,
  loadMicFromStart,
  loadVideoFromStart,
  saveCaptureApiSpec,
  saveCaptureDetail,
  saveClickHighlight,
  saveCursorSpotlight,
  saveMicFromStart,
  saveVideoFromStart,
  useSidepanel,
} from '../store';
import { isTranscriptionConfigured } from './VoiceSetupModal';
interface State {
  ready: boolean;
  busy: boolean;
  localError?: string;
  detail: number;
  videoFromStart: boolean;
  micFromStart: boolean;
  apiSpec: boolean;
  cursorSpotlight: boolean;
  clickHighlight: boolean;
  open: boolean;
  voiceSetupOpen: boolean;
}
const initial: State = {
  ready: false,
  busy: false,
  detail: 2,
  videoFromStart: false,
  micFromStart: false,
  apiSpec: false,
  cursorSpotlight: false,
  clickHighlight: false,
  open: false,
  voiceSetupOpen: false,
};
export function useRecordSetup() {
  const startRecording = useSidepanel((s) => s.startRecording);
  const [state, update] = useReducer(
    (state: State, patch: Partial<State>) => ({ ...state, ...patch }),
    initial,
  );
  const {
    busy,
    localError,
    detail,
    videoFromStart,
    micFromStart,
    apiSpec,
    cursorSpotlight,
    clickHighlight,
    open,
    voiceSetupOpen,
  } = state;
  const setBusy = (busy: boolean) => update({ busy });
  const setLocalError = (localError: string | undefined) => update({ localError });
  const setDetail = (detail: number) => update({ detail });
  const setVideoFromStart = (videoFromStart: boolean) => update({ videoFromStart });
  const setMicFromStart = (micFromStart: boolean) => update({ micFromStart });
  const setApiSpec = (apiSpec: boolean) => update({ apiSpec });
  const setCursorSpotlight = (cursorSpotlight: boolean) => update({ cursorSpotlight });
  const setClickHighlight = (clickHighlight: boolean) => update({ clickHighlight });
  const setOpen = (open: boolean) => update({ open });
  const setVoiceSetupOpen = (voiceSetupOpen: boolean) => update({ voiceSetupOpen });
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      loadDefaultSettings(),
      loadVideoFromStart(),
      loadMicFromStart(),
    ]).then(([s, video, mic]) => {
      if (cancelled) return;
      setDetail(detailIndexFromSettings(s));
      setApiSpec(s.captureApiSpec);
      setCursorSpotlight(s.cursorSpotlight);
      setClickHighlight(s.clickHighlight);
      setVideoFromStart(video);
      setMicFromStart(mic);
      update({ ready: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close the popover on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const record = async () => {
    if (busy || !state.ready) return;
    // Mic will start with the session but no transcription provider is set up
    // yet: offer voice setup BEFORE recording begins. `start()` below re-runs
    // once the modal resolves.
    if (micFromStart && !(await isTranscriptionConfigured())) {
      setVoiceSetupOpen(true);
      return;
    }
    await start();
  };

  const start = async () => {
    if (busy || !state.ready) return;
    setBusy(true);
    setLocalError(undefined);
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (typeof tabId !== 'number') {
        setLocalError('No active tab to record.');
        return;
      }
      // Pass the choices explicitly: the storage writes are async, so the
      // override is what makes a quick change-then-Record race-free.
      // Media choices travel with Start too: persistence can still be pending.
      const res = await startRecording(tabId, {
        ...(settingsForDetail(detail) ?? {}),
        captureApiSpec: apiSpec,
        cursorSpotlight,
        clickHighlight,
      }, { video: videoFromStart, mic: micFromStart });
      if (!res.ok) {
        setLocalError(res.error ?? 'Could not start recording.');
        return;
      }
    } finally {
      setBusy(false);
    }
  };

  const onDetail = (value: number) => {
    setDetail(value);
    void saveCaptureDetail(value);
  };

  const onVideo = (on: boolean) => {
    setVideoFromStart(on);
    void saveVideoFromStart(on);
  };

  const onMicFromStart = (on: boolean) => {
    setMicFromStart(on);
    void saveMicFromStart(on);
  };

  const onApiSpec = (on: boolean) => {
    setApiSpec(on);
    void saveCaptureApiSpec(on);
  };

  const onCursorSpotlight = (on: boolean) => {
    setCursorSpotlight(on);
    void saveCursorSpotlight(on);
  };

  const onClickHighlight = (on: boolean) => {
    setClickHighlight(on);
    void saveClickHighlight(on);
  };

  return {
    ...state,
    wrapRef,
    record,
    start,
    onDetail,
    onVideo,
    onMicFromStart,
    onApiSpec,
    onCursorSpotlight,
    onClickHighlight,
    setVoiceSetupOpen,
    toggleOptions: () => setOpen(!open),
  };
}
