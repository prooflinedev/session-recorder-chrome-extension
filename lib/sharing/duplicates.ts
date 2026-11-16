import type { ErrorFingerprint } from './fingerprint';
import { githubHeaders, repositoryPath } from './github';

export interface DuplicateIssue {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
}
export interface DuplicateMatches {
  /** Issues whose body contains the fingerprint. */
  exact: DuplicateIssue[];
  /** Issues mentioning the error message: possibly related. */
  related: DuplicateIssue[];
}
const LIST_LIMIT = 5;
/** Issues whose comments are read when the fingerprint is not in the issue body. */
const COMMENT_CHECKS = 5;
const MIN_TERM = 12;
const MAX_TERM = 100;
const PLACEHOLDERS = /<(?:uuid|hex|email|url|n|str)>|"/;

/** The longest literal text between placeholders, if it is specific enough to search for. */
function messageTerm(message: string): string | undefined {
  const longest = message
    .split(PLACEHOLDERS)
    .map((run) => run.trim())
    .reduce((best, run) => (run.length > best.length ? run : best), '');
  return longest.length >= MIN_TERM ? longest.slice(0, MAX_TERM).trim() : undefined;
}

interface SearchItem {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  body?: unknown;
  pull_request?: unknown;
}
async function searchIssues(
  path: string,
  term: string,
  token: string,
  signal?: AbortSignal,
): Promise<SearchItem[]> {
  const query = new URLSearchParams({ q: `repo:${path} is:issue "${term}"`, per_page: '20' });
  const response = await fetch(`https://api.github.com/search/issues?${query}`, {
    headers: githubHeaders(token),
    signal,
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Couldn't check for duplicates (${response.status}).`);
  const { items } = (await response.json()) as { items?: unknown };
  return Array.isArray(items)
    ? items.filter((item): item is SearchItem => !!item && typeof item === 'object')
    : [];
}

function toIssue(path: string, item: SearchItem): DuplicateIssue | undefined {
  if (
    item.pull_request ||
    typeof item.number !== 'number' ||
    !Number.isSafeInteger(item.number) ||
    item.number < 1 ||
    typeof item.title !== 'string'
  )
    return undefined;
  return {
    number: item.number,
    title: item.title,
    // Built locally rather than trusting a returned link.
    url: `https://github.com/${path}/issues/${item.number}`,
    state: item.state === 'closed' ? 'closed' : 'open',
  };
}

/** "Add to #N" leaves the fingerprint in a comment; read the first page of comments. */
async function commentsContain(
  path: string,
  number: number,
  text: string,
  token: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${path}/issues/${number}/comments?${new URLSearchParams({ per_page: '100' })}`,
      { headers: githubHeaders(token), signal, redirect: 'error' },
    );
    if (!response.ok) return false;
    const comments: unknown = await response.json();
    return (
      Array.isArray(comments) &&
      comments.some(
        (comment) =>
          typeof (comment as { body?: unknown } | null)?.body === 'string' &&
          (comment as { body: string }).body.includes(text),
      )
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    // An unverified candidate is dropped rather than failing the whole check.
    return false;
  }
}

/** At most two GitHub searches: the exact fingerprint, then the error message. */
export async function findDuplicates(
  repository: string,
  token: string,
  fingerprint: ErrorFingerprint,
  signal?: AbortSignal,
): Promise<DuplicateMatches> {
  const path = repositoryPath(repository);
  const term = messageTerm(fingerprint.message);
  const [exactItems, messageItems] = await Promise.all([
    searchIssues(path, fingerprint.id, token, signal),
    term ? searchIssues(path, term, token, signal) : Promise.resolve([]),
  ]);
  const issues = (items: SearchItem[]) =>
    items.flatMap((item) => toIssue(path, item) ?? []);
  // Search tokenization is not trusted: the issue body or one of its comments
  // must contain the exact fingerprint.
  const inBody = (item: SearchItem) =>
    typeof item.body === 'string' && item.body.includes(fingerprint.id);
  const candidates = exactItems.flatMap((item) => {
    const match = toIssue(path, item);
    return match ? [{ match, inBody: inBody(item) }] : [];
  });
  const toCheck = candidates.filter((candidate) => !candidate.inBody).slice(0, COMMENT_CHECKS);
  const verified = await Promise.all(
    toCheck.map(({ match }) => commentsContain(path, match.number, fingerprint.id, token, signal)),
  );
  const inComments = new Set(
    toCheck.filter((_, index) => verified[index]).map(({ match }) => match.number),
  );
  const exact = candidates
    .filter((candidate) => candidate.inBody || inComments.has(candidate.match.number))
    .map((candidate) => candidate.match)
    .slice(0, LIST_LIMIT);
  const related = issues(messageItems)
    .filter((match) => !exact.some((found) => found.number === match.number))
    .slice(0, LIST_LIMIT);
  return { exact, related };
}
