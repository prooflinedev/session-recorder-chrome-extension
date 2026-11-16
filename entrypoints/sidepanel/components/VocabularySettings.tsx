import React from 'react';
import { SpellCheck } from 'lucide-react';
import type { SharingSettings } from '@/lib/sharing/settings';
import type { useTranscriptionVocabulary } from './useTranscriptionVocabulary';

/** Per-repository terms that lead the transcription dictionary. */
export function VocabularySettings({
  settings,
  controller: vocabulary,
}: {
  settings: SharingSettings;
  controller: ReturnType<typeof useTranscriptionVocabulary>;
}): React.JSX.Element {
  const { repositories, repository } = vocabulary;
  return (
    <section
      className="settings__section"
      aria-labelledby="transcription-vocabulary-title"
    >
      <div className="settings__head">
        <SpellCheck size={14} strokeWidth={1.75} />
        <h3 className="settings__title" id="transcription-vocabulary-title">
          Vocabulary
        </h3>
        {vocabulary.saved && (
          <span className="settings__saved" role="status">
            Saved
          </span>
        )}
      </div>
      {repositories.length === 0 ? (
        <p className="settings__hint">
          {settings.proofline?.github === 'proofline' ? (
            'Repositories with the Proofline GitHub App appear here.'
          ) : (
            <>
              Add a repository in <a href="#github">GitHub settings</a> to set its
              vocabulary.
            </>
          )}
        </p>
      ) : (
        <>
          {repositories.length > 1 && (
            <label className="settings__field">
              <span className="settings__label">Repository</span>
              <select
                value={repository}
                disabled={vocabulary.saving}
                onChange={(e) => vocabulary.select(e.target.value)}
              >
                {repositories.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="settings__field">
            <span className="settings__label">
              {repositories.length > 1 ? 'Terms' : `Terms for ${repository}`}
            </span>
            <textarea
              rows={5}
              spellCheck={false}
              value={vocabulary.text}
              disabled={!vocabulary.loaded || vocabulary.saving}
              placeholder="one term per line"
              onChange={(e) => vocabulary.edit(e.target.value)}
            />
          </label>
          <p className="settings__hint">
            Product, feature and team names help speech recognition. Recordings send the
            terms for the repository new issues default to, ahead of terms read from the
            page, up to 40 in total.
          </p>
          <div className="settings__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!vocabulary.loaded || vocabulary.saving}
              onClick={() => void vocabulary.save()}
            >
              {vocabulary.saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          {vocabulary.rejected.length > 0 && (
            <p className="settings__result settings__result--error">
              Skipped {vocabulary.rejected.join(', ')}. Terms need 50 characters or
              fewer, at most 5 words, no links or number runs, and the list holds up to
              40.
            </p>
          )}
        </>
      )}
      {vocabulary.error && (
        <p className="settings__result settings__result--error" role="alert">
          {vocabulary.error}
        </p>
      )}
    </section>
  );
}
