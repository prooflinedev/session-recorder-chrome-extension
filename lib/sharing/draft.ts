import { repositoryPath, type CreatedIssue, type IssueAttempt } from './github';
import type { CloudflareConfig } from './settings';
import type { Deployment } from './cloudflare';
import type { IssueDraft } from './summary';
import type { VerbosityLevel } from '@/lib/session/types';

export interface CloudflarePublication {
  deployment: Deployment;
  destination: Omit<CloudflareConfig, 'apiToken'>;
  level: VerbosityLevel;
}
export interface ProoflinePublication {
  provider: 'proofline';
  id: string;
  organizationId: string;
  url: string;
  level: VerbosityLevel;
  requestId: string;
  attachments: { path: string; requestId: string; uploaded: boolean }[];
}
export type Publication = CloudflarePublication | ProoflinePublication;
export function isProoflinePublication(
  publication: Publication,
): publication is ProoflinePublication {
  return 'provider' in publication && publication.provider === 'proofline';
}
export function publicationUrl(publication: Publication): string {
  return isProoflinePublication(publication)
    ? publication.url
    : publication.deployment.url;
}
export function publicationReady(publication?: Publication): boolean {
  return (
    !!publication &&
    (isProoflinePublication(publication)
      ? !!publication.id && publication.attachments.every((asset) => asset.uploaded)
      : publication.deployment.latest_stage?.name === 'deploy' &&
        publication.deployment.latest_stage.status === 'success')
  );
}
export interface SavedDraft {
  summaryRequestId?: string;

  draft: IssueDraft;
  repository: string;
  publication?: Publication;
  draftSource?: 'initial' | 'title-edited' | 'edited' | 'generated';
  issue?: CreatedIssue;
  attempt?: IssueAttempt;
  /** Requested for personal-token filing; Proofline-managed filing ignores them. */
  labels?: string[];
  assignees?: string[];
  /** An existing issue chosen with "Add to #N": the report is posted there as a comment. */
  addTo?: AddToTarget;
}
/** Another share tab may already have filed the issue while this tab was editing. */
export function mergeStaleEdit(edited: SavedDraft, stored: SavedDraft | undefined): SavedDraft {
  if (!stored) return edited;
  const submitted = !!(stored.attempt || stored.issue);
  return {
    ...edited,
    repository: stored.attempt?.repository ?? stored.issue?.repository ?? edited.repository,
    publication: stored.publication,
    issue: stored.issue,
    attempt: stored.attempt,
    // A submitted request's labels and assignees are what GitHub was asked for.
    ...(submitted
      ? { labels: stored.labels, assignees: stored.assignees, addTo: stored.addTo }
      : {}),
  };
}
export const REPORT_LEVELS: { id: VerbosityLevel; label: string }[] = [
  { id: 'L0', label: 'Full' },
  { id: 'L1', label: 'Standard' },
  { id: 'L2', label: 'Compact' },
  { id: 'L3', label: 'Minimal' },
];
export function initialDraft(name: string): IssueDraft {
  return {
    title: name,
    body: `## Recorded session\n\n${name}\n\nSee the linked report for captured actions, logs, and attachments.`,
  };
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}
/** An issue number is meaningful only in the repository where the match was found. */
export interface AddToTarget {
  repository: string;
  number: number;
}
/** Refuse when another tab changed the draft's repository after the match was found. */
export function addToMismatch(saved: SavedDraft): string | undefined {
  if (!saved.addTo) return undefined;
  const key = (repository: string) => {
    try {
      return repositoryPath(repository).toLowerCase();
    } catch {
      return repository.trim().toLowerCase();
    }
  };
  const repository = saved.attempt?.repository ?? saved.repository;
  return key(repository) === key(saved.addTo.repository)
    ? undefined
    : `This duplicate was found in ${saved.addTo.repository}. Check the repository and duplicates again before adding the report.`;
}
