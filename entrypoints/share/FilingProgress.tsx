import { Check, Circle } from 'lucide-react';
import { GitHubIcon } from '@/lib/ui/GitHubIcon';
import { isLinearDestination } from '@/lib/sharing/linear';
import { destinationLabel } from '@/lib/sharing/settings';
import { SquareKanban } from 'lucide-react';
import { FilingActivity } from './FilingActivity';
import type { FilingStage } from '@/lib/sharing/file-issue';
import type { useShareReport } from './useShareReport';

function stages(linear: boolean): { id: FilingStage; label: string }[] {
  return [
    { id: 'connection', label: linear ? 'Check Linear access' : 'Check repository access' },
    { id: 'summary', label: 'Prepare issue summary' },
    { id: 'publish', label: 'Publish protected report' },
    { id: 'issue', label: linear ? 'Create Linear issue' : 'Create GitHub issue' },
  ];
}

export function FilingProgress({ share }: { share: ReturnType<typeof useShareReport> }) {
  const { state, actions } = share;
  const destination = state.attempt?.repository ?? state.repository;
  const linear = isLinearDestination(destination);
  const STAGES = stages(linear);
  const current = STAGES.findIndex((stage) => stage.id === state.stage);
  return (
    <main className="filing-screen" aria-labelledby="filing-title">
      <div className="filing-progress">
        <div className="filing-heading">
          {linear ? <SquareKanban size={24} /> : <GitHubIcon size={24} />}
          <h1 id="filing-title">{state.cancelling ? 'Cancelling…' : 'Filing your issue'}</h1>
        </div>
        {state.draft.title.trim() && <p className="filing-issue-title">{state.draft.title}</p>}
        <p className="filing-repository">{destinationLabel(state.settings, destination)}</p>
        <ol className="filing-stages" aria-label="Filing progress">
          {STAGES.map((stage, index) => (
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
