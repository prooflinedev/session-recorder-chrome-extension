import type { ElementDescriptor, Point, Rect } from '@/lib/session/types';

export type AnnotationSelection =
  | { kind: 'element'; target: Element; descriptor: ElementDescriptor }
  | { kind: 'region'; rect: Rect; scroll: Point };
export interface SavedPointComment {
  selection: AnnotationSelection;
  text: string;
}
export interface PointAnnotationState {
  selection?: AnnotationSelection;
  text: string;
  status: 'picking' | 'editing' | 'saving';
  message: string;
  comments: SavedPointComment[];
  dictating: boolean;
  /** Dictated speech for this comment is still being transcribed. */
  transcribing: boolean;
}
export type PointAnnotationAction =
  | { type: 'select'; selection: AnnotationSelection }
  | { type: 'text'; text: string }
  | { type: 'pick' }
  | { type: 'save' }
  | { type: 'saved' }
  | { type: 'dictate'; active: boolean }
  | { type: 'transcribing'; pending: boolean }
  | { type: 'error'; message: string };
export const initialPointAnnotationState: PointAnnotationState = {
  text: '',
  status: 'picking',
  message: '',
  comments: [],
  dictating: false,
  transcribing: false,
};
export function pointAnnotationReducer(
  state: PointAnnotationState,
  action: PointAnnotationAction,
): PointAnnotationState {
  switch (action.type) {
    case 'select':
      return { ...state, selection: action.selection, status: 'editing', message: '' };
    case 'text':
      return { ...state, text: action.text.slice(0, 4000), message: '' };
    case 'pick':
      return {
        ...state,
        selection: undefined,
        text: '',
        status: 'picking',
        dictating: false,
        transcribing: false,
        message: '',
      };
    case 'save':
      return { ...state, status: 'saving', dictating: false, transcribing: false, message: '' };
    case 'saved':
      return {
        ...initialPointAnnotationState,
        comments: state.selection
          ? [...state.comments, { selection: state.selection, text: state.text }]
          : state.comments,
        message: 'Comment added to the recording.',
      };
    case 'dictate':
      return { ...state, dictating: action.active };
    case 'transcribing':
      return { ...state, transcribing: action.pending && state.status === 'editing' };
    case 'error':
      return { ...state, status: 'editing', dictating: false, message: action.message };
  }
}
export function selectionRect(selection: AnnotationSelection): Rect | undefined {
  if (selection.kind === 'region')
    return {
      ...selection.rect,
      x: selection.rect.x + selection.scroll.x - scrollX,
      y: selection.rect.y + selection.scroll.y - scrollY,
    };
  if (!selection.target.isConnected) return;
  const r = selection.target.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}
export function dragRect(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.abs(end.x - start.x),
    h: Math.abs(end.y - start.y),
  };
}
