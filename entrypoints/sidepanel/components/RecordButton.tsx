/**
 * The idle-state Record control: a split button. The main area starts a
 * recording of the active tab; the caret on its right opens the capture-setup
 * popover: a detail slider (screenshot frequency, pointer sensitivity, network
 * body caps) plus extras — start tab video (which includes the tab's sound) and
 * mic narration with the session, and build an OpenAPI spec from captured
 * requests. All choices persist into the global capture defaults.
 */

import React from 'react';
import {
  ChevronDown,
  Video,
  Mic,
  FileJson2,
  CircleDot,
  MousePointerClick,
} from 'lucide-react';
import { CAPTURE_DETAIL_LEVELS } from '@/lib/session/settings';
import { VoiceSetupModal } from './VoiceSetupModal';
import { useRecordSetup } from './useRecordSetup';

/** A compact switch row inside the popover: icon, label + hint, toggle. */
function OptionRow({
  icon,
  label,
  hint,
  on,
  onChange,
  disabled = false,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="detail-opt"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      title={disabled ? 'Enable Video to use cursor effects' : undefined}
      onClick={() => onChange(!on)}
    >
      <span className={`detail-opt__icon${on ? ' detail-opt__icon--on' : ''}`}>
        {icon}
      </span>
      <span className="detail-opt__text">
        <span className="detail-opt__label">{label}</span>
        <span className="detail-opt__hint">{hint}</span>
      </span>
      <span className={`sw${on ? ' sw--on' : ''}`} aria-hidden="true">
        <span className="sw__knob" />
      </span>
    </button>
  );
}

export function RecordButton(): React.JSX.Element {
  const {
    ready,
    busy,
    localError,
    detail,
    videoFromStart,
    micFromStart,
    apiSpec,
    cursorSpotlight,
    clickHighlight,
    open,
    voiceSetupOpen,
    wrapRef,
    record,
    start,
    onDetail,
    onVideo,
    onMicFromStart,
    onApiSpec,
    onCursorSpotlight,
    onClickHighlight,
    setVoiceSetupOpen,
    toggleOptions,
  } = useRecordSetup();
  const preset = CAPTURE_DETAIL_LEVELS[detail];

  return (
    <div className="record-hero">
      {voiceSetupOpen && (
        <VoiceSetupModal
          onDone={() => {
            setVoiceSetupOpen(false);
            void start();
          }}
          onCancel={() => setVoiceSetupOpen(false)}
        />
      )}
      <div className="record-split" ref={wrapRef}>
        <button
          type="button"
          className="record-split__main"
          onClick={() => void record()}
          disabled={busy || !ready}
          aria-label="Start recording"
        >
          <span className="record-btn__dot" />
          {busy ? 'Starting…' : 'Record'}
        </button>
        <button
          type="button"
          className="record-split__caret"
          onClick={toggleOptions}
          aria-label="Capture options"
          aria-expanded={open}
          disabled={!ready}
        >
          <ChevronDown size={16} strokeWidth={2.5} />
        </button>

        {open && (
          <div className="detail-pop" role="dialog" aria-label="Capture options">
            <div className="detail-pop__head">
              <span>Capture detail</span>
              <span className="detail-pop__level">{preset?.label}</span>
            </div>
            <input
              type="range"
              className="detail-pop__range"
              min={0}
              max={CAPTURE_DETAIL_LEVELS.length - 1}
              step={1}
              value={detail}
              onChange={(e) => onDetail(Number(e.target.value))}
            />
            <div className="detail-pop__ticks">
              <span>Less</span>
              <span>More</span>
            </div>
            <p className="detail-pop__hint">{preset?.hint}</p>

            <div className="detail-pop__sep" role="separator" />
            <div className="detail-pop__head">
              <span>Also capture</span>
            </div>
            <OptionRow
              icon={<Video size={15} strokeWidth={1.9} />}
              label="Video"
              hint="Record the tab, with its sound, from the start"
              on={videoFromStart}
              onChange={onVideo}
            />
            <OptionRow
              icon={<Mic size={15} strokeWidth={1.9} />}
              label="Mic"
              hint="Narrate with your microphone from the start"
              on={micFromStart}
              onChange={onMicFromStart}
            />
            <OptionRow
              icon={<FileJson2 size={15} strokeWidth={1.9} />}
              label="API spec"
              hint="Full bodies → openapi.json in the export"
              on={apiSpec}
              onChange={onApiSpec}
            />

            <div className="detail-pop__sep" role="separator" />
            <div className="detail-pop__head">
              <span>Cursor effects</span>
            </div>
            <OptionRow
              icon={<CircleDot size={15} strokeWidth={1.9} />}
              label="Cursor spotlight"
              hint="Subtle halo around the pointer"
              on={cursorSpotlight}
              onChange={onCursorSpotlight}
              disabled={!videoFromStart}
            />
            <OptionRow
              icon={<MousePointerClick size={15} strokeWidth={1.9} />}
              label="Highlight clicks"
              hint="Expanding ripple at each click"
              on={clickHighlight}
              onChange={onClickHighlight}
              disabled={!videoFromStart}
            />
            <p className="detail-pop__note">
              {!videoFromStart && 'Enable Video to use cursor effects. '}
              Rendered on the page while video is recording and embedded permanently in captured video and screenshots.
            </p>
          </div>
        )}
      </div>
      {localError && <p className="record-hero__error">{localError}</p>}
    </div>
  );
}
