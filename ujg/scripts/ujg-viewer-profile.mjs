// Projects a UJG document onto the viewer profile (see ujg-composition-validate.mjs): drops every
// node family and property the Journey Viewer does not render, plus background/no-op self-loops
// and exact-duplicate transitions. Idempotent: running it on its own output changes nothing.
//
//   node scripts/ujg-viewer-profile.mjs [file]            rewrite the document in place
//   node scripts/ujg-viewer-profile.mjs [file] --check    fail if the document is not already reduced
//   node scripts/ujg-viewer-profile.mjs [file] --dry-run  print the report only
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { profile } from './ujg-composition-validate.mjs';

// Self-loops that are blocked invocations or transient error banners, not screen actions. They were
// reviewed one by one; user-invoked loops with a visible outcome (expand/inspect/undo/...) are kept.
export const DROPPED_SELF_LOOP_LABELS = new Set([
  'Surface mic capture error; keep session',
  'Surface video capture error; keep session',
  'No markup activation while paused',
  'Show Resume recording to annotate the page',
  'Cycle focus within annotation controls',
  'Keep the voice setup modal after credential persistence fails',
  'Show dictation configuration, permission, or microphone error',
  'Do nothing when there is no session parameter',
]);

export function reduceDocument(input) {
  const report = { droppedNodes: {}, droppedProperties: 0, droppedSelfLoops: {}, duplicateTransitions: 0 };
  const count = (bucket, key) => { bucket[key] = (bucket[key] ?? 0) + 1; };
  const keepTypes = new Set(profile.types);
  const keepProperties = new Set(profile.properties);
  const richInput = input.nodes.some((node) => node['@type'] === 'Command');

  const ownedStates = new Set(input.nodes.filter((n) => n['@type'] === 'Journey').flatMap((j) => j.stateRefs ?? []));
  const byId = new Map(input.nodes.map((n) => [n['@id'], n]));
  const dropped = new Set();
  const drop = (node, reason) => { dropped.add(node['@id']); count(report.droppedNodes, reason); };

  for (const node of input.nodes) {
    const type = node['@type'];
    if (!keepTypes.has(type)) { drop(node, type); continue; }
    // Unowned states exist only as targets of outgoing navigation to other pages.
    if (type === 'State' && !ownedStates.has(node['@id'])) { drop(node, 'State(external)'); continue; }
    if (type === 'Transition' && node.from === node.to) {
      // Without Commands the automatic/user split is unknowable, so only the reviewed denylist applies.
      const automatic = richInput && !node.commandRef;
      if (automatic || DROPPED_SELF_LOOP_LABELS.has(node.label)) {
        drop(node, 'Transition(self-loop)');
        count(report.droppedSelfLoops, automatic ? 'automatic (no Command)' : 'blocked/no-op/error feedback');
      }
    }
  }
  // Surfaces follow their target: states only, and only retained ones.
  for (const node of input.nodes) {
    if (node['@type'] !== 'Surface' || dropped.has(node['@id'])) continue;
    const target = byId.get(node.graphNodeRef);
    if (!target || target['@type'] !== 'State' || dropped.has(target['@id'])) drop(node, 'Surface(not state-bound)');
  }
  // Exact duplicates (same edge, same label) collapse to the first.
  const seen = new Set();
  for (const node of input.nodes) {
    if (node['@type'] !== 'Transition' || dropped.has(node['@id'])) continue;
    const key = JSON.stringify([node.from, node.to, node.toEntryRef, node.fromExitRef, node.label]);
    if (seen.has(key)) { drop(node, 'Transition(duplicate)'); report.duplicateTransitions++; } else seen.add(key);
  }

  const nodes = [];
  for (const node of input.nodes) {
    if (dropped.has(node['@id'])) continue;
    const next = {};
    for (const [key, value] of Object.entries(node)) {
      if (!keepProperties.has(key)) { report.droppedProperties++; continue; }
      next[key] = Array.isArray(value) ? value.filter((ref) => typeof ref !== 'string' || !dropped.has(ref)) : value;
    }
    nodes.push(next);
  }
  const document = { '@context': [...profile.contexts], '@id': input['@id'], '@type': input['@type'], nodes };
  return { document, report };
}

export const serialize = (document) => `${JSON.stringify(document, null, 2)}\n`;

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith('--')) ?? new URL('../generated/user-journeys.ujg.jsonld', import.meta.url);
  const text = fs.readFileSync(file, 'utf8');
  const { document, report } = reduceDocument(JSON.parse(text));
  const next = serialize(document);
  const changed = next !== text;
  if (args.includes('--check')) {
    if (changed) {
      console.error(`Document is not in the viewer profile. Run: node scripts/ujg-viewer-profile.mjs\n${JSON.stringify(report, null, 2)}`);
      process.exit(1);
    }
    console.log('Document is already in the viewer profile.');
  } else if (args.includes('--dry-run')) {
    console.log(JSON.stringify({ changed, ...report }, null, 2));
  } else {
    if (changed) fs.writeFileSync(file, next);
    console.log(JSON.stringify({ changed, ...report }, null, 2));
  }
}
