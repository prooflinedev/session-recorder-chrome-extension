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
import {
  waitWithSignal,
  samePublication,
  publicationOperationKey,
} from '@/lib/sharing/concurrency';
import { issueBody, repositoryPath } from '@/lib/sharing/github';
import { initialShareState, shareReducer, type ShareState } from './reducer';

type Recording = Omit<BuildBundleInput, 'level'>;

export function useShareReport(sessionId: string, initialLevel: VerbosityLevel) {
  const [state, dispatch] = useReducer(shareReducer, initialLevel, initialShareState);
  const recording = useRef<Recording>();
  const operation = useRef<AbortController>();
  const preparation = useRef(0);
  const pendingPublication = useRef<Publication>();

  const writes = useRef<Promise<void>>(Promise.resolve());
  const draftKey = `shareDraft:${sessionId}`;
  const recoveryKey = `${draftKey}:publicationRecovery`;
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
        chrome.storage.local.get([draftKey, recoveryKey]),
        getEvents(sessionId),
        getAssets(sessionId),
      ]);
      if (!session)
        throw new Error('This recording is no longer stored in this browser.');
      if (session.status !== 'stopped')
        throw new Error('Stop the recording before sharing it.');
      if (!active) return;
      const storedDraft = saved[draftKey] as SavedDraft | undefined;
      const recovery = saved[recoveryKey] as Publication | undefined;
      const draft = storedDraft && recovery
        ? { ...storedDraft, publication: recovery }
        : storedDraft;
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
  const pendingEdit = useRef<{
    draft: Partial<IssueDraft>;
    repository?: string;
  }>({ draft: {} });

  function persistEdit(
    patch: Partial<IssueDraft>,
    repository?: string,
  ) {
    const fallback = snapshot();
    const write = writes.current.then(() =>
      navigator.locks.request(draftKey, async () => {
        pendingEdit.current = {
          draft: { ...pendingEdit.current.draft, ...patch },
          repository: repository ?? pendingEdit.current.repository,
        };
        const pending = pendingEdit.current;
        const stored = (await chrome.storage.local.get(draftKey))[draftKey] as
          SavedDraft | undefined;
        const latest = stored
          ? { ...stored, draftSource: stored.draftSource ?? 'edited' as const }
          : fallback;

        const draftSource =
          pending.draft.body !== undefined
            ? 'edited'
            : pending.draft.title !== undefined && latest.draftSource === 'initial'
              ? 'title-edited'
              : latest.draftSource;

        const saved: SavedDraft = {
          ...latest,
          draft: { ...latest.draft, ...pending.draft },
          draftSource,
          repository:
            latest.attempt?.repository ??
            latest.issue?.repository ??
            pending.repository ??
            latest.repository,
        };

        await chrome.storage.local.set({ [draftKey]: saved });
        pendingEdit.current = { draft: {} };
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
    persistEdit(patch);
  }

  function editRepository(repository: string) {
    if (operation.current || state.attempt || state.issue) return;
    dispatch({ type: 'repository', repository });
    persistEdit({}, repository);

    try {
      const path = repositoryPath(repository);
      void rememberRepository(path).catch(() =>
        dispatch({
          type: 'error',
          message: 'Could not remember the repository selection.',
        }),
      );
    } catch {
      /* An incomplete typed repository is saved only with this draft. */
    }
  }

  async function readDraft(): Promise<SavedDraft> {
    const records = await chrome.storage.local.get([
      draftKey,
      recoveryKey,
    ]);
    const stored = records[draftKey] as SavedDraft | undefined;
    const recovery = records[recoveryKey] as Publication | undefined;
    const latest = stored
      ? { ...stored, draftSource: stored.draftSource ?? 'edited' as const }
      : snapshot();

    return recovery
      ? { ...latest, publication: recovery }
      : latest;
  }

  async function updateDraft(
    update: (latest: SavedDraft) => SavedDraft,
    signal?: AbortSignal,
  ): Promise<SavedDraft> {
    return navigator.locks.request(
      draftKey,
      { mode: 'exclusive', ...(signal ? { signal } : {}) },
      async () => {
        const latest = await readDraft();
        signal?.throwIfAborted();
        const next = update(latest);
        await chrome.storage.local.set({ [draftKey]: next });
        return next;
      },
    );
  }

  async function withOperation(
    signal: AbortSignal,
    task: () => Promise<void>,
  ) {
    await waitWithSignal(writes.current, signal);
    await navigator.locks.request(
      publicationOperationKey(draftKey),
      { mode: 'exclusive', signal },
      async () => {
        signal.throwIfAborted();

        // Promote an interrupted publication checkpoint before
        // starting another external operation.
        // Ensure even a first-time publication has a durable draft.
        // Also promote any recovery checkpoint left by an interrupted tab.
        const pending = pendingPublication.current;

        if (pending) {
          const latest = await readDraft();

          if (
            latest.publication &&
            !samePublication(pending, latest.publication)
          )
            throw new Error(
              'Another report exists. Resolve the unsaved publication before continuing.',
            );

          await remember(pending);
        }

        await updateDraft(latest => latest, signal);
        await chrome.storage.local.remove(recoveryKey);

        signal.throwIfAborted();
        await task();
      },
    );
  }

  async function remember(publication?: Publication) {
    // Persist recovery metadata before waiting for the draft lock.
    if (publication) {
      pendingPublication.current = publication;
      dispatch({ type: 'publication', publication });

      try {
        await chrome.storage.local.set({ [recoveryKey]: publication });
      } catch {
        throw new Error(
          'Could not save the report checkpoint. Keep this tab open and retry.',
        );
      }
    }

    await updateDraft(latest => ({ ...latest, publication }));
    await chrome.storage.local.remove(recoveryKey);
    pendingPublication.current = undefined;

    dispatch({ type: 'publication', publication });
  }

  async function requirePublication(expected: Publication) {
    const latest = await readDraft();
    if (!samePublication(expected, latest.publication)) {
      dispatch({ type: 'publication', publication: latest.publication });
      throw new Error('The report changed in another tab. Review its current state before retrying.');
    }
    return latest.publication!;
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
      dispatch({
        type: 'error',
        message: controller.signal.aborted
          ? 'Cancelled. Saved drafts and published reports are kept. If GitHub received the request, use Check GitHub issue before retrying.'
          : errorMessage(error),
      });
    } finally {
      operation.current = undefined;
      dispatch({ type: 'finish' });
    }
  }
  async function publishedConfig(publication: Publication) {
    const current = (await loadSharingSettings()).cloudflare;
    if (isProoflinePublication(publication))
      throw new Error('No Cloudflare deployment to manage.');
    if (current.accountId !== publication.destination.accountId)
      throw new Error(
        'Select this report’s Cloudflare account in settings to manage its deployment.',
      );
    return { ...publication.destination, apiToken: current.apiToken };
  }

  function generate() {
    return run('summary', async (signal) => {
      await waitWithSignal(writes.current, signal);
      const before = await readDraft();
      const config = await loadSharingSettings();
      progress('Generating issue summary…');
      const draft = await generateConfiguredSummary(
        config,
        state.evidence,
        signal,
      );

      const saved = await updateDraft(latest => {
        if (
          latest.draft.title !== before.draft.title ||
          latest.draft.body !== before.draft.body ||
          latest.draftSource !== before.draftSource
        )
          throw new Error('The draft changed while generating the summary. Your edits were kept.');

        return { ...latest, draft, draftSource: 'generated' };
      }, signal);

      dispatch({ type: 'draft', draft: saved.draft, source: 'generated' });
      progress('Summary ready.');
    });
  }

  function publish() {
    const expected = state.publication;

    return run('publish', async (signal) => {
      await withOperation(signal, async () => {
        const stored = await readDraft();
        const previous = stored.publication;

        if (expected && !samePublication(expected, previous)) {
          dispatch({ type: 'publication', publication: previous });
          throw new Error('The report changed in another tab. Review its current state before retrying.');
        }

        if (!expected && previous && previous.level !== state.level) {
          dispatch({ type: 'publication', publication: previous });
          throw new Error('Another tab published a report at a different detail level.');
        }

        dispatch({ type: 'publication', publication: previous });

        const level = previous?.level ?? state.level;
        const files = level === state.level
          ? state.files
          : recording.current
            ? await buildHostedReport({ ...recording.current, level })
            : [];

        if (!files.length)
          throw new Error('The report is still preparing.');

        if (level !== state.level)
          await prepare(recording.current!, level);

        signal.throwIfAborted();
        const settings = await loadSharingSettings();

        if (
          (previous && isProoflinePublication(previous)) ||
          (!previous && settings.proofline?.publishing === 'proofline')
        ) {
          await publishProoflineReport(
            settings.proofline!,
            files,
            stored.draft.title,
            level,
            previous,
            remember,
            progress,
            signal,
          );
          progress('Private report published.');
          return;
        }

        if (previous && !isProoflinePublication(previous)) {
          if (!publicationReady(previous)) {
            const deployment = await waitForDeployment(
              await publishedConfig(previous),
              previous.deployment,
              progress,
              signal,
            );
            await remember({ ...previous, deployment });
          }
          progress('Report published. File a GitHub issue to share its link.');
          return;
        }

        const config = settings.cloudflare;
        const { apiToken: _secret, ...destination } = config;

        const deployment = await publishReport(
          config,
          files,
          progress,
          signal,
          created => remember({ deployment: created, destination, level }),
        );

        await remember({ deployment, destination, level });
        progress('Report published. File a GitHub issue to share its link.');
      });
    });
  }

  function checkDeployment() {
    const expected = state.publication;
    if (!expected) return;
    if (isProoflinePublication(expected)) return publish();

    return run('check', async (signal) => {
      await withOperation(signal, async () => {
        const current = await requirePublication(expected);
        if (isProoflinePublication(current))
          throw new Error('The report changed in another tab.');

        dispatch({ type: 'publication', publication: current });

        const deployment = await waitForDeployment(
          await publishedConfig(current),
          current.deployment,
          progress,
          signal,
        );

        const saved = await updateDraft(latest => {
          if (!samePublication(current, latest.publication))
            return latest;

          return {
            ...latest,
            publication: { ...current, deployment },
          };
        }, signal);

        dispatch({ type: 'publication', publication: saved.publication });

        if (!samePublication(current, saved.publication))
          throw new Error('The report changed in another tab.');

        progress('Report published.');
      });
    });
  }

  function unpublish() {
    const expected = state.publication;
    if (!expected) return;

    return run('delete', async (signal) => {
      await withOperation(signal, async () => {
        const publication = await requirePublication(expected);

        if (isProoflinePublication(publication)) {
          const settings = await loadSharingSettings();
          if (
            settings.proofline?.connection?.organizationId !==
            publication.organizationId
          )
            throw new Error('Reconnect the original Proofline workspace to delete this report.');

          signal.throwIfAborted();
          await prooflineRequest(
            settings.proofline,
            `/reports/${publication.id}`,
            { method: 'DELETE' },
          );
        } else {
          const config = await publishedConfig(publication);
          signal.throwIfAborted();
          await deletePublishedReport(config, publication.deployment.id);
        }

        await remember();
        progress('Report unpublished. Local recording kept.');
      });
    });
  }

  const finalBody = state.publication && publicationReady(state.publication)
    ? issueBody(state.draft, publicationUrl(state.publication))
    : '';
  function submitIssue() {
    return run('github', async (signal) => {
      await withOperation(signal, async () => {
        const stored = await readDraft();
        const saved = {
          ...stored,
          repository: stored.repository || state.repository,
        };

        const level = saved.publication?.level ?? state.level;
        const files = level === state.level
          ? state.files
          : recording.current
            ? await buildHostedReport({ ...recording.current, level })
            : [];

        signal.throwIfAborted();
        await rememberRepository(saved.attempt?.repository ?? saved.repository);

        const result = await fileIssue({
          saved,
          settings: await loadSharingSettings(),
          files,
          evidence: state.evidence,
          level,
          signal,
          progress,
          stage: stage => dispatch({ type: 'stage', stage }),
          save: async (_next, patch) => {
            if (patch.publication)
              await remember(patch.publication);

            const merged = await updateDraft(latest => {
              const changes = { ...patch };

              // Automatic summaries must not replace user edits
              // made while the summary request was running.
              if (
                changes.draftSource === 'generated' &&
                (
                  latest.draft.title !== saved.draft.title ||
                  latest.draft.body !== saved.draft.body ||
                  latest.draftSource !== saved.draftSource
                )
              ) {
                delete changes.draft;
                delete changes.draftSource;
              }

              return {
                ...latest,
                ...changes,
                repository:
                  changes.attempt?.repository ??
                  changes.issue?.repository ??
                  latest.repository,
              };
            });

            dispatch({ type: 'saved', saved: merged });
            return merged;
          },
        });

        dispatch({ type: 'saved', saved: await readDraft() });
        progress(`Issue #${result.issue!.number} created.`);
        await chrome.tabs.create({ url: result.issue!.url });
      });
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
