import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NS, profile, touchpointPresentationErrors, validateDocument } from './ujg-composition-validate.mjs';
import { reduceDocument, serialize } from './ujg-viewer-profile.mjs';

const id = (type, slug) => `${NS}${type}:${slug}`;

// A minimal profile-conformant document: a parent journey that opens a child journey and continues
// after its exit, one state-bound Surface, one touchpoint naming both journeys.
function valid() {
  return structuredClone({
    '@context': profile.contexts,
    '@id': `${NS}document:test`,
    '@type': 'UJGDocument',
    nodes: [
      { '@id': id('Journey', 'main'), '@type': 'Journey', label: 'Main', entryRefs: [id('JourneyEntry', 'main')], defaultEntryRef: id('JourneyEntry', 'main'), stateRefs: [id('State', 'a'), id('State', 'b'), id('CompositeState', 'c')], transitionRefs: [id('Transition', 'ab'), id('Transition', 'bc'), id('Transition', 'ca')] },
      { '@id': id('JourneyEntry', 'main'), '@type': 'JourneyEntry', label: 'Open main', stateRef: id('State', 'a') },
      { '@id': id('State', 'a'), '@type': 'State', label: 'A' },
      { '@id': id('State', 'b'), '@type': 'State', label: 'B' },
      { '@id': id('CompositeState', 'c'), '@type': 'CompositeState', label: 'Child', subjourneyRefs: [id('Journey', 'child')] },
      { '@id': id('Transition', 'ab'), '@type': 'Transition', label: 'Go to B', from: id('State', 'a'), to: id('State', 'b') },
      { '@id': id('Transition', 'bc'), '@type': 'Transition', label: 'Open child', from: id('State', 'b'), to: id('CompositeState', 'c') },
      { '@id': id('Transition', 'ca'), '@type': 'Transition', label: 'Child done', from: id('CompositeState', 'c'), to: id('State', 'a'), fromExitRef: id('JourneyExit', 'done') },
      { '@id': id('Journey', 'child'), '@type': 'Journey', label: 'Child', entryRefs: [id('JourneyEntry', 'child')], defaultEntryRef: id('JourneyEntry', 'child'), stateRefs: [id('State', 'x')], transitionRefs: [id('Transition', 'xd')], exitRefs: [id('JourneyExit', 'done')] },
      { '@id': id('JourneyEntry', 'child'), '@type': 'JourneyEntry', label: 'Enter child', stateRef: id('State', 'x') },
      { '@id': id('State', 'x'), '@type': 'State', label: 'X' },
      { '@id': id('Transition', 'xd'), '@type': 'Transition', label: 'Finish', from: id('State', 'x'), to: id('JourneyExit', 'done') },
      { '@id': id('JourneyExit', 'done'), '@type': 'JourneyExit', label: 'Child finished' },
      { '@id': id('Surface', 'state-a'), '@type': 'Surface', graphNodeRef: id('State', 'a') },
      { '@id': id('Touchpoint', 'page'), '@type': 'Touchpoint', label: 'Page', journeyRefs: [id('Journey', 'main'), id('Journey', 'child')] },
    ],
  });
}
const node = (doc, ref) => doc.nodes.find((n) => n['@id'] === ref);
const rules = (doc) => validateDocument(doc).errors.map((e) => /^\[([a-z-]+)\]/.exec(e)?.[1]);
const expectRule = (doc, rule) => assert.ok(rules(doc).includes(rule), `expected [${rule}], got ${JSON.stringify(validateDocument(doc).errors)}`);

test('the minimal profile document is valid', () => {
  assert.deepEqual(validateDocument(valid()).errors, []);
});

test('rejects contexts and node families outside the viewer profile', () => {
  const wrongContext = valid(); wrongContext['@context'] = [...profile.contexts, 'https://ujg.specs.openuji.org/ed/ns/effect.context.jsonld'];
  expectRule(wrongContext, 'context');
  const extraType = valid(); extraType.nodes.push({ '@id': id('Command', 'x'), '@type': 'Command', label: 'Do it' });
  expectRule(extraType, 'type');
  const extraProperty = valid(); node(extraProperty, id('Transition', 'ab')).conditionRef = id('Condition', 'x');
  expectRule(extraProperty, 'property');
});

test('rejects an unreachable state and an unselected child entry', () => {
  const dead = valid();
  dead.nodes.push({ '@id': id('State', 'dead'), '@type': 'State', label: 'Dead' });
  node(dead, id('Journey', 'main')).stateRefs.push(id('State', 'dead'));
  expectRule(dead, 'unreachable');
  const orphanEntry = valid();
  orphanEntry.nodes.push({ '@id': id('JourneyEntry', 'extra'), '@type': 'JourneyEntry', label: 'Extra', stateRef: id('State', 'x') });
  node(orphanEntry, id('Journey', 'child')).entryRefs.push(id('JourneyEntry', 'extra'));
  expectRule(orphanEntry, 'child-entry-referenced');
});

test('rejects exits nobody reaches or continues', () => {
  const unreached = valid();
  unreached.nodes = unreached.nodes.filter((n) => n['@id'] !== id('Transition', 'xd'));
  node(unreached, id('Journey', 'child')).transitionRefs = [];
  expectRule(unreached, 'exit-reached');
  const unreachedParent = valid();
  node(unreachedParent, id('Transition', 'ca')).fromExitRef = undefined;
  delete node(unreachedParent, id('Transition', 'ca')).fromExitRef;
  expectRule(unreachedParent, 'exit-continued');
});

test('rejects duplicate transitions but allows the same label to different destinations', () => {
  const duplicate = valid();
  duplicate.nodes.push({ ...node(duplicate, id('Transition', 'ab')), '@id': id('Transition', 'ab2') });
  node(duplicate, id('Journey', 'main')).transitionRefs.push(id('Transition', 'ab2'));
  expectRule(duplicate, 'duplicate-transition');
  const sameLabel = valid();
  sameLabel.nodes.push({ '@id': id('Transition', 'ab3'), '@type': 'Transition', label: 'Go to B', from: id('State', 'a'), to: id('State', 'a') });
  node(sameLabel, id('Journey', 'main')).transitionRefs.push(id('Transition', 'ab3'));
  assert.deepEqual(validateDocument(sameLabel).errors, []);
});

test('enforces the per-state transition budget', () => {
  const crowded = valid();
  for (let i = 0; i < profile.transitionsPerStateFail; i++) {
    const tid = id('Transition', `loop${i}`);
    crowded.nodes.push({ '@id': tid, '@type': 'Transition', label: `Action ${i}`, from: id('State', 'a'), to: id('State', 'a') });
    node(crowded, id('Journey', 'main')).transitionRefs.push(tid);
  }
  expectRule(crowded, 'budget');
});

test('enforces label budgets and required labels', () => {
  const long = valid(); node(long, id('State', 'a')).label = 'x'.repeat(profile.labelBudget.State + 1);
  expectRule(long, 'label-budget');
  const missing = valid(); delete node(missing, id('State', 'a')).label;
  expectRule(missing, 'label-missing');
  const exit = valid(); node(exit, id('JourneyExit', 'done')).label = 'x'.repeat(profile.labelBudget.JourneyExit + 1);
  expectRule(exit, 'label-budget');
});

test('Surfaces: one per State, named after it, never on a composite or a command', () => {
  const twice = valid();
  twice.nodes.push({ '@id': id('Surface', 'state-a-again'), '@type': 'Surface', graphNodeRef: id('State', 'a') });
  expectRule(twice, 'surface-duplicate');
  const misnamed = valid(); node(misnamed, id('Surface', 'state-a'))['@id'] = id('Surface', 'screen-a');
  expectRule(misnamed, 'surface-id');
  const composite = valid();
  composite.nodes.push({ '@id': id('Surface', 'state-c'), '@type': 'Surface', graphNodeRef: id('CompositeState', 'c') });
  expectRule(composite, 'surface-composite');
  const command = valid();
  command.nodes.push({ '@id': id('Command', 'go'), '@type': 'Command', label: 'Go' });
  command.nodes.push({ '@id': id('Surface', 'command-go'), '@type': 'Surface', graphNodeRef: id('Command', 'go') });
  expectRule(command, 'type');
  expectRule(command, 'reference');
});

test('touchpoints must be used and must name every journey', () => {
  const unused = valid(); node(unused, id('Touchpoint', 'page')).journeyRefs = [];
  expectRule(unused, 'touchpoint-used');
  const partial = valid(); node(partial, id('Touchpoint', 'page')).journeyRefs = [id('Journey', 'main')];
  expectRule(partial, 'journey-touchpoint');
});

test('the touchpoint presentation has exactly one entry per touchpoint', () => {
  const page = id('Touchpoint', 'page');
  assert.deepEqual(touchpointPresentationErrors(valid(), { [page]: { shortLabel: 'Page' } }), []);
  assert.match(touchpointPresentationErrors(valid(), {}).join('\n'), /No presentation entry for Touchpoint:page/);
  assert.match(touchpointPresentationErrors(valid(), { [page]: {}, [id('Touchpoint', 'gone')]: {} }).join('\n'), /not in the document: Touchpoint:gone/);
});

test('the reducer projects a rich document onto the profile and is idempotent', () => {
  const rich = valid();
  rich.nodes.push({ '@id': id('Command', 'go'), '@type': 'Command', label: 'Go' });
  rich.nodes.push({ '@id': id('Condition', 'c'), '@type': 'Condition', label: 'If so' });
  rich.nodes.push({ '@id': id('Surface', 'command-go'), '@type': 'Surface', graphNodeRef: id('Command', 'go') });
  node(rich, id('Transition', 'ab')).commandRef = id('Command', 'go');
  node(rich, id('Transition', 'ab')).conditionRef = id('Condition', 'c');
  // An automatic self-loop (no Command) and a reviewed blocked loop are dropped; a user action is kept.
  rich.nodes.push({ '@id': id('Transition', 'auto'), '@type': 'Transition', label: 'Recover after restart', from: id('State', 'a'), to: id('State', 'a') });
  rich.nodes.push({ '@id': id('Transition', 'blocked'), '@type': 'Transition', label: 'No markup activation while paused', from: id('State', 'a'), to: id('State', 'a'), commandRef: id('Command', 'go') });
  rich.nodes.push({ '@id': id('Transition', 'keep'), '@type': 'Transition', label: 'Expand details', from: id('State', 'a'), to: id('State', 'a'), commandRef: id('Command', 'go') });
  const main = node(rich, id('Journey', 'main'));
  main.transitionRefs.push(id('Transition', 'auto'), id('Transition', 'blocked'), id('Transition', 'keep'));
  const once = reduceDocument(rich).document;
  assert.deepEqual(validateDocument(once).errors, []);
  assert.ok(!once.nodes.some((n) => ['Command', 'Condition'].includes(n['@type'])));
  assert.ok(once.nodes.some((n) => n['@id'] === id('Transition', 'keep')));
  assert.ok(!once.nodes.some((n) => [id('Transition', 'auto'), id('Transition', 'blocked')].includes(n['@id'])));
  assert.equal(serialize(reduceDocument(once).document), serialize(once));
});

test('the committed document is in the profile and valid', () => {
  const file = new URL('../generated/user-journeys.ujg.jsonld', import.meta.url);
  const text = fs.readFileSync(file, 'utf8');
  assert.deepEqual(validateDocument(JSON.parse(text)).errors, []);
  assert.equal(serialize(reduceDocument(JSON.parse(text)).document), text);
});
