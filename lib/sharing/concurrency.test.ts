import { describe, expect, it } from 'vitest';
import {
  waitWithSignal,
  publicationOperationKey,
} from './concurrency';

describe('sharing concurrency', () => {
  it('returns the result of completed work', async () => {
    const controller = new AbortController();

    await expect(
      waitWithSignal(Promise.resolve(42), controller.signal),
    ).resolves.toBe(42);
  });

  it('rejects when the underlying work fails', async () => {
    const controller = new AbortController();

    await expect(
      waitWithSignal(
        Promise.reject(new Error('storage failed')),
        controller.signal,
      ),
    ).rejects.toThrow('storage failed');
  });

  it('cancels waiting without discarding pending work', async () => {
    const controller = new AbortController();
    let finish!: (value: string) => void;

    const pending = new Promise<string>(resolve => {
      finish = resolve;
    });

    const waiting = waitWithSignal(
      pending,
      controller.signal,
    );

    const assertion = expect(waiting).rejects.toMatchObject({
      name: 'AbortError',
    });

    controller.abort();
    await assertion;

    finish('draft saved');

    await expect(pending).resolves.toBe('draft saved');
  });

  it('rejects immediately for an already cancelled caller', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitWithSignal(
        Promise.resolve('saved'),
        controller.signal,
      ),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('separates operation locks from draft storage locks', () => {
    const draftKey = 'shareDraft:session-1';

    expect(publicationOperationKey(draftKey))
      .not.toBe(draftKey);

    expect(publicationOperationKey(draftKey))
      .not.toBe(publicationOperationKey('shareDraft:session-2'));
  });
});

import { samePublication } from './concurrency';
import type { ProoflinePublication } from './draft';

describe('publication identity', () => {
  const original: ProoflinePublication = {
    provider: 'proofline',
    id: 'report-1',
    organizationId: 'org-1',
    url: 'https://proofline.sh/reports/report-1',
    level: 'L1',
    requestId: 'request-1',
    attachments: [
      {
        path: 'report.json',
        requestId: 'attachment-1',
        uploaded: false,
      },
    ],
  };

  it('recognizes the same report after attachment progress', () => {
    expect(samePublication(original, {
      ...original,
      attachments: original.attachments.map(asset => ({
        ...asset,
        uploaded: true,
      })),
    })).toBe(true);
  });

  it('recognizes a pending report after its ID is assigned', () => {
    expect(samePublication({
      ...original,
      id: '',
      url: '',
    }, original)).toBe(true);
  });

  it('rejects a replacement report', () => {
    expect(samePublication(original, {
      ...original,
      id: 'report-2',
      requestId: 'request-2',
    })).toBe(false);
  });

  it('rejects a different workspace', () => {
    expect(samePublication(original, {
      ...original,
      organizationId: 'org-2',
    })).toBe(false);
  });

  it('rejects conflicting assigned report IDs', () => {
    expect(samePublication(original, {
      ...original,
      id: 'report-2',
    })).toBe(false);
  });

  it('rejects different publication requests', () => {
    expect(samePublication(original, {
      ...original,
      requestId: 'request-2',
    })).toBe(false);
  });

  it('rejects a publication that has been deleted', () => {
    expect(samePublication(original, undefined)).toBe(false);
    expect(samePublication(undefined, original)).toBe(false);
  });

  it('recognizes two absent publications', () => {
    expect(samePublication(undefined, undefined)).toBe(true);
  });
});
