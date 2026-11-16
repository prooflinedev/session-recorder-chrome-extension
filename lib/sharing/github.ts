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

export function issueBody(
  draft: IssueDraft,
  reportUrl: string,
  fingerprint?: string,
): string {
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
  return `${draft.body.trim()}\n\n### Recorded session\n[Open the full report](${url.href}) — ${url.hostname === 'proofline.sh' ? 'Proofline' : 'Cloudflare Access'} sign-in required.\n${fingerprintLine(fingerprint)}`;
}
/** Lets later reports of the same error find this issue. */
export function fingerprintLine(fingerprint?: string): string {
  return fingerprint ? `Error fingerprint: \`${fingerprint}\`\n` : '';
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
  url: string;
  repository: string;
  /** Applied values from GitHub's response. Absent for Proofline-filed and older saved issues. */
  labels?: string[];
  assignees?: string[];
  /** Set when the report was added to this existing issue as a comment. */
  comment?: { url: string };
}
export interface IssueAttempt {
  proofline?: { organizationId: string; reportId: string; repositoryId: string };
  id: string;
  repository: string;
  startedAt: string;
  /** Set when the attempt adds a comment to this existing issue instead of creating one. */
  issueNumber?: number;
}
export interface IssueTriage {
  labels: string[];
  assignees: string[];
}
/** GitHub silently drops labels and assignees without push access; name what it dropped. */
export function notApplied(requested: IssueTriage, issue: CreatedIssue): IssueTriage {
  const missing = (wanted: string[], applied: string[] = []) => {
    const present = new Set(applied.map((value) => value.toLowerCase()));
    return wanted.filter((value) => !present.has(value.toLowerCase()));
  };
  return {
    labels: missing(requested.labels, issue.labels),
    assignees: missing(requested.assignees, issue.assignees),
  };
}
export class GitHubRequestError extends Error {
  constructor(
    message: string,
    public readonly definitive: boolean,
  ) {
    super(message);
  }
}
export function githubHeaders(token: string): HeadersInit {
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
function names(values: unknown, key: 'name' | 'login'): string[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value: unknown) => {
    const name = (value as Record<string, unknown> | null)?.[key];
    return typeof name === 'string' ? [name] : [];
  });
}
function result(
  value: { number?: unknown; html_url?: unknown; labels?: unknown; assignees?: unknown },
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
  return {
    number: value.number,
    url: value.html_url,
    repository,
    labels: names(value.labels, 'name'),
    assignees: names(value.assignees, 'login'),
  };
}
export async function verifyGitHub(
  repository: string,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  const path = repositoryPath(repository);
  const response = await fetch(`https://api.github.com/repos/${path}`, {
    headers: githubHeaders(token),
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
export interface IssueOptions {
  /** GitHub drops labels and assignees from requests without push access. */
  canTriage: boolean;
  labels: { name: string; color: string }[];
  assignees: string[];
}
const NEUTRAL_LABEL_COLOR = '8b949e';
async function getJson(path: string, token: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${path}`, {
    headers: githubHeaders(token),
    signal,
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      `Could not load labels and assignees (${response.status}). Check the token in Sharing settings.`,
    );
  return response.json();
}
/** Collect every page, up to ten, keeping only entries `pick` accepts. */
async function listPages<T>(
  path: string,
  token: string,
  signal: AbortSignal | undefined,
  pick: (entry: Record<string, unknown>) => T | undefined,
): Promise<T[]> {
  const values: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({ per_page: '100', page: String(page) });
    const entries = await getJson(`${path}?${query}`, token, signal);
    if (!Array.isArray(entries)) break;
    for (const entry of entries) {
      const value = entry && typeof entry === 'object' ? pick(entry) : undefined;
      if (value !== undefined) values.push(value);
    }
    if (entries.length < 100) break;
  }
  return values;
}
export async function listIssueOptions(
  repository: string,
  token: string,
  signal?: AbortSignal,
): Promise<IssueOptions> {
  const path = repositoryPath(repository);
  const [repo, labels, assignees] = await Promise.all([
    getJson(path, token, signal) as Promise<{ permissions?: { push?: unknown } } | null>,
    listPages(`${path}/labels`, token, signal, ({ name, color }) =>
      typeof name === 'string'
        ? {
            name,
            // The colour reaches CSS, so accept only GitHub's plain hex format.
            color:
              typeof color === 'string' && /^[0-9a-f]{6}$/i.test(color)
                ? color
                : NEUTRAL_LABEL_COLOR,
          }
        : undefined,
    ),
    listPages(`${path}/assignees`, token, signal, ({ login }) =>
      typeof login === 'string' ? login : undefined,
    ),
  ]);
  return { canTriage: repo?.permissions?.push === true, labels, assignees };
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
      { headers: githubHeaders(token), signal, redirect: 'error' },
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
  triage?: IssueTriage,
  fingerprint?: string,
): Promise<CreatedIssue> {
  const path = repositoryPath(attempt.repository);
  const response = await fetch(`https://api.github.com/repos/${path}/issues`, {
    method: 'POST',
    headers: githubHeaders(token),
    signal,
    redirect: 'error',
    body: JSON.stringify({
      title: draft.title.trim().slice(0, 120),
      body: `${issueBody(draft, reportUrl, fingerprint)}\n${marker(attempt)}`,
      // Without a selection the request stays exactly as before.
      ...(triage?.labels.length ? { labels: triage.labels } : {}),
      ...(triage?.assignees.length ? { assignees: triage.assignees } : {}),
    }),
  });
  if (!response.ok)
    throw new GitHubRequestError(
      `GitHub could not create the issue (${response.status}). Check Issues: Write access for this repository.`,
      response.status >= 400 && response.status < 500 && response.status !== 408,
    );
  return result(await response.json(), path);
}
function commentTarget(attempt: IssueAttempt): { path: string; number: number } {
  const number = attempt.issueNumber;
  if (!number || !Number.isSafeInteger(number) || number < 1)
    throw new Error('Choose an issue to add this report to.');
  return { path: repositoryPath(attempt.repository), number };
}
function commentResult(
  value: { html_url?: unknown },
  path: string,
  number: number,
): CreatedIssue {
  const issueUrl = `https://github.com/${path}/issues/${number}`;
  if (
    typeof value.html_url !== 'string' ||
    !value.html_url.toLowerCase().startsWith(`${issueUrl.toLowerCase()}#issuecomment-`)
  )
    throw new GitHubRequestError(
      'GitHub returned an unexpected comment response. Check the issue before retrying.',
      false,
    );
  return { number, url: issueUrl, repository: path, comment: { url: value.html_url } };
}
/** Adds the report to an existing issue; the marker makes a lost response recoverable. */
export async function createIssueComment(
  attempt: IssueAttempt,
  token: string,
  draft: IssueDraft,
  reportUrl: string,
  signal?: AbortSignal,
  fingerprint?: string,
): Promise<CreatedIssue> {
  const { path, number } = commentTarget(attempt);
  const response = await fetch(
    `https://api.github.com/repos/${path}/issues/${number}/comments`,
    {
      method: 'POST',
      headers: githubHeaders(token),
      signal,
      redirect: 'error',
      body: JSON.stringify({
        body: `${issueBody(draft, reportUrl, fingerprint)}\n${marker(attempt)}`,
      }),
    },
  );
  if (!response.ok)
    throw new GitHubRequestError(
      `GitHub could not add the comment to #${number} (${response.status}). Check Issues: Write access for this repository.`,
      response.status >= 400 && response.status < 500 && response.status !== 408,
    );
  return commentResult(await response.json(), path, number);
}
/** Finds a comment accepted by GitHub whose response was lost, by its attempt marker. */
export async function findCreatedComment(
  attempt: IssueAttempt,
  token: string,
  signal?: AbortSignal,
): Promise<CreatedIssue | undefined> {
  const { path, number } = commentTarget(attempt);
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({
      since: attempt.startedAt,
      per_page: '100',
      page: String(page),
    });
    const response = await fetch(
      `https://api.github.com/repos/${path}/issues/${number}/comments?${query}`,
      { headers: githubHeaders(token), signal, redirect: 'error' },
    );
    if (!response.ok)
      throw new Error(
        `Could not check the previous GitHub request (${response.status}). Retry to check again.`,
      );
    const comments = (await response.json()) as Array<{ html_url?: unknown; body?: unknown }>;
    const found = comments.find(
      (comment) => typeof comment.body === 'string' && comment.body.includes(marker(attempt)),
    );
    if (found) return commentResult(found, path, number);
    if (comments.length < 100) return undefined;
  }
  throw new Error(
    'Could not finish checking the previous request. Check the issue for the comment.',
  );
}
