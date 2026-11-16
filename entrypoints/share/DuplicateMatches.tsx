import { useId } from 'react';
import type { DuplicateIssue } from '@/lib/sharing/duplicates';
import type { useShareReport } from './useShareReport';

type ShareModel = ReturnType<typeof useShareReport>;

/** Issues that may already describe this recording's error, under Issue details. */
export function DuplicateMatches({ share }: { share: ShareModel }) {
  const { state, busy, blocked, triageManaged, actions } = share;
  const id = useId();
  const { duplicates } = state;
  // Hidden for managed filing, without a fingerprint or token (never searched) and once filed.
  if (!state.fingerprint || triageManaged || state.issue || duplicates.status === 'idle')
    return null;
  const locked = busy || !!state.attempt;
  // Add to needs the same prepared, publishable report as File issue.
  const filingLocked = locked || !!blocked;
  const list = (key: string, title: string, issues: DuplicateIssue[]) =>
    !!issues.length && (
      <>
        <h4 id={`${id}-${key}`}>{title}</h4>
        <ul className="duplicate-list" aria-labelledby={`${id}-${key}`}>
          {issues.map((issue) => (
            <li key={issue.number} className="duplicate-item">
              <div className="duplicate-row">
                <a href={issue.url} target="_blank" rel="noreferrer">
                  <span className="duplicate-number">#{issue.number}</span> {issue.title}
                </a>
                <span className="duplicate-state">{issue.state}</span>
              </div>
              {issue.state === 'closed' && (
                <span className="duplicate-note">possible regression</span>
              )}
              <button
                type="button"
                className="btn btn--sm"
                disabled={filingLocked}
                onClick={() => actions.addToIssue(issue.number)}
              >
                Add to #{issue.number}
              </button>
            </li>
          ))}
        </ul>
      </>
    );
  return (
    <section className="duplicates" aria-labelledby={`${id}-title`} aria-live="polite">
      <div className="duplicates-heading">
        <h3 id={`${id}-title`}>Possible duplicates</h3>
        <code title="Error fingerprint">{state.fingerprint.id}</code>
      </div>
      {duplicates.status === 'loading' ? (
        <p className="duplicate-message">Checking for duplicates…</p>
      ) : duplicates.status === 'error' ? (
        <>
          <p className="duplicate-message">{duplicates.error}</p>
          <button
            type="button"
            className="btn btn--sm"
            disabled={locked}
            onClick={actions.checkDuplicates}
          >
            Retry
          </button>
        </>
      ) : duplicates.exact.length || duplicates.related.length ? (
        <>
          {(!!state.labels.length || !!state.assignees.length) && (
            <p className="duplicate-message">Labels and assignees apply only to new issues.</p>
          )}
          {list('exact', 'Same error', duplicates.exact)}
          {list('related', 'Possibly related', duplicates.related)}
        </>
      ) : (
        <p className="duplicate-message">No matching issues</p>
      )}
    </section>
  );
}
