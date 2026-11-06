import { GitHubIcon } from '@/lib/ui/GitHubIcon';
import { ProoflineMark } from '@/lib/ui/ProoflineMark';
import React from 'react';
import {
  AudioLines,
  SlidersHorizontal,
  Camera,
  Database,
  ShieldCheck,
  CloudUpload,
  Sparkles,
  SquareKanban,
} from 'lucide-react';
import type { ScreenshotPolicy } from '@/lib/session/types';
import { PROVIDERS, type TranscriptionConfig } from '@/lib/transcription';
import { DEFAULT_HEADER_BLOCKLIST, DEFAULT_KEY_PATTERN } from '@/lib/capture/redaction';
import { ProoflineSettings } from './ProoflineSettings';
import { ServicesSettings } from './ServicesSettings';
import { SharingSettings } from './SharingSettings';
import { useSharingSettings, type SharingSection } from './useSharingSettings';
import { useCaptureSettings } from './useCaptureSettings';
import { useSettingsNavigation } from './useSettingsNavigation';
import { formatBytes, totalEvents, clampInt } from './settings-utils';

const SETTINGS_PAGES = [
  { id: 'proofline', label: 'Proofline', icon: ProoflineMark },
  { id: 'services', label: 'Services', icon: SlidersHorizontal },
  { id: 'capture', label: 'Capture', icon: Camera },
  { id: 'redaction', label: 'Privacy', icon: ShieldCheck },
  { id: 'transcription', label: 'Transcription', icon: AudioLines },
  { id: 'publishing', label: 'Publishing', icon: CloudUpload },
  { id: 'summaries', label: 'AI summaries', icon: Sparkles },
  { id: 'github', label: 'GitHub', icon: GitHubIcon },
  { id: 'linear', label: 'Linear', icon: SquareKanban },
  { id: 'storage', label: 'Storage', icon: Database },
] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number]['id'];
function SavedBadge({ show }: { show: boolean }) {
  return show ? (
    <span className="settings__saved" role="status">
      Saved
    </span>
  ) : null;
}
export function SettingsForm(): React.JSX.Element {
  const { page, navigate } = useSettingsNavigation(SETTINGS_PAGES.map((p) => p.id));
  const sharing = useSharingSettings();
  const { state, providerMeta, usagePct, actions } = useCaptureSettings();
  const {
    tx,
    testState,
    settings,
    redaction,
    storage,
    sessions,
    busy,
    loaded,
    saved,
    error,
  } = state;
  const {
    patchTx,
    patchSettings,
    patchRedaction,
    saveTranscription,
    runTest,
    persistSettings,
    refreshStorage,
    deleteAllSessions,
  } = actions;
  return (
    <div className="settings settings-shell">
      <nav className="settings-nav" aria-label="Settings pages">
        {SETTINGS_PAGES.map(({ id, label, icon: Icon }) => (
          <a
            key={id}
            href={`#${id}`}
            aria-current={page === id ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(id);
            }}
          >
            <Icon size={16} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="settings-page" id="settings-page">
        {error && (
          <p className="export__error" role="alert">
            {error}
          </p>
        )}
        <fieldset className="settings-fields" disabled={!loaded || busy}>
          {page === 'proofline' && <ProoflineSettings />}
          {page === 'services' && <ServicesSettings />}
          {['publishing', 'summaries', 'github', 'linear'].includes(page) && (
            <SharingSettings
              section={page as SharingSection}
              controller={sharing}
            />
          )}
          {/* ---------------------------------------------------------------- */}
          {/* 1) Transcription                                                 */}
          {/* ---------------------------------------------------------------- */}
          {page === 'transcription' && sharing.settings.proofline?.connection && (
            <section className="settings__section" aria-label="Transcription">
              <h3 className="settings__title">Transcription</h3>
              <p className="settings__hint">Using Proofline credits for transcription.</p>
              <a href="#proofline">Manage connection</a>
            </section>
          )}
          {page === 'transcription' && sharing.loaded && !sharing.settings.proofline?.connection && (
            <section className="settings__section" aria-label="Transcription">
              <div className="settings__head">
                <AudioLines size={14} strokeWidth={1.75} />
                <h3 className="settings__title">Transcription</h3>
                <SavedBadge show={!!saved.transcription} />
              </div>

              <label className="settings__field">
                <span className="settings__label">Provider</span>
                <select
                  value={tx.provider}
                  onChange={(e) =>
                    patchTx({
                      provider: e.target.value as TranscriptionConfig['provider'],
                    })
                  }
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="settings__field">
                <span className="settings__label">Base URL</span>
                <input
                  type="text"
                  value={tx.baseUrl ?? ''}
                  placeholder={providerMeta?.defaultBaseUrl ?? ''}
                  onChange={(e) => patchTx({ baseUrl: e.target.value })}
                />
              </label>

              <label className="settings__field">
                <span className="settings__label">Model</span>
                <input
                  type="text"
                  value={tx.model ?? ''}
                  placeholder={providerMeta?.defaultModel ?? ''}
                  onChange={(e) => patchTx({ model: e.target.value })}
                />
              </label>

              <label className="settings__field">
                <span className="settings__label">API key</span>
                <input
                  type="password"
                  value={tx.apiKey}
                  placeholder="sk-…"
                  autoComplete="off"
                  onChange={(e) => patchTx({ apiKey: e.target.value })}
                />
              </label>

              <label className="settings__field">
                <span className="settings__label">Language</span>
                <input
                  type="text"
                  value={tx.language ?? ''}
                  placeholder="auto (e.g. en, es, fr)"
                  onChange={(e) => patchTx({ language: e.target.value })}
                />
              </label>

              <div className="settings__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => void saveTranscription()}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={testState.status === 'testing'}
                  onClick={() => void runTest()}
                >
                  {testState.status === 'testing' ? 'Testing…' : 'Test'}
                </button>
              </div>
              {testState.status === 'ok' && (
                <p className="settings__result settings__result--ok">
                  {testState.message}
                </p>
              )}
              {testState.status === 'error' && (
                <p className="settings__result settings__result--error">
                  {testState.message}
                </p>
              )}
            </section>
          )}

          {/* ---------------------------------------------------------------- */}
          {/* 2) Redaction                                                     */}
          {/* ---------------------------------------------------------------- */}
          {page === 'redaction' && (
            <section className="settings__section" aria-label="Redaction">
              <div className="settings__head">
                <ShieldCheck size={14} strokeWidth={1.75} />
                <h3 className="settings__title">Redaction</h3>
                <SavedBadge show={!!saved.redaction} />
              </div>

              <label className="settings__toggle">
                <input
                  type="checkbox"
                  checked={settings.redactionEnabled}
                  onChange={(e) =>
                    patchSettings({ redactionEnabled: e.target.checked })
                  }
                />
                <span>Strip secrets from headers, bodies, and URLs</span>
              </label>

              <p className="settings__hint">
                Your entries below are merged with the built-in defaults. Defaults
                always apply while redaction is enabled.
              </p>

              <label className="settings__field">
                <span className="settings__label">Extra header names</span>
                <textarea
                  rows={3}
                  spellCheck={false}
                  value={redaction.headers}
                  placeholder="one header name per line"
                  onChange={(e) => patchRedaction({ headers: e.target.value })}
                />
                <span className="settings__ref-label">Built-in:</span>
                <code className="settings__ref">
                  {DEFAULT_HEADER_BLOCKLIST.join(', ')}
                </code>
              </label>

              <label className="settings__field">
                <span className="settings__label">Body key regex patterns</span>
                <textarea
                  rows={3}
                  spellCheck={false}
                  value={redaction.bodyKeys}
                  placeholder="one regex per line, e.g. account.?number"
                  onChange={(e) => patchRedaction({ bodyKeys: e.target.value })}
                />
                <span className="settings__ref-label">Built-in:</span>
                <code className="settings__ref">/{DEFAULT_KEY_PATTERN.source}/i</code>
              </label>

              <label className="settings__field">
                <span className="settings__label">URL param patterns</span>
                <textarea
                  rows={3}
                  spellCheck={false}
                  value={redaction.urlParams}
                  placeholder="one regex per line, e.g. access_token"
                  onChange={(e) => patchRedaction({ urlParams: e.target.value })}
                />
                <span className="settings__ref-label">Built-in:</span>
                <code className="settings__ref">/{DEFAULT_KEY_PATTERN.source}/i</code>
              </label>

              <div className="settings__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => void persistSettings('redaction')}
                >
                  Save
                </button>
              </div>
            </section>
          )}

          {/* ---------------------------------------------------------------- */}
          {/* 3) Capture knobs                                                 */}
          {/* ---------------------------------------------------------------- */}
          {page === 'capture' && (
            <section className="settings__section" aria-label="Capture">
              <div className="settings__head">
                <Camera size={14} strokeWidth={1.75} />
                <h3 className="settings__title">Capture</h3>
                <SavedBadge show={!!saved.capture} />
              </div>

              <label className="settings__field">
                <span className="settings__label">Screenshot policy</span>
                <select
                  value={settings.screenshotPolicy}
                  onChange={(e) =>
                    patchSettings({
                      screenshotPolicy: e.target.value as ScreenshotPolicy,
                    })
                  }
                >
                  <option value="every-interaction">Every interaction</option>
                  <option value="key-moments">Key moments</option>
                  <option value="on-demand">On demand only</option>
                </select>
              </label>

              <label className="settings__toggle">
                <input
                  type="checkbox"
                  checked={settings.filterTelemetry}
                  onChange={(e) => patchSettings({ filterTelemetry: e.target.checked })}
                />
                <span>Hide analytics and telemetry requests from exports</span>
              </label>
              <p className="settings__hint">
                Everything is still captured. This only keeps tracker noise out of the
                report so it stays focused on your app.
              </p>

              <label className="settings__toggle">
                <input
                  type="checkbox"
                  checked={settings.captureApiSpec}
                  onChange={(e) => patchSettings({ captureApiSpec: e.target.checked })}
                />
                <span>Build an API spec from captured requests</span>
              </label>
              <p className="settings__hint">
                Stores full request and response bodies for API calls and adds
                openapi.json to exports. Increases storage use.
              </p>

              <div className="settings__row">
                <ByteInput
                  label="Inline body cap"
                  unit="KB"
                  bytes={settings.inlineBodyCapBytes}
                  onChange={(b) => patchSettings({ inlineBodyCapBytes: b })}
                />
                <ByteInput
                  label="Asset body cap"
                  unit="KB"
                  bytes={settings.assetBodyCapBytes}
                  onChange={(b) => patchSettings({ assetBodyCapBytes: b })}
                />
              </div>

              <div className="settings__row">
                <ByteInput
                  label="File cap"
                  unit="MB"
                  bytes={settings.fileCapBytes}
                  onChange={(b) => patchSettings({ fileCapBytes: b })}
                />
                <label className="settings__field">
                  <span className="settings__label">Quality (0-100)</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={settings.screenshotQuality}
                    onChange={(e) =>
                      patchSettings({
                        screenshotQuality: clampInt(e.target.value, 0, 100),
                      })
                    }
                  />
                </label>
              </div>

              <label className="settings__field">
                <span className="settings__label">Dedup threshold (0-64)</span>
                <input
                  type="number"
                  min={0}
                  max={64}
                  value={settings.screenshotDedupThreshold}
                  onChange={(e) =>
                    patchSettings({
                      screenshotDedupThreshold: clampInt(e.target.value, 0, 64),
                    })
                  }
                />
              </label>

              <div className="settings__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => void persistSettings('capture')}
                >
                  Save
                </button>
              </div>
            </section>
          )}

          {/* ---------------------------------------------------------------- */}
          {/* 4) Storage                                                       */}
          {/* ---------------------------------------------------------------- */}
          {page === 'storage' && (
            <section className="settings__section" aria-label="Storage">
              <div className="settings__head">
                <Database size={14} strokeWidth={1.75} />
                <h3 className="settings__title">Storage</h3>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void refreshStorage()}
                >
                  Refresh
                </button>
              </div>

              <div className="settings__storage-numbers">
                <strong>{formatBytes(storage.usage)}</strong>
                <span>
                  {' '}
                  used of {formatBytes(storage.quota)} (
                  {usagePct.toFixed(usagePct >= 10 ? 0 : 1)}%)
                </span>
              </div>
              <div
                className="settings__storage-bar"
                role="progressbar"
                aria-valuenow={Math.round(usagePct)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="settings__storage-fill"
                  style={{ width: `${usagePct}%` }}
                />
              </div>

              {sessions.length === 0 ? (
                <p className="settings__hint">No recorded sessions.</p>
              ) : (
                <ul className="settings__sessions">
                  {sessions.map((s) => (
                    <li key={s.id} className="settings__session">
                      <a className="settings__session-name" href={`${chrome.runtime.getURL('share.html')}?session=${encodeURIComponent(s.id)}`} target="_blank" rel="noreferrer">{s.name || s.id}</a>
                      <span className="settings__session-meta">
                        {totalEvents(s)} events · {formatBytes(s.assetBytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="settings__actions">
                <button
                  type="button"
                  className="btn btn--sm settings__danger"
                  disabled={busy || sessions.length === 0}
                  onClick={() => void deleteAllSessions()}
                >
                  {busy ? 'Deleting…' : 'Delete all sessions'}
                </button>
              </div>
            </section>
          )}
        </fieldset>
      </div>
    </div>
  );
}

/** A byte-valued field edited in KB or MB, stored canonically in bytes. */
function ByteInput({
  label,
  unit,
  bytes,
  onChange,
}: {
  label: string;
  unit: 'KB' | 'MB';
  bytes: number;
  onChange: (bytes: number) => void;
}): React.JSX.Element {
  const factor = unit === 'MB' ? 1024 * 1024 : 1024;
  const display = bytes / factor;
  return (
    <label className="settings__field">
      <span className="settings__label">
        {label} ({unit})
      </span>
      <input
        type="number"
        min={0}
        step={unit === 'MB' ? 1 : 16}
        value={Number.isFinite(display) ? display : 0}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange(Number.isFinite(v) ? Math.max(0, Math.round(v * factor)) : 0);
        }}
      />
      <span className="settings__ref-label">{formatBytes(bytes)}</span>
    </label>
  );
}
