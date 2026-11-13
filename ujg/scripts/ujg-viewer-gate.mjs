// Acceptance gate: the document must be one the real Journey Viewer opens without findings.
// `journey-viewer generate` only checks the screenshot map and touchpoints and copies the document
// unchanged (the browser checks it), so this gate runs the app's own `checkDocument` policy first and
// then the CLI itself into a fresh temporary folder.
//
//   JOURNEY_VIEWER_DIR=/path/to/journey-viewer node scripts/ujg-viewer-gate.mjs [document]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const generated = new URL('../generated/', import.meta.url);
const file = (name) => path.resolve(generated.pathname, name);

export async function runViewerGate({ viewerDir, document = file('user-journeys.ujg.jsonld'), screenshots = file('user-journeys.screenshots.json'), touchpoints = file('user-journeys.touchpoints.json') }) {
  const errors = [];
  if (!viewerDir) throw new Error('Set JOURNEY_VIEWER_DIR to the journey-viewer checkout (it must be built: pnpm build).');
  const appBundle = path.join(viewerDir, 'packages/app/dist/index.js');
  const cli = path.join(viewerDir, 'packages/app/dist/cli/cli.js');
  for (const required of [appBundle, cli]) if (!fs.existsSync(required)) throw new Error(`${required} not found; build journey-viewer first.`);

  const { checkDocument, findingPath } = await import(pathToFileURL(appBundle).href);
  const value = JSON.parse(fs.readFileSync(document, 'utf8'));
  const check = checkDocument(value);
  for (const finding of check.findings) errors.push(`viewer ${finding.ruleId} ${findingPath(finding.path)}: ${finding.message}`);
  if (check.kind !== 'ready') return { errors, metrics: {} };

  const graph = check.graph;
  const rendered = new Set([...graph.states, ...graph.entries, ...graph.exits, ...graph.journeys].map((node) => node.id));
  const attached = graph.surfaces.filter((surface) => rendered.has(surface.node));
  const outgoing = new Map();
  for (const t of graph.transitions) outgoing.set(t.from, (outgoing.get(t.from) ?? 0) + 1);
  const mapped = fs.existsSync(screenshots) ? Object.keys(JSON.parse(fs.readFileSync(screenshots, 'utf8'))) : [];
  const surfaceIds = new Set(graph.surfaces.map((surface) => surface.id));
  const metrics = {
    roots: graph.roots.map((journey) => journey.label),
    rootless: graph.rootless.length,
    journeys: graph.journeys.length,
    states: graph.states.length,
    transitions: graph.transitions.length,
    maxTransitionsOnOneState: Math.max(0, ...outgoing.values()),
    touchpoints: graph.touchpoints.length,
    surfaces: graph.surfaces.length,
    surfacesAttachedToRenderedNodes: attached.length,
    screenshotMapEntriesWithoutSurface: mapped.filter((idValue) => !surfaceIds.has(idValue)).length,
    surfacesWithoutScreenshot: graph.surfaces.filter((surface) => !mapped.includes(surface.id)).length,
  };
  if (graph.rootless.length) errors.push(`${graph.rootless.length} journey(s) are unreachable from any root.`);
  if (attached.length !== graph.surfaces.length) errors.push(`${graph.surfaces.length - attached.length} Surface(s) attach to no rendered node.`);
  if (!graph.touchpoints.length) errors.push('No touchpoints; the viewer filter would be empty.');

  // The CLI validates the screenshot map shape, touchpoint shape and that every mapped image exists.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ujg-viewer-gate-'));
  const site = path.join(out, 'site');
  try {
    const args = ['generate', document, '--out', site];
    if (fs.existsSync(screenshots)) args.push('--screenshots', screenshots);
    if (fs.existsSync(touchpoints)) args.push('--touchpoints', touchpoints);
    execFileSync(process.execPath, [cli, ...args], { stdio: 'pipe' });
  } catch (error) {
    errors.push(`journey-viewer generate failed: ${String(error.stderr ?? error.message).trim()}`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  return { errors, metrics };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const { errors, metrics } = await runViewerGate({ viewerDir: process.env.JOURNEY_VIEWER_DIR, document: process.argv[2] ? path.resolve(process.argv[2]) : undefined });
    console.log(JSON.stringify(metrics, null, 2));
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exit(1);
    }
    console.log('Journey Viewer accepts the document.');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
