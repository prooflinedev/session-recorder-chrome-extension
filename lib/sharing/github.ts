import type { IssueDraft } from './summary';

export function repositoryPath(value: string): string {
  const path = value
    .trim()
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/\.git\/?$/, '')
    .replace(/\/$/, '');
  if (
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9_.-]+$/.test(path) ||
    path.endsWith('/..') ||
    path.endsWith('/.')
  ) {
    throw new Error(
      'Enter a GitHub repository as owner/repository or its https://github.com URL.',
    );
  }
  return path;
}

export function issueBody(draft: IssueDraft, reportUrl: string): string {
  const url = new URL(reportUrl);
  if (
    url.protocol !== 'https:' ||
    !(url.hostname.endsWith('.pages.dev') || (url.origin === 'https://proofline.sh' && /^\/recorder\/reports\/[a-f0-9-]+\/[a-f0-9-]+$/.test(url.pathname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('A published Cloudflare Pages or Proofline report URL is required.');
  return `${draft.body.trim()}\n\n### Recorded session\n[Open the full report](${url.href}) — ${url.hostname === 'proofline.sh' ? 'Proofline' : 'Cloudflare Access'} sign-in required.\n`;
}

/** Keep encoded URLs small; the clipboard carries longer reviewed summaries. */
export function githubIssueLink(
  repository: string,
  title: string,
  body: string,
): { url: string; needsPaste: boolean } {
  const base = `https://github.com/${repositoryPath(repository)}/issues/new`;
  const query = new URLSearchParams({ title: title.slice(0, 120), body });
  const url = `${base}?${query}`;
  return url.length <= 7500
    ? { url, needsPaste: false }
    : {
        url: `${base}?${new URLSearchParams({ title: title.slice(0, 120) })}`,
        needsPaste: true,
      };
}

export interface CreatedIssue {
  number: number;
  /** Set for Linear issues, whose readable ID is `KEY-n`. */
  identifier?: string;
  url: string;
  repository: string;
}
export function issueLabel(issue: CreatedIssue): string {
  return issue.identifier ?? `#${issue.number}`;
}
export interface IssueAttempt {
  proofline?: { organizationId: string; reportId: string; repositoryId: string };
  id: string;
  repository: string;
  startedAt: string;
}
export class GitHubRequestError extends Error {
  constructor(
    message: string,
    public readonly definitive: boolean,
  ) {
    super(message);
  }
}
function headers(token: string): HeadersInit {
  if (!token.trim()) throw new Error('Add a GitHub API token in Settings → GitHub.');
  return {
    Authorization: `Bearer ${token.trim()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}
function marker(attempt: IssueAttempt): string {
  return `<!-- session-recorder:${attempt.id} -->`;
}
function result(
  value: { number?: unknown; html_url?: unknown },
  repository: string,
): CreatedIssue {
  if (
    typeof value.number !== 'number' ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    typeof value.html_url !== 'string' ||
    value.html_url.toLowerCase() !==
      `https://github.com/${repository.toLowerCase()}/issues/${value.number}`
  )
    throw new GitHubRequestError(
      'GitHub returned an unexpected issue response. Check the repository before retrying.',
      false,
    );
  return { number: value.number, url: value.html_url, repository };
}
export async function verifyGitHub(
  repository: string,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  const path = repositoryPath(repository);
  const response = await fetch(`https://api.github.com/repos/${path}`, {
    headers: headers(token),
    signal,
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      `GitHub repository check failed (${response.status}). Check the repository and token permissions in Settings → GitHub.`,
    );
  const repo = await response.json();
  if (repo.has_issues === false || repo.archived)
    throw new Error('This repository does not accept new issues.');
}
/** A persisted marker lets us recover an accepted request whose response was lost. */
export async function findCreatedIssue(
  attempt: IssueAttempt,
  token: string,
  signal?: AbortSignal,
): Promise<CreatedIssue | undefined> {
  const path = repositoryPath(attempt.repository);
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({
      state: 'all',
      since: attempt.startedAt,
      sort: 'created',
      direction: 'desc',
      per_page: '100',
      page: String(page),
    });
    const response = await fetch(
      `https://api.github.com/repos/${path}/issues?${query}`,
      { headers: headers(token), signal, redirect: 'error' },
    );
    if (!response.ok)
      throw new Error(
        `Could not check the previous GitHub request (${response.status}). Retry to check again.`,
      );
    const issues = (await response.json()) as Array<{
      number: number;
      html_url: string;
      body?: string;
      pull_request?: unknown;
    }>;
    const found = issues.find(
      (issue) => !issue.pull_request && issue.body?.includes(marker(attempt)),
    );
    if (found) return result(found, path);
    if (issues.length < 100) return undefined;
  }
  throw new Error(
    'Could not finish checking the previous request. Check your repository for the issue.',
  );
}
export async function createGitHubIssue(
  attempt: IssueAttempt,
  token: string,
  draft: IssueDraft,
  reportUrl: string,
  signal?: AbortSignal,
): Promise<CreatedIssue> {
  const path = repositoryPath(attempt.repository);
  const response = await fetch(`https://api.github.com/repos/${path}/issues`, {
    method: 'POST',
    headers: headers(token),
    signal,
    redirect: 'error',
    body: JSON.stringify({
      title: draft.title.trim().slice(0, 120),
      body: `${issueBody(draft, reportUrl)}\n${marker(attempt)}`,
    }),
  });
  if (!response.ok)
    throw new GitHubRequestError(
      `GitHub could not create the issue (${response.status}). Check Issues: Write access for this repository.`,
      response.status >= 400 && response.status < 500 && response.status !== 408,
    );
  return result(await response.json(), path);
}
