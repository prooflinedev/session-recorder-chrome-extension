import type { ExportFile } from '@/lib/export/bundle';
import {
  isProoflinePublication,
  type Publication,
  type ProoflinePublication,
} from '@/lib/sharing/draft';
import type { VerbosityLevel } from '@/lib/session/types';
import { ProoflineError, delay, prooflineRequest } from './client';
import { requireConnection, type ProoflineSettings } from './settings';
import {
  GitHubRequestError,
  type CreatedIssue,
  type IssueAttempt,
} from '@/lib/sharing/github';
import type { IssueDraft } from '@/lib/sharing/summary';

function assetType(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  return (
    (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        webm: path.startsWith('audio/') ? 'audio/webm' : 'video/webm',
        mp4: 'video/mp4',
        json: 'application/json',
        md: 'text/plain',
        txt: 'text/plain',
      } as Record<string, string>
    )[extension ?? ''] ?? 'application/octet-stream'
  );
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export async function publishProoflineReport(
  settings: ProoflineSettings,
  files: ExportFile[],
  title: string,
  level: VerbosityLevel,
  previous: Publication | undefined,
  save: (publication: ProoflinePublication) => Promise<void>,
  progress: (message: string) => void,
  signal: AbortSignal,
): Promise<ProoflinePublication> {
  const connection = requireConnection(settings);
  if (
    previous &&
    (!isProoflinePublication(previous) ||
      previous.organizationId !== connection.organizationId)
  )
    throw new Error(
      'This report belongs to another publishing destination. Keep its original account connected to finish publishing.',
    );
  const markdown = files.find((file) => file.path === 'report.md')?.text;
  if (!markdown) throw new Error('The report is still preparing.');
  let publication: ProoflinePublication = previous ?? {
    provider: 'proofline',
    id: '',
    organizationId: connection.organizationId,
    url: '',
    level,
    requestId: crypto.randomUUID(),
    attachments: files
      .filter((file) => file.path !== 'report.md' && !/\.html?$/i.test(file.path))
      .map((file) => ({
        path: file.path,
        requestId: crypto.randomUUID(),
        uploaded: false,
      })),
  };
  await save(publication);
  if (!publication.id) {
    progress('Creating private report…');
    const report = await prooflineRequest<{ id: string; url: string }>(
      settings,
      '/reports',
      {
        method: 'POST',
        body: JSON.stringify({ request_id: publication.requestId, title, markdown }),
        signal,
      },
    );
    publication = {
      ...publication,
      id: report.id,
      url: new URL(report.url, 'https://proofline.sh').href,
    };
    await save(publication);
  }
  for (const [index, attachment] of publication.attachments.entries()) {
    signal.throwIfAborted();
    if (attachment.uploaded) continue;
    const file = files.find((file) => file.path === attachment.path);
    if (!file)
      throw new Error('A saved report attachment is no longer available locally.');
    const bytes = file.bytes ?? new TextEncoder().encode(file.text ?? '');
    if (bytes.length > 25 * 1024 * 1024)
      throw new Error(
        `${file.path} exceeds Proofline’s 25 MB attachment limit. Reduce the attachment size or export the report locally.`,
      );
    progress(`Uploading evidence ${index + 1} of ${publication.attachments.length}…`);
    await prooflineRequest(settings, `/reports/${publication.id}/attachments`, {
      method: 'POST',
      body: JSON.stringify({
        request_id: attachment.requestId,
        name: file.path,
        media_type: assetType(file.path),
        data_base64: base64(bytes),
      }),
      signal,
    });
    publication = {
      ...publication,
      attachments: publication.attachments.map((item) =>
        item.path === attachment.path ? { ...item, uploaded: true } : item,
      ),
    };
    await save(publication);
  }
  return publication;
}
interface IssueJob {
  request_id: string;
  status: 'pending' | 'submitting' | 'complete' | 'uncertain' | 'cancelled' | 'failed';
  number?: number;
  url?: string;
}
export async function fileProoflineIssue(
  settings: ProoflineSettings,
  attempt: IssueAttempt,
  draft: IssueDraft,
  signal: AbortSignal,
  resume = false,
  progress: (message: string) => void = () => {},
): Promise<CreatedIssue> {
  const connection = requireConnection(settings);
  const target = attempt.proofline;
  if (!target || target.organizationId !== connection.organizationId)
    throw new Error(
      'Reconnect the original Proofline workspace to finish this issue request.',
    );
  const base = `/reports/${target.reportId}`;
  try {
    let job = resume
      ? await prooflineRequest<IssueJob>(settings, `${base}/issues/${attempt.id}`, {
          signal,
        })
      : await prooflineRequest<IssueJob>(settings, `${base}/issue`, {
          method: 'POST',
          body: JSON.stringify({
            request_id: attempt.id,
            repository_id: target.repositoryId,
            title: draft.title,
            body: draft.body,
          }),
          signal,
        });
    const deadline = Date.now() + 60_000;
    while (job.status === 'pending' || job.status === 'submitting') {
      if (Date.now() >= deadline)
        throw new Error(
          'Proofline is still processing this issue request in the background. GitHub rate limits can delay it. Use Check GitHub issue later to check the same request; do not file a second issue manually.',
        );
      progress(
        job.status === 'pending'
          ? 'Issue request queued in Proofline. Waiting for submission; GitHub rate limits can delay this step…'
          : 'Proofline is submitting the issue to GitHub. Waiting for confirmation…',
      );
      await delay(2000, signal);
      job = await prooflineRequest<IssueJob>(settings, `${base}/issues/${attempt.id}`, {
        signal,
      });
    }
    if (job.status === 'cancelled')
      throw new GitHubRequestError(
        'Issue creation was cancelled. You can file it again.',
        true,
      );
    // The server exposes failed only when publication never reached GitHub.
    // Requests that crossed the send boundary remain submitting or uncertain.
    if (job.status === 'failed')
      throw new GitHubRequestError(
        'Proofline could not submit this issue. Check repository access and try again.',
        true,
      );
    if (job.status !== 'complete' || !job.url || !job.number)
      throw new Error(
        job.status === 'uncertain'
          ? 'GitHub may have received this issue. Check the repository before retrying; no duplicate was submitted.'
          : `Proofline issue creation ${job.status}. Check the request in Proofline.`,
      );
    return { number: job.number, url: job.url, repository: attempt.repository };
  } catch (error) {
    if (
      !resume &&
      error instanceof ProoflineError &&
      [400, 401, 403, 404, 413, 422].includes(error.status)
    )
      throw new GitHubRequestError(error.message, true);
    throw error;
  } finally {
    if (signal.aborted) {
      try {
        await prooflineRequest(settings, `${base}/issues/${attempt.id}/cancel`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        /* Keep the durable attempt so a retry checks the original request. */
      }
    }
  }
}
