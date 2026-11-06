import {
  loadProoflineSettings,
  PROOFLINE_SETTINGS_KEY,
  type ProoflineSettings,
} from '@/lib/proofline/settings';
import { useEffect, useReducer, useRef } from 'react';
import {
  defaultSharingSettings,
  loadSharingSettings,
  saveSharingSettings,
  SUMMARY_PROVIDERS,
  type SharingSettings,
  type SummaryProvider,
  type ModelConfig,
  type GitHubRepository,
} from '@/lib/sharing/settings';
import { verifyCloudflare } from '@/lib/sharing/cloudflare';
import { validateModelConfig } from '@/lib/sharing/summary';
import { repositoryPath, verifyGitHub } from '@/lib/sharing/github';
import { errorMessage } from '@/lib/sharing/draft';
import {
  listLinearTeams,
  verifyLinear,
  type LinearConfig,
  type LinearTeam,
} from '@/lib/sharing/linear';

export type SharingSection = 'publishing' | 'summaries' | 'github' | 'linear';

interface State {
  settings: SharingSettings;
  linearTeams: LinearTeam[];
  status: 'loading' | 'idle' | 'saving' | 'verifying';
  message: string;
  error: string;
}
type Action =
  | { type: 'proofline'; settings: ProoflineSettings }
  | { type: 'loaded'; settings: SharingSettings }
  | { type: 'cloudflare'; patch: Partial<SharingSettings['cloudflare']> }
  | { type: 'model'; patch: Partial<ModelConfig> }
  | { type: 'provider'; provider: SummaryProvider }
  | { type: 'add-repository'; id: string }
  | { type: 'remove-repository'; id: string }
  | { type: 'repository'; id: string; patch: Partial<GitHubRepository> }
  | { type: 'linear'; patch: Partial<LinearConfig> }
  | { type: 'linear-teams'; teams: LinearTeam[] }
  | { type: 'start'; verify: boolean }
  | { type: 'saved'; message: string }
  | { type: 'error'; message: string };

export function sharingSettingsReducer(state: State, action: Action): State {
  const edit = (settings: SharingSettings): State => ({
    ...state,
    settings,
    message: '',
    error: '',
  });
  switch (action.type) {
    case 'proofline':
      return { ...state, settings: { ...state.settings, proofline: action.settings } };
    case 'loaded':
      return { ...state, settings: action.settings, status: 'idle' };
    case 'cloudflare':
      return edit({
        ...state.settings,
        cloudflare: { ...state.settings.cloudflare, ...action.patch },
      });
    case 'model':
      return edit({
        ...state.settings,
        models: {
          ...state.settings.models,
          [state.settings.provider]: {
            ...state.settings.models[state.settings.provider],
            ...action.patch,
          },
        },
      });
    case 'provider':
      return edit({ ...state.settings, provider: action.provider });
    case 'add-repository':
      return edit({
        ...state.settings,
        repositories: [
          ...state.settings.repositories,
          { id: action.id, repository: '', token: '' },
        ],
      });
    case 'remove-repository':
      return edit({
        ...state.settings,
        repositories: state.settings.repositories.filter(
          (entry) => entry.id !== action.id,
        ),
      });
    case 'repository':
      return edit({
        ...state.settings,
        repositories: state.settings.repositories.map((entry) =>
          entry.id === action.id ? { ...entry, ...action.patch } : entry,
        ),
      });
    case 'linear':
      return {
        ...edit({ ...state.settings, linear: { ...state.settings.linear, ...action.patch } }),
        // Teams loaded with a different key may not be visible to the new one.
        linearTeams: action.patch.apiKey === undefined ? state.linearTeams : [],
      };
    case 'linear-teams':
      return {
        ...state,
        status: 'idle',
        linearTeams: action.teams,
        message: action.teams.length ? '' : 'This key cannot see any Linear teams.',
        settings: action.teams.some((team) => team.id === state.settings.linear.teamId)
          ? state.settings
          : { ...state.settings, linear: { ...state.settings.linear, teamId: action.teams[0]?.id ?? '' } },
      };
    case 'start':
      return {
        ...state,
        status: action.verify ? 'verifying' : 'saving',
        error: '',
        message: '',
      };
    case 'saved':
      return { ...state, status: 'idle', message: action.message };
    case 'error':
      return {
        ...state,
        status: state.status === 'loading' ? 'loading' : 'idle',
        error: action.message,
        message: '',
      };
  }
}

export function useSharingSettings() {
  const [state, dispatch] = useReducer(
    sharingSettingsReducer,
    undefined,
    (): State => ({
      settings: defaultSharingSettings(),
      linearTeams: [],
      status: 'loading',
      message: '',
      error: '',
    }),
  );
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    void loadSharingSettings()
      .then((settings) => {
        if (active) dispatch({ type: 'loaded', settings });
      })
      .catch(() => {
        if (active)
          dispatch({
            type: 'error',
            message: 'Could not load sharing settings. Reload this page.',
          });
      });
    const changed = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'local' && changes[PROOFLINE_SETTINGS_KEY])
        void loadProoflineSettings()
          .then((settings) => {
            if (active) dispatch({ type: 'proofline', settings });
          })
          .catch(() => {
            if (active)
              dispatch({
                type: 'error',
                message: 'Could not reload the Proofline connection.',
              });
          });
    };
    chrome.storage.onChanged.addListener(changed);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);
  async function loadLinearTeams() {
    if (inFlight.current || state.status === 'loading') return;
    inFlight.current = true;
    dispatch({ type: 'start', verify: true });
    try {
      dispatch({ type: 'linear-teams', teams: await listLinearTeams(state.settings.linear.apiKey) });
    } catch (error) {
      dispatch({ type: 'error', message: errorMessage(error) });
    } finally {
      inFlight.current = false;
    }
  }
  async function verifiedLinear(): Promise<LinearConfig> {
    const apiKey = state.settings.linear.apiKey.trim();
    if (!apiKey) return { apiKey: '', teamId: '', teamKey: '', teamName: '' };
    if (!state.settings.linear.teamId) throw new Error('Load teams and choose a Linear team.');
    const team = await verifyLinear(apiKey, state.settings.linear.teamId);
    return { apiKey, teamId: team.id, teamKey: team.key, teamName: team.name };
  }
  async function save(section: SharingSection) {
    const verify = section !== 'summaries';
    if (inFlight.current || state.status === 'loading') return;
    inFlight.current = true;
    dispatch({ type: 'start', verify });
    try {
      const repositories = state.settings.repositories.map((entry) => ({
        ...entry,
        repository: repositoryPath(entry.repository),
        token: entry.token.trim(),
      }));
      if (
        new Set(repositories.map((entry) => entry.repository.toLowerCase())).size !==
        repositories.length
      )
        throw new Error('Each repository only needs one entry.');
      let linear = state.settings.linear;
      if (section === 'publishing') await verifyCloudflare(state.settings.cloudflare);
      else if (section === 'linear') linear = await verifiedLinear();
      else if (section === 'github') {
        for (const entry of repositories)
          await verifyGitHub(entry.repository, entry.token);
      } else {
        const model = state.settings.models[state.settings.provider];
        if (
          model.apiKey ||
          (state.settings.provider === 'compatible' && (model.baseUrl || model.model))
        )
          validateModelConfig(state.settings.provider, model);
      }
      await saveSharingSettings({ ...state.settings, repositories, linear });
      if (section === 'linear') {
        const { apiKey, ...team } = linear;
        dispatch({ type: 'linear', patch: apiKey ? team : linear });
      }
      dispatch({
        type: 'saved',
        message:
          section === 'publishing'
            ? 'Saved. Access application and reader policies verified.'
            : section === 'github'
              ? 'Repositories verified and saved.'
              : section === 'linear'
                ? linear.apiKey
                  ? `Linear team ${linear.teamKey} verified and saved.`
                  : 'Linear settings cleared.'
                : 'Sharing settings saved.',
      });
    } catch (error) {
      dispatch({ type: 'error', message: errorMessage(error) });
    } finally {
      inFlight.current = false;
    }
  }
  return {
    ...state,
    busy: state.status === 'saving' || state.status === 'verifying',
    loaded: state.status !== 'loading',
    provider: SUMMARY_PROVIDERS.find((p) => p.id === state.settings.provider)!,
    model: state.settings.models[state.settings.provider],
    actions: {
      save,
      patchCloudflare: (patch: Partial<SharingSettings['cloudflare']>) =>
        dispatch({ type: 'cloudflare', patch }),
      patchModel: (patch: Partial<ModelConfig>) => dispatch({ type: 'model', patch }),
      selectProvider: (provider: SummaryProvider) =>
        dispatch({ type: 'provider', provider }),
      addRepository: () =>
        dispatch({ type: 'add-repository', id: crypto.randomUUID() }),
      removeRepository: (id: string) => dispatch({ type: 'remove-repository', id }),
      editRepository: (id: string, patch: Partial<GitHubRepository>) =>
        dispatch({ type: 'repository', id, patch }),
      patchLinear: (patch: Partial<LinearConfig>) => dispatch({ type: 'linear', patch }),
      loadLinearTeams,
    },
  };
}
