import { useEffect, useReducer } from 'react';
import { preferredRepository, type SharingSettings } from '@/lib/sharing/settings';
import {
  loadVocabulary,
  parseVocabulary,
  repositoryTerms,
  saveRepositoryTerms,
  vocabularyRepositories,
  VOCABULARY_KEY,
  type RepositoryVocabulary,
} from '@/lib/transcription/custom-vocabulary';
import { errorMessage } from '@/lib/sharing/draft';

interface State {
  vocabulary: RepositoryVocabulary | null;
  /** Explicit picker choice; empty follows the repository new issues default to. */
  repository: string;
  /** Unsaved editor text for one repository; otherwise the stored terms show. */
  draft: { repository: string; text: string } | null;
  saving: boolean;
  saved: boolean;
  rejected: string[];
  error: string;
}
type Action =
  | { type: 'loaded'; vocabulary: RepositoryVocabulary }
  | { type: 'select'; repository: string }
  | { type: 'edit'; repository: string; text: string }
  | { type: 'saving' }
  | { type: 'saved'; vocabulary: RepositoryVocabulary; rejected: string[] }
  | { type: 'error'; message: string };

const initial: State = {
  vocabulary: null,
  repository: '',
  draft: null,
  saving: false,
  saved: false,
  rejected: [],
  error: '',
};

export function vocabularyReducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded':
      return { ...state, vocabulary: action.vocabulary };
    case 'select':
      return {
        ...state,
        repository: action.repository,
        draft: null,
        saved: false,
        rejected: [],
        error: '',
      };
    case 'edit':
      return {
        ...state,
        draft: { repository: action.repository, text: action.text },
        saved: false,
        rejected: [],
        error: '',
      };
    case 'saving':
      return { ...state, saving: true, error: '' };
    case 'saved':
      return {
        ...state,
        vocabulary: action.vocabulary,
        draft: null,
        saving: false,
        saved: true,
        rejected: action.rejected,
      };
    case 'error':
      return { ...state, saving: false, error: action.message };
  }
}

function defaultRepository(settings: SharingSettings, repositories: string[]): string {
  const preferred = preferredRepository(settings).toLowerCase();
  return (
    repositories.find((r) => r.toLowerCase() === preferred) ?? repositories[0] ?? ''
  );
}

export function useTranscriptionVocabulary(settings: SharingSettings) {
  const [state, dispatch] = useReducer(vocabularyReducer, initial);
  useEffect(() => {
    let active = true;
    const load = () =>
      void loadVocabulary()
        .then((vocabulary) => {
          if (active) dispatch({ type: 'loaded', vocabulary });
        })
        .catch((error: unknown) => {
          if (active) dispatch({ type: 'error', message: errorMessage(error) });
        });
    // GitHub settings move saved terms when a repository is renamed.
    const changed = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'local' && changes[VOCABULARY_KEY]) load();
    };
    load();
    chrome.storage.onChanged.addListener(changed);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);
  const repositories = vocabularyRepositories(settings);
  const repository = repositories.includes(state.repository)
    ? state.repository
    : defaultRepository(settings, repositories);
  const draft = state.draft?.repository === repository ? state.draft.text : null;
  const text =
    draft ??
    (state.vocabulary && repository
      ? repositoryTerms(state.vocabulary, repository).join('\n')
      : '');
  return {
    repositories,
    repository,
    text,
    loaded: state.vocabulary !== null,
    saving: state.saving,
    saved: state.saved,
    rejected: state.rejected,
    error: state.error,
    select: (next: string) => dispatch({ type: 'select', repository: next }),
    edit: (next: string) => dispatch({ type: 'edit', repository, text: next }),
    save: async () => {
      if (!repository) return;
      dispatch({ type: 'saving' });
      try {
        const { terms, rejected } = parseVocabulary(text);
        await saveRepositoryTerms(repository, terms);
        dispatch({ type: 'saved', vocabulary: await loadVocabulary(), rejected });
      } catch (error) {
        dispatch({ type: 'error', message: errorMessage(error) });
      }
    },
  };
}
