import { ProoflineBrand } from '@/lib/ui/ProoflineBrand';
import { FilingProgress } from './FilingProgress';
import { destinationLabel, issueDestinations } from '@/lib/sharing/settings';
import { issueLabel } from '@/lib/sharing/github';
import { isLinearDestination } from '@/lib/sharing/linear';
import { GitHubIcon } from '@/lib/ui/GitHubIcon';
import React, { useReducer } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  LockKeyhole,
  Settings,
  Film,
  ArrowLeft,
  Pencil,
  Check,
  SquareKanban,
} from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { formatClock } from '@/lib/export/markdown';
import type { VerbosityLevel } from '@/lib/session/types';
import {
  isProoflinePublication,
  publicationUrl,
  REPORT_LEVELS,
} from '@/lib/sharing/draft';
import { useShareReport } from './useShareReport';
import { useReportEvidence, type EvidenceItem } from './useReportEvidence';

const params = new URLSearchParams(location.search);
const sessionId = params.get('session') ?? '';
const initialLevel =
  REPORT_LEVELS.find((l) => l.id === params.get('level'))?.id ?? 'L1';
type ShareModel = ReturnType<typeof useShareReport>;
const optionsUrl = (section: string) =>
  chrome.runtime.getURL(`options.html#${section}`);
const recordingUrl = () =>
  `${chrome.runtime.getURL('report.html')}?session=${encodeURIComponent(sessionId)}`;

export function App(): React.JSX.Element {
  const share = useShareReport(sessionId, initialLevel);
  const { state } = share;
  if (state.operation === 'github') return <FilingProgress share={share} />;
  return (
    <main className="report-workspace">
      <nav className="report-rail" aria-label="Report navigation">
        <a className="report-brand" href={optionsUrl('storage')}>
          <ProoflineBrand compact />
        </a>
        <a className="rail-link" href={optionsUrl('storage')}>
          <Film size={16} />
          Sessions
        </a>
        <div className="rail-session" aria-current="page">
          <span>{state.session?.name || 'Current recording'}</span>
          <small>
            {state.session
              ? formatClock(
                  (state.session.endedAt ?? Date.now()) - state.session.startedAt,
                )
              : 'Loading…'}
          </small>
        </div>
        <a className="rail-link rail-settings" href={optionsUrl('capture')}>
          <Settings size={16} />
          Settings
        </a>
      </nav>
      <div className="report-workarea">
        <header className="report-toolbar">
          <a href={optionsUrl('storage')} className="report-back" aria-label="Sessions">
            <ArrowLeft size={16} />
          </a>
          <span className="toolbar-context">Sessions</span>
          <ChevronRight size={13} />
          <span>Issue draft</span>
          <div className="toolbar-end">
            <span className="draft-status">
              {state.issue
                ? 'Filed'
                : share.ready
                  ? 'Published'
                  : state.publication
                    ? 'Upload incomplete'
                    : 'Saved locally'}
            </span>
            <FileIssueAction share={share} />
          </div>
        </header>
        <ShareStatus share={share} />
        {state.loading ? (
          <p className="report-loading" role="status">
            Loading recording…
          </p>
        ) : (
          state.session && (
            <div className="report-columns">
              <article className="report-document">
                <IssueDraft share={share} />
                <Evidence />
                <AdvancedReport share={share} />
              </article>
              <ReportDetails share={share} />
            </div>
          )
        )}
      </div>
    </main>
  );
}
function TrackerIcon({ destination }: { destination: string }) {
  return isLinearDestination(destination) ? <SquareKanban size={14} /> : <GitHubIcon size={14} />;
}
function FileIssueAction({ share }: { share: ShareModel }) {
  const { state, busy, publishLimit, actions } = share;
  if (state.issue)
    return (
      <a
        className="btn btn--primary"
        href={state.issue.url}
        target="_blank"
        rel="noreferrer"
      >
        <TrackerIcon destination={state.issue.repository} />
        View issue {issueLabel(state.issue)}
      </a>
    );
  const destinations = issueDestinations(state.settings);
  const repositories = state.repository && !destinations.some((entry) => entry.value === state.repository)
    ? [{ value: state.repository, label: destinationLabel(state.settings, state.repository) }, ...destinations]
    : destinations;
  const tracker = isLinearDestination(state.repository) ? 'Linear' : 'GitHub';
  return (
    <div className="file-issue-split">
      <button
        className="btn btn--primary"
        type="button"
        aria-label={state.attempt ? `Check ${tracker} issue` : `File ${tracker} issue`}
        disabled={busy || state.preparing || !state.files.length || !!publishLimit}
        onClick={() => void actions.submitIssue()}
        autoFocus={!!state.error}
      >
        <TrackerIcon destination={state.repository} />
        {state.attempt ? `Check ${tracker} issue` : 'File issue'}
      </button>
      <label
        className="issue-destination"
        title={destinationLabel(state.settings, state.repository) || 'Select a repository'}
      >
        <select
          aria-label="Issue repository"
          value={state.repository}
          disabled={busy || !!state.attempt || !repositories.length}
          onChange={(event) => actions.editRepository(event.target.value)}
        >
          {!state.repository && (
            <option value="" disabled>
              Select repository
            </option>
          )}
          {repositories.map((destination) => (
            <option key={destination.value} value={destination.value}>
              {destination.label}
            </option>
          ))}
        </select>
        <ChevronDown size={14} aria-hidden="true" />
      </label>
    </div>
  );
}
function ShareStatus({ share }: { share: ShareModel }) {
  const { state, busy, actions, publishLimit } = share;
  if (!state.phase && !state.error && !busy && !publishLimit) return null;
  return (
    <div className="report-feedback" aria-live="polite">
      {state.phase && <span role="status">{state.phase}</span>}
      {(state.error || publishLimit) && (
        <span className="export__error" role="alert">
          {state.error || publishLimit}
        </span>
      )}
      {busy && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={actions.cancel}
        >
          Cancel
        </button>
      )}
    </div>
  );
}
function IssueDraft({ share }: { share: ShareModel }) {
  const { state, busy, actions } = share;
  const [editing, toggleEditing] = useReducer((value: boolean) => !value, false);
  const hasModel =
    !!state.settings.models[state.settings.provider].model.trim() &&
    !!(
      state.settings.models[state.settings.provider].apiKey.trim() ||
      state.settings.provider === 'compatible'
    );
  const initial =
    state.draftSource === 'initial' || state.draftSource === 'title-edited';
  const html = DOMPurify.sanitize(
    marked.parse(state.draft.body, { async: false }) as string,
  );
  return (
    <section className="issue-draft" aria-label="Issue draft">
      <textarea
        rows={1}
        className="issue-title"
        aria-label="Issue title"
        value={state.draft.title}
        maxLength={120}
        disabled={busy || !!state.issue}
        onChange={(e) => actions.editDraft({ title: e.target.value })}
      />
      <div className="draft-tools">
        <span className="muted">
          {initial
            ? hasModel
              ? 'Summary generated when you file'
              : 'Recorded session'
            : state.draftSource === 'generated'
              ? 'Generated summary'
              : 'Your summary'}
        </span>
        <button
          type="button"
          className="text-action"
          disabled={busy || !!state.issue}
          onClick={toggleEditing}
        >
          {editing ? <Check size={13} /> : <Pencil size={13} />}{' '}
          {editing ? 'Done' : 'Edit draft'}
        </button>
      </div>
      {editing ? (
        <textarea
          className="draft-editor"
          aria-label="Issue summary · Markdown"
          rows={10}
          value={state.draft.body}
          disabled={busy}
          onChange={(e) => actions.editDraft({ body: e.target.value })}
        />
      ) : initial ? (
        <p className="draft-placeholder">
          {hasModel
            ? 'Your recording, annotations, and captured errors will become the issue summary.'
            : 'Add a summary, or configure AI summaries in settings. Your recording will be linked in the issue.'}
        </p>
      ) : (
        <div className="issue-prose" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </section>
  );
}
function Evidence() {
  const { items, diagnostics, error } = useReportEvidence(sessionId);
  const lead = items.find((item) => item.label === 'Annotation') ?? items[0];
  const others = items.filter((item) => item !== lead);
  return (
    <section className="report-evidence" aria-labelledby="evidence-title">
      <div className="section-heading">
        <h2 id="evidence-title">Evidence</h2>
        <a
          className="text-action"
          href={recordingUrl()}
          target="_blank"
          rel="noreferrer"
        >
          Full timeline <ExternalLink size={12} />
        </a>
      </div>
      {error && <p role="alert">{error}</p>}
      {lead ? (
        <EvidenceRow item={lead} />
      ) : (
        <p className="muted">No screenshots or annotations in this recording.</p>
      )}
      {!!others.length && (
        <details className="report-disclosure">
          <summary>
            More evidence <span>{others.length}</span>
            <ChevronDown size={14} />
          </summary>
          {others.map((item) => (
            <EvidenceRow key={item.id} item={item} />
          ))}
        </details>
      )}
      {!!diagnostics.length && (
        <details className="report-disclosure">
          <summary>
            Technical details <span>{diagnostics.length} events</span>
            <ChevronDown size={14} />
          </summary>
          <p className="muted">
            Console and network events captured during this recording.
          </p>
          <pre className="diagnostic-data">
            {JSON.stringify(diagnostics.slice(0, 100), null, 2)}
          </pre>
          {diagnostics.length > 100 && <a href={recordingUrl()}>View all events</a>}
        </details>
      )}
    </section>
  );
}
function EvidenceRow({ item }: { item: EvidenceItem }) {
  return (
    <figure className="evidence-item">
      <figcaption>
        <span>{item.label}</span>
        <time>{formatClock(item.time)}</time>
      </figcaption>
      {item.image && (
        <a href={item.image} target="_blank" rel="noreferrer">
          <img src={item.image} alt={item.comments[0] || item.label} loading="lazy" />
        </a>
      )}
      {item.comments.map((comment, index) => (
        <p className="evidence-comment" key={index}>
          <span className="comment-number">{index + 1}</span>
          {comment}
        </p>
      ))}
    </figure>
  );
}
function ReportDetails({ share }: { share: ShareModel }) {
  const { state, busy, ready, actions } = share;
  return (
    <aside className="report-details" aria-label="Report details">
      <h2>Issue details</h2>
      {isLinearDestination(state.repository) ? (
        <div className="detail-field">
          <span>Destination</span>
          <span>{destinationLabel(state.settings, state.repository)}</span>
        </div>
      ) : (
        <label className="detail-field">
          <span>Repository</span>
          <input
            aria-label="GitHub repository"
            value={state.repository}
            disabled={busy || !!state.issue || !!state.attempt}
            placeholder="owner/repository"
            onChange={(e) => actions.editRepository(e.target.value)}
          />
        </label>
      )}
      <dl>
        <div>
          <dt>Status</dt>
          <dd>
            {state.issue
              ? 'Filed'
              : ready
                ? 'Published'
                : state.publication
                  ? 'Upload incomplete'
                  : 'Draft'}
          </dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd>
            {state.session &&
              new Date(state.session.startedAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
          </dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>
            {state.session &&
              formatClock(
                (state.session.endedAt ?? state.session.startedAt) -
                  state.session.startedAt,
              )}
          </dd>
        </div>
      </dl>
      <p className="report-protection">
        <LockKeyhole size={13} />
        Report requires sign-in
      </p>
      {state.publication && publicationUrl(state.publication) && (
        <a
          className="text-action"
          href={publicationUrl(state.publication)}
          target="_blank"
          rel="noreferrer"
        >
          {ready
            ? 'Open published report'
            : isProoflinePublication(state.publication)
              ? 'Open partial report'
              : 'Deployment created'}
          <ExternalLink size={12} />
        </a>
      )}
      <a className="text-action details-settings" href={optionsUrl('github')}>
        Sharing settings
      </a>
      {state.publication && !ready && (
        <button
          className="btn btn--sm"
          disabled={busy}
          onClick={() => void actions.checkDeployment()}
        >
          {isProoflinePublication(state.publication)
            ? 'Resume upload'
            : 'Check deployment'}
        </button>
      )}
    </aside>
  );
}
function AdvancedReport({ share }: { share: ShareModel }) {
  const { state, busy, actions, totalBytes, ready, finalBody } = share;
  return (
    <details className="report-disclosure advanced-report">
      <summary>
        Report options
        <ChevronDown size={14} />
      </summary>
      <div className="advanced-fields">
        <label className="detail-field">
          <span>Report detail</span>
          <select
            value={state.level}
            disabled={busy || !!state.publication}
            onChange={(e) => actions.changeLevel(e.target.value as VerbosityLevel)}
          >
            {REPORT_LEVELS.map((level) => (
              <option key={level.id} value={level.id}>
                {level.label}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {state.files.length} files · {(totalBytes / 1048576).toFixed(1)} MiB
        </span>
        <button
          className="btn btn--sm"
          disabled={busy || !state.evidence}
          onClick={() => void actions.generate()}
        >
          Regenerate summary
        </button>
        <details>
          <summary>Text sent to the model</summary>
          <pre className="diagnostic-data">{state.evidence}</pre>
        </details>
        <details>
          <summary>Files to publish</summary>
          <ul>
            {state.files.map((file) => (
              <li key={file.path}>{file.path}</li>
            ))}
          </ul>
        </details>
        <p className="muted">
          The issue follows the repository’s visibility. The full report requires
          sign-in.
        </p>
        {!state.publication ? (
          <button
            className="btn btn--sm"
            disabled={busy || !state.files.length}
            onClick={() => void actions.publish()}
          >
            Publish report only
          </button>
        ) : (
          <>
            <button
              className="btn btn--sm"
              disabled={busy || !ready}
              onClick={() => void actions.copyIssue()}
            >
              Copy issue Markdown
            </button>
            <details>
              <summary>GitHub Markdown</summary>
              <textarea
                aria-label="Final GitHub Markdown"
                className="draft-editor"
                readOnly
                value={finalBody}
                rows={8}
              />
            </details>
            {state.confirmingDelete ? (
              <div>
                <p>Delete this deployment? Existing report links will stop working.</p>
                <button
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() => void actions.unpublish()}
                >
                  Delete deployment
                </button>{' '}
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => actions.confirmDelete(false)}
                >
                  Keep report
                </button>
              </div>
            ) : (
              <button
                className="text-action"
                disabled={busy}
                onClick={() => actions.confirmDelete(true)}
              >
                Unpublish report…
              </button>
            )}
          </>
        )}
      </div>
    </details>
  );
}
