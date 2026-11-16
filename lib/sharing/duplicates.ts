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
  // Search tokenization is not trusted: the body must contain the exact fingerprint.
  const exact = issues(
    exactItems.filter(
      (item) => typeof item.body === 'string' && item.body.includes(fingerprint.id),
    ),
  ).slice(0, LIST_LIMIT);
  const related = issues(messageItems)
    .filter((match) => !exact.some((found) => found.number === match.number))
    .slice(0, LIST_LIMIT);
  return { exact, related };
}
