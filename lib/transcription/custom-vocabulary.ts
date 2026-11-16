import { repositoryPath } from '@/lib/sharing/github';
import {
  configuredRepositories,
  loadSharingSettings,
  preferredRepository,
  type GitHubRepository,
  type SharingSettings,
} from '@/lib/sharing/settings';
import { normalizeKeyterms } from './keyterms';

/**
 * Per-repository transcription vocabulary. Each repository starts with its
 * owner and name; once the user saves a list, that list replaces the default.
 * Custom terms are sent to the transcription provider ahead of page terms.
 */
export const VOCABULARY_KEY = 'transcriptionVocabulary';
export type RepositoryVocabulary = Record<string, string[]>;

function vocabularyKey(repository: string): string {
  return repositoryPath(repository).toLowerCase();
}

/** Configured issue destinations, in settings order, without incomplete entries. */
export function vocabularyRepositories(settings: SharingSettings): string[] {
  const repositories: string[] = [];
  for (const entry of configuredRepositories(settings)) {
    try {
      const path = repositoryPath(entry.repository);
      if (!repositories.some((r) => r.toLowerCase() === path.toLowerCase()))
        repositories.push(path);
    } catch {
      // An entry still being typed in Settings → GitHub.
    }
  }
  return repositories;
}

export function defaultRepositoryTerms(repository: string): string[] {
  const [owner = '', name = ''] = repositoryPath(repository).split('/');
  return normalizeKeyterms([owner, name]);
}

export function repositoryTerms(
  vocabulary: RepositoryVocabulary,
  repository: string,
): string[] {
  return vocabulary[vocabularyKey(repository)] ?? defaultRepositoryTerms(repository);
}

/** Splits editor text into terms; `rejected` lists lines the provider limits drop. */
export function parseVocabulary(text: string): { terms: string[]; rejected: string[] } {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const terms = normalizeKeyterms(lines);
  const kept = new Set(terms.map((term) => term.toLocaleLowerCase()));
  const rejected: string[] = [];
  for (const line of lines) {
    const key = line.replace(/\s+/g, ' ').toLocaleLowerCase();
    if (
      !kept.has(key) &&
      !rejected.some((r) => r.toLocaleLowerCase() === line.toLocaleLowerCase())
    )
      rejected.push(line);
  }
  return { terms, rejected };
}

/** Custom terms lead; page terms fill what remains of the provider limits. */
export function mergeKeyterms(
  custom: readonly string[],
  page: readonly string[],
): string[] {
  return normalizeKeyterms([...custom, ...page]);
}

export async function loadVocabulary(): Promise<RepositoryVocabulary> {
  const stored = await chrome.storage.local.get(VOCABULARY_KEY);
  const value = stored[VOCABULARY_KEY];
  return value && typeof value === 'object' ? (value as RepositoryVocabulary) : {};
}

export async function saveRepositoryTerms(
  repository: string,
  terms: string[],
): Promise<void> {
  const vocabulary = await loadVocabulary();
  await chrome.storage.local.set({
    [VOCABULARY_KEY]: {
      ...vocabulary,
      [vocabularyKey(repository)]: normalizeKeyterms(terms),
    },
  });
}

function pathOrUndefined(repository: string): string | undefined {
  try {
    return vocabularyKey(repository);
  } catch {
    return undefined;
  }
}

/**
 * Follows repository entries renamed in GitHub settings: saved terms move to the
 * new name, which adds its owner and repository. A list already saved under the
 * new name wins, and the old list stays while another entry still uses that name.
 * Returns undefined when nothing changes.
 */
export function renameVocabulary(
  vocabulary: RepositoryVocabulary,
  previous: readonly GitHubRepository[],
  next: readonly GitHubRepository[],
): RepositoryVocabulary | undefined {
  const result = { ...vocabulary };
  const inUse = new Set(next.map((entry) => pathOrUndefined(entry.repository)));
  let changed = false;
  for (const entry of next) {
    const old = previous.find((p) => p.id === entry.id);
    const from = old && pathOrUndefined(old.repository);
    const to = pathOrUndefined(entry.repository);
    const terms = from && result[from];
    if (!from || !to || from === to || !terms || result[to]) continue;
    result[to] = normalizeKeyterms([...terms, ...defaultRepositoryTerms(to)]);
    if (!inUse.has(from)) delete result[from];
    changed = true;
  }
  return changed ? result : undefined;
}

export async function moveRenamedVocabulary(
  previous: readonly GitHubRepository[],
  next: readonly GitHubRepository[],
): Promise<void> {
  const renamed = renameVocabulary(await loadVocabulary(), previous, next);
  if (renamed) await chrome.storage.local.set({ [VOCABULARY_KEY]: renamed });
}

/** Terms for the repository the next issue defaults to; empty when none is configured. */
export async function loadCustomKeyterms(): Promise<string[]> {
  try {
    const repository = preferredRepository(await loadSharingSettings());
    if (!repository) return [];
    return repositoryTerms(await loadVocabulary(), repository);
  } catch {
    return [];
  }
}
