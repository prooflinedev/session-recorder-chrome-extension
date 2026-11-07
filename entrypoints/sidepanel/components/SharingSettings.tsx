import { GitHubIcon } from '@/lib/ui/GitHubIcon';
import React from 'react';
import { CloudUpload, Sparkles, Plus, SquareKanban, Trash2 } from 'lucide-react';
import {
  cloudflareTokenUrl,
  githubTokenUrl,
  SUMMARY_PROVIDERS,
  type SummaryProvider,
} from '@/lib/sharing/settings';
import { LINEAR_KEYS_URL } from '@/lib/sharing/linear';
import { HelpLink } from './HelpLink';
import type { SharingSection, useSharingSettings } from './useSharingSettings';

export function SharingSettings({
  section,
  controller,
}: {
  section: SharingSection;
  controller: ReturnType<typeof useSharingSettings>;
}): React.JSX.Element {
  const { settings, loaded, busy, message, error, provider, model, actions } =
    controller;
  const cf = settings.cloudflare;
  const { patchCloudflare: patchCf, patchModel, save } = actions;
  if (!loaded) return <p role={error ? "alert" : "status"}>{error || "Loading settings…"}</p>;
  // Linear keeps its personal key while connected; Proofline only hosts the report.
  if (settings.proofline?.connection && section !== 'linear') {
    const title = section === 'summaries' ? 'AI summaries' : section === 'github' ? 'GitHub issues' : 'Publishing';
    const service = section === 'summaries' ? 'AI summaries' : section === 'github' ? 'GitHub issues' : 'private report hosting';
    return (
      <section className="settings__section" aria-label={title}>
        <h3 className="settings__title">{title}</h3>
        <p className="settings__hint">Using Proofline for {service}.</p>
        <a href="#proofline">Manage connection</a>
      </section>
    );
  }
  return (
    <div className="sharing-settings">
      <fieldset className="sharing-settings__fields" disabled={!loaded || busy}>
        {section === 'publishing' && (
          <section
            className="settings__section"
            aria-labelledby="sharing-cloudflare-title"
          >
            <div className="settings__head">
              <CloudUpload size={14} />
              <h3 className="settings__title" id="sharing-cloudflare-title">
                Cloudflare publishing
              </h3>
            </div>
            <p className="settings__hint">
              Publish reports with reader sign-in.
            </p>
            <HelpLink topic="cloudflare">Set up protected publishing</HelpLink>
            <label className="settings__field">
              <span className="settings__label">Cloudflare account ID</span>
              <input
                value={cf.accountId}
                onChange={(e) => patchCf({ accountId: e.target.value.trim() })}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <a
              className="sharing-link"
              href={cloudflareTokenUrl(cf.accountId)}
              target="_blank"
              rel="noreferrer"
            >
              Create a preconfigured API token
            </a>
            <label className="settings__field">
              <span className="settings__label">Cloudflare API token</span>
              <input
                type="password"
                value={cf.apiToken}
                onChange={(e) => patchCf({ apiToken: e.target.value })}
                autoComplete="new-password"
                spellCheck={false}
              />
            </label>
            <label className="settings__field">
              <span className="settings__label">Pages project name</span>
              <input
                value={cf.projectName}
                onChange={(e) => patchCf({ projectName: e.target.value.trim() })}
                placeholder="my-session-reports"
                spellCheck={false}
              />
            </label>

            <label className="settings__field">
              <span className="settings__label">Access application ID</span>
              <input
                value={cf.accessAppId}
                onChange={(e) => patchCf({ accessAppId: e.target.value.trim() })}
                spellCheck={false}
              />
              <span className="settings__hint">
                The application UUID, not its audience (AUD) tag.
              </span>
            </label>
            <label className="settings__field">
              <span className="settings__label">Access team domain</span>
              <input
                value={cf.teamDomain}
                onChange={(e) => patchCf({ teamDomain: e.target.value.trim() })}
                placeholder="your-team.cloudflareaccess.com"
                spellCheck={false}
              />
            </label>
            <div className="settings__actions">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void save('publishing')}
              >
                {busy ? 'Checking…' : 'Verify Access & save'}
              </button>
            </div>
          </section>
        )}
        {section === 'summaries' && (
          <section
            className="settings__section"
            aria-labelledby="sharing-summary-title"
          >
            <div className="settings__head">
              <Sparkles size={14} />
              <h3 className="settings__title" id="sharing-summary-title">
                Issue summaries
              </h3>
            </div>
            <p className="settings__hint">
              Automatically summarize text evidence when filing an issue.
            </p>
            <HelpLink topic="ai-summaries">Set up AI summaries</HelpLink>
            <label className="settings__field">
              <span className="settings__label">Summary provider</span>
              <select
                value={settings.provider}
                onChange={(e) =>
                  actions.selectProvider(e.target.value as SummaryProvider)
                }
              >
                {SUMMARY_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings__field">
              <span className="settings__label">Summary API key</span>
              <input
                type="password"
                value={model.apiKey}
                onChange={(e) => patchModel({ apiKey: e.target.value })}
                autoComplete="new-password"
                spellCheck={false}
              />
            </label>
            {provider.keysUrl && (
              <a
                className="sharing-link"
                href={provider.keysUrl}
                target="_blank"
                rel="noreferrer"
              >
                Get a {provider.label} API key
              </a>
            )}
            {settings.provider === 'compatible' && (
              <label className="settings__field">
                <span className="settings__label">API base URL</span>
                <input
                  type="url"
                  value={model.baseUrl}
                  onChange={(e) => patchModel({ baseUrl: e.target.value })}
                  placeholder="https://your-provider.example/v1"
                />
                <span className="settings__hint">
                  Include /v1 if required.
                </span>
              </label>
            )}
            <label className="settings__field">
              <span className="settings__label">Summary model</span>
              <input
                value={model.model}
                onChange={(e) => patchModel({ model: e.target.value })}
                placeholder={provider.models[0] || 'Model ID from your provider'}
                list="summary-model-suggestions"
                spellCheck={false}
              />
            </label>
            <datalist id="summary-model-suggestions">
              {provider.models.map((id) => <option key={id} value={id} />)}
            </datalist>
            <div className="settings__actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void save(section)}
              >
                Save summary settings
              </button>
            </div>
          </section>
        )}
        {section === 'github' && (
          <section className="settings__section" aria-labelledby="sharing-github-title">
            <div className="settings__head">
              <GitHubIcon size={16} />
              <h3 className="settings__title" id="sharing-github-title">
                GitHub issues
              </h3>
            </div>
            <p className="settings__hint">
              File an issue with a summary and protected report link.
            </p>
            <HelpLink topic="github">Set up one-click filing</HelpLink>
            {settings.repositories.map((entry, index) => (
              <fieldset className="repository-settings" key={entry.id} aria-label={`Repository ${index + 1}`}>
                <div className="repository-settings__head">
                  <span>Repository {index + 1}</span>
                  <button type="button" className="icon-btn" aria-label={`Remove repository ${index + 1}`} onClick={() => actions.removeRepository(entry.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
                <label className="settings__field">
                  <span className="settings__label">GitHub repository</span>
                  <input value={entry.repository} onChange={(e) => actions.editRepository(entry.id, { repository: e.target.value })} placeholder="owner/repository" spellCheck={false} />
                </label>
                <label className="settings__field">
                  <span className="settings__label">GitHub API token</span>
                  <input type="password" value={entry.token} onChange={(e) => actions.editRepository(entry.id, { token: e.target.value })} autoComplete="new-password" spellCheck={false} />
                </label>
                <a className="sharing-link" href={githubTokenUrl(entry.repository)} target="_blank" rel="noreferrer">Create a GitHub token</a>
              </fieldset>
            ))}
            <div>
              <button type="button" className="btn btn--sm" onClick={actions.addRepository}><Plus size={13} /> Add repository</button>
            </div>
            <div className="settings__actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void save(section)}
              >
                {busy ? 'Checking…' : 'Save GitHub settings'}
              </button>
            </div>
          </section>
        )}
        {section === 'linear' && (
          <section className="settings__section" aria-labelledby="sharing-linear-title">
            <div className="settings__head">
              <SquareKanban size={14} />
              <h3 className="settings__title" id="sharing-linear-title">
                Linear issues
              </h3>
            </div>
            <p className="settings__hint">
              File an issue in one Linear team with a summary and protected report link.
            </p>
            <label className="settings__field">
              <span className="settings__label">Linear API key</span>
              <input
                type="password"
                value={settings.linear.apiKey}
                onChange={(e) => actions.patchLinear({ apiKey: e.target.value })}
                autoComplete="new-password"
                spellCheck={false}
              />
            </label>
            <a className="sharing-link" href={LINEAR_KEYS_URL} target="_blank" rel="noreferrer">
              Create a Linear personal API key
            </a>
            <div>
              <button
                type="button"
                className="btn btn--sm"
                disabled={!settings.linear.apiKey.trim()}
                onClick={() => void actions.loadLinearTeams()}
              >
                Load teams
              </button>
            </div>
            <label className="settings__field">
              <span className="settings__label">Linear team</span>
              <select
                value={settings.linear.teamId}
                disabled={!controller.linearTeams.length && !settings.linear.teamId}
                onChange={(e) => actions.patchLinear({ teamId: e.target.value })}
              >
                {!settings.linear.teamId && <option value="">Load teams first</option>}
                {(controller.linearTeams.length
                  ? controller.linearTeams
                  : settings.linear.teamId
                    ? [{ id: settings.linear.teamId, key: settings.linear.teamKey, name: settings.linear.teamName }]
                    : []
                ).map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.key} · {team.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="settings__actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void save(section)}
              >
                {busy ? 'Checking…' : 'Save Linear settings'}
              </button>
            </div>
          </section>
        )}
        <p className="settings__hint">
          Keys are stored locally and never included in reports.
        </p>
      </fieldset>
      {message && (
        <p className="settings__hint" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="export__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
