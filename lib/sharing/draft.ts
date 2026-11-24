import type { CreatedIssue, IssueAttempt } from './github';
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
  /** Screenshot revision used to generate an existing publication. */
  publicationRevision?: string;

  draft: IssueDraft;
  repository: string;
  publication?: Publication;
  draftSource?: 'initial' | 'title-edited' | 'edited' | 'generated';
  issue?: CreatedIssue;
  attempt?: IssueAttempt;
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
