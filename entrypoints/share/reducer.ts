import type { FilingStage } from '@/lib/sharing/file-issue';
import type { Session, VerbosityLevel } from '@/lib/session/types';
import type { ExportFile } from '@/lib/export/bundle';
import { defaultSharingSettings, preferredRepository, type SharingSettings } from '@/lib/sharing/settings';
import { initialDraft, type AddToTarget, type Publication, type SavedDraft } from '@/lib/sharing/draft';
import type { IssueDraft } from '@/lib/sharing/summary';
import { triageFor, withTriage, type TriageDefaults } from '@/lib/sharing/triage';
import type { ErrorFingerprint } from '@/lib/sharing/fingerprint';
import type { DuplicateMatches } from '@/lib/sharing/duplicates';

export interface DuplicateState extends DuplicateMatches {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** The repository searched; results for another repository are dropped. */
  repository: string;
  error: string;
}
const noDuplicates: DuplicateState = {
  status: 'idle',
  repository: '',
  exact: [],
  related: [],
  error: '',
};

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
  labels: string[];
  assignees: string[];
  triageDefaults: TriageDefaults;
  fingerprint?: ErrorFingerprint;
  duplicates: DuplicateState;
  /** The existing issue chosen with "Add to #N". */
  addTo?: AddToTarget;
}
export type ShareAction =
  | {
      type: 'loaded';
      session: Session;
      settings: SharingSettings;
      saved?: SavedDraft;
      triageDefaults?: TriageDefaults;
    }
  | { type: 'settings'; settings: SharingSettings }
  | { type: 'prepare'; level: VerbosityLevel }
  | { type: 'prepared'; files: ExportFile[]; evidence: string }
  | { type: 'draft'; draft: IssueDraft; source?: ShareState['draftSource'] }
  | { type: 'saved'; saved: SavedDraft }
  | { type: 'repository'; repository: string }
  | { type: 'triage'; labels: string[]; assignees: string[] }
  | { type: 'fingerprint'; fingerprint?: ErrorFingerprint }
  | { type: 'duplicates-loading'; repository: string }
  | { type: 'duplicates-reset' }
  | { type: 'duplicates-ready'; repository: string; matches: DuplicateMatches }
  | { type: 'duplicates-failed'; repository: string; message: string }
  | { type: 'add-to'; target?: AddToTarget }
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
    labels: [],
    assignees: [],
    triageDefaults: {},
    duplicates: noDuplicates,
  };
}

/** A filed or attempted draft keeps its repository; otherwise the draft's or the preferred one. */
export function loadedRepository(settings: SharingSettings, saved?: SavedDraft): string {
  return (
    saved?.issue?.repository ??
    saved?.attempt?.repository ??
    (saved?.repository || preferredRepository(settings))
  );
}

/** Why the report cannot be filed or added to an issue yet; empty when it can. */
export function filingBlocker(
  state: Pick<ShareState, 'preparing' | 'files'>,
  publishLimit: string,
): string {
  if (state.preparing || !state.files.length) return 'The report is still preparing.';
  return publishLimit;
}

/** Destination choices freeze while working and once a request may have reached GitHub. */
function locked(state: ShareState): boolean {
  return state.operation !== 'idle' || !!state.attempt || !!state.issue;
}

/** The in-memory defaults with this repository's choice; incomplete repositories keep them as is. */
function rememberChoice(
  defaults: TriageDefaults,
  repository: string,
  choice: { labels: string[]; assignees: string[] },
): TriageDefaults {
  try {
    return withTriage(defaults, repository, choice);
  } catch {
    return defaults;
  }
}

export function shareReducer(state: ShareState, action: ShareAction): ShareState {
  switch (action.type) {
    case 'loaded': {
      const repository = loadedRepository(action.settings, action.saved);
      const stored = action.triageDefaults ?? {};
      const chosen = action.saved?.labels || action.saved?.assignees ? action.saved : undefined;
      const choice = chosen
        ? { labels: chosen.labels ?? [], assignees: chosen.assignees ?? [] }
        : triageFor(stored, repository);
      // A draft's own choice wins over a newer default when switching repositories and back.
      const triageDefaults = chosen ? rememberChoice(stored, repository, choice) : stored;
      return {
        ...state,
        session: action.session,
        settings: action.settings,
        loading: false,
        preparing: true,
        draft: action.saved?.draft ?? initialDraft(action.session.name),
        repository,
        triageDefaults,
        ...choice,
        publication: action.saved?.publication,
        summaryRequestId: action.saved?.summaryRequestId,
        issue: action.saved?.issue,
        attempt: action.saved?.attempt,
        addTo: action.saved?.addTo,
        draftSource: action.saved?.draftSource ?? (action.saved ? 'edited' : 'initial'),
        level: action.saved?.publication?.level ?? state.level,
      };
    }
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
      if (locked(state)) return state;
      return {
        ...state,
        repository: action.repository,
        ...triageFor(state.triageDefaults, action.repository),
        duplicates: noDuplicates,
      };
    case 'triage': {
      if (locked(state)) return state;
      const choice = { labels: action.labels, assignees: action.assignees };
      return {
        ...state,
        ...choice,
        triageDefaults: rememberChoice(state.triageDefaults, state.repository, choice),
      };
    }
    case 'fingerprint':
      return { ...state, fingerprint: action.fingerprint };
    case 'duplicates-reset':
      return { ...state, duplicates: noDuplicates };
    case 'duplicates-loading':
      return { ...state, duplicates: { ...noDuplicates, status: 'loading', repository: action.repository } };
    case 'duplicates-ready':
    case 'duplicates-failed':
      // A search for a previously selected repository no longer applies.
      if (state.duplicates.status !== 'loading' || state.duplicates.repository !== action.repository)
        return state;
      return {
        ...state,
        duplicates:
          action.type === 'duplicates-ready'
            ? { ...state.duplicates, ...action.matches, status: 'ready' }
            : { ...state.duplicates, status: 'error', error: action.message },
      };
    case 'add-to':
      if (locked(state)) return state;
      return { ...state, addTo: action.target };
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
