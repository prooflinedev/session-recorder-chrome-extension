import { defineContentScript } from 'wxt/utils/define-content-script';
import { onContentMessage, sendMessage } from '@/lib/messaging';
import { PointAnnotationOverlay } from '@/lib/annotations/point-overlay';
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    if (window.top !== window) return;
    const scope = window as Window & { __srPointAnnotations?: boolean };
    if (scope.__srPointAnnotations) return;
    scope.__srPointAnnotations = true;
    let overlay: PointAnnotationOverlay | undefined;
    let micOn = false;
    const setOn = (on: boolean) => {
      if (on && !overlay) {
        overlay = new PointAnnotationOverlay(async () => {
          setOn(false);
          await sendMessage({ kind: 'point-annotation/toggle', on: false });
        });
        overlay.setMicState(micOn);
      } else if (!on) {
        overlay?.dispose();
        overlay = undefined;
      }
    };
    onContentMessage((message) => {
      if (message.kind === 'content/mic') { micOn = message.on; overlay?.setMicState(micOn); }
      if (message.kind === 'content/dictation') overlay?.receiveTranscript(message);
      if (message.kind === 'content/point-annotate') setOn(message.on);
      if (message.kind === 'content/setActive' && !message.active) setOn(false);
      if (message.kind === 'content/annotate' && message.on) setOn(false);
    });
    void sendMessage({ kind: 'content/hello' })
      .then((state) => { micOn = state.micOn; setOn(state.active && state.pointing); })
      .catch(() => {});
  },
});
