import type { CloudflarePublication } from './draft';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileIssue } from './file-issue';
import { defaultSharingSettings } from './settings';
import { generateSummary } from './summary';
import { publishReport, waitForDeployment } from './cloudflare';
import {
  createGitHubIssue,
  findCreatedIssue,
  verifyGitHub,
  GitHubRequestError,
} from './github';
import type { SavedDraft } from './draft';
import { fileProoflineIssue, publishProoflineReport } from '@/lib/proofline/reports';
vi.mock('@/lib/proofline/reports', () => ({
  fileProoflineIssue: vi.fn(),
  publishProoflineReport: vi.fn(),
}));
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
  it('sends the chosen labels and assignees with a personal-token issue', async () => {
    const input = fixture();
    input.saved.labels = ['bug'];
    input.saved.assignees = ['octocat'];
    await fileIssue(input);
    expect(vi.mocked(createGitHubIssue).mock.calls[0]![5]).toEqual({
      labels: ['bug'],
      assignees: ['octocat'],
    });
  });
  it('files through Proofline exactly as before, without labels or assignees', async () => {
    const input = fixture();
    const repository = { id: 'repo-id', full_name: 'owner/repo', github_repository_id: 1 };
    input.settings.proofline = {
      aiMode: 'proofline',
      publishing: 'proofline',
      github: 'proofline',
      model: '',
      connection: {
        accessToken: 'proofline-token',
        organizationId: 'org',
        expiresAt: Date.now() + 3_600_000,
        account: { repositories: [repository] } as never,
      },
    };
    input.saved.draftSource = 'edited';
    input.saved.labels = ['bug'];
    input.saved.assignees = ['octocat'];
    const publication = {
      provider: 'proofline' as const,
      id: 'report',
      organizationId: 'org',
      url: 'https://proofline.sh/recorder/reports/org/report',
      level: 'L1' as const,
      requestId: 'request',
      attachments: [],
    };
    vi.mocked(publishProoflineReport).mockImplementation(
      async (_settings, _files, _title, _level, _previous, save) => {
        await save(publication);
        return publication;
      },
    );
    vi.mocked(fileProoflineIssue).mockResolvedValue(issue);
    await fileIssue(input);
    expect(createGitHubIssue).not.toHaveBeenCalled();
    const call = vi.mocked(fileProoflineIssue).mock.calls[0]!;
    expect(call).toHaveLength(6);
    expect(call[0]).toBe(input.settings.proofline);
    expect(call[1]).toEqual({
      id: expect.any(String),
      repository: 'owner/repo',
      proofline: { organizationId: 'org', reportId: 'report', repositoryId: 'repo-id' },
      startedAt: expect.any(String),
    });
    expect(call[2]).toEqual({ title: 'Session', body: 'Evidence' });
    expect(call.slice(3, 5)).toEqual([input.signal, false]);
  });
});
