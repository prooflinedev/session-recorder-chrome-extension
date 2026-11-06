import type { FilingStage } from '@/lib/sharing/file-issue';
import type { Session, VerbosityLevel } from '@/lib/session/types';
import type { ExportFile } from '@/lib/export/bundle';
import { defaultSharingSettings, preferredRepository, type SharingSettings } from '@/lib/sharing/settings';
import { initialDraft, type Publication, type SavedDraft } from '@/lib/sharing/draft';
import type { IssueDraft } from '@/lib/sharing/summary';

export interface ShareState {
  summaryRequestId?: string;
  session?: Session;
  settings: SharingSettings;
  level: VerbosityLevel;
  files: ExportFile[];
  evidence: string;
  draft: IssueDraft;
  repository: string;
  publication?: Publication;
  loading: boolean;
  preparing: boolean;
  operation: 'idle' | 'summary' | 'publish' | 'check' | 'delete' | 'github' | 'copy';
  phase: string;
  stage: FilingStage;
  cancelling: boolean;
  error: string;
  draftSource: 'initial' | 'title-edited' | 'edited' | 'generated';
  issue?: SavedDraft['issue'];
  attempt?: SavedDraft['attempt'];
  confirmingDelete: boolean;
}
export type ShareAction =
  | { type: 'loaded'; session: Session; settings: SharingSettings; saved?: SavedDraft }
  | { type: 'settings'; settings: SharingSettings }
  | { type: 'prepare'; level: VerbosityLevel }
  | { type: 'prepared'; files: ExportFile[]; evidence: string }
  | { type: 'draft'; draft: IssueDraft; source?: ShareState['draftSource'] }
  | { type: 'saved'; saved: SavedDraft }
  | { type: 'repository'; repository: string }
  | { type: 'confirm-delete'; confirming: boolean }
  | { type: 'start'; operation: ShareState['operation'] }
  | { type: 'progress'; message: string }
  | { type: 'stage'; stage: FilingStage }
  | { type: 'cancel' }
  | { type: 'error'; message: string }
  | { type: 'finish' }
  | { type: 'publication'; publication?: Publication };

export function initialShareState(level: VerbosityLevel): ShareState {
  return {
    settings: defaultSharingSettings(),
    level,
    files: [],
    evidence: '',
    draft: { title: '', body: '' },
    repository: '',
    loading: true,
    preparing: false,
    operation: 'idle',
    phase: '',
    stage: 'connection',
    cancelling: false,
    error: '',
    draftSource: 'initial',
    confirmingDelete: false,
  };
}

export function shareReducer(state: ShareState, action: ShareAction): ShareState {
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        session: action.session,
        settings: action.settings,
        loading: false,
        preparing: true,
        draft: action.saved?.draft ?? initialDraft(action.session.name),
        repository: action.saved?.issue?.repository ?? action.saved?.attempt?.repository ?? (action.saved?.repository || preferredRepository(action.settings)),
        publication: action.saved?.publication,
        summaryRequestId: action.saved?.summaryRequestId,
        issue: action.saved?.issue,
        attempt: action.saved?.attempt,
        draftSource: action.saved?.draftSource ?? (action.saved ? 'edited' : 'initial'),
        level: action.saved?.publication?.level ?? state.level,
      };
    case 'settings':
      return { ...state, settings: action.settings, repository: state.repository || preferredRepository(action.settings) };
    case 'prepare':
      return {
        ...state,
        level: action.level,
        files: [],
        preparing: true,
        error: '',
      };
    case 'prepared':
      return {
        ...state,
        files: action.files,
        evidence: action.evidence,
        preparing: false,
      };
    case 'draft':
      return { ...state, draft: action.draft, draftSource: action.source ?? 'edited' };
    case 'saved':
      return {
        ...state,
        ...action.saved,
        draftSource: action.saved.draftSource ?? 'edited',
      };
    case 'repository':
      if (state.operation !== 'idle' || state.attempt || state.issue) return state;
      return { ...state, repository: action.repository };
    case 'confirm-delete':
      return { ...state, confirmingDelete: action.confirming };
    case 'start':
      return { ...state, operation: action.operation, cancelling: false, stage: 'connection', error: '', phase: 'Preparing…' };
    case 'stage':
      return { ...state, stage: action.stage };
    case 'cancel':
      return { ...state, cancelling: true, phase: 'Cancelling…' };
    case 'progress':
      return state.cancelling ? state : { ...state, phase: action.message };
    case 'error':
      return {
        ...state,
        error: action.message,
        phase: '',
        loading: false,
        preparing: false,
      };
    case 'finish':
      return { ...state, operation: 'idle', cancelling: false };
    case 'publication':
      return {
        ...state,
        publication: action.publication,
        confirmingDelete: false,
      };
  }
}
