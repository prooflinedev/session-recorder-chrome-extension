import type { NetRequestPayload } from '@/lib/session/types';

const SKIPPED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'accept-encoding',
]);

const SHAPE_SUMMARY_PLACEHOLDER = '«body reduced to shape summary»';

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
  const bodyText = req.requestBody?.text;
  const hasRawBody =
    Boolean(req.requestBody?.present) &&
    typeof bodyText === 'string' &&
    bodyText.length > 0 &&
    bodyText !== SHAPE_SUMMARY_PLACEHOLDER;

  const lines: string[] = [];

  if (method === 'GET' && !hasRawBody) {
    lines.push(`curl --globoff ${shellQuote(req.url)}`);
  } else {
    lines.push(`curl --globoff -X ${shellQuote(method)} ${shellQuote(req.url)}`);
  }

  for (const header of req.requestHeaders ?? []) {
    const name = header.name.trim();
    if (!name || name.startsWith(':')) continue;
    if (SKIPPED_HEADERS.has(name.toLowerCase())) continue;
    lines.push(`-H ${shellQuote(`${name}: ${header.value}`)}`);
  }

  if (hasRawBody && bodyText) {
    lines.push(`--data-raw ${shellQuote(bodyText)}`);
  }

  return lines.join(' \\\n  ');
}
