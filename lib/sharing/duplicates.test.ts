import { afterEach, describe, expect, it, vi } from 'vitest';
import { findDuplicates } from './duplicates';

const fp = {
  id: 'sr-7c41e9a2b3d0',
  message: "TypeError: Cannot read properties of undefined (reading 'total') at <url>",
};
function respond(json: unknown, status = 200) {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
interface Item {
  number: number;
  title?: string;
  state?: string;
  body?: string | null;
  pull_request?: unknown;
}
const issue = (number: number, extra: Partial<Item> = {}): Item => ({
  number,
  title: `Issue ${number}`,
  state: 'open',
  body: `Report\nError fingerprint: \`${fp.id}\``,
  ...extra,
});
/** Answers the exact (fingerprint) and message searches separately. */
function search(results: { exact?: Item[]; message?: Item[] }) {
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const query = new URL(String(input)).searchParams.get('q') ?? '';
    const items = query.includes(fp.id) ? results.exact : results.message;
    return respond({ total_count: items?.length ?? 0, items: items ?? [] });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const queries = (fetch: ReturnType<typeof search>) =>
  fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('q'));
afterEach(() => vi.unstubAllGlobals());

describe('duplicate search', () => {
  it('searches the repository’s issues for the fingerprint and the message', async () => {
    const fetch = search({});
    await findDuplicates('https://github.com/Owner/Repo', 'token', fp);
    expect(queries(fetch)).toEqual([
      'repo:Owner/Repo is:issue "sr-7c41e9a2b3d0"',
      'repo:Owner/Repo is:issue "TypeError: Cannot read properties of undefined (reading \'total\') at"',
    ]);
    for (const [url, init] of fetch.mock.calls) {
      const parsed = new URL(String(url));
      expect(parsed.origin + parsed.pathname).toBe('https://api.github.com/search/issues');
      expect(String(url)).not.toMatch(/[ "]/);
      expect(init?.redirect).toBe('error');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token');
    }
  });
  it('searches the longest literal run of the message, capped at 100 characters', async () => {
    const fetch = search({});
    await findDuplicates('owner/repo', 'token', {
      id: fp.id,
      message: `Order <uuid> failed: "quantity" ${'x'.repeat(150)} <n> short`,
    });
    expect(queries(fetch)[1]).toBe(`repo:owner/repo is:issue "${'x'.repeat(100)}"`);
  });
  it('counts a fingerprint result only when its body contains the fingerprint', async () => {
    search({
      exact: [
        issue(118),
        issue(119, { body: 'Mentions sr-7c41e9a2 only in part' }),
        issue(120, { body: null }),
      ],
    });
    const matches = await findDuplicates('owner/repo', 'token', fp);
    expect(matches.exact.map((match) => match.number)).toEqual([118]);
    expect(matches.exact[0]).toEqual({
      number: 118,
      title: 'Issue 118',
      url: 'https://github.com/owner/repo/issues/118',
      state: 'open',
    });
  });
  it('skips the message search when its literal text is shorter than 12 characters', async () => {
    for (const message of ['TypeError: <str>', '<n> <uuid>', '']) {
      const fetch = search({});
      await findDuplicates('owner/repo', 'token', { id: fp.id, message });
      expect(queries(fetch)).toEqual(['repo:owner/repo is:issue "sr-7c41e9a2b3d0"']);
    }
  });
  it('lists related issues once, without pull requests, at most five each, marking closed ones', async () => {
    search({
      exact: [issue(118), issue(97, { state: 'closed' }), { number: 5, title: 'PR', pull_request: {} }],
      message: [
        issue(118),
        issue(61, { state: 'closed', body: 'Different text' }),
        { number: 62, pull_request: { url: 'x' }, title: 'A pull request' },
        { number: 0, title: 'Invalid' },
        { number: 63, title: undefined },
        ...[64, 65, 66, 67, 68, 69].map((number) => issue(number, { body: '' })),
      ],
    });
    const matches = await findDuplicates('owner/repo', 'token', fp);
    expect(matches.exact.map(({ number, state }) => [number, state])).toEqual([
      [118, 'open'],
      [97, 'closed'],
    ]);
    expect(matches.related.map((match) => match.number)).toEqual([61, 64, 65, 66, 67]);
    expect(matches.related[0]!.state).toBe('closed');
  });
  it.each([403, 422, 500])('explains a failed search (%s)', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('sr-')
          ? respond({ items: [] })
          : respond({ message: 'API rate limit exceeded' }, status),
      ),
    );
    await expect(findDuplicates('owner/repo', 'token', fp)).rejects.toThrow(
      `Couldn't check for duplicates (${status}).`,
    );
  });
});
