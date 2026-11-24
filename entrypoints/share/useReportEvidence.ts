import { useEffect, useReducer } from 'react';
import { getAssets, getEvents } from '@/lib/storage';
import { onBroadcast } from '@/lib/messaging';
import type { SessionEvent } from '@/lib/session/types';

export interface EvidenceItem {
  id: string;
  time: number;
  label: string;
  image?: string;
  comments: string[];
}
interface State {
  items: EvidenceItem[];
  diagnostics: SessionEvent[];
  error: string;
}
type Action =
  | { type: 'loaded'; items: EvidenceItem[]; diagnostics: SessionEvent[] }
  | { type: 'error'; message: string };
const initial: State = { items: [], diagnostics: [], error: '' };
function reducer(state: State, action: Action): State {
  return action.type === 'loaded'
    ? { ...initial, items: action.items, diagnostics: action.diagnostics }
    : { ...state, error: action.message };
}
/** Owns the lifetime of local attachment URLs; no image leaves this browser. */
export function useReportEvidence(sessionId: string) {
  const [state, dispatch] = useReducer(reducer, initial);
  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    const refresh = async () => {
      const [events, assets] = await Promise.all([getEvents(sessionId), getAssets(sessionId)]);
      if (!active) return;
      urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
      const images = new Map(assets.filter((a) => a.mime.startsWith('image/')).map((asset) => {
        const url = URL.createObjectURL(asset.blob);
        urls.push(url);
        return [asset.id, url] as const;
      }));
      const items: EvidenceItem[] = [];
      for (const event of events) {
        if (event.type === 'annotation') {
          items.push({ id: event.id, time: event.t, label: 'Annotation', image: images.get(event.payload.screenshotAssetId ?? ''), comments: event.payload.shapes.flatMap((s) => (s.text ? [s.text] : [])) });
        } else if (event.type === 'screenshot') {
          items.push({ id: event.id, time: event.t, label: 'Screenshot', image: images.get(event.payload.assetId), comments: [] });
        } else if (event.type === 'note') {
          items.push({ id: event.id, time: event.t, label: 'Note', comments: [event.payload.text] });
        }
      }
      dispatch({ type: 'loaded', items, diagnostics: events.filter((e) => ['error', 'console', 'net-request'].includes(e.type)) });
    };
    void refresh().catch((error) => {
      if (active) dispatch({ type: 'error', message: error instanceof Error ? error.message : 'Could not load evidence.' });
    });
    const unsubscribe = onBroadcast((event) => {
      if (event.kind === 'asset/redaction-updated' && event.sessionId === sessionId)
        void refresh().catch(() => {});
    });
    return () => {
      active = false;
      unsubscribe();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [sessionId]);
  return state;
}
