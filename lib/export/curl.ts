import type { NetRequestPayload } from '@/lib/session/types';

const SKIPPED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'accept-encoding',
]);

/**
 * Safely quotes a string for POSIX-compliant shells (sh, bash, zsh).
 * Strips NUL bytes so strings cannot be truncated by C-based shell parsers.
 */
export function shellQuote(value: string): string {
  const sanitized = value.replace(/\0/g, '');
  return `'${sanitized.replace(/'/g, `'\\''`)}'`;
}

/**
 * Converts a captured HTTP network request into a multi-line cURL command.
 * Returns null for WebSocket entries, which cannot be replayed via HTTP cURL.
 */
export function buildCurlCommand(req: NetRequestPayload): string | null {
  if (req.websocket) return null;

  const method = (req.method || 'GET').toUpperCase();
  const hasRawBody =
    Boolean(req.requestBody?.present) &&
    typeof req.requestBody?.text === 'string' &&
    req.requestBody.text.length > 0;

  const lines: string[] = [];

  if (method === 'GET' && !hasRawBody) {
    lines.push(`curl ${shellQuote(req.url)}`);
  } else {
    lines.push(`curl -X ${shellQuote(method)} ${shellQuote(req.url)}`);
  }

  for (const header of req.requestHeaders ?? []) {
    const name = header.name.trim();
    if (!name || name.startsWith(':')) continue;
    if (SKIPPED_HEADERS.has(name.toLowerCase())) continue;
    lines.push(`-H ${shellQuote(`${name}: ${header.value}`)}`);
  }

  if (hasRawBody && req.requestBody?.text) {
    lines.push(`--data-raw ${shellQuote(req.requestBody.text)}`);
  }

  return lines.join(' \\\n  ');
}
