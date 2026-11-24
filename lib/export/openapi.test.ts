/** Unit tests for the pure OpenAPI compiler (lib/export/openapi.ts). */
import { describe, expect, it } from 'vitest';
import { SessionBuilder } from '@/lib/fixtures/session-builder';
import type { NetRequestPayload, SessionEvent } from '@/lib/session/types';
import { apiBodyAssetIds, buildOpenApiSpec, isApiIsh } from './openapi';

const noAssets = (): string | undefined => undefined;

function netEvents(build: (b: SessionBuilder) => void): SessionEvent[] {
  const b = new SessionBuilder({ name: 'API session' });
  build(b);
  return b.build().events;
}

/** The payload of the ONLY net-request event, for post-hoc tweaking. */
function netPayload(events: SessionEvent[], index = 0): NetRequestPayload {
  const nets = events.filter(
    (e): e is Extract<SessionEvent, { type: 'net-request' }> =>
      e.type === 'net-request',
  );
  return (nets[index] as Extract<SessionEvent, { type: 'net-request' }>).payload;
}

type Op = Record<string, any>;

function opAt(spec: Record<string, unknown>, path: string, method: string): Op {
  const paths = spec.paths as Record<string, Record<string, Op>>;
  const item = paths[path];
  expect(item, `paths['${path}'] exists`).toBeTruthy();
  const op = item![method];
  expect(op, `paths['${path}'].${method} exists`).toBeTruthy();
  return op!;
}

describe('isApiIsh', () => {
  it('accepts XHR/fetch and JSON responses, rejects the rest', () => {
    expect(isApiIsh({ url: 'https://a/api/x', resourceType: 'XHR' })).toBe(true);
    expect(isApiIsh({ url: 'https://a/api/x', resourceType: 'Fetch' })).toBe(true);
    expect(isApiIsh({ url: 'https://a/x', mime: 'application/json' })).toBe(true);
    expect(isApiIsh({ url: 'https://a/x', resourceType: 'Document', mime: 'text/html' })).toBe(false);
    expect(isApiIsh({ url: 'https://a/x', resourceType: 'XHR', websocket: true })).toBe(false);
    // static + telemetry lose even when XHR-shaped
    expect(isApiIsh({ url: 'https://a/logo.png', resourceType: 'Image', mime: 'image/png' })).toBe(false);
    expect(isApiIsh({ url: 'https://api.segment.io/v1/batch', resourceType: 'XHR' })).toBe(false);
  });
});

describe('buildOpenApiSpec', () => {
  it('compiles a happy-path POST with request and response schemas', () => {
    const events = netEvents((b) =>
      b.net('POST', 'https://api.example.com/api/users?verbose=1', {
        status: 200,
        reqBody: '{"name":"Ada","age":36}',
        resBody: '{"id":7,"name":"Ada"}',
      }),
    );
    const result = buildOpenApiSpec(events, noAssets, {
      name: 'API session',
      startedAt: Date.UTC(2026, 0, 2),
    });
    expect(result).not.toBeNull();
    const { spec, endpointCount } = result!;
    expect(endpointCount).toBe(1);
    expect(spec.openapi).toBe('3.1.0');
    expect((spec.info as Op).title).toContain('API session');
    expect(spec.servers).toEqual([{ url: 'https://api.example.com' }]);

    const op = opAt(spec, '/api/users', 'post');
    const reqSchema = op.requestBody.content['application/json'].schema;
    expect(reqSchema.type).toBe('object');
    expect(Object.keys(reqSchema.properties)).toEqual(['name', 'age']);
    const resSchema = op.responses['200'].content['application/json'].schema;
    expect(Object.keys(resSchema.properties)).toEqual(['id', 'name']);
    // observed query param, optional
    expect(op.parameters).toContainEqual({
      name: 'verbose',
      in: 'query',
      required: false,
      schema: { type: 'string' },
    });
    // valid JSON document end to end
    expect(() => JSON.parse(JSON.stringify(spec))).not.toThrow();
  });

  it('templates id-like segments and merges numeric/uuid/hex variants into one path', () => {
    const events = netEvents((b) =>
      b
        .net('GET', 'https://api.example.com/api/users/123', {
          status: 200,
          resBody: '{"id":123}',
        })
        .net('GET', 'https://api.example.com/api/users/9f8b7c6d-1a2b-4c3d-8e9f-0a1b2c3d4e5f', {
          status: 200,
          resBody: '{"id":9}',
        })
        .net('GET', 'https://api.example.com/api/users/0123456789abcdef0123', {
          status: 200,
          resBody: '{"id":1}',
        }),
    );
    const { spec, endpointCount } = buildOpenApiSpec(events, noAssets)!;
    expect(endpointCount).toBe(1);
    const op = opAt(spec, '/api/users/{userId}', 'get');
    expect(op.parameters).toContainEqual({
      name: 'userId',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    });
    expect(op.summary).toContain('3');
  });

  it('gives multiple id segments in one path unique param names', () => {
    const events = netEvents((b) =>
      b.net('GET', 'https://api.example.com/api/users/12/12', { status: 200 }),
    );
    const { spec } = buildOpenApiSpec(events, noAssets)!;
    const op = opAt(spec, '/api/users/{userId}/{userId2}', 'get');
    const names = (op.parameters as Op[])
      .filter((p) => p.in === 'path')
      .map((p) => p.name);
    expect(names).toEqual(['userId', 'userId2']);
  });

  it('keeps one response entry per observed status', () => {
    const events = netEvents((b) =>
      b
        .net('GET', 'https://api.example.com/api/items', {
          status: 200,
          resBody: '{"items":[]}',
        })
        .net('GET', 'https://api.example.com/api/items', {
          status: 404,
          resBody: '{"error":"not found"}',
        }),
    );
    const { spec, endpointCount } = buildOpenApiSpec(events, noAssets)!;
    expect(endpointCount).toBe(1);
    const op = opAt(spec, '/api/items', 'get');
    expect(Object.keys(op.responses).sort()).toEqual(['200', '404']);
    expect(
      Object.keys(op.responses['404'].content['application/json'].schema.properties),
    ).toEqual(['error']);
  });

  it('merges schemas across samples: shared fields required, extras optional', () => {
    const events = netEvents((b) =>
      b
        .net('GET', 'https://api.example.com/api/profile', {
          status: 200,
          resBody: '{"id":1,"nickname":"ada"}',
        })
        .net('GET', 'https://api.example.com/api/profile', {
          status: 200,
          resBody: '{"id":2}',
        }),
    );
    const { spec } = buildOpenApiSpec(events, noAssets)!;
    const schema = opAt(spec, '/api/profile', 'get').responses['200'].content[
      'application/json'
    ].schema;
    expect(Object.keys(schema.properties).sort()).toEqual(['id', 'nickname']);
    expect(schema.required).toEqual(['id']);
  });

  it('prefers the full stored body (via resolver) over truncated inline text', () => {
    const events = netEvents((b) =>
      b.net('GET', 'https://api.example.com/api/big', { status: 200 }),
    );
    const p = netPayload(events);
    p.responseBody = {
      present: true,
      mime: 'application/json',
      text: '{"items":[{"id":1},{"i', // cut mid-JSON by the inline cap
      truncated: true,
      originalSize: 4096,
      assetId: 'asset_big',
    };
    const resolve = (id: string) =>
      id === 'asset_big' ? '{"items":[{"id":1},{"id":2}],"total":2}' : undefined;
    const { spec } = buildOpenApiSpec(events, resolve)!;
    const schema = opAt(spec, '/api/big', 'get').responses['200'].content[
      'application/json'
    ].schema;
    expect(Object.keys(schema.properties).sort()).toEqual(['items', 'total']);
  });

  it('ignores a truncated inline body with no stored copy (no schema, mime kept)', () => {
    const events = netEvents((b) =>
      b.net('GET', 'https://api.example.com/api/big', { status: 200 }),
    );
    const p = netPayload(events);
    p.responseBody = {
      present: true,
      mime: 'application/json',
      text: '{"items":[{"id":1},{"i',
      truncated: true,
      originalSize: 4096,
    };
    const { spec } = buildOpenApiSpec(events, noAssets)!;
    const entry = opAt(spec, '/api/big', 'get').responses['200'];
    expect(entry.content['application/json'].schema).toBeUndefined();
  });

  it('tolerates malformed JSON: endpoint listed, content type kept, no schema', () => {
    const events = netEvents((b) =>
      b.net('POST', 'https://api.example.com/api/echo', {
        status: 200,
        reqBody: 'not json at all {',
        resBody: '{"broken":',
      }),
    );
    const { spec } = buildOpenApiSpec(events, noAssets)!;
    const op = opAt(spec, '/api/echo', 'post');
    expect(op.requestBody.content['application/json']).toEqual({});
    expect(op.responses['200'].content['application/json']).toEqual({});
  });

  it('excludes telemetry, static assets, and websockets entirely', () => {
    const events = netEvents((b) =>
      b
        .net('POST', 'https://api.segment.io/v1/batch', {
          status: 200,
          reqBody: '{"batch":[]}',
        })
        .net('GET', 'https://cdn.example.com/logo.png', {
          status: 200,
          mime: 'image/png',
        })
        .net('GET', 'https://app.example.com/ingest/i/v0/e', {
          status: 200,
          resBody: '{"ok":true}',
        }),
    );
    // Hand-build a websocket request (the builder has no ws helper).
    const wsEvents = netEvents((b) =>
      b.net('GET', 'wss://app.example.com/api/live', { status: 101 }),
    );
    netPayload(wsEvents).websocket = true;

    expect(buildOpenApiSpec(events, noAssets)).toBeNull();
    expect(buildOpenApiSpec(wsEvents, noAssets)).toBeNull();
  });

  it('describes application endpoints whose last segment looks like a collector', () => {
    const events = netEvents((b) =>
      b
        .net('POST', 'https://shop.example.com/api/orders/batch', {
          status: 200,
          reqBody: '{"items":[1,2]}',
          resBody: '{"orderIds":[7]}',
        })
        .net('GET', 'https://music.example.com/api/playlists/12/track', {
          status: 200,
          resBody: '{"title":"x"}',
        }),
    );
    const { spec } = buildOpenApiSpec(events, noAssets)!;
    expect(opAt(spec, '/api/orders/batch', 'post')).toBeTruthy();
    expect(opAt(spec, '/api/playlists/{playlistId}/track', 'get')).toBeTruthy();
  });

  it('returns null for sessions with no API traffic at all', () => {
    const events = netEvents((b) => b.nav('https://a/x').click('Go').scroll());
    expect(buildOpenApiSpec(events, noAssets)).toBeNull();
    expect(buildOpenApiSpec([], noAssets)).toBeNull();
  });

  it('emits only schema types legal for the declared OpenAPI version', () => {
    // Null-valued fields and mixed-type ids make genson emit JSON-Schema type
    // unions like ["null","string"] — legal in 3.1 (Schema Objects are JSON
    // Schema), illegal in 3.0.x. Guard the declared version against the output.
    const events = netEvents((b) =>
      b
        .net('GET', 'https://api.example.com/api/profile', {
          status: 200,
          resBody: '{"id":1,"middleName":null}',
        })
        .net('GET', 'https://api.example.com/api/profile', {
          status: 200,
          resBody: '{"id":"1e4b","middleName":"Q"}',
        }),
    );
    const { spec } = buildOpenApiSpec(events, noAssets)!;
    expect(spec.openapi).toBe('3.1.0');

    const JSON_SCHEMA_TYPES = new Set([
      'null', 'boolean', 'object', 'array', 'number', 'string', 'integer',
    ]);
    const typesSeen: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'type') typesSeen.push(value);
        walk(value);
      }
    };
    walk(spec);

    expect(typesSeen.length).toBeGreaterThan(0);
    for (const t of typesSeen) {
      const list = Array.isArray(t) ? t : [t];
      for (const entry of list) {
        expect(typeof entry).toBe('string');
        expect(JSON_SCHEMA_TYPES.has(entry as string)).toBe(true);
      }
    }

    // The union cases the version bump exists for really are exercised.
    const schema = opAt(spec, '/api/profile', 'get').responses['200'].content[
      'application/json'
    ].schema;
    expect([...schema.properties.id.type].sort()).toEqual(['integer', 'string']);
    expect([...schema.properties.middleName.type].sort()).toEqual(['null', 'string']);
  });

  it('emits a default response when a request never got a status', () => {
    const events = netEvents((b) =>
      b.net('GET', 'https://api.example.com/api/flaky', { status: 200 }),
    );
    const p = netPayload(events);
    delete p.status;
    p.failed = true;
    p.responseBody = undefined;
    const { spec } = buildOpenApiSpec(events, noAssets)!;
    const op = opAt(spec, '/api/flaky', 'get');
    expect(op.responses.default.description).toContain('No response');
  });
});

describe('apiBodyAssetIds', () => {
  it('collects only asset ids referenced by API-ish bodies, skipping base64', () => {
    const events = netEvents((b) =>
      b
        .net('GET', 'https://api.example.com/api/a', { status: 200 })
        .net('GET', 'https://cdn.example.com/logo.png', { status: 200, mime: 'image/png' }),
    );
    netPayload(events, 0).responseBody = {
      present: true,
      truncated: true,
      text: '{',
      assetId: 'asset_json',
    };
    netPayload(events, 0).requestBody = {
      present: true,
      truncated: true,
      base64: true,
      text: 'AAAA',
      assetId: 'asset_bin',
    };
    netPayload(events, 1).responseBody = {
      present: true,
      truncated: true,
      text: 'x',
      assetId: 'asset_png',
    };
    expect(apiBodyAssetIds(events)).toEqual(['asset_json']);
  });
});
