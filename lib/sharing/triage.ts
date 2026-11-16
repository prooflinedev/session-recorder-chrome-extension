import { repositoryPath, type IssueTriage } from './github';

/** Labels and assignees last chosen for each repository, keyed by lower-case owner/repo. */
export const TRIAGE_DEFAULTS_KEY = 'issueTriageDefaults';
export type TriageDefaults = Record<string, IssueTriage>;

function key(repository: string): string {
  return repositoryPath(repository).toLowerCase();
}

export async function loadTriageDefaults(): Promise<TriageDefaults> {
  const stored = await chrome.storage.local.get(TRIAGE_DEFAULTS_KEY);
  return (stored[TRIAGE_DEFAULTS_KEY] as TriageDefaults | undefined) ?? {};
}

/** An empty choice forgets the repository's entry. */
export async function rememberTriage(repository: string, choice: IssueTriage): Promise<void> {
  const path = key(repository);
  const { [path]: _previous, ...others } = await loadTriageDefaults();
  await chrome.storage.local.set({
    [TRIAGE_DEFAULTS_KEY]:
      choice.labels.length || choice.assignees.length ? { ...others, [path]: choice } : others,
  });
}
