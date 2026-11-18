/**
 * Unit tests for the pure correlation-ID picker in correlation.ts.
 */

import { describe, expect, it } from 'vitest';
import { REDACTED } from '@/lib/capture/redaction';
import type { NetHeader } from '@/lib/session/types';
import { correlationIds } from './correlation';

function header(name: string, value = 'abc123'): NetHeader {
  return { name, value };
}

describe('correlationIds', () => {
  it('picks the IDs out of a response and leaves every other header behind', () => {
    const ids = correlationIds([
      header('content-type', 'application/json'),
      header('x-request-id', '5f1c0a52'),
      header('cache-control', 'no-store'),
      header('cf-ray', '8f2a1b3c4d5e6f70-FRA'),
    ]);
    expect(ids).toEqual([
      { name: 'x-request-id', value: '5f1c0a52' },
      { name: 'cf-ray', value: '8f2a1b3c4d5e6f70-FRA' },
    ]);
  });

  it('knows the request and trace headers of common servers, clouds and tracers', () => {
    for (const name of [
      // generic
      'x-request-id',
      'request-id',
      'x-correlation-id',
      'x-trace-id',
      // tracing
      'traceparent',
      'sentry-trace',
      'b3',
      'x-b3-traceid',
      'x-datadog-trace-id',
      'uber-trace-id',
      // AWS
      'x-amzn-requestid',
      'x-amzn-trace-id',
      'x-amz-request-id',
      'x-amz-id-2',
      'x-amz-cf-id',
      'x-amz-apigw-id',
      // Google Cloud and Azure
      'x-cloud-trace-context',
      'x-ms-request-id',
      'x-ms-correlation-request-id',
      'x-azure-ref',
      // edges and hosts
      'cf-ray',
      'x-vercel-id',
      'x-nf-request-id',
      'fly-request-id',
      'x-github-request-id',
    ]) {
      expect(correlationIds([header(name)]), name).toEqual([{ name, value: 'abc123' }]);
    }
  });

  it('matches a name in any case and reports it in lower case', () => {
    expect(
      correlationIds([
        header('X-Request-Id', 'r-1'),
        header('X-Amzn-RequestId', 'r-2'),
        header('CF-RAY', 'r-3'),
      ]),
    ).toEqual([
      { name: 'x-request-id', value: 'r-1' },
      { name: 'x-amzn-requestid', value: 'r-2' },
      { name: 'cf-ray', value: 'r-3' },
    ]);
  });

  it('ignores headers that are not request or trace IDs', () => {
    for (const name of [
      'content-type',
      'content-length',
      'etag',
      'server-timing',
      'x-forwarded-for',
      'x-session-id',
      'x-user-id',
      'x-client-id',
      'x-device-id',
      'x-api-key',
      'authorization',
      'cookie',
      'idempotency-key',
      'x-b3-spanid',
      'baggage',
      'tracestate',
      'x-subrequest-id',
      'x-requested-with',
      // Only plain hyphenated names are matched, so a name is safe to print.
      'x_request_id',
      'odd`name-request-id',
    ]) {
      expect(correlationIds([header(name)]), name).toEqual([]);
    }
  });

  it('leaves out a header whose value redaction has replaced', () => {
    expect(
      correlationIds([header('x-request-id', REDACTED), header('cf-ray', '8f2a-FRA')]),
    ).toEqual([{ name: 'cf-ray', value: '8f2a-FRA' }]);
  });

  it('leaves out an empty value', () => {
    expect(
      correlationIds([header('x-request-id', ''), header('cf-ray', '  ')]),
    ).toEqual([]);
  });

  it('reports a header once when the capture holds it twice in different case', () => {
    expect(
      correlationIds([header('X-Request-Id', 'r-1'), header('x-request-id', 'r-1')]),
    ).toEqual([{ name: 'x-request-id', value: 'r-1' }]);
  });

  it('keeps both values when one header name carries two different IDs', () => {
    expect(
      correlationIds([header('X-Request-Id', 'r-1'), header('x-request-id', 'r-2')]),
    ).toEqual([
      { name: 'x-request-id', value: 'r-1' },
      { name: 'x-request-id', value: 'r-2' },
    ]);
  });

  it('puts a value on one line', () => {
    expect(
      correlationIds([header('x-amzn-trace-id', 'Root=1-abc;\r\n  Parent=def')]),
    ).toEqual([{ name: 'x-amzn-trace-id', value: 'Root=1-abc; Parent=def' }]);
  });

  it('cuts a value at 200 characters and marks the cut', () => {
    const [id] = correlationIds([header('x-request-id', 'a'.repeat(5000))]);
    expect(id!.value).toBe(`${'a'.repeat(200)}…`);
    // A value at the cap is left whole.
    expect(correlationIds([header('x-request-id', 'b'.repeat(200))])[0]!.value).toBe(
      'b'.repeat(200),
    );
  });

  it('does not change the headers it is given', () => {
    const headers = [header('X-Request-Id', ' r-1 ')];
    const before = structuredClone(headers);
    correlationIds(headers);
    expect(headers).toEqual(before);
  });
});
