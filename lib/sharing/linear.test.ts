import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLinearIssue,
  findLinearIssue,
  linearDestination,
  LinearRequestError,
  listLinearTeams,
  verifyLinear,
} from './linear';

const KEY = 'lin_api_secretKEY123';
const TEAM = 'team-1';
const attempt = {
  id: '6f1c2f3e-7b4a-4f8e-9a51-0c2d3e4f5a6b',
  repository: linearDestination(TEAM),
  startedAt: '2026-11-06T10:00:00.000Z',
};
const node = {
  id: attempt.id,
  identifier: 'ENG-12',
  number: 12,
  url: 'https://linear.app/acme/issue/ENG-12/checkout-fails',
  team: { id: TEAM },
};
const draft = { title: 'Checkout fails', body: '## Summary\n500 on checkout' };
const reportUrl = 'https://abc.reports.pages.dev';

function respond(status: number, json: unknown) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
function sent(fetchMock: ReturnType<typeof respond>, call = 0) {
  const [url, init] = fetchMock.mock.calls[call] as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) };
}
async function failure(promise: Promise<unknown>): Promise<LinearRequestError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(LinearRequestError);
  return error as LinearRequestError;
}

afterEach(() => vi.unstubAllGlobals());

describe('Linear client', () => {
  it('sends a personal key without a Bearer prefix and never follows redirects', async () => {
    const fetchMock = respond(200, { data: { teams: { nodes: [{ id: TEAM, key: 'ENG', name: 'Engineering' }] } } });
    await expect(verifyLinear(KEY, TEAM)).resolves.toEqual({ id: TEAM, key: 'ENG', name: 'Engineering' });
    const { url, init } = sent(fetchMock);
    expect(url).toBe('https://api.linear.app/graphql');
    expect((init.headers as Record<string, string>).Authorization).toBe(KEY);
    expect(init.redirect).toBe('error');
  });

  it('rejects a team the key cannot see and keys with unexpected characters', async () => {
    respond(200, { data: { teams: { nodes: [{ id: 'other', key: 'OPS', name: 'Ops' }] } } });
    await expect(verifyLinear(KEY, TEAM)).rejects.toThrow('cannot access the selected team');
    const fetchMock = respond(200, {});
    await expect(listLinearTeams('lin_api_ключ')).rejects.toThrow('unexpected characters');
    await expect(listLinearTeams('lin api')).rejects.toThrow('unexpected characters');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates the issue with the saved attempt ID, the report link and no credential', async () => {
    const fetchMock = respond(200, { data: { issueCreate: { success: true, issue: node } } });
    const issue = await createLinearIssue(attempt, KEY, { ...draft, title: `  ${'x'.repeat(200)} ` }, reportUrl);
    expect(issue).toEqual({ number: 12, identifier: 'ENG-12', url: node.url, repository: 'linear:team-1' });
    const { init, body } = sent(fetchMock);
    expect(body.variables.input.id).toBe(attempt.id);
    expect(body.variables.input.teamId).toBe(TEAM);
    expect(body.variables.input.title).toHaveLength(120);
    expect(body.variables.input.description).toContain(`[Open the full report](${reportUrl}/)`);
    expect(body.variables.input.description).toContain('500 on checkout');
    expect(init.body).not.toContain(KEY);
  });

  it('looks an issue up by its attempt ID, including archived issues', async () => {
    let fetchMock = respond(200, { data: { issues: { nodes: [node] } } });
    await expect(findLinearIssue(attempt, KEY)).resolves.toMatchObject({ identifier: 'ENG-12' });
    const { body } = sent(fetchMock);
    expect(body.variables).toEqual({ id: attempt.id });
    expect(body.query).toContain('includeArchived: true');
    fetchMock = respond(200, { data: { issues: { nodes: [] } } });
    await expect(findLinearIssue(attempt, KEY)).resolves.toBeUndefined();
  });

  it.each([
    ['another issue ID', { id: 'other-id' }],
    ['another team', { team: { id: 'other-team' } }],
    ['another host', { url: 'https://linear.evil.example/acme/issue/ENG-12/x' }],
    ['plain http', { url: 'http://linear.app/acme/issue/ENG-12/x' }],
    ['credentials in the URL', { url: 'https://user:pw@linear.app/acme/issue/ENG-12/x' }],
    ['a path for another issue', { url: 'https://linear.app/acme/issue/ENG-13/x' }],
    ['a non-positive number', { number: 0, identifier: 'ENG-0' }],
    ['an identifier for another number', { identifier: 'ENG-99' }],
  ])('rejects a returned issue with %s as uncertain', async (_name, patch) => {
    respond(200, { data: { issueCreate: { success: true, issue: { ...node, ...patch } } } });
    const error = await failure(createLinearIssue(attempt, KEY, draft, reportUrl));
    expect(error.definitive).toBe(false);
  });

  it.each([
    ['HTTP 401', 401, {}, true],
    ['HTTP 403', 403, {}, true],
    ['HTTP 429', 429, {}, true],
    ['AUTHENTICATION_ERROR', 200, { errors: [{ extensions: { code: 'AUTHENTICATION_ERROR' } }] }, true],
    ['FORBIDDEN', 200, { errors: [{ extensions: { code: 'FORBIDDEN' } }] }, true],
    ['RATELIMITED', 400, { errors: [{ extensions: { code: 'RATELIMITED' } }] }, true],
    ['HTTP 500', 500, {}, false],
    ['a 200 with an unknown error', 200, { errors: [{ extensions: { code: 'SOMETHING_ELSE' } }] }, false],
    ['a duplicate ID', 200, { errors: [{ extensions: { code: 'INVALID_INPUT' } }] }, false],
    ['an unconfirmed create', 200, { data: { issueCreate: { success: false, issue: null } } }, false],
  ])('classifies %s', async (_name, status, payload, definitive) => {
    respond(status, payload);
    const error = await failure(createLinearIssue(attempt, KEY, draft, reportUrl));
    expect(error.definitive).toBe(definitive);
  });

  it('never puts the key or response text in error messages', async () => {
    const echoed = `Invalid input ${KEY} ${reportUrl}`;
    for (const [status, payload] of [
      [200, { errors: [{ message: echoed, extensions: { code: 'INVALID_INPUT', userPresentableMessage: echoed } }] }],
      [200, { errors: [{ message: echoed, extensions: { code: echoed } }] }],
      [401, { errors: [{ message: echoed }] }],
      [502, { message: echoed }],
    ] as const) {
      respond(status, payload);
      const error = await failure(createLinearIssue(attempt, KEY, draft, reportUrl));
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain('Invalid input');
      expect(error.message).not.toContain(reportUrl);
    }
  });
});
