import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configuredRepositories, defaultSharingSettings, loadSharingSettings,
  preferredRepository, rememberRepository, saveSharingSettings, tokenForRepository,
  issueDestinations, linearKeyForTeam, SHARING_KEY, LAST_REPOSITORY_KEY,
  type SharingSettings,
} from './settings';

afterEach(() => vi.unstubAllGlobals());
describe('repository settings', () => {
  it('migrates a legacy repository without losing its token', async () => {
    const stored: Record<string, unknown> = {
      [SHARING_KEY]: { repository: 'owner/first', githubToken: 'old-token' },
      [LAST_REPOSITORY_KEY]: 'owner/first',
    };
    vi.stubGlobal('chrome', { storage: { local: {
      get: vi.fn(async () => stored),
      setAccessLevel: vi.fn(),
      set: vi.fn(async (value) => Object.assign(stored, value)),
    } } });
    const settings = await loadSharingSettings();
    expect(settings.repositories).toEqual([{ id: 'legacy', repository: 'owner/first', token: 'old-token' }]);
    await saveSharingSettings(settings);
    expect((await loadSharingSettings()).repositories[0]?.token).toBe('old-token');
    expect((stored[SHARING_KEY] as { githubToken: string }).githubToken).toBe('');
    await rememberRepository('https://github.com/owner/second');
    expect(stored[LAST_REPOSITORY_KEY]).toBe('owner/second');
    expect(configuredRepositories({ repository: '', githubToken: '' })).toEqual([]);
  });

  it('does not send another repository’s credential or override a chosen repository', () => {
    const settings = defaultSharingSettings();
    settings.repositories = [
      { id: 'a', repository: 'owner/first', token: 'first-token' },
      { id: 'b', repository: 'team/second', token: 'second-token' },
    ];
    settings.lastRepository = 'team/second';
    expect(preferredRepository(settings)).toBe('team/second');
    expect(tokenForRepository(settings, 'TEAM/second')).toBe('second-token');
    expect(() => tokenForRepository(settings, 'team/unknown')).toThrow('Add a GitHub token');
    settings.repositories.pop();
    expect(preferredRepository(settings)).toBe('owner/first');
  });
});

describe('Linear destinations', () => {
  function configured() {
    const settings = defaultSharingSettings();
    settings.repositories = [{ id: 'a', repository: 'owner/first', token: 'first-token' }];
    settings.linear = { apiKey: 'linear-key', teamId: 'team-1', teamKey: 'ENG', teamName: 'Engineering' };
    return settings;
  }
  it('lists the team as a destination and remembers it', async () => {
    const settings = configured();
    expect(issueDestinations(settings)).toEqual([
      { value: 'owner/first', label: 'owner/first' },
      { value: 'linear:team-1', label: 'Linear · ENG' },
    ]);
    settings.lastRepository = 'linear:team-1';
    expect(preferredRepository(settings)).toBe('linear:team-1');
    expect(linearKeyForTeam(settings, 'linear:team-1')).toBe('linear-key');
    expect(() => linearKeyForTeam(settings, 'linear:team-2')).toThrow('Add a Linear API key');
    const stored: Record<string, unknown> = {};
    vi.stubGlobal('chrome', { storage: { local: { set: vi.fn(async (value) => Object.assign(stored, value)) } } });
    await rememberRepository('linear:team-1');
    expect(stored[LAST_REPOSITORY_KEY]).toBe('linear:team-1');
  });
  it('offers Linear with its personal key while Proofline is connected', () => {
    const settings = configured();
    settings.lastRepository = 'linear:team-1';
    settings.proofline = {
      github: 'proofline',
      connection: { account: { repositories: [{ id: 'r1', full_name: 'alice/product' }] } },
    } as unknown as SharingSettings['proofline'];
    expect(issueDestinations(settings)).toEqual([
      { value: 'alice/product', label: 'alice/product' },
      { value: 'linear:team-1', label: 'Linear · ENG' },
    ]);
    expect(preferredRepository(settings)).toBe('linear:team-1');
    expect(linearKeyForTeam(settings, 'linear:team-1')).toBe('linear-key');
  });
  it('hides Linear until a key and team are saved, and stores them with the other credentials', async () => {
    const settings = configured();
    settings.linear.apiKey = '';
    expect(issueDestinations(settings)).toHaveLength(1);
    const stored: Record<string, unknown> = {};
    vi.stubGlobal('chrome', { storage: { local: {
      get: vi.fn(async () => stored), setAccessLevel: vi.fn(),
      set: vi.fn(async (value) => Object.assign(stored, value)),
    } } });
    await saveSharingSettings(configured());
    expect((stored[SHARING_KEY] as SharingSettings).linear).toEqual(configured().linear);
    expect((await loadSharingSettings()).linear.teamKey).toBe('ENG');
  });
});
