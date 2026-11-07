import type { CreatedIssue, IssueAttempt } from './github';
import { issueBody } from './github';
import type { IssueDraft } from './summary';

export const LINEAR_API_URL = 'https://api.linear.app/graphql';
export const LINEAR_KEYS_URL = 'https://linear.app/settings/account/security';
const PREFIX = 'linear:';

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}
export interface LinearConfig {
  apiKey: string;
  teamId: string;
  teamKey: string;
  teamName: string;
}
export class LinearRequestError extends Error {
  constructor(
    message: string,
    public readonly definitive: boolean,
  ) {
    super(message);
  }
}

export function isLinearDestination(value: string): boolean {
  return value.startsWith(PREFIX);
}
export function linearDestination(teamId: string): string {
  const destination = `${PREFIX}${teamId}`;
  linearTeamId(destination);
  return destination;
}
export function linearTeamId(destination: string): string {
  const id = destination.slice(PREFIX.length);
  if (!isLinearDestination(destination) || !/^[a-zA-Z0-9-]{1,64}$/.test(id))
    throw new Error('Choose a Linear team in Settings → Linear.');
  return id;
}

function headers(apiKey: string): HeadersInit {
  const key = apiKey.trim();
  if (!key) throw new Error('Add a Linear API key in Settings → Linear.');
  if (!/^[\x21-\x7e]+$/.test(key))
    throw new Error('The Linear API key contains unexpected characters. Paste it again.');
  // Personal API keys are sent as-is; a Bearer prefix is only for OAuth tokens.
  return { Authorization: key, 'Content-Type': 'application/json' };
}

const KNOWN_CODES = new Set([
  'INVALID_INPUT',
  'GRAPHQL_VALIDATION_FAILED',
  'ENTITY_NOT_FOUND',
  'INTERNAL_SERVER_ERROR',
]);
const BAD_KEY = 'Linear rejected the API key. Check the key in Settings → Linear.';
const FORBIDDEN = 'This Linear API key cannot create issues in the selected team.';
const RATE_LIMITED = 'Linear rate limited the request. Wait a minute, then retry.';

/**
 * Messages are built only from the status and known codes: response bodies are
 * untrusted and may echo request data, including the key.
 */
async function linearRequest<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: headers(apiKey),
    signal,
    redirect: 'error',
    body: JSON.stringify({ query, variables }),
  });
  if (response.status === 401) throw new LinearRequestError(BAD_KEY, true);
  if (response.status === 403) throw new LinearRequestError(FORBIDDEN, true);
  if (response.status === 429) throw new LinearRequestError(RATE_LIMITED, true);
  let payload: { data?: T; errors?: { extensions?: { code?: unknown } }[] } | undefined;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const codes = (Array.isArray(payload?.errors) ? payload.errors : []).map((error) =>
    String(error?.extensions?.code ?? ''),
  );
  if (codes.includes('AUTHENTICATION_ERROR')) throw new LinearRequestError(BAD_KEY, true);
  if (codes.includes('FORBIDDEN')) throw new LinearRequestError(FORBIDDEN, true);
  if (codes.includes('RATELIMITED')) throw new LinearRequestError(RATE_LIMITED, true);
  if (!response.ok || codes.length || !payload?.data) {
    const known = codes.find((code) => KNOWN_CODES.has(code));
    throw new LinearRequestError(
      `Linear could not complete the request (${response.status}${known ? `, ${known}` : ''}).`,
      false,
    );
  }
  return payload.data;
}

export async function listLinearTeams(
  apiKey: string,
  signal?: AbortSignal,
): Promise<LinearTeam[]> {
  const data = await linearRequest<{ teams?: { nodes?: unknown[] } }>(
    apiKey,
    'query SessionRecorderTeams { teams(first: 250) { nodes { id key name } } }',
    {},
    signal,
  );
  return (data.teams?.nodes ?? []).filter(
    (team): team is LinearTeam =>
      !!team &&
      typeof (team as LinearTeam).id === 'string' &&
      typeof (team as LinearTeam).key === 'string' &&
      typeof (team as LinearTeam).name === 'string',
  );
}

/** Confirms that the key can see the chosen team and returns its current key and name. */
export async function verifyLinear(
  apiKey: string,
  teamId: string,
  signal?: AbortSignal,
): Promise<LinearTeam> {
  const team = (await listLinearTeams(apiKey, signal)).find((entry) => entry.id === teamId);
  if (!team)
    throw new Error('This Linear API key cannot access the selected team. Load teams and choose again.');
  return team;
}

const ISSUE_FIELDS = 'id identifier number url team { id }';
interface LinearIssueNode {
  id?: unknown;
  identifier?: unknown;
  number?: unknown;
  url?: unknown;
  team?: { id?: unknown } | null;
}

/** Accept only the issue we asked for, in the team we asked for, at a linear.app URL. */
function result(node: LinearIssueNode | null | undefined, attempt: IssueAttempt): CreatedIssue {
  const teamId = linearTeamId(attempt.repository);
  const number = node?.number;
  const identifier = node?.identifier;
  let url: URL | undefined;
  try {
    url = typeof node?.url === 'string' ? new URL(node.url) : undefined;
  } catch {
    url = undefined;
  }
  if (
    !node ||
    node.id !== attempt.id ||
    node.team?.id !== teamId ||
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    typeof identifier !== 'string' ||
    !new RegExp(`^[A-Z][A-Z0-9_]{0,9}-${number}$`).test(identifier) ||
    !url ||
    url.protocol !== 'https:' ||
    url.hostname !== 'linear.app' ||
    url.username ||
    url.password ||
    !url.pathname.split('/').some(
      (segment, index, segments) => segment === identifier && segments[index - 1] === 'issue',
    )
  )
    throw new LinearRequestError(
      'Linear returned an unexpected issue response. Check the team before retrying.',
      false,
    );
  return { number, identifier, url: url.href, repository: attempt.repository };
}

/** The attempt ID is the Linear issue ID, so a lost response can be found again. */
export async function findLinearIssue(
  attempt: IssueAttempt,
  apiKey: string,
  signal?: AbortSignal,
): Promise<CreatedIssue | undefined> {
  const data = await linearRequest<{ issues?: { nodes?: LinearIssueNode[] } }>(
    apiKey,
    `query SessionRecorderIssue($id: ID!) { issues(filter: { id: { eq: $id } }, first: 1, includeArchived: true) { nodes { ${ISSUE_FIELDS} } } }`,
    { id: attempt.id },
    signal,
  );
  const node = data.issues?.nodes?.[0];
  return node ? result(node, attempt) : undefined;
}

export async function createLinearIssue(
  attempt: IssueAttempt,
  apiKey: string,
  draft: IssueDraft,
  reportUrl: string,
  signal?: AbortSignal,
): Promise<CreatedIssue> {
  const data = await linearRequest<{
    issueCreate?: { success?: unknown; issue?: LinearIssueNode | null };
  }>(
    apiKey,
    `mutation SessionRecorderIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
    {
      input: {
        id: attempt.id,
        teamId: linearTeamId(attempt.repository),
        title: draft.title.trim().slice(0, 120),
        description: issueBody(draft, reportUrl),
      },
    },
    signal,
  );
  if (data.issueCreate?.success !== true)
    throw new LinearRequestError(
      'Linear did not confirm the issue. Check Linear issue to look for it before retrying.',
      false,
    );
  return result(data.issueCreate.issue, attempt);
}
