import {
  isProoflinePublication,
  type Publication,
} from './draft';

/**
 * Cancel the caller's wait without cancelling the underlying work.
 * Pending draft edits must still finish after publication is cancelled.
 */
export async function waitWithSignal<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();

  let onAbort: (() => void) | undefined;

  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Compare stable publication identities, not mutable readiness or
 * attachment-upload state.
 */
export function samePublication(
  left: Publication | undefined,
  right: Publication | undefined,
): boolean {
  if (!left || !right) return left === right;

  if (isProoflinePublication(left)) {
    return (
      isProoflinePublication(right) &&
      left.organizationId === right.organizationId &&
      left.requestId === right.requestId &&
      (!left.id || !right.id || left.id === right.id)
    );
  }

  return (
    !isProoflinePublication(right) &&
    left.deployment.id === right.deployment.id &&
    left.destination.accountId === right.destination.accountId &&
    left.destination.projectName === right.destination.projectName
  );
}

/**
 * External operations acquire this lock before taking the short-lived
 * draft storage lock. Draft edits never acquire the operation lock.
 */
export function publicationOperationKey(draftKey: string): string {
  return `${draftKey}:operation`;
}
