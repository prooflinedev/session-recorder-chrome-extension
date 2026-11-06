import { PROOFLINE_SETTINGS_KEY } from '@/lib/proofline/settings';
import { publishProoflineReport } from '@/lib/proofline/reports';
import { prooflineRequest } from '@/lib/proofline/client';
import { isProoflinePublication, publicationUrl, publicationReady } from '@/lib/sharing/draft';
import { useEffect, useReducer, useRef } from 'react';
import { getAssets, getEvents, getSession } from '@/lib/storage';
import type { BuildBundleInput } from '@/lib/export/bundle';
import type { VerbosityLevel } from '@/lib/session/types';
import { buildHostedReport } from '@/lib/sharing/report';
import {
  deletePublishedReport,
  publishReport,
  validateFiles,
  waitForDeployment,
} from '@/lib/sharing/cloudflare';
import {
  loadSharingSettings,
  normalizeDestination,
  rememberRepository,
  LAST_REPOSITORY_KEY,
  SHARING_KEY,
  SUMMARY_PROVIDERS,
} from '@/lib/sharing/settings';
import {
  errorMessage,
  REPORT_LEVELS,
  type Publication,
  type SavedDraft,
} from '@/lib/sharing/draft';
import {
  generateConfiguredSummary,
  summaryEvidence,
  type IssueDraft,
} from '@/lib/sharing/summary';
import { fileIssue } from '@/lib/sharing/file-issue';
import { issueBody, issueLabel } from '@/lib/sharing/github';
import { isLinearDestination } from '@/lib/sharing/linear';
import { initialShareState, shareReducer, type ShareState } from './reducer';

type Recording = Omit<BuildBundleInput, 'level'>;

export function useShareReport(sessionId: string, initialLevel: VerbosityLevel) {
  const [state, dispatch] = useReducer(shareReducer, initialLevel, initialShareState);
  const recording = useRef<Recording>();
  const operation = useRef<AbortController>();
  const preparation = useRef(0);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const draftKey = `shareDraft:${sessionId}`;
  const progress = (message: string) => dispatch({ type: 'progress', message });

  async function prepare(data: Recording, level: VerbosityLevel) {
    const revision = ++preparation.current;
    dispatch({ type: 'prepare', level });
    try {
      const files = await buildHostedReport({ ...data, level });
      if (revision !== preparation.current) return;
      const evidence = summaryEvidence(
        data.session,
        data.events,
        data.assets.map(({ blob: _blob, ...meta }) => meta),
      );
      dispatch({ type: 'prepared', files, evidence });
    } catch (error) {
      if (revision === preparation.current)
        dispatch({ type: 'error', message: errorMessage(error) });
    }
  }

  // The sole effect owns the browser lifecycle: initial load, external settings
  // changes and cancellation. User actions explicitly prepare/save/run below.
  useEffect(() => {
    let active = true;
    void (async () => {
      if (!sessionId) throw new Error('Open Share report from a recorded session.');
      const [session, settings, saved, events, assets] = await Promise.all([
        getSession(sessionId),
        loadSharingSettings(),
        chrome.storage.local.get(draftKey),
        getEvents(sessionId),
        getAssets(sessionId),
      ]);
      if (!session)
        throw new Error('This recording is no longer stored in this browser.');
      if (session.status !== 'stopped')
        throw new Error('Stop the recording before sharing it.');
      if (!active) return;
      const draft = saved[draftKey] as SavedDraft | undefined;
      recording.current = { session, events, assets };
      dispatch({ type: 'loaded', session, settings, saved: draft });
      await prepare(recording.current, draft?.publication?.level ?? initialLevel);
    })().catch((error) => {
      if (active) dispatch({ type: 'error', message: errorMessage(error) });
    });
    const changed = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'local' && (changes[SHARING_KEY] || changes[LAST_REPOSITORY_KEY] || changes[PROOFLINE_SETTINGS_KEY]))
        void loadSharingSettings()
          .then((settings) => {
            if (active) dispatch({ type: 'settings', settings });
          })
          .catch(() => {
            if (active)
              dispatch({
                type: 'error',
                message: 'Could not reload sharing settings.',
              });
          });
    };
    chrome.storage.onChanged.addListener(changed);
    return () => {
      active = false;
      ++preparation.current;
      operation.current?.abort();
      chrome.storage.onChanged.removeListener(changed);
    };
  }, [sessionId, initialLevel, draftKey]);

  /** Serialize explicit writes so typing and deployment creation cannot race. */
  function persist(next: SavedDraft): Promise<void> {
    const write = writes.current.then(() =>
      chrome.storage.local.set({ [draftKey]: next }),
    );
    writes.current = write.catch(() => {});
    return write;
  }
  function snapshot(patch: Partial<SavedDraft> = {}): SavedDraft {
    return {
      draft: state.draft,
      repository: state.repository,
      publication: state.publication,
      draftSource: state.draftSource,
      issue: state.issue,
      attempt: state.attempt,
      summaryRequestId: state.summaryRequestId,
      ...patch,
    };
  }
  function persistEdit(next: SavedDraft) {
    const edited = snapshot(next);
    const write = writes.current.then(() =>
      navigator.locks.request(draftKey, async () => {
        const stored = (await chrome.storage.local.get(draftKey))[draftKey] as
          SavedDraft | undefined;
        // Another share tab may already have filed the issue while this tab was editing.
        const saved = stored
          ? {
              ...edited,
              repository: stored.attempt?.repository ?? stored.issue?.repository ?? edited.repository,
              publication: stored.publication,
              issue: stored.issue,
              attempt: stored.attempt,
            }
          : edited;
        await chrome.storage.local.set({ [draftKey]: saved });
      }),
    );
    writes.current = write.catch(() => {});
    void write.catch(() =>
      dispatch({
        type: 'error',
        message: 'Could not save this draft locally. Keep this tab open.',
      }),
    );
  }
  function editDraft(patch: Partial<IssueDraft>) {
    const draft = { ...state.draft, ...patch };
    const draftSource =
      patch.body !== undefined
        ? 'edited'
        : state.draftSource === 'initial'
          ? 'title-edited'
          : state.draftSource;
    dispatch({ type: 'draft', draft, source: draftSource });
    persistEdit({
      draft,
      draftSource,
      repository: state.repository,
      publication: state.publication,
    });
  }
  function editRepository(repository: string) {
    if (operation.current || state.attempt || state.issue) return;
    dispatch({ type: 'repository', repository });
    persistEdit({ draft: state.draft, repository, publication: state.publication });
    let destination;
    try {
      destination = normalizeDestination(repository);
    } catch { /* An incomplete typed repository is saved only with this draft. */ }
    if (destination)
      void rememberRepository(destination).catch(() => dispatch({ type: 'error', message: 'Could not remember the repository selection.' }));
  }
  async function remember(publication?: Publication) {
    dispatch({ type: 'publication', publication });
    await persist(snapshot({ publication }));
  }
  async function run(
    kind: ShareState['operation'],
    task: (signal: AbortSignal) => Promise<void>,
  ) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    dispatch({ type: 'start', operation: kind });
    try {
      await task(controller.signal);
    } catch (error) {
      const tracker = isLinearDestination(state.attempt?.repository ?? state.repository) ? 'Linear' : 'GitHub';
      dispatch({
        type: 'error',
        message: controller.signal.aborted
          ? `Cancelled. Saved drafts and published reports are kept. If ${tracker} received the request, use Check ${tracker} issue before retrying.`
          : errorMessage(error),
      });
    } finally {
      operation.current = undefined;
      dispatch({ type: 'finish' });
    }
  }
  async function publishedConfig() {
    const current = (await loadSharingSettings()).cloudflare;
    const publication = state.publication;
    if (!publication || isProoflinePublication(publication)) throw new Error('No Cloudflare deployment to manage.');
    if (current.accountId !== publication.destination.accountId)
      throw new Error(
        'Select this report’s Cloudflare account in settings to manage its deployment.',
      );
    return { ...publication.destination, apiToken: current.apiToken };
  }
  function generate() {
    return run('summary', async (signal) => {
      const config = await loadSharingSettings();
      progress('Generating issue summary…');
      const draft = await generateConfiguredSummary(
        config,
        state.evidence,
        signal,
      );
      dispatch({ type: 'draft', draft, source: 'generated' });
      await persist(snapshot({ draft, draftSource: 'generated' }));
      progress('Summary ready.');
    });
  }
  function publish() {
    return run('publish', async (signal) => {
      if (!state.files.length) throw new Error('The report is still preparing.');
      const settings = await loadSharingSettings();
      if (settings.proofline?.publishing === 'proofline' || (state.publication && isProoflinePublication(state.publication))) {
        await publishProoflineReport(settings.proofline!, state.files, state.draft.title, state.level, state.publication, remember, progress, signal);
        progress('Private report published.');
        return;
      }
      const config = settings.cloudflare;
      const { apiToken: _secret, ...destination } = config;
      const deployment = await publishReport(
        config,
        state.files,
        progress,
        signal,
        (d) => remember({ deployment: d, destination, level: state.level }),
      );
      await remember({ deployment, destination, level: state.level });
      progress('Report published. File a GitHub issue to share its link.');
    });
  }
  function checkDeployment() {
    if (state.publication && isProoflinePublication(state.publication)) return publish();
    return run('check', async (signal) => {
      if (!state.publication || isProoflinePublication(state.publication)) return;
      const deployment = await waitForDeployment(
        await publishedConfig(),
        state.publication.deployment,
        progress,
        signal,
      );
      await remember({ ...state.publication, deployment });
      progress('Report published.');
    });
  }
  function unpublish() {
    return run('delete', async () => {
      if (!state.publication) return;
      if (isProoflinePublication(state.publication)) {
        const settings = await loadSharingSettings();
        if (settings.proofline?.connection?.organizationId !== state.publication.organizationId) throw new Error('Reconnect the original Proofline workspace to delete this report.');
        await prooflineRequest(settings.proofline, `/reports/${state.publication.id}`, { method: 'DELETE' });
        await remember();
        progress('Report deleted. Local recording kept.');
        return;
      }
      await deletePublishedReport(
        await publishedConfig(),
        state.publication.deployment.id,
      );
      await remember();
      progress('Report unpublished. Local recording kept.');
    });
  }
  const finalBody = state.publication && publicationReady(state.publication)
    ? issueBody(state.draft, publicationUrl(state.publication))
    : '';
  function submitIssue() {
    return run('github', async (signal) => {
      await writes.current;
      await navigator.locks.request(
        draftKey,
        { mode: 'exclusive', signal },
        async () => {
          const stored = (await chrome.storage.local.get(draftKey))[draftKey] as
            SavedDraft | undefined;
          const saved = stored ? { ...stored, repository: stored.repository || state.repository } : snapshot();
          await rememberRepository(saved.attempt?.repository ?? saved.repository);
          const result = await fileIssue({
            saved,
            settings: await loadSharingSettings(),
            files: state.files,
            evidence: state.evidence,
            level: state.level,
            signal,
            progress,
            stage: (stage) => dispatch({ type: 'stage', stage }),
            save: async (next) => {
              await persist(next);
              dispatch({ type: 'saved', saved: next });
            },
          });
          dispatch({ type: 'saved', saved: result });
          progress(`Issue ${issueLabel(result.issue!)} created.`);
          await chrome.tabs.create({ url: result.issue!.url });
        },
      );
    });
  }
  function copyIssue() {
    return run('copy', async () => {
      await navigator.clipboard.writeText(finalBody);
      progress('Issue Markdown copied.');
    });
  }
  let publishLimit = '';
  try {
    if (state.files.length) validateFiles(state.files);
  } catch (error) {
    publishLimit = errorMessage(error);
  }
  return {
    state,
    finalBody,
    publishLimit,
    busy: state.operation !== 'idle',
    ready: publicationReady(state.publication),
    provider: SUMMARY_PROVIDERS.find((p) => p.id === state.settings.provider)!,
    totalBytes: state.files.reduce(
      (sum, f) =>
        sum + (f.bytes?.byteLength ?? new TextEncoder().encode(f.text ?? '').length),
      0,
    ),
    levels: REPORT_LEVELS,
    actions: {
      editDraft,
      editRepository,
      generate,
      publish,
      checkDeployment,
      unpublish,
      submitIssue,
      copyIssue,
      changeLevel: (level: VerbosityLevel) => {
        if (recording.current && !state.publication && !operation.current)
          void prepare(recording.current, level);
      },
      confirmDelete: (confirming: boolean) =>
        dispatch({ type: 'confirm-delete', confirming }),
      cancel: () => {
        if (operation.current) {
          dispatch({ type: 'cancel' });
          operation.current.abort();
        }
      },
    },
  };
}
