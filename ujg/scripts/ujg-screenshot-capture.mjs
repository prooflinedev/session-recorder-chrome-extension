import { expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, readdir, stat, rename, rm, cp } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { contracts, surfaceId } from './ujg-screenshot-contracts.mjs';

export const viewports = { page: { width: 1220, height: 844 }, panel: { width: 390, height: 844 }, workspace: { width: 1440, height: 1200 }, timeline: { width: 1440, height: 900 }, settings: { width: 1200, height: 1600 } };
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const inside = (inner, outer) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;
export function requireInFrame(required, frame) {
  for (const item of required) if (!inside(item.bounds, frame)) throw new Error(`${item.description} lies outside the capture frame: ${JSON.stringify(item.bounds)} / ${JSON.stringify(frame)}`);
}
export function decode(buffer) {
  const png = PNG.sync.read(buffer, { checkCRC: true });
  if (png.width < 100 || png.height < 80 || png.width > 3200 || png.height > 3200) throw new Error(`Implausible PNG dimensions ${png.width}×${png.height}`);
  let ink = 0, light = 0;
  for (let i = 0; i < png.data.length; i += 16) {
    const level = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
    if (level < 220) ink++;
    if (level > 45) light++;
  }
  if (ink < 20 || light < 20) throw new Error('Blank or black raster capture.');
  return png;
}
export function crop(buffer, rectangle) {
  const source = PNG.sync.read(buffer);
  const target = new PNG({ width: rectangle.width, height: rectangle.height });
  PNG.bitblt(source, target, rectangle.x, rectangle.y, rectangle.width, rectangle.height, 0, 0);
  return PNG.sync.write(target);
}
export function pairBuffers(left, right) {
  const a = PNG.sync.read(left), b = PNG.sync.read(right);
  if (a.height !== b.height) throw new Error('Two-pane source heights must match; no scaling is allowed.');
  const target = new PNG({ width: a.width + 1 + b.width, height: a.height });
  target.data.fill(222);
  PNG.bitblt(a, target, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, target, 0, 0, b.width, b.height, a.width + 1, 0);
  return PNG.sync.write(target);
}
// Compare distinctive pixels of a DOM-unique chrome band against lower raster
// rows. A compositor repeating an entire app header passes DOM count checks.
export function rejectRepeatedChrome(buffer, anchor, exclusions = []) {
  const png = PNG.sync.read(buffer);
  const x = Math.max(0, Math.round(anchor.x)), y = Math.max(0, Math.round(anchor.y));
  const width = Math.min(Math.floor(anchor.width), png.width - x);
  const height = Math.min(Math.floor(anchor.height), png.height - y);
  if (height < 20 || width < 90) return;
  const points = [];
  for (let dy = 2; dy < height - 2; dy += 3) for (let dx = 2; dx < width - 2; dx += 5) {
    const offset = ((y + dy) * png.width + x + dx) * 4;
    const rgb = [...png.data.subarray(offset, offset + 3)];
    if (Math.max(...rgb) < 190) points.push({ dx, dy, rgb });
  }
  if (points.length < 20) return;
  const sample = points.filter((_, i) => i % Math.max(1, Math.floor(points.length / 120)) === 0);
  for (let otherY = y + height + 24; otherY <= png.height - height; otherY++) {
    if (exclusions.some((r) => inside({ x, y: otherY, width, height }, r))) continue;
    let matched = 0;
    for (const point of sample) {
      const offset = ((otherY + point.dy) * png.width + x + point.dx) * 4;
      if (point.rgb.every((v, channel) => Math.abs(v - png.data[offset + channel]) < 18)) matched++;
      if (matched + sample.length - (sample.indexOf(point) + 1) < sample.length * 0.985) break;
    }
    if (matched / sample.length >= 0.985) throw new Error(`Repeated owning chrome at raster y=${otherY}; expected once at y=${y}.`);
  }
}

function locator(page, rule) {
  let result = rule.css ? page.locator(rule.css) : rule.role ? page.getByRole(rule.role, { ...(rule.name ? { name: rule.name, exact: true } : {}) }) : rule.label ? page.getByLabel(rule.label, { exact: rule.exact ?? false }) : page.getByText(rule.text, { exact: rule.exact ?? true });
  return rule.first ? result.first() : result;
}
async function evidence(page, rules) {
  const found = [];
  for (const rule of rules) {
    const item = locator(page, rule), description = rule.css ?? rule.name ?? rule.label ?? rule.text ?? rule.role;
    if (rule.absent) { await expect(item).not.toBeVisible(); continue; }
    await expect(item).toBeVisible();
    if (rule.contains) await expect(item).toContainText(rule.contains);
    if (rule.value !== undefined) await expect(item).toHaveValue(rule.value);
    if (rule.disabled !== undefined) {
      if (await item.evaluate((element) => element.tagName === 'FIELDSET')) {
        if (rule.disabled) await expect(item).toHaveAttribute('disabled', '');
        else await expect(item).not.toHaveAttribute('disabled', '');
      } else await expect(item)[rule.disabled ? 'toBeDisabled' : 'toBeEnabled']();
    }
    const bounds = await item.boundingBox();
    if (!bounds) throw new Error(`${description} has no rendered bounds.`);
    if (rule.minWidth && bounds.width < rule.minWidth) throw new Error(`${description}: source was captured at the wrong width (${bounds.width}; minimum ${rule.minWidth}).`);
    found.push({ description, bounds, disabled: rule.disabled, text: (await item.textContent())?.trim().slice(0, 180) });
  }
  return found;
}

async function stabilize(page) {
  await page.bringToFront();
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].filter((image) => image.getClientRects().length && image.getBoundingClientRect().top < innerHeight).map(async (image) => {
      if (!image.complete) await new Promise((done, fail) => { image.addEventListener('load', done, { once: true }); image.addEventListener('error', fail, { once: true }); });
      await image.decode();
    }));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}
function frameFor(boxes, viewport) {
  let x = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.x)) - 16));
  let y = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.y)) - 16));
  let right = Math.min(viewport.width, Math.ceil(Math.max(...boxes.map((b) => b.x + b.width)) + 16));
  let bottom = Math.min(viewport.height, Math.ceil(Math.max(...boxes.map((b) => b.y + b.height)) + 16));
  if (right - x < 100) {
    right = Math.min(viewport.width, x + 100);
    x = Math.max(0, right - 100);
  }
  if (bottom - y < 80) {
    bottom = Math.min(viewport.height, y + 80);
    y = Math.max(0, bottom - 80);
  }
  return { x, y, width: right - x, height: bottom - y };
}
export async function rawViewport(page) {
  await stabilize(page);
  const viewport = page.viewportSize();
  return page.screenshot({ animations: 'disabled', caret: 'hide', fullPage: false, scale: 'css', clip: { x: 0, y: 0, ...viewport } });
}

export async function createCaptureBook(root, bundleRoot) {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, surface: { type: 'string', multiple: true }, group: { type: 'string', multiple: true }, out: { type: 'string' } } });
  const canonical = resolve(bundleRoot, 'generated');
  const destination = values.out ? resolve(bundleRoot, values.out) : canonical;
  if (destination === root || destination === bundleRoot || destination === '/' || destination === dirname(root)) {
    if (destination !== canonical) throw new Error('Unsafe output directory.');
  }
  const document = JSON.parse(await readFile(resolve(bundleRoot, 'user-journeys.ujg.jsonld'), 'utf8'));
  const nodes = new Map(document.nodes.map((node) => [node['@id'], node]));
  if (nodes.size !== document.nodes.length) throw new Error('Duplicate UJG IDs.');
  const surfaces = document.nodes.filter((node) => node['@type'] === 'Surface' && ['State', 'CompositeState'].includes(nodes.get(node.graphNodeRef)?.['@type']));
  const expected = new Set(surfaces.map((node) => node['@id']));
  for (const node of document.nodes.filter((node) => node['@type'] === 'Surface')) if (!nodes.has(node.graphNodeRef)) throw new Error(`Unresolved Surface ${node['@id']}`);
  if (surfaces.length !== expected.size || expected.size !== contracts.size || [...expected].some((id) => !contracts.has(id)) || [...contracts].some(([id]) => !expected.has(id))) throw new Error(`Capture registry must match exactly the ${expected.size} material state-bound Surfaces derived from the UJG.`);
  for (const id of values.surface ?? []) if (!expected.has(id)) throw new Error(`Unknown Surface URN ${id}`);
  const groups = new Set([...contracts.values()].map((c) => c.group));
  for (const group of values.group ?? []) if (!groups.has(group)) throw new Error(`Unknown group ${group}`);
  const selected = new Set([...expected].filter((id) => (!values.surface || values.surface.includes(id)) && (!values.group || values.group.includes(contracts.get(id).group))));
  if (!selected.size) throw new Error('No capture contracts selected.');
  const filename = (id) => id.split(':Surface:').at(-1) + '.png';
  const auditName = 'user-journeys.screenshots.audit.json';
  const mapName = 'user-journeys.screenshots.json';
  async function validate(folder, partial = false) {
    const map = JSON.parse(await readFile(resolve(folder, mapName), 'utf8'));
    const audit = JSON.parse(await readFile(resolve(folder, auditName), 'utf8'));
    const ids = Object.keys(map);
    if ((!partial && ids.length !== expected.size) || ids.some((id) => !expected.has(id)) || Object.keys(audit.surfaces).length !== ids.length) throw new Error('Map/audit Surface coverage mismatch.');
    const seen = new Set();
    for (const id of ids) {
      const path = resolve(folder, map[id]), within = relative(resolve(folder, 'screenshots'), path);
      if (!within || within.startsWith('..') || within.startsWith(sep) || seen.has(path)) throw new Error(`Unsafe or duplicate PNG path ${map[id]}`);
      seen.add(path);
      const buffer = await readFile(path), png = decode(buffer), receipt = audit.surfaces[id];
      if (!receipt || receipt.sha256 !== hash(buffer) || receipt.stateId !== nodes.get(id).graphNodeRef) throw new Error(`Stale or unresolved audit for ${id}`);
      if (receipt.width !== png.width || receipt.height !== png.height) throw new Error(`Wrong dimensions for ${id}`);
      const contract = contracts.get(id);
      if (receipt.scroll?.x !== 0 || receipt.scroll?.y !== 0) throw new Error(`Unexpected captured scroll for ${id}`);
      if (contract.frame === 'panel' && (png.width !== 390 || png.height !== 844)) throw new Error(`Wrong panel dimensions for ${id}`);
      if (contract.frame === 'pair' && (png.width !== 1611 || png.height !== 844)) throw new Error(`Wrong two-pane dimensions for ${id}`);
      if (contract.frame === 'region' && (png.width !== receipt.crop?.width || png.height !== receipt.crop?.height)) throw new Error(`Wrong crop dimensions for ${id}`);
      if (contract.frame !== 'native') {
        const expectedEvidence = [...contract.required, ...(contract.contextRequired ?? [])].filter((rule) => !rule.absent).map((rule) => rule.css ?? rule.name ?? rule.label ?? rule.text ?? rule.role).sort();
        const capturedEvidence = receipt.required.map((item) => item.description).sort();
        if (JSON.stringify(expectedEvidence) !== JSON.stringify(capturedEvidence)) throw new Error(`Missing or extra identifying evidence for ${id}`);
      }
      for (const rule of contract.required.filter((rule) => rule.minWidth)) {
        const item = receipt.required.find((item) => item.description === rule.css);
        if (!item || item.bounds.width < rule.minWidth) throw new Error(`Wrong recorded-page source width for ${id}`);
      }
      if (contract.pending && contract.frame !== 'native' && (!receipt.heldDependency?.reached || receipt.heldDependency.released)) throw new Error(`Missing held dependency proof for ${id}`);
      if (contract.frame === 'native' && !receipt.native?.confirmedDialog) throw new Error(`Missing native dialog proof for ${id}`);
      requireInFrame(receipt.required, { x: 0, y: 0, width: png.width, height: png.height });
      if (receipt.chromeAnchor) rejectRepeatedChrome(buffer, receipt.chromeAnchor, receipt.evidenceImages ?? []);
    }
    const pngs = (await readdir(resolve(folder, 'screenshots'))).filter((name) => name.endsWith('.png'));
    if (pngs.length !== ids.length) throw new Error('Extra or missing PNG files.');
    console.log(`Validated ${ids.length} UJG Surface screenshots, evidence bounds, raster checks and audit hashes.`);
  }
  if (values.check) { await validate(destination, !!values.out); return { checkOnly: true }; }
  await mkdir(resolve(bundleRoot, '.output'), { recursive: true });
  const stage = await mkdtemp(resolve(bundleRoot, '.output/ujg-capture-'));
  await mkdir(resolve(stage, 'screenshots'));
  let receipts = {};
  const captured = new Set();
  if (!values.out && selected.size !== expected.size) {
    await validate(canonical);
    receipts = JSON.parse(await readFile(resolve(canonical, auditName), 'utf8')).surfaces;
    await cp(resolve(canonical, 'screenshots'), resolve(stage, 'screenshots'), { recursive: true });
  }
  function wants(name) { return selected.has(surfaceId(name)); }
  async function save(name, buffer, details) {
    const id = surfaceId(name), contract = contracts.get(id);
    if (!selected.has(id)) return;
    if (captured.has(id)) throw new Error(`Duplicate capture write: ${id}`);
    const png = decode(buffer);
    if (details.chromeAnchor) rejectRepeatedChrome(buffer, details.chromeAnchor, details.evidenceImages);
    requireInFrame(details.required ?? [], { x: 0, y: 0, width: png.width, height: png.height });
    await writeFile(resolve(stage, 'screenshots', filename(id)), buffer);
    receipts[id] = { surfaceId: id, stateId: nodes.get(id).graphNodeRef, label: nodes.get(nodes.get(id).graphNodeRef).label, group: contract.group, fixture: contract.fixture, setup: contract.setup, source: contract.source, frame: contract.frame, assertions: contract.required, ...(contract.contextRequired ? { contextAssertions: contract.contextRequired } : {}), ...(contract.equivalence ? { equivalence: contract.equivalence } : {}), ...details, width: png.width, height: png.height, sha256: hash(buffer) };
    captured.add(id);
    console.log(`Captured ${name} (${png.width}×${png.height})`);
  }
  async function take(name, page, rules, regions, full) {
    const contract = contracts.get(surfaceId(name));
    await page.evaluate(() => scrollTo(0, 0));
    await stabilize(page);
    await expect(page.locator(contract.root)).toHaveCount(1);
    const required = await evidence(page, rules);
    const viewport = page.viewportSize();
    const boxes = required.map((item) => item.bounds);
    for (const css of regions) {
      const region = page.locator(css);
      if (await region.isVisible().catch(() => false)) boxes.push(await region.boundingBox());
    }
    const frame = full ? { x: 0, y: 0, ...viewport } : frameFor(boxes, viewport);
    requireInFrame(required, frame);
    const geometry = await page.evaluate(() => ({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }));
    if (geometry.y || geometry.x || geometry.width !== viewport.width || geometry.height !== viewport.height) throw new Error(`${name}: unexpected scroll or viewport.`);
    const rootBox = await page.locator(contract.root).boundingBox();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const after = await page.locator(contract.root).boundingBox();
    if (JSON.stringify(rootBox) !== JSON.stringify(after)) throw new Error(`${name}: owning surface geometry changed before capture.`);
    if (contract.editing !== undefined) {
      const editing = await page.evaluate(() => {
        return !!document.querySelector('textarea[data-fabric="textarea"]');
      });
      if (editing !== contract.editing) throw new Error(`${name}: text-editing condition mismatch (${editing}).`);
    }
    let chromeAnchor;
    const anchorSelector = page.url().includes('share.html') ? '.report-toolbar' : page.url().includes('sidepanel.html') ? '.app__actions' : page.url().includes('report.html') ? '.bar' : null;
    if (anchorSelector && await page.locator(anchorSelector).isVisible()) {
      await expect(page.locator(anchorSelector)).toHaveCount(1);
      const bounds = await page.locator(anchorSelector).boundingBox();
      if (inside(bounds, frame)) chromeAnchor = { ...bounds, x: bounds.x - frame.x, y: bounds.y - frame.y };
    }
    const evidenceImages = [];
    for (const image of await page.locator('img').all()) {
      const bounds = await image.boundingBox();
      if (bounds && inside(bounds, frame)) evidenceImages.push({ ...bounds, x: bounds.x - frame.x, y: bounds.y - frame.y });
    }
    const held = contract.pending ? (page.__ujgHold ? await page.__ujgHold.assertHeld() : await page.evaluate(() => {
      if (globalThis.__ujgHold && !globalThis.__ujgHold.released) return globalThis.__ujgHold;
      const calls = [...(globalThis.__ujgPendingCalls?.values() ?? [])];
      return calls.length ? { reached: true, released: false, boundary: calls } : null;
    })) : null;
    if (contract.pending && !held) throw new Error(`${name}: pending state has no reached, held dependency.`);
    if (contract.pending && held && (!held.reached || held.released)) throw new Error(`${name}: dependency is no longer held.`);
    const raw = await rawViewport(page);
    const afterRequired = await evidence(page, rules);
    requireInFrame(afterRequired, frame);
    if (JSON.stringify(required.map((r) => r.bounds)) !== JSON.stringify(afterRequired.map((r) => r.bounds))) throw new Error(`${name}: identifying UI moved during capture.`);
    if (contract.pending && page.__ujgHold) await page.__ujgHold.assertHeld();
    else if (contract.pending && held) {
      const stillHeld = await page.evaluate(() => (globalThis.__ujgHold?.reached && !globalThis.__ujgHold.released) || globalThis.__ujgPendingCalls?.size > 0);
      if (!stillHeld) throw new Error(`${name}: pending checkpoint changed during capture.`);
    }
    const post = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    if (post.x || post.y) throw new Error(`${name}: scroll moved during capture.`);
    return { buffer: crop(raw, frame), required: required.map((r) => ({ ...r, bounds: { ...r.bounds, x: r.bounds.x - frame.x, y: r.bounds.y - frame.y } })), viewport, scroll: { x: 0, y: 0 }, crop: frame, evidenceImages, ...(held ? { heldDependency: held } : {}), ...(chromeAnchor ? { chromeAnchor } : {}) };
  }
  async function capture(name, source, second) {
    const contract = contracts.get(surfaceId(name));
    if (!contract) throw new Error(`Missing Surface contract for ${name}`);
    if (!wants(name)) return;
    const page = typeof source.page === 'function' ? source.page() : source;
    if (contract.frame === 'native') throw new Error(`Native Surface ${name} requires actual browser chrome.`);
    if (contract.frame === 'pair') {
      const a = await take(name, page, contract.required, [], true);
      // The second page is a panel, not another instance of the overlay root.
      await second.evaluate(() => scrollTo(0, 0));
      const required = await evidence(second, contract.contextRequired);
      requireInFrame(required, { x: 0, y: 0, ...viewports.panel });
      const b = await rawViewport(second);
      const offset = a.viewport.width + 1;
      await save(name, pairBuffers(a.buffer, b), { ...a, buffer: undefined, required: [...a.required, ...required.map((r) => ({ ...r, bounds: { ...r.bounds, x: r.bounds.x + offset } }))], secondViewport: second.viewportSize(), ...(a.chromeAnchor ? {} : { chromeAnchor: { x: offset, y: 0, width: 390, height: 48 } }) });
    } else {
      const shot = await take(name, page, contract.required, contract.regions, contract.frame === 'panel');
      await save(name, shot.buffer, { ...shot, buffer: undefined });
    }
  }
  async function captureNative(name, page, buffer, native) {
    if (!wants(name)) return;
    const contract = contracts.get(surfaceId(name));
    await expect(page.locator(contract.root)).toHaveCount(1);
    // The native driver verifies prompt text with OS raster recognition.
    // Browser coordinates cannot describe browser chrome.
    const png = decode(buffer);
    await save(name, buffer, { required: [{ description: 'OS-recognized native dialog: ' + native.title, bounds: { x: 0, y: 0, width: png.width, height: png.height }, text: native.recognizedText }], viewport: page.viewportSize(), scroll: { x: 0, y: 0 }, native, appearance: 'App light; native browser chrome follows host macOS appearance.' });
  }
  async function finish() {
    const missing = [...selected].filter((id) => !captured.has(id));
    if (missing.length) throw new Error(`Missing captures: ${missing.join(', ')}`);
    const ids = Object.keys(receipts);
    for (const id of ids) {
      const same = ids.filter((other) => other !== id && receipts[other].sha256 === receipts[id].sha256);
      if (same.length) receipts[id].visuallyEquivalentTo = same;
    }
    const map = Object.fromEntries(ids.map((id) => [id, `./screenshots/${filename(id)}`]));
    await writeFile(resolve(stage, mapName), json(map));
    await writeFile(resolve(stage, auditName), json({ version: 1, partial: ids.length !== expected.size, theme: 'light', surfaces: receipts }));
    await validate(stage, ids.length !== expected.size);
    const review = resolve(destination, 'review');
    await writeReviewGallery(root, stage, resolve(stage, 'review'), false, '../screenshots');
    await mkdir(destination, { recursive: true });
    await mkdir(dirname(review), { recursive: true });
    const backup = resolve(stage, 'previous');
    await mkdir(backup);
    const promoted = [], backedUp = [];
    try {
      for (const [name, target] of [...['screenshots', mapName, auditName].map((name) => [name, resolve(destination, name)]), ['review', review]]) {
        if (await stat(target).catch(() => null)) { await rename(target, resolve(backup, name)); backedUp.push({ name, target }); }
        await rename(resolve(stage, name), target); promoted.push(name);
      }
    } catch (error) {
      for (const name of promoted) await rm(name === 'review' ? review : resolve(destination, name), { recursive: true, force: true });
      for (const { name, target } of backedUp) await rename(resolve(backup, name), target);
      throw error;
    }
    await rm(stage, { recursive: true, force: true });
    console.log(`Review gallery: ${resolve(review, 'index.html')}`);
  }
  return { capture, captureNative, wants, finish, selected, contracts, checkOnly: false, needsGroup: (group) => [...selected].some((id) => contracts.get(id).group === group) };
}

export async function writeReviewGallery(root, folder, review = resolve(root, '.output/ujg-screenshots-review'), announce = true, imageBase = 'images') {
  const receipts = JSON.parse(await readFile(resolve(folder, 'user-journeys.screenshots.audit.json'), 'utf8')).surfaces;
  const ids = Object.keys(receipts);
  const filename = (id) => id.split(':Surface:').at(-1) + '.png';
    await mkdir(review, { recursive: true });
    if (imageBase === 'images') {
      await rm(resolve(review, 'images'), { recursive: true, force: true });
      await cp(resolve(folder, 'screenshots'), resolve(review, 'images'), { recursive: true });
    }
    const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    const cards = ids.sort((a, b) => `${receipts[a].group}:${a}`.localeCompare(`${receipts[b].group}:${b}`)).map((id) => { const r = receipts[id]; return `<article id="${escape(contracts.get(id).name)}"><h2>${escape(r.label)}</h2><code>${escape(id)}</code><p>${escape(r.setup)}</p><p>Fixture: ${escape(r.fixture)}<br>Source: ${escape(r.source)} · ${escape(r.frame)}</p>${r.equivalence ? `<p>${escape(r.equivalence)}</p>` : ''}${r.visuallyEquivalentTo?.length ? `<p>Identical rendered appearance: ${escape(r.visuallyEquivalentTo.map((id) => contracts.get(id).name).join(', '))}. Setup and dependency receipts distinguish these states.</p>` : ''}<a href="${imageBase}/${filename(id)}"><img loading="lazy" src="${imageBase}/${filename(id)}" alt="${escape(r.label)}"></a><details><summary>Captured evidence</summary><pre>${escape(json(r.required))}</pre></details></article>`; }).join('');
    await writeFile(resolve(review, 'index.html'), `<!doctype html><meta charset="utf-8"><title>UJG screenshot review</title><style>body{font:15px/1.5 system-ui;margin:24px;background:#eee;color:#222}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(600px,1fr));gap:24px}article{background:white;padding:20px;overflow:auto}h2{margin:0 0 8px;font-size:20px}code{font-size:11px;overflow-wrap:anywhere}img{display:block;max-width:100%;max-height:1100px;object-fit:contain;object-position:top left}pre{white-space:pre-wrap}</style><h1>${ids.length} UJG Surface captures</h1><p>Compare neighboring variants. Images contain real app pixels; captions describe fixtures and setup.</p><main>${cards}</main>`);
    if (announce) console.log(`Review gallery: ${resolve(review, 'index.html')}`);

}
