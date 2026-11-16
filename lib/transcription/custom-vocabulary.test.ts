import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSharingSettings,
  LAST_REPOSITORY_KEY,
  SHARING_KEY,
} from '@/lib/sharing/settings';
import {
  defaultRepositoryTerms,
  loadCustomKeyterms,
  mergeKeyterms,
  moveRenamedVocabulary,
  parseVocabulary,
  renameVocabulary,
  repositoryTerms,
  saveRepositoryTerms,
  vocabularyRepositories,
  VOCABULARY_KEY,
} from './custom-vocabulary';

afterEach(() => vi.unstubAllGlobals());

function stubStorage(stored: Record<string, unknown>) {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async () => stored),
        set: vi.fn(async (value: Record<string, unknown>) =>
          Object.assign(stored, value),
        ),
      },
    },
  });
}

describe('repository vocabulary', () => {
  it('starts each repository with its owner and name', () => {
    expect(defaultRepositoryTerms('https://github.com/acme/web-app')).toEqual([
      'acme',
      'web-app',
    ]);
    expect(repositoryTerms({}, 'acme/web-app')).toEqual(['acme', 'web-app']);
  });

  it('replaces the default once saved, including with an empty list', () => {
    expect(
      repositoryTerms({ 'acme/web-app': ['Stripe Checkout'] }, 'ACME/Web-App'),
    ).toEqual(['Stripe Checkout']);
    expect(repositoryTerms({ 'acme/web-app': [] }, 'acme/web-app')).toEqual([]);
  });

  it('lists configured repositories once, skipping incomplete entries', () => {
    const settings = defaultSharingSettings();
    settings.repositories = [
      { id: 'a', repository: 'acme/web-app', token: '' },
      { id: 'b', repository: 'https://github.com/ACME/web-app', token: '' },
      { id: 'c', repository: 'acme/', token: '' },
      { id: 'd', repository: 'acme/billing', token: '' },
    ];
    expect(vocabularyRepositories(settings)).toEqual(['acme/web-app', 'acme/billing']);
  });

  it('reports lines the provider limits would drop', () => {
    const { terms, rejected } = parseVocabulary(
      'Stripe Checkout\n\n  stripe checkout \nhttps://acme.test\nrelease 2026\none two three four five six\nLedger',
    );
    expect(terms).toEqual(['Stripe Checkout', 'Ledger']);
    expect(rejected).toEqual([
      'https://acme.test',
      'release 2026',
      'one two three four five six',
    ]);
  });

  it('puts custom terms ahead of page terms within the shared limit', () => {
    const page = Array.from(
      { length: 40 },
      (_, i) => `Page ${String.fromCharCode(65 + i)}`,
    );
    const merged = mergeKeyterms(['acme', 'web-app'], page);
    expect(merged.slice(0, 2)).toEqual(['acme', 'web-app']);
    expect(merged.length).toBeLessThanOrEqual(40);
    expect(mergeKeyterms(['Ledger'], ['ledger', 'Invoices'])).toEqual([
      'Ledger',
      'Invoices',
    ]);
  });

  it('loads terms for the repository new issues default to', async () => {
    const stored: Record<string, unknown> = {
      [SHARING_KEY]: {
        repositories: [
          { id: 'a', repository: 'acme/web-app', token: 't' },
          { id: 'b', repository: 'acme/billing', token: 't' },
        ],
      },
      [LAST_REPOSITORY_KEY]: 'acme/billing',
    };
    stubStorage(stored);
    expect(await loadCustomKeyterms()).toEqual(['acme', 'billing']);
    await saveRepositoryTerms('acme/billing', ['Ledger', 'Ledger', 'a'.repeat(51)]);
    expect(stored[VOCABULARY_KEY]).toEqual({ 'acme/billing': ['Ledger'] });
    expect(await loadCustomKeyterms()).toEqual(['Ledger']);
  });

  it('sends no custom terms without a configured repository', async () => {
    stubStorage({});
    expect(await loadCustomKeyterms()).toEqual([]);
  });
});

describe('renamed repositories', () => {
  const entry = (id: string, repository: string) => ({ id, repository, token: 't' });

  it('moves saved terms to the new name and adds its owner and repository', () => {
    expect(
      renameVocabulary(
        { 'acme/web-app': ['acme', 'web-app', 'Ledger'] },
        [entry('a', 'acme/web-app')],
        [entry('a', 'acme/storefront')],
      ),
    ).toEqual({ 'acme/storefront': ['acme', 'web-app', 'Ledger', 'storefront'] });
  });

  it('changes nothing without a rename or saved terms', () => {
    const vocabulary = { 'acme/web-app': ['Ledger'] };
    const previous = [entry('a', 'acme/web-app'), entry('b', 'acme/billing')];
    expect(renameVocabulary(vocabulary, previous, previous)).toBeUndefined();
    expect(
      renameVocabulary(vocabulary, previous, [
        entry('a', 'acme/web-app'),
        entry('b', 'acme/invoices'),
      ]),
    ).toBeUndefined();
    expect(
      renameVocabulary(vocabulary, previous, [entry('c', 'acme/new')]),
    ).toBeUndefined();
  });

  it('keeps a list saved under the new name and an old name still in use', () => {
    const vocabulary = { 'acme/web-app': ['Ledger'], 'acme/billing': ['Invoices'] };
    expect(
      renameVocabulary(
        vocabulary,
        [entry('a', 'acme/web-app'), entry('b', 'acme/billing')],
        [entry('a', 'acme/billing'), entry('b', 'acme/web-app')],
      ),
    ).toBeUndefined();
    expect(
      renameVocabulary(
        { 'acme/web-app': ['Ledger'] },
        [entry('a', 'acme/web-app'), entry('b', 'acme/other')],
        [entry('a', 'acme/storefront'), entry('b', 'acme/web-app')],
      ),
    ).toEqual({
      'acme/web-app': ['Ledger'],
      'acme/storefront': ['Ledger', 'acme', 'storefront'],
    });
  });

  it('stores the moved list', async () => {
    const stored: Record<string, unknown> = {
      [VOCABULARY_KEY]: { 'acme/web-app': ['Ledger'] },
    };
    stubStorage(stored);
    await moveRenamedVocabulary(
      [entry('a', 'acme/web-app')],
      [entry('a', 'https://github.com/acme/storefront')],
    );
    expect(stored[VOCABULARY_KEY]).toEqual({
      'acme/storefront': ['Ledger', 'acme', 'storefront'],
    });
  });
});
