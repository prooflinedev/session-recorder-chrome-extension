/**
 * Export panel for a single session. Reads the session's events + assets
 * directly from IndexedDB, shows the four verbosity levels (L0..L3) with their
 * estimated token counts and a one-line "omits…" note, and on Download builds
 * the bundle, zips it, and hands the blob to `chrome.downloads`.
 *
 * Everything here runs against the full-fidelity data in IndexedDB, so a session
 * can be re-exported at any level after the fact.
 */

import React, { useEffect, useState } from 'react';
import {
  getAssets,
  getAssetsMeta,
  getEvents,
  getSession,
} from '@/lib/storage';
import { buildBundle, estimateForLevels } from '@/lib/export/bundle';
import { zipFiles } from '@/lib/export/zip';
import DOMPurify from 'dompurify';
import { applyLevel } from '@/lib/export/trimmer';
import { buildReportHtml } from '@/lib/export/report-html';
import { toAssetMeta } from '@/lib/session/asset-meta';
import { screenshotRedactionLock } from '@/lib/capture/redaction-lock';
import { broadcast, onBroadcast, type TokenEstimate } from '@/lib/messaging';
import type { VerbosityLevel } from '@/lib/session/types';
import { fileToDataUrl, sessionFolderName } from '../store';

interface ExportPanelProps {
  sessionId: string;
}

/** Above this token estimate a level is flagged as risky for model context. */
const TOKEN_WARN_LIMIT = 180_000;

const LEVEL_ORDER: VerbosityLevel[] = ['L0', 'L1', 'L2', 'L3'];
const LEVEL_LABELS: Record<VerbosityLevel, string> = {
  L0: 'Full',
  L1: 'Standard',
  L2: 'Compact',
  L3: 'Minimal',
};

export function ExportPanel({ sessionId }: ExportPanelProps): React.JSX.Element {
  const [estimates, setEstimates] = useState<TokenEstimate[] | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [level, setLevel] = useState<VerbosityLevel>('L1');
  const [assetVersion, setAssetVersion] = useState(0);

  // Follow level changes made in an open report tab, so the two choosers never
  // disagree (the radio onChange broadcasts the same event the other way).
  useEffect(
    () =>
      onBroadcast((evt) => {
        if (evt.kind === 'report/level' && evt.sessionId === sessionId) {
          setLevel(evt.level);
        }
        if (evt.kind === 'asset/redaction-updated' && evt.sessionId === sessionId) {
          setAssetVersion((version) => version + 1);
        }
      }),
    [sessionId],
  );

  const [building, setBuilding] = useState(false);
  const [phase, setPhase] = useState('');
  const [buildError, setBuildError] = useState<string | undefined>();
  const [includeHtml, setIncludeHtml] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEstimates(null);
    setLoadError(undefined);
    (async () => {
      try {
        const session = await getSession(sessionId);
        if (!session) throw new Error('Session not found.');
        const [events, assets] = await Promise.all([
          getEvents(sessionId),
          getAssetsMeta(sessionId),
        ]);
        const result = estimateForLevels(events, assets, session);
        if (!cancelled) setEstimates(result);
      } catch (err) {
        if (!cancelled) setLoadError(describe(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, assetVersion]);

  // Once estimates land, if the selected level is over the limit, nudge to L1.
  useEffect(() => {
    if (!estimates) return;
    const current = estimates.find((e) => e.level === level);
    if (current && current.tokens > TOKEN_WARN_LIMIT) setLevel('L1');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimates]);

  const onDownload = async () => {
    if (building) return;
    setBuilding(true);
    setBuildError(undefined);
    setPhase('Preparing…');
    let url: string | undefined;
    try {
      const session = await getSession(sessionId);
      if (!session) throw new Error('Session not found.');
      await navigator.locks.request(screenshotRedactionLock(sessionId), { mode: 'exclusive' }, async () => {
      const [events, assets] = await Promise.all([
        getEvents(sessionId),
        getAssets(sessionId),
      ]);

      setPhase('Building report…');
      const files = await buildBundle({ session, events, assets, level });

      if (includeHtml) {
        setPhase('Rendering HTML…');
        const meta = assets.map(toAssetMeta);
        const ctx = {
          assetsById: new Map(meta.map((m) => [m.id, m])),
          settings: session.settings,
        };
        const trimmed = applyLevel(events, level, ctx);
        const urls = new Map<string, string>();
        for (const a of assets) {
          // Images only, deliberately: embedding multi-MB video/audio blobs as
          // data URLs would explode the standalone HTML. Video-segment lines
          // render there without a link.
          if (a.kind === 'screenshot' || a.mime.startsWith('image/')) {
            urls.set(a.id, await fileToDataUrl(a.blob));
          }
        }
        const html = buildReportHtml({
          session,
          events: trimmed,
          assets: meta,
          level,
          imageUrl: (id) => urls.get(id),
          sanitize: (h) =>
            DOMPurify.sanitize(h, {
              ADD_ATTR: ['target'],
              // Allow data: image URIs (our embedded screenshots).
              ALLOWED_URI_REGEXP:
                /^(?:data:image\/|https?:|mailto:|tel:|#|\/)/i,
            }),
        });
        files.push({ path: 'report.html', text: html });
      }

      setPhase('Zipping…');
      const folder = sessionFolderName(session);
      const bytes = await zipFiles(files, folder);

      setPhase('Downloading…');
      const blob = new Blob([bytes], { type: 'application/zip' });
      url = URL.createObjectURL(blob);
      await chrome.downloads.download({ url, filename: `${folder}.zip` });
      setPhase('Downloaded');
      });
    } catch (err) {
      setBuildError(describe(err));
      setPhase('');
    } finally {
      setBuilding(false);
      // Give the download a moment to start reading the blob before revoking.
      if (url) {
        const toRevoke = url;
        setTimeout(() => URL.revokeObjectURL(toRevoke), 60_000);
      }
    }
  };

  const byLevel = new Map((estimates ?? []).map((e) => [e.level, e]));

  return (
    <div className="export">
      <div className="export__head">Export</div>

      {loadError && <p className="export__error">{loadError}</p>}

      {!estimates && !loadError && (
        <p className="export__loading">Estimating…</p>
      )}

      {estimates && (
        <fieldset className="levels">
          {LEVEL_ORDER.map((lvl) => {
            const est = byLevel.get(lvl);
            const selected = level === lvl;
            return (
              <label
                key={lvl}
                className={`level ${selected ? 'level--selected' : ''}`}
              >
                <input
                  type="radio"
                  name="verbosity"
                  value={lvl}
                  checked={selected}
                  onChange={() => {
                    setLevel(lvl);
                    // Re-render an open report tab for this session at the new level.
                    broadcast({ kind: 'report/level', sessionId, level: lvl });
                  }}
                />
                <span className="level__body">
                  <span className="level__title">
                    <span className="level__name">{LEVEL_LABELS[lvl]}</span>
                    <span className="level__tokens">
                      {est ? `~${formatTokens(est.tokens)}` : '—'}
                    </span>
                  </span>
                  <span className="level__omits">{omitNote(est)}</span>
                  {est && est.tokens > TOKEN_WARN_LIMIT && (
                    <span className="level__warn">
                      large: may exceed model limits
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      <label className="export__opt">
        <input
          type="checkbox"
          checked={includeHtml}
          onChange={(e) => setIncludeHtml(e.target.checked)}
        />
        <span>Also include a rendered HTML page</span>
      </label>

      <button
        type="button"
        className="btn btn--primary export__download"
        onClick={() => void onDownload()}
        disabled={building || !estimates}
      >
        {building ? phase || 'Working…' : 'Download .zip'}
      </button>

      {building && (
        <div className="export__progress" role="status">
          {phase}
        </div>
      )}
      {!building && phase === 'Downloaded' && (
        <div className="export__done" role="status">
          Saved to your downloads.
        </div>
      )}
      {buildError && <p className="export__error">{buildError}</p>}
      <button type="button" className="btn export__share" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(`/share.html?session=${encodeURIComponent(sessionId)}&level=${level}`) })}>
        Share report & create issue
      </button>
    </div>
  );
}

function omitNote(est: TokenEstimate | undefined): string {
  if (!est) return '';
  if (est.omitted.length === 0) return 'Full fidelity, nothing omitted';
  return `Omits: ${est.omitted.join(', ')}`;
}

function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(n);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
