import type { CloudflarePublication } from './draft';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileIssue } from './file-issue';
import { defaultSharingSettings, type SharingSettings } from './settings';
import { generateSummary } from './summary';
import { publishReport, waitForDeployment } from './cloudflare';
import {
  createGitHubIssue,
  findCreatedIssue,
  verifyGitHub,
  GitHubRequestError,
} from './github';
import type { ProoflinePublication, SavedDraft } from './draft';
import { fileProoflineIssue, publishProoflineReport } from '@/lib/proofline/reports';
import {
  createLinearIssue,
  findLinearIssue,
  LinearRequestError,
  verifyLinear,
} from './linear';
vi.mock('./summary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./summary')>()), generateSummary: vi.fn(),
}));
vi.mock('./cloudflare', () => ({
  publishReport: vi.fn(),
  waitForDeployment: vi.fn(),
  validateFiles: vi.fn(),
}));
vi.mock('./github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./github')>()),
  verifyGitHub: vi.fn(),
  createGitHubIssue: vi.fn(),
  findCreatedIssue: vi.fn(),
}));
vi.mock('@/lib/proofline/reports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/proofline/reports')>()),
  publishProoflineReport: vi.fn(),
  fileProoflineIssue: vi.fn(),
}));
vi.mock('./linear', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./linear')>()),
  verifyLinear: vi.fn(),
  createLinearIssue: vi.fn(),
  findLinearIssue: vi.fn(),
}));
const deployment = {
  id: 'd',
  environment: 'preview',
  url: 'https://abc.reports.pages.dev',
  latest_stage: { name: 'deploy', status: 'success' },
};
const issue = {
  number: 42,
  repository: 'owner/repo',
  url: 'https://github.com/owner/repo/issues/42',
};
function fixture() {
  const settings = defaultSharingSettings();
  settings.githubToken = 'github-key';
  settings.repository = 'owner/repo';
  settings.models.openai = {
    apiKey: 'model-key',
    model: 'model',
    baseUrl: 'https://api.openai.com/v1',
  };
  const snapshots: SavedDraft[] = [];
  return {
    saved: {
      draft: { title: 'Session', body: 'Evidence' },
      draftSource: 'initial' as const,
      repository: 'owner/repo',
    } as SavedDraft,
    settings,
    files: [],
    evidence: 'Captured events',
    level: 'L1' as const,
    save: async (value: SavedDraft) => {
      snapshots.push(value);
    },
    progress: vi.fn(),
    signal: new AbortController().signal,
    snapshots,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(generateSummary).mockResolvedValue({
    title: 'Generated',
    body: 'Useful summary',
  });
  vi.mocked(publishReport).mockResolvedValue(deployment);
  vi.mocked(createGitHubIssue).mockResolvedValue(issue);
});
describe('one-click issue filing', () => {
  it('uses only the selected repository credential', async () => {
    const input = fixture();
    input.settings.repositories = [
      { id: 'one', repository: 'other/repo', token: 'wrong-key' },
      { id: 'two', repository: 'owner/repo', token: 'scoped-key' },
    ];
    await fileIssue(input);
    expect(verifyGitHub).toHaveBeenCalledWith('owner/repo', 'scoped-key', input.signal);
    expect(vi.mocked(createGitHubIssue).mock.calls[0]![1]).toBe('scoped-key');
  });
  it('cancels after publication without submitting an issue and keeps the deployment', async () => {
    const input = fixture();
    const controller = new AbortController();
    input.signal = controller.signal;
    vi.mocked(publishReport).mockImplementation(async () => {
      controller.abort();
      return deployment;
    });
    await expect(fileIssue(input)).rejects.toThrow();
    expect(createGitHubIssue).not.toHaveBeenCalled();
    expect((input.snapshots.at(-1)?.publication as CloudflarePublication)?.deployment).toEqual(deployment);
    expect(input.snapshots.at(-1)?.attempt).toBeUndefined();
  });
  it('summarizes, publishes and creates, saving checkpoints without secrets', async () => {
    const input = fixture();
    const result = await fileIssue(input);
    expect(generateSummary).toHaveBeenCalledOnce();
    expect(publishReport).toHaveBeenCalledOnce();
    expect(createGitHubIssue).toHaveBeenCalledOnce();
    expect(result.issue).toEqual(issue);
    expect((input.snapshots.find((s) => s.attempt)?.publication as CloudflarePublication)?.deployment).toEqual(
      deployment,
    );
    expect(JSON.stringify(input.snapshots)).not.toMatch(/github-key|model-key/);
  });
  it('automatically summarizes while preserving a custom title', async () => {
    const input = fixture(); input.saved.draftSource = 'title-edited'; input.saved.draft.title = '[E2E test] Custom title';
    const result = await fileIssue(input);
    expect(generateSummary).toHaveBeenCalledOnce(); expect(result.draft).toEqual({title:'[E2E test] Custom title',body:'Useful summary'});
  });
  it('preserves edited text and reuses a successful publication', async () => {
    const input = fixture();
    input.saved.draftSource = 'edited';
    input.saved.publication = {
      deployment,
      destination: input.settings.cloudflare,
      level: 'L1',
    };
    await fileIssue(input);
    expect(generateSummary).not.toHaveBeenCalled();
    expect(publishReport).not.toHaveBeenCalled();
    expect(waitForDeployment).not.toHaveBeenCalled();
    expect(vi.mocked(createGitHubIssue).mock.calls[0]![2].title).toBe('Session');
  });
  it('needs no model key to file a manually written issue', async () => {
    const input = fixture();
    input.settings.models.openai.apiKey = '';
    await fileIssue(input);
    expect(generateSummary).not.toHaveBeenCalled();
    expect(createGitHubIssue).toHaveBeenCalledOnce();
  });
  it('does no further work for a completed issue', async () => {
    const input = fixture();
    input.saved.issue = issue;
    await fileIssue(input);
    expect(verifyGitHub).not.toHaveBeenCalled();
    expect(createGitHubIssue).not.toHaveBeenCalled();
  });
  it('recovers an accepted request without another POST', async () => {
    const input = fixture();
    input.saved.attempt = {
      id: 'a',
      repository: 'owner/repo',
      startedAt: new Date().toISOString(),
    };
    vi.mocked(findCreatedIssue).mockResolvedValue(issue);
    const result = await fileIssue(input);
    expect(result.issue).toEqual(issue);
    expect(result.attempt).toBeUndefined();
    expect(createGitHubIssue).not.toHaveBeenCalled();
    expect(publishReport).not.toHaveBeenCalled();
  });
  it('retains an uncertain attempt and never blindly resubmits it', async () => {
    const input = fixture();
    vi.mocked(createGitHubIssue).mockRejectedValue(new TypeError('Network failed'));
    await expect(fileIssue(input)).rejects.toThrow('Network failed');
    const saved = input.snapshots.at(-1)!;
    expect(saved.attempt).toBeDefined();
    await expect(fileIssue({ ...input, saved })).rejects.toThrow('No duplicate');
    expect(createGitHubIssue).toHaveBeenCalledOnce();
  });
  it('allows retry after a definitive rejection without another upload or summary', async () => {
    const input = fixture();
    vi.mocked(createGitHubIssue).mockRejectedValueOnce(
      new GitHubRequestError('Forbidden', true),
    );
    await expect(fileIssue(input)).rejects.toThrow('Forbidden');
    const saved = input.snapshots.at(-1)!;
    expect(saved.attempt).toBeUndefined();
    await fileIssue({ ...input, saved });
    expect(publishReport).toHaveBeenCalledOnce();
    expect(generateSummary).toHaveBeenCalledOnce();
    expect(createGitHubIssue).toHaveBeenCalledTimes(2);
  });
});

describe('Linear issue filing', () => {
  const linearIssue = {
    number: 12,
    identifier: 'ENG-12',
    repository: 'linear:team-1',
    url: 'https://linear.app/acme/issue/ENG-12/checkout',
  };
  function linearFixture() {
    const input = fixture();
    input.settings.linear = { apiKey: 'linear-key', teamId: 'team-1', teamKey: 'ENG', teamName: 'Engineering' };
    input.saved.repository = 'linear:team-1';
    input.saved.draftSource = 'edited';
    input.saved.publication = { deployment, destination: input.settings.cloudflare, level: 'L1' };
    return input;
  }
  function uncertain(input: ReturnType<typeof linearFixture>) {
    input.saved.attempt = {
      id: 'original-attempt-id',
      repository: 'linear:team-1',
      startedAt: new Date().toISOString(),
    };
    return input;
  }
  beforeEach(() => {
    vi.mocked(verifyLinear).mockResolvedValue({ id: 'team-1', key: 'ENG', name: 'Engineering' });
    vi.mocked(createLinearIssue).mockResolvedValue(linearIssue);
  });

  it('creates with the attempt ID saved before sending and only the Linear key', async () => {
    const input = linearFixture();
    const result = await fileIssue(input);
    expect(result.issue).toEqual(linearIssue);
    expect(verifyLinear).toHaveBeenCalledWith('linear-key', 'team-1', input.signal);
    const [attempt, key, , reportUrl] = vi.mocked(createLinearIssue).mock.calls[0]!;
    expect(key).toBe('linear-key');
    expect(reportUrl).toBe(deployment.url);
    expect(input.snapshots.find((s) => s.attempt)?.attempt?.id).toBe(attempt.id);
    expect(attempt.repository).toBe('linear:team-1');
    expect(createGitHubIssue).not.toHaveBeenCalled();
    expect(input.progress).toHaveBeenLastCalledWith('Issue ENG-12 created.');
    expect(JSON.stringify(input.snapshots)).not.toContain('linear-key');
  });

  it('resends an uncertain attempt only after a lookup, with its original ID', async () => {
    const input = uncertain(linearFixture());
    vi.mocked(findLinearIssue).mockResolvedValue(undefined);
    const result = await fileIssue(input);
    expect(findLinearIssue).toHaveBeenCalledOnce();
    expect(vi.mocked(findLinearIssue).mock.calls[0]![0].id).toBe('original-attempt-id');
    expect(createLinearIssue).toHaveBeenCalledOnce();
    expect(vi.mocked(createLinearIssue).mock.calls[0]![0].id).toBe('original-attempt-id');
    expect(vi.mocked(findLinearIssue).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(createLinearIssue).mock.invocationCallOrder[0]!,
    );
    expect(result.issue).toEqual(linearIssue);
    expect(result.attempt).toBeUndefined();
    expect(input.snapshots.at(-1)?.issue).toEqual(linearIssue);
    expect(publishReport).not.toHaveBeenCalled();
  });

  it('completes from the lookup without creating again', async () => {
    const input = uncertain(linearFixture());
    vi.mocked(findLinearIssue).mockResolvedValue(linearIssue);
    const result = await fileIssue(input);
    expect(result.issue).toEqual(linearIssue);
    expect(result.attempt).toBeUndefined();
    expect(createLinearIssue).not.toHaveBeenCalled();
  });

  it('keeps an uncertain attempt when the response is lost', async () => {
    const input = linearFixture();
    vi.mocked(createLinearIssue).mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(fileIssue(input)).rejects.toThrow('Failed to fetch');
    expect(input.snapshots.at(-1)?.attempt?.repository).toBe('linear:team-1');
  });

  it('clears the attempt after a definitive rejection, also on a resend', async () => {
    const input = linearFixture();
    vi.mocked(createLinearIssue).mockRejectedValueOnce(new LinearRequestError('Bad key', true));
    await expect(fileIssue(input)).rejects.toThrow('Bad key');
    expect(input.snapshots.at(-1)?.attempt).toBeUndefined();

    const retry = uncertain(linearFixture());
    vi.mocked(findLinearIssue).mockResolvedValue(undefined);
    vi.mocked(createLinearIssue).mockRejectedValueOnce(new LinearRequestError('Rate limited', true));
    await expect(fileIssue(retry)).rejects.toThrow('Rate limited');
    expect(retry.snapshots.at(-1)?.attempt).toBeUndefined();
  });

  it('keeps the attempt when the lookup itself fails', async () => {
    const input = uncertain(linearFixture());
    vi.mocked(findLinearIssue).mockRejectedValue(new LinearRequestError('Rate limited', true));
    await expect(fileIssue(input)).rejects.toThrow('Rate limited');
    expect(createLinearIssue).not.toHaveBeenCalled();
    expect(input.snapshots.every((s) => s.attempt)).toBe(true);
  });

  describe('while Proofline is connected', () => {
    const prooflineUrl =
      'https://proofline.sh/recorder/reports/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001';
    const hosted: ProoflinePublication = {
      provider: 'proofline',
      id: '20000000-0000-4000-8000-000000000001',
      organizationId: '10000000-0000-4000-8000-000000000001',
      url: prooflineUrl,
      level: 'L1',
      requestId: 'report-request',
      attachments: [],
    };
    function connectedFixture() {
      const input = linearFixture();
      input.saved.publication = undefined;
      input.settings.proofline = {
        aiMode: 'proofline',
        publishing: 'proofline',
        github: 'proofline',
        model: '',
        connection: { accessToken: 'proofline-token', organizationId: hosted.organizationId, expiresAt: Date.now() + 3600000, account: { repositories: [] } },
      } as unknown as SharingSettings['proofline'];
      vi.mocked(publishProoflineReport).mockImplementation(async (_s, _f, _t, _l, _p, save) => {
        await save(hosted);
        return hosted;
      });
      return input;
    }

    it('hosts the report on Proofline and files with the personal Linear key and that link', async () => {
      const input = connectedFixture();
      const result = await fileIssue(input);
      expect(publishProoflineReport).toHaveBeenCalledOnce();
      expect(publishReport).not.toHaveBeenCalled();
      expect(verifyLinear).toHaveBeenCalledWith('linear-key', 'team-1', input.signal);
      const [attempt, key, , reportUrl] = vi.mocked(createLinearIssue).mock.calls[0]!;
      expect(key).toBe('linear-key');
      expect(reportUrl).toBe(prooflineUrl);
      expect(attempt.proofline).toBeUndefined();
      expect(input.snapshots.find((s) => s.attempt)?.attempt?.id).toBe(attempt.id);
      expect(fileProoflineIssue).not.toHaveBeenCalled();
      expect(createGitHubIssue).not.toHaveBeenCalled();
      expect(result.issue).toEqual(linearIssue);
      expect(JSON.stringify(input.snapshots)).not.toMatch(/linear-key|proofline-token/);
    });

    it('resends an uncertain attempt with its original ID and the Proofline link after a lookup', async () => {
      const input = uncertain(connectedFixture());
      input.saved.publication = hosted;
      vi.mocked(findLinearIssue).mockResolvedValue(undefined);
      const result = await fileIssue(input);
      expect(findLinearIssue).toHaveBeenCalledOnce();
      const [attempt, , , reportUrl] = vi.mocked(createLinearIssue).mock.calls[0]!;
      expect(attempt.id).toBe('original-attempt-id');
      expect(reportUrl).toBe(prooflineUrl);
      expect(fileProoflineIssue).not.toHaveBeenCalled();
      expect(result.attempt).toBeUndefined();
    });
  });
});
