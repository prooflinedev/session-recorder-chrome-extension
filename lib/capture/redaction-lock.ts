export function screenshotRedactionLock(sessionId: string): string {
  return `session-recorder:screenshot-redaction:${sessionId}`;
}
