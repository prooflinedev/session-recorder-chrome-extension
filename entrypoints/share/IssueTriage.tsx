import React, { useId, useState } from 'react';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import { notApplied, repositoryPath } from '@/lib/sharing/github';
import type { TriageOptions, useShareReport } from './useShareReport';

type ShareModel = ReturnType<typeof useShareReport>;
/** GitHub accepts at most ten assignees per issue. */
const MAX_ASSIGNEES = 10;

function displayRepository(repository: string): string {
  try {
    return repositoryPath(repository);
  } catch {
    return repository;
  }
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Optional labels and assignees for personal-token filing, under the Repository field. */
export function IssueTriage({ share }: { share: ShareModel }) {
  const { state, busy, triageManaged, triageOptions, actions } = share;
  if (triageManaged) return null;
  const colors = new Map(
    triageOptions.labels.map((label) => [label.name.toLowerCase(), label.color]),
  );
  const labelChip = (name: string) => {
    const color = colors.get(name.toLowerCase());
    return (
      <span className="triage-chip" key={name}>
        <span className="triage-dot" style={color ? { background: `#${color}` } : undefined} />
        {name}
      </span>
    );
  };
  const assigneeChip = (login: string) => (
    <span className="triage-chip" key={login}>
      @{login}
    </span>
  );
  if (busy || state.attempt || state.issue) {
    // Filed issues show what GitHub applied; pending requests show what was asked for.
    const labels = state.issue ? (state.issue.labels ?? []) : state.labels;
    const assignees = state.issue ? (state.issue.assignees ?? []) : state.assignees;
    const dropped =
      state.issue?.labels &&
      notApplied({ labels: state.labels, assignees: state.assignees }, state.issue);
    const missing = dropped
      ? [...dropped.labels, ...dropped.assignees.map((login) => `@${login}`)]
      : [];
    return (
      <>
        <div className="detail-field triage-field">
          <span>Labels</span>
          <div>
            <Chips>{labels.map(labelChip)}</Chips>
          </div>
        </div>
        <div className="detail-field triage-field">
          <span>Assignees</span>
          <div>
            <Chips>{assignees.map(assigneeChip)}</Chips>
          </div>
        </div>
        {!!missing.length && (
          <p className="triage-warning">
            <TriangleAlert size={13} aria-hidden="true" />
            GitHub did not apply {missing.join(', ')}. Check write access to{' '}
            {state.issue!.repository}.
          </p>
        )}
      </>
    );
  }
  const repository = displayRepository(state.repository);
  return (
    <React.Fragment key={`${repository.toLowerCase()}:${share.triageRevision}`}>
      <TriagePicker
        title="Labels"
        noun="labels"
        repository={repository}
        options={triageOptions}
        values={triageOptions.labels.map((label) => ({ value: label.name, color: label.color }))}
        selected={state.labels}
        dots
        chip={labelChip}
        onOpen={() => void actions.loadTriageOptions()}
        onChange={(labels) => actions.editTriage(labels, state.assignees)}
      />
      <TriagePicker
        title="Assignees"
        noun="assignees"
        repository={repository}
        options={triageOptions}
        values={triageOptions.assignees.map((login) => ({ value: login }))}
        selected={state.assignees}
        limit={MAX_ASSIGNEES}
        chip={assigneeChip}
        onOpen={() => void actions.loadTriageOptions()}
        onChange={(assignees) => actions.editTriage(state.labels, assignees)}
      />
    </React.Fragment>
  );
}

function Chips({ children }: { children: React.ReactNode[] }) {
  return (
    <span className="triage-chips">
      {children.length ? children : <span className="muted">None</span>}
    </span>
  );
}

function TriagePicker(props: {
  title: string;
  noun: string;
  repository: string;
  options: TriageOptions;
  values: { value: string; color?: string }[];
  selected: string[];
  limit?: number;
  dots?: boolean;
  chip: (value: string) => React.ReactNode;
  onOpen: () => void;
  onChange: (selected: string[]) => void;
}) {
  const { title, noun, options, selected, limit } = props;
  const id = useId();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  // Keep remembered values that the repository no longer lists, so they can be cleared.
  const all = [
    ...selected
      .filter((value) => !props.values.some((option) => same(option.value, value)))
      .map((value) => ({ value, color: undefined as string | undefined })),
    ...props.values,
  ];
  const shown = all.filter((option) =>
    option.value.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const toggle = (value: string, checked: boolean) =>
    props.onChange(
      checked
        ? [...selected, value]
        : selected.filter((entry) => !same(entry, value)),
    );
  return (
    <div className="detail-field triage-field">
      <span id={`${id}-name`}>{title}</span>
      <details
        className="triage-picker"
        onToggle={(event) => {
          const next = event.currentTarget.open;
          setOpen(next);
          if (next) props.onOpen();
        }}
      >
        <summary aria-labelledby={`${id}-name`} aria-describedby={`${id}-value`}>
          <span id={`${id}-value`}>
            <Chips>{selected.map(props.chip)}</Chips>
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </summary>
        {open && (
          <div className="triage-panel" aria-live="polite">
            {options.status === 'error' ? (
              <>
                <p className="triage-message">{options.error}</p>
                <button type="button" className="btn btn--sm" onClick={props.onOpen}>
                  Retry
                </button>
              </>
            ) : options.status !== 'ready' ? (
              <p className="triage-message">Loading {noun}…</p>
            ) : !options.canTriage ? (
              <p className="triage-message">
                You need write access to {props.repository} to set labels or assignees.
              </p>
            ) : (
              <>
                <input
                  type="search"
                  aria-label={`Filter ${noun}`}
                  placeholder={`Filter ${noun}`}
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
                {shown.length ? (
                  <ul className="triage-options">
                    {shown.map((option) => {
                      const checked = selected.some((value) => same(value, option.value));
                      return (
                        <li key={option.value}>
                          <label className="triage-option">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!checked && !!limit && selected.length >= limit}
                              onChange={(event) => toggle(option.value, event.target.checked)}
                            />
                            {props.dots && (
                              <span
                                className="triage-dot"
                                style={option.color ? { background: `#${option.color}` } : undefined}
                              />
                            )}
                            {option.value}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="triage-message">No matching {noun}.</p>
                )}
              </>
            )}
          </div>
        )}
      </details>
    </div>
  );
}
