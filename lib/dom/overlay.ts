/**
 * Shared identifier for the annotation overlay's shadow-DOM host element.
 *
 * Lives in its own tiny module so both the annotation content script (which
 * creates the host) and the interaction content script (which must ignore
 * pointer/keyboard events that retarget to it while annotating) agree on the id
 * without importing each other's bundles.
 */
export const ANNOTATION_HOST_ID = '__session_recorder_annotation_host__';

export const POINT_ANNOTATION_HOST_ID = '__session_recorder_point_annotation_host__';

export const CURSOR_OVERLAY_HOST_ID = '__session_recorder_cursor_overlay_host__';

/** True when an event target is (or lives inside) the annotation overlay host. */
export function isAnnotationOverlay(target: unknown): boolean {
  return target instanceof Element && [ANNOTATION_HOST_ID, POINT_ANNOTATION_HOST_ID].includes(target.id);
}

/** True when an event target belongs to any recorder-injected overlay host. */
export function isRecorderOverlay(target: unknown): boolean {
  return (
    target instanceof Element &&
    [ANNOTATION_HOST_ID, POINT_ANNOTATION_HOST_ID, CURSOR_OVERLAY_HOST_ID].includes(target.id)
  );
}
