import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A minimal stand-in for the `idb` connection used by `getSession`. */
const connection = {
  get: vi.fn(async () => undefined),
};

let failOpens = 0;
let terminate: (() => void) | undefined;

const openDB = vi.fn(async (_name: string, _version: number, callbacks: { terminated?: () => void }) => {
  if (failOpens > 0) {
    failOpens -= 1;
    throw new DOMException('The database could not be opened.', 'UnknownError');
  }
  terminate = callbacks.terminated;
  return connection;
});

vi.mock('idb', () => ({ openDB }));

const { getSession } = await import('./index');

describe('database connection', () => {
  beforeEach(() => {
    failOpens = 0;
    openDB.mockClear();
    // Close any connection a previous test left open.
    terminate?.();
    terminate = undefined;
  });

  it('opens once and reuses the connection', async () => {
    await getSession('ses_1');
    await getSession('ses_1');
    expect(openDB).toHaveBeenCalledTimes(1);
  });

  it('tries to open again after a failed open', async () => {
    failOpens = 1;
    await expect(getSession('ses_1')).rejects.toThrow('could not be opened');
    await expect(getSession('ses_1')).resolves.toBeUndefined();
    expect(openDB).toHaveBeenCalledTimes(2);
  });

  it('opens a new connection after the browser closes the old one', async () => {
    await getSession('ses_1');
    terminate?.();
    await getSession('ses_1');
    expect(openDB).toHaveBeenCalledTimes(2);
  });
});
