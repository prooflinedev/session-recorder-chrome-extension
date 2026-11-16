import { repositoryPath, type IssueTriage } from './github';

/** Labels and assignees last chosen for each repository, keyed by lower-case owner/repo. */
export const TRIAGE_DEFAULTS_KEY = 'issueTriageDefaults';
export type TriageDefaults = Record<string, IssueTriage>;

function key(repository: string): string {
  return repositoryPath(repository).toLowerCase();
}

/** The remembered choice for a repository; none for unknown or incomplete repositories. */
export function triageFor(defaults: TriageDefaults, repository: string): IssueTriage {
  let path;
  try {
    path = key(repository);
  } catch {
    return { labels: [], assignees: [] };
  }
  const choice = defaults[path];
  return { labels: choice?.labels ?? [], assignees: choice?.assignees ?? [] };
}

export async function loadTriageDefaults(): Promise<TriageDefaults> {
  const stored = await chrome.storage.local.get(TRIAGE_DEFAULTS_KEY);
  return (stored[TRIAGE_DEFAULTS_KEY] as TriageDefaults | undefined) ?? {};
}

/** Record a repository's choice; an empty choice forgets its entry. */
export function withTriage(
  defaults: TriageDefaults,
  repository: string,
  choice: IssueTriage,
): TriageDefaults {
  const path = key(repository);
  const { [path]: _previous, ...others } = defaults;
  return choice.labels.length || choice.assignees.length ? { ...others, [path]: choice } : others;
}

/** Share tabs update the same map; the lock keeps one tab from dropping another's entry. */
export async function rememberTriage(repository: string, choice: IssueTriage): Promise<void> {
  await navigator.locks.request(TRIAGE_DEFAULTS_KEY, async () => {
    await chrome.storage.local.set({
      [TRIAGE_DEFAULTS_KEY]: withTriage(await loadTriageDefaults(), repository, choice),
    });
  });
}
