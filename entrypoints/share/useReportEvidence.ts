import { useEffect, useReducer } from 'react';
import { getAssets, getEvents } from '@/lib/storage';
import type { SessionEvent } from '@/lib/session/types';

export interface EvidenceItem {
  id: string;
  time: number;
  label: string;
  image?: string;
  comments: string[];
}
interface State {
  loading: boolean;
  items: EvidenceItem[];
  diagnostics: SessionEvent[];
  error: string;
}
type Action =
  | { type: 'loaded'; items: EvidenceItem[]; diagnostics: SessionEvent[] }
  | { type: 'error'; message: string };
const initial: State = { loading: true, items: [], diagnostics: [], error: '' };
function reducer(state: State, action: Action): State {
  return action.type === 'loaded'
    ? { ...initial, loading: false, items: action.items, diagnostics: action.diagnostics }
    : { ...state, loading: false, error: action.message };
}
/** Owns the lifetime of local attachment URLs; no image leaves this browser. */
export function useReportEvidence(sessionId: string) {
  const [state, dispatch] = useReducer(reducer, initial);
  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    void Promise.all([getEvents(sessionId), getAssets(sessionId)])
      .then(([events, assets]) => {
        if (!active) return;
        const images = new Map(
          assets
            .filter((a) => a.mime.startsWith('image/'))
            .map((a) => {
              const url = URL.createObjectURL(a.blob);
              urls.push(url);
              return [a.id, url];
            }),
        );
        const items: EvidenceItem[] = [];
        for (const event of events) {
          if (event.type === 'annotation') {
            items.push({
              id: event.id,
              time: event.t,
              label: 'Annotation',
              image: images.get(event.payload.screenshotAssetId ?? ''),
              comments: event.payload.shapes.flatMap((s) => (s.text ? [s.text] : [])),
            });
          } else if (event.type === 'screenshot') {
            items.push({
              id: event.id,
              time: event.t,
              label: 'Screenshot',
              image: images.get(event.payload.assetId),
              comments: [],
            });
          } else if (event.type === 'note') {
            items.push({
              id: event.id,
              time: event.t,
              label: 'Note',
              comments: [event.payload.text],
            });
          }
        }
        dispatch({
          type: 'loaded',
          items,
          diagnostics: events.filter((e) =>
            ['error', 'console', 'net-request'].includes(e.type),
          ),
        });
      })
      .catch((error) => {
        if (active)
          dispatch({
            type: 'error',
            message:
              error instanceof Error ? error.message : 'Could not load evidence.',
          });
      });
    return () => {
      active = false;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [sessionId]);
  return state;
}
