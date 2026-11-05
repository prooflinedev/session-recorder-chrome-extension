import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { contracts } from './ujg-screenshot-contracts.mjs';
import { decode, requireInFrame, rejectRepeatedChrome, pairBuffers } from './ujg-screenshot-capture.mjs';

test('every material Surface has one explicit capture contract', async () => {
  const document = JSON.parse(await readFile(new URL('../generated/user-journeys.ujg.jsonld', import.meta.url), 'utf8'));
  const nodes = new Map(document.nodes.map((node) => [node['@id'], node]));
  const expected = new Set(document.nodes
    .filter((node) => node['@type'] === 'Surface' && ['State', 'CompositeState'].includes(nodes.get(node.graphNodeRef)?.['@type']))
    .map((node) => node['@id']));
  assert.equal(contracts.size, expected.size);
  assert.deepEqual(new Set(contracts.keys()), expected);
  for (const [id, contract] of contracts) {
    assert.match(id, /^urn:proofline:session-recorder:Surface:/);
    for (const field of ['group', 'frame', 'fixture', 'setup', 'source', 'root']) assert.ok(contract[field], `${id}: missing ${field}`);
    assert.ok(contract.required.length > 0, `${id}: missing identifying evidence`);
  }
});

test('reject the actual duplicated workspace PNG from the previous capture', async () => {
  const png = await readFile(new URL('./fixtures/ujg/duplicated-workspace.png', import.meta.url));
  assert.throws(() => rejectRepeatedChrome(png, { x: 180, y: 0, width: 1260, height: 62 }), /Repeated owning chrome/);
});

test('reject the legacy scrolled copying frame when the required feedback is above it', async () => {
  const png = decode(await readFile(new URL('./fixtures/ujg/scrolled-copying.png', import.meta.url)));
  // Sticky toolbar stays on screen; the feedback row below it scrolls away.
  // The old runner checked DOM visibility, so accepted this missing evidence.
  assert.throws(() => requireInFrame([
    { description: 'Preparing… / Cancel', bounds: { x: 180, y: -550, width: 1260, height: 50 } },
    { description: 'Copy issue Markdown', bounds: { x: 237, y: 720, width: 180, height: 32 } },
  ], { x: 0, y: 0, width: png.width, height: png.height }), /Preparing.*outside the capture frame/);
});

test('reject partial clipping, allow a fully contained control', () => {
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  assert.throws(() => requireInFrame([{ description: 'Stop', bounds: { x: 340, y: 50, width: 90, height: 32 } }], frame), /outside/);
  requireInFrame([{ description: 'Stop', bounds: { x: 300, y: 50, width: 74, height: 32 } }], frame);
});

test('two-pane composition preserves pixels and rejects scaling', () => {
  const a = new PNG({ width: 3, height: 2 }), b = new PNG({ width: 2, height: 2 });
  a.data.fill(123); b.data.fill(231);
  const result = PNG.sync.read(pairBuffers(PNG.sync.write(a), PNG.sync.write(b)));
  assert.equal(result.width, 6);
  assert.equal(result.height, 2);
  assert.equal(result.data[0], 123);
  assert.equal(result.data[4 * 4], 231);
  assert.throws(() => pairBuffers(PNG.sync.write(a), PNG.sync.write(new PNG({ width: 2, height: 3 }))), /no scaling/);
});

test('black and blank images fail even with valid dimensions and PNG headers', () => {
  for (const fill of [0, 255]) {
    const png = new PNG({ width: 200, height: 200 }); png.data.fill(fill);
    assert.throws(() => decode(PNG.sync.write(png)), /Blank or black/);
  }
});
