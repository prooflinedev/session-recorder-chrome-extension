/**
 * Live session timeline: a dense, chronological activity feed.
 *
 * Each event is one row: a muted monospace time, a small line icon (the icon
 * conveys the type, so we never repeat it as a label), the event content, and
 * right-aligned metadata. Screenshots and annotations show an inline thumbnail
 * chip. Errors, voice, markers, notes, and annotations use the coral accent.
 *
 * The `visualFor` switch is exhaustive over `EventType` (guarded by
 * `assertNever`), so a new event type is a compile error.
 */
import React, { useEffect, useRef } from 'react';
import {
  MousePointer2,
  Pointer,
  Globe,
  Keyboard,
  ScrollText,
  TextCursor,
  Command,
  Compass,
  ArrowLeftRight,
  Camera,
  Pencil,
  Mic,
  Video,
  AlertCircle,
  Terminal,
  Flag,
  StickyNote,
  Paperclip,
  FileUp,
  Database,
  Info,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { formatClock } from '@/lib/export/markdown';
import { assertNever } from '@/lib/session/events';
import type { SessionEvent } from '@/lib/session/types';
import { useSidepanel } from '../store';
import { AssetThumb } from './AssetThumb';

type Tone = 'default' | 'muted' | 'error' | 'signal';

interface Visual {
  Icon: LucideIcon;
  label: string;
  meta?: string;
  sub?: string;
  tone: Tone;
  thumbAssetId?: string;
}

export function Timeline(): React.JSX.Element {
  const events = useSidepanel((s) => s.recentEvents);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Whether we should keep pinning to the bottom. True unless the user scrolls up.
  const stickRef = useRef(true);

  const toBottom = () => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    // Double-rAF: wait for layout (thumbnails, wrapping) to fully settle, then
    // pin. A single frame can land before late layout shifts and leave the
    // newest row just below the fold.
    requestAnimationFrame(() => {
      if (stickRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
      requestAnimationFrame(() => {
        if (stickRef.current && scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    });
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // "Stuck" if within ~80px of the bottom; lets the user scroll up to read
    // history without being yanked back down, while tolerating a row of
    // in-flight growth between pins.
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Re-pin whenever the NEWEST event changes. The ticker buffer is capped, so
  // once full its length stays constant while events flow — keying on length
  // would stop re-pinning exactly when the session gets busy.
  const lastEventId = events.length > 0 ? events[events.length - 1]?.id : undefined;
  useEffect(toBottom, [lastEventId]);

  // Re-pin when the list grows for any reason (thumbnails loading late, wrapping),
  // so async image loads don't leave us a few rows short of the bottom.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => toBottom());
    ro.observe(list);
    return () => ro.disconnect();
  }, []);

  const items = groupItems(events);

  return (
    <div className="tl" ref={scrollRef} onScroll={onScroll}>
      {events.length === 0 ? (
        <p className="tl__empty">Waiting for activity…</p>
      ) : (
        <ul className="tl__list" ref={listRef}>
          {items.map((item) =>
            item.kind === 'event' ? (
              <EventRow key={item.event.id} event={item.event} />
            ) : (
              <NetGroup key={item.id} events={item.events} />
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function EventRow({ event }: { event: SessionEvent }): React.JSX.Element {
  const v = visualFor(event);
  return (
    <li className={`tl-row tl-row--${v.tone}`}>
      <span className="tl-time">{formatClock(event.t)}</span>
      <span className="tl-icon" aria-hidden="true">
        <v.Icon size={15} strokeWidth={1.75} />
      </span>
      <span className="tl-body">
        <span className="tl-line">
          <span className="tl-label">{v.label}</span>
          {v.meta && <span className="tl-meta">{v.meta}</span>}
        </span>
        {v.sub && <span className="tl-sub">{v.sub}</span>}
      </span>
      {v.thumbAssetId && <AssetThumb assetId={v.thumbAssetId} alt={v.label} />}
    </li>
  );
}

/** Consecutive network requests, collapsed into a disclosure to cut clutter. */
function NetGroup({ events }: { events: SessionEvent[] }): React.JSX.Element {
  const errors = events.filter(
    (e) =>
      e.type === 'net-request' &&
      (e.payload.failed ||
        (typeof e.payload.status === 'number' && e.payload.status >= 400)),
  ).length;
  return (
    <li className="tl-netgroup">
      <details>
        <summary className="tl-row tl-row--muted">
          <span className="tl-time">{formatClock(events[0]!.t)}</span>
          <span className="tl-icon" aria-hidden="true">
            <Globe size={15} strokeWidth={1.75} />
          </span>
          <span className="tl-body">
            <span className="tl-line">
              <span className="tl-label">{events.length} network requests</span>
              {errors > 0 && (
                <span className="tl-meta tl-netgroup__err">
                  {errors} failed
                </span>
              )}
            </span>
          </span>
          <ChevronRight size={14} className="tl-netgroup__chev" />
        </summary>
        <ul className="tl-netgroup__list">
          {events.map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </ul>
      </details>
    </li>
  );
}

// ----------------------------------------------------------------------------
// Grouping: fold runs of >= 3 consecutive network requests into one group.
// ----------------------------------------------------------------------------

type TimelineItem =
  | { kind: 'event'; event: SessionEvent }
  | { kind: 'netgroup'; id: string; events: SessionEvent[] };

const NET_GROUP_MIN = 3;

function groupItems(events: SessionEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let run: SessionEvent[] = [];
  const flush = () => {
    if (run.length >= NET_GROUP_MIN) {
      items.push({ kind: 'netgroup', id: `ng-${run[0]!.id}`, events: run });
    } else {
      for (const e of run) items.push({ kind: 'event', event: e });
    }
    run = [];
  };
  for (const e of events) {
    if (e.type === 'net-request') {
      run.push(e);
    } else {
      flush();
      items.push({ kind: 'event', event: e });
    }
  }
  flush();
  return items;
}

function truncate(s: string, n = 52): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return truncate(u.pathname + u.search, 40);
  } catch {
    return truncate(url, 40);
  }
}

function netMeta(status: number | undefined, ms: number | undefined): string {
  const s = typeof status === 'number' ? String(status) : '';
  const t = typeof ms === 'number' ? `${Math.round(ms)}ms` : '';
  return [s, t].filter(Boolean).join(' · ');
}

function visualFor(e: SessionEvent): Visual {
  switch (e.type) {
    case 'click':
      return {
        Icon: MousePointer2,
        label: truncate(
          e.payload.descriptor.text ||
            e.payload.descriptor.ariaLabel ||
            e.payload.descriptor.selector ||
            e.payload.descriptor.tag ||
            'element',
        ),
        tone: 'default',
      };
    case 'input':
      return {
        Icon: Keyboard,
        label: truncate(
          e.payload.redacted ? '«redacted»' : e.payload.value || 'input',
        ),
        tone: 'default',
      };
    case 'scroll':
      return { Icon: ScrollText, label: 'Scrolled', tone: 'muted' };
    case 'key':
      return { Icon: Command, label: e.payload.key, tone: 'muted' };
    case 'hover': {
      const d = e.payload.descriptor;
      const noun = d.role || d.tag || 'element';
      const lbl = d.text || d.ariaLabel || d.name;
      return {
        Icon: Pointer,
        label: truncate(`Hovered ${noun}${lbl ? ` "${lbl}"` : ''}`),
        tone: 'muted',
      };
    }
    case 'text-select':
      return e.payload.cleared
        ? { Icon: TextCursor, label: 'Selection cleared', tone: 'muted' }
        : {
            Icon: TextCursor,
            label: truncate(`Selected "${e.payload.text ?? ''}"`),
            tone: 'muted',
          };
    case 'nav':
      return {
        Icon: Globe,
        label: truncate(e.payload.title || pathOf(e.payload.url)),
        tone: 'default',
      };
    case 'spa-route':
      return {
        Icon: Compass,
        label: truncate(e.payload.title || pathOf(e.payload.url)),
        tone: 'default',
      };
    case 'tab-switch':
    case 'tab-opened':
    case 'tab-closed': {
      const p = e.payload as { toTitle?: string; toUrl?: string; title?: string; url?: string };
      return {
        Icon: ArrowLeftRight,
        label: truncate(p.toTitle || p.title || p.toUrl || p.url || 'tab'),
        tone: 'muted',
      };
    }
    case 'net-request': {
      const p = e.payload;
      const bad = p.failed || (typeof p.status === 'number' && p.status >= 400);
      return {
        Icon: Globe,
        label: truncate(`${p.method} ${pathOf(p.url)}`, 44),
        meta: p.failed ? 'failed' : netMeta(p.status, p.timing?.durationMs),
        tone: bad ? 'error' : 'default',
      };
    }
    case 'console': {
      const p = e.payload;
      const repeat = p.repeat && p.repeat > 1 ? ` ×${p.repeat}` : '';
      return {
        Icon: Terminal,
        label: truncate(p.text + repeat),
        tone: p.level === 'error' ? 'error' : 'muted',
      };
    }
    case 'error':
      return {
        Icon: AlertCircle,
        label: truncate(e.payload.message, 44),
        tone: 'error',
      };
    case 'screenshot':
      return {
        Icon: Camera,
        label: 'Screenshot',
        sub: e.payload.contextText
          ? truncate(e.payload.contextText, 40)
          : undefined,
        tone: 'signal',
        thumbAssetId: e.payload.assetId,
      };
    case 'annotation-start':
      return { Icon: Pencil, label: 'Annotating…', tone: 'signal' };
    case 'annotation':
      return {
        Icon: Pencil,
        label: e.payload.shapes.find(shape => shape.text)?.text ?? 'Annotation',
        tone: 'signal',
        thumbAssetId: e.payload.screenshotAssetId,
      };
    case 'voice-segment': {
      const p = e.payload;
      if (p.transcriptionError)
        return {
          Icon: Mic,
          label: 'Voice',
          sub: truncate(p.transcriptionError, 40),
          tone: 'error',
        };
      return {
        Icon: Mic,
        label: truncate(p.transcript ?? '(audio)'),
        sub: p.anchorContext ? truncate(p.anchorContext, 40) : undefined,
        tone: 'signal',
      };
    }
    case 'video-segment': {
      const p = e.payload;
      const secs = Math.max(1, Math.round((p.tEnd - p.tStart) / 1000));
      return {
        Icon: Video,
        label: 'Video segment',
        meta: `${secs}s`,
        tone: 'signal',
      };
    }
    case 'file-captured':
      return {
        Icon: FileUp,
        label: truncate(e.payload.fileName),
        tone: 'signal',
      };
    case 'file-attached':
      return {
        Icon: Paperclip,
        label: truncate(e.payload.fileName),
        tone: 'signal',
      };
    case 'storage-snapshot':
      return {
        Icon: Database,
        label: e.payload.phase === 'start' ? 'Storage at start' : 'Storage at stop',
        sub: truncate(e.payload.origin, 40),
        meta: `${e.payload.entries.length} keys`,
        tone: 'muted',
      };
    case 'marker':
      return { Icon: Flag, label: truncate(e.payload.name), tone: 'signal' };
    case 'note':
      return { Icon: StickyNote, label: truncate(e.payload.text), tone: 'signal' };
    case 'session-note':
      return { Icon: Info, label: truncate(e.payload.text), tone: 'muted' };
    default:
      return assertNever(e);
  }
}
