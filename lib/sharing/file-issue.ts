import { ProoflineAiCancelledError, ProoflineAiFailedError } from '@/lib/proofline/ai';
import type { ExportFile } from '@/lib/export/bundle';
import type { VerbosityLevel } from '@/lib/session/types';
import { isProoflinePublication, publicationUrl, type SavedDraft } from './draft';
import { fileProoflineIssue, publishProoflineReport } from '@/lib/proofline/reports';
import { requireConnection } from '@/lib/proofline/settings';
import { tokenForRepository, type SharingSettings } from './settings';
import {
  generateSummary,
  generateConfiguredSummary,
  isSummaryConfigured,
} from './summary';
import { publishReport, validateFiles, waitForDeployment } from './cloudflare';
import {
  createGitHubIssue,
  findCreatedIssue,
  GitHubRequestError,
  repositoryPath,
  verifyGitHub,
} from './github';

export type FilingStage = 'connection' | 'summary' | 'publish' | 'issue';

interface FileIssueInput {
  saved: SavedDraft;
  settings: SharingSettings;
  files: ExportFile[];
  evidence: string;
  level: VerbosityLevel;
  save: (draft: SavedDraft) => Promise<void>;
  progress: (message: string) => void;
  signal: AbortSignal;
  stage?: (stage: FilingStage) => void;
}
/** One transaction, with durable checkpoints before each external side effect. */
export async function fileIssue(input: FileIssueInput): Promise<SavedDraft> {
  const { settings, files, evidence, level, save, progress, signal } = input;
  let saved = { ...input.saved };
  async function checkpoint(patch: Partial<SavedDraft>) {
    saved = { ...saved, ...patch };
    await save(saved);
  }
  if (saved.issue) return saved;
  signal.throwIfAborted();
  // An uncertain request is permanently tied to its original repository.
  const repository = repositoryPath(saved.attempt?.repository ?? saved.repository);
  saved = { ...saved, repository };
  const managedGitHub =
    !!saved.attempt?.proofline || settings.proofline?.github === 'proofline';
  const token = managedGitHub ? '' : tokenForRepository(settings, repository);
  input.stage?.('connection');
  progress('Checking GitHub connection…');
  if (managedGitHub) requireConnection(settings.proofline!);
  else await verifyGitHub(repository, token, signal);
  if (saved.attempt) {
    input.stage?.('issue');
    progress('Checking the previous GitHub request…');
    let issue;
    try {
      issue = saved.attempt.proofline
        ? await fileProoflineIssue(
            settings.proofline!,
            saved.attempt,
            saved.draft,
            signal,
            true,
            progress,
          )
        : await findCreatedIssue(saved.attempt, token, signal);
    } catch (error) {
      if (error instanceof GitHubRequestError && error.definitive)
        await checkpoint({ attempt: undefined });
      throw error;
    }
    if (!issue)
      throw new Error(
        'The previous request may still be processing. Check your repository, then retry to look for the issue again. No duplicate issue was submitted.',
      );
    await checkpoint({ issue, attempt: undefined });
    return saved;
  }
  signal.throwIfAborted();
  validateFiles(files);
  input.stage?.('summary');
  const configured = isSummaryConfigured(settings);
  if (
    configured &&
    ['initial', 'title-edited'].includes(saved.draftSource ?? 'initial')
  ) {
    progress('Generating issue summary…');
    if (settings.proofline?.aiMode === 'proofline' && !saved.summaryRequestId)
      await checkpoint({ summaryRequestId: crypto.randomUUID() });
    let draft;
    try {
      draft =
        settings.proofline?.aiMode === 'proofline'
          ? await generateConfiguredSummary(
              settings,
              evidence,
              signal,
              saved.summaryRequestId,
            )
          : await generateSummary(
              settings.provider,
              settings.models[settings.provider],
              evidence,
              signal,
            );
    } catch (error) {
      if (
        error instanceof ProoflineAiCancelledError ||
        error instanceof ProoflineAiFailedError
      )
        await checkpoint({ summaryRequestId: undefined });
      throw error;
    }
    if (saved.draftSource === 'title-edited') draft.title = saved.draft.title;
    await checkpoint({ draft, draftSource: 'generated', summaryRequestId: undefined });
  }
  if (!saved.draft.title.trim() || !saved.draft.body.trim())
    throw new Error('Add an issue title and summary.');
  signal.throwIfAborted();
  input.stage?.('publish');
  if (
    settings.proofline?.publishing === 'proofline' ||
    (saved.publication && isProoflinePublication(saved.publication))
  ) {
    await publishProoflineReport(
      settings.proofline!,
      files,
      saved.draft.title,
      level,
      saved.publication,
      (publication) => checkpoint({ publication }),
      progress,
      signal,
    );
  } else if (saved.publication) {
    const publication = saved.publication;
    if (isProoflinePublication(publication))
      throw new Error('Reconnect Proofline to manage this report.');
    if (
      publication.deployment.latest_stage?.name !== 'deploy' ||
      publication.deployment.latest_stage.status !== 'success'
    ) {
      if (settings.cloudflare.accountId !== publication.destination.accountId)
        throw new Error(
          'Select this report’s Cloudflare account in Publishing settings to finish its deployment.',
        );
      const deployment = await waitForDeployment(
        { ...publication.destination, apiToken: settings.cloudflare.apiToken },
        publication.deployment,
        progress,
        signal,
      );
      await checkpoint({ publication: { ...publication, deployment } });
    }
  } else {
    const { apiToken: _secret, ...destination } = settings.cloudflare;
    const deployment = await publishReport(
      settings.cloudflare,
      files,
      progress,
      signal,
      (deployment) => checkpoint({ publication: { deployment, destination, level } }),
    );
    await checkpoint({ publication: { deployment, destination, level } });
  }
  signal.throwIfAborted();
  const managedRepository = settings.proofline?.connection?.account.repositories.find(
    (entry) => entry.full_name.toLowerCase() === repository.toLowerCase(),
  );
  if (
    managedGitHub &&
    (!managedRepository ||
      !saved.publication ||
      !isProoflinePublication(saved.publication))
  )
    throw new Error(
      'Choose a repository installed in this Proofline workspace and use Proofline report hosting.',
    );
  const attempt = {
    id: crypto.randomUUID(),
    repository,
    ...(managedGitHub && saved.publication && isProoflinePublication(saved.publication)
      ? {
          proofline: {
            organizationId: saved.publication.organizationId,
            reportId: saved.publication.id,
            repositoryId: managedRepository!.id,
          },
        }
      : {}),
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  };
  await checkpoint({ attempt });
  if (signal.aborted) {
    await checkpoint({ attempt: undefined });
    signal.throwIfAborted();
  }
  input.stage?.('issue');
  progress('Creating GitHub issue…');
  try {
    const issue = managedGitHub
      ? await fileProoflineIssue(
          settings.proofline!,
          attempt,
          saved.draft,
          signal,
          false,
          progress,
        )
      : await createGitHubIssue(
          attempt,
          token,
          saved.draft,
          publicationUrl(saved.publication!),
          signal,
        );
    await checkpoint({ issue, attempt: undefined });
  } catch (error) {
    // A rejected request is safe to retry. An uncertain response retains its marker.
    if (error instanceof GitHubRequestError && error.definitive)
      await checkpoint({ attempt: undefined });
    throw error;
  }
  progress(`Issue #${saved.issue!.number} created.`);
  return saved;
}
