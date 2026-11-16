import { Check, Circle } from 'lucide-react';
import { GitHubIcon } from '@/lib/ui/GitHubIcon';
import { FilingActivity } from './FilingActivity';
import type { FilingStage } from '@/lib/sharing/file-issue';
import type { useShareReport } from './useShareReport';

const STAGES: { id: FilingStage; label: string }[] = [
  { id: 'connection', label: 'Check repository access' },
  { id: 'summary', label: 'Prepare issue summary' },
  { id: 'publish', label: 'Publish protected report' },
  { id: 'issue', label: 'Create GitHub issue' },
];

export function FilingProgress({ share }: { share: ReturnType<typeof useShareReport> }) {
  const { state, actions } = share;
  const current = STAGES.findIndex((stage) => stage.id === state.stage);
  const target = state.attempt?.issueNumber ?? state.addTo?.number;
  const stages = target
    ? STAGES.map((stage) => (stage.id === 'issue' ? { ...stage, label: `Add to #${target}` } : stage))
    : STAGES;
  return (
    <main className="filing-screen" aria-labelledby="filing-title">
      <div className="filing-progress">
        <div className="filing-heading">
          <GitHubIcon size={24} />
          <h1 id="filing-title">{state.cancelling ? 'Cancelling…' : 'Filing your issue'}</h1>
        </div>
        {state.draft.title.trim() && <p className="filing-issue-title">{state.draft.title}</p>}
        <p className="filing-repository">{state.attempt?.repository ?? state.repository}</p>
        <ol className="filing-stages" aria-label="Filing progress">
          {stages.map((stage, index) => (
            <li key={stage.id} data-state={index < current ? 'done' : index === current ? 'active' : 'pending'} aria-current={index === current ? 'step' : undefined}>
              <span className="filing-stage-icon">
                {index < current ? <Check size={16} /> : index === current ? <FilingActivity stage={stage.id} /> : <Circle size={16} />}
              </span>
              <span>{stage.label}</span>
              {index < current && <span className="sr-only">Complete</span>}
            </li>
          ))}
        </ol>
        <p className="filing-phase" role="status" aria-live="polite">{state.phase}</p>
        <button type="button" className="btn" onClick={actions.cancel} disabled={state.cancelling} autoFocus>
          {state.cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      </div>
    </main>
  );
}
