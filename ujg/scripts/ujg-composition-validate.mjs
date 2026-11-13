// Validates the viewer-profile UJG document: Core + Graph + Surface only, exactly what
// `journey-viewer` renders (journeys, states, composites, transitions, state Surfaces,
// touchpoints). The profile is a deliberate narrowing of the Editor's Draft. Never widen it;
// out-of-profile modules belong in a different document.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const NS = 'urn:proofline:session-recorder:';

export const profile = {
  contexts: [
    'https://ujg.specs.openuji.org/ed/ns/core.context.jsonld',
    'https://ujg.specs.openuji.org/ed/ns/graph.context.jsonld',
    'https://ujg.specs.openuji.org/ed/ns/surface.context.jsonld',
  ],
  rootKeys: ['@context', '@id', '@type', 'nodes'],
  types: [
    'Journey', 'JourneyEntry', 'JourneyExit', 'State', 'CompositeState', 'Transition', 'Surface', 'Touchpoint',
  ],
  properties: [
    '@id', '@type', 'label', 'entryRefs', 'stateRefs', 'transitionRefs', 'exitRefs', 'defaultEntryRef',
    'stateRef', 'subjourneyRefs', 'from', 'to', 'toEntryRef', 'fromExitRef', 'graphNodeRef', 'journeyRefs',
    'channel',
  ],
  // Layout budgets from journey-viewer's flow composer: state 3 lines @168px, journey/composite title
  // 2 lines @176px, entry/exit 2 lines @132px.
  labelBudget: {
    State: 60, CompositeState: 40, Journey: 40, JourneyEntry: 40, JourneyExit: 40, Transition: 60, Touchpoint: 40,
  },
  transitionsPerStateWarn: 12,
  transitionsPerStateFail: 16,
};

const referenceTypes = [
  ['entryRefs', ['JourneyEntry']],
  ['stateRefs', ['State', 'CompositeState']],
  ['transitionRefs', ['Transition']],
  ['exitRefs', ['JourneyExit']],
  ['defaultEntryRef', ['JourneyEntry']],
  ['stateRef', ['State', 'CompositeState']],
  ['subjourneyRefs', ['Journey']],
  ['toEntryRef', ['JourneyEntry']],
  ['fromExitRef', ['JourneyExit']],
  ['graphNodeRef', ['State', 'CompositeState']],
  ['journeyRefs', ['Journey']],
];

export function validateDocument(doc) {
  const errors = [];
  const warnings = [];
  const fail = (rule, message) => errors.push(`[${rule}] ${message}`);
  const warn = (rule, message) => warnings.push(`[${rule}] ${message}`);
  const short = (id) => String(id).replace(NS, '');

  if (JSON.stringify(doc['@context']) !== JSON.stringify(profile.contexts)) {
    fail('context', 'Document must use exactly the Core, Graph and Surface Editor Draft contexts.');
  }
  if (doc['@type'] !== 'UJGDocument' || !Array.isArray(doc.nodes)) {
    fail('root-shape', 'Root must be a UJGDocument with a nodes array.');
    return { errors, warnings, stats: {} };
  }
  for (const key of Object.keys(doc)) {
    if (!profile.rootKeys.includes(key)) fail('root-shape', `Unexpected document property ${key}.`);
  }

  const types = new Set(profile.types);
  const properties = new Set(profile.properties);
  const byId = new Map();
  for (const node of doc.nodes) {
    if (!node['@id']) { fail('unique-id', `Node without @id: ${JSON.stringify(node).slice(0, 80)}`); continue; }
    if (byId.has(node['@id'])) fail('unique-id', `Duplicate @id: ${node['@id']}`);
    else byId.set(node['@id'], node);
    if (!types.has(node['@type'])) fail('type', `Type ${node['@type']} is outside the viewer profile: ${short(node['@id'])}`);
    for (const key of Object.keys(node)) {
      if (!properties.has(key)) fail('property', `Property ${key} is outside the viewer profile: ${short(node['@id'])}`);
    }
  }
  const nodesOf = (type) => doc.nodes.filter((node) => node['@type'] === type);
  const journeys = nodesOf('Journey');
  const composites = nodesOf('CompositeState');
  const states = nodesOf('State');
  const transitions = nodesOf('Transition');
  const entries = nodesOf('JourneyEntry');
  const exits = nodesOf('JourneyExit');
  const surfaces = nodesOf('Surface');
  const touchpoints = nodesOf('Touchpoint');
  const refsOf = (node, field) => (Array.isArray(node[field]) ? node[field] : node[field] === undefined ? [] : [node[field]]);

  // Typed references.
  for (const node of doc.nodes) {
    for (const [field, expected] of referenceTypes) {
      if (!(field in node)) continue;
      // graphNodeRef is only a Surface property; stateRef only a JourneyEntry one; the others are unambiguous.
      for (const ref of refsOf(node, field)) {
        const target = byId.get(ref);
        if (!target) fail('reference', `Unresolved ${field} on ${short(node['@id'])}: ${short(ref)}`);
        else if (!expected.includes(target['@type'])) fail('reference', `Wrong type for ${field} on ${short(node['@id'])}: ${short(ref)} is ${target['@type']}`);
      }
    }
    for (const field of ['from', 'to']) {
      if (!(field in node)) continue;
      const allowed = field === 'from' ? ['State', 'CompositeState'] : ['State', 'CompositeState', 'JourneyExit'];
      const target = byId.get(node[field]);
      if (!target || !allowed.includes(target['@type'])) fail('reference', `Invalid ${field} target on ${short(node['@id'])}: ${short(node[field])}`);
    }
  }

  // Ownership.
  const owners = { state: new Map(), transition: new Map(), exit: new Map(), entry: new Map() };
  const own = (map, ref, journeyId, kind) => {
    const list = map.get(ref) ?? [];
    list.push(journeyId);
    map.set(ref, list);
    if (list.length > 1) fail('ownership', `${kind} ${short(ref)} has multiple owning journeys: ${list.map(short).join(', ')}`);
  };
  for (const journey of journeys) {
    if (!journey.entryRefs?.length) fail('ownership', `Journey has no entryRefs: ${short(journey['@id'])}`);
    if (!journey.stateRefs?.length) fail('ownership', `Journey has no stateRefs: ${short(journey['@id'])}`);
    if (journey.defaultEntryRef && !journey.entryRefs?.includes(journey.defaultEntryRef)) {
      fail('ownership', `Journey defaultEntryRef is not in entryRefs: ${short(journey['@id'])}`);
    }
    for (const ref of journey.entryRefs ?? []) own(owners.entry, ref, journey['@id'], 'JourneyEntry');
    for (const ref of journey.stateRefs ?? []) own(owners.state, ref, journey['@id'], 'State');
    for (const ref of journey.transitionRefs ?? []) own(owners.transition, ref, journey['@id'], 'Transition');
    for (const ref of journey.exitRefs ?? []) own(owners.exit, ref, journey['@id'], 'JourneyExit');
  }
  const ownerOf = (map, ref) => (map.get(ref) ?? [])[0];
  for (const entry of entries) {
    const list = owners.entry.get(entry['@id']) ?? [];
    if (list.length !== 1) { fail('ownership', `JourneyEntry must have one owner: ${short(entry['@id'])}`); continue; }
    if (!byId.get(list[0]).stateRefs.includes(entry.stateRef)) fail('entry-local', `JourneyEntry target is not local: ${short(entry['@id'])} -> ${short(entry.stateRef)}`);
  }
  for (const state of [...states, ...composites]) {
    if ((owners.state.get(state['@id']) ?? []).length !== 1) fail('ownership', `State must have exactly one owning journey: ${short(state['@id'])}`);
  }
  for (const exit of exits) {
    if ((owners.exit.get(exit['@id']) ?? []).length !== 1) fail('ownership', `JourneyExit must have one owner: ${short(exit['@id'])}`);
    if (transitions.some((t) => t.from === exit['@id'])) fail('exit-terminal', `JourneyExit has outgoing transitions: ${short(exit['@id'])}`);
  }

  // Composition.
  const childJourneyIds = new Set(composites.flatMap((c) => c.subjourneyRefs ?? []));
  for (const composite of composites) {
    if (!composite.subjourneyRefs?.length) fail('composite-child', `Composite has no subjourneyRefs: ${short(composite['@id'])}`);
    const parent = byId.get(ownerOf(owners.state, composite['@id']));
    for (const childId of composite.subjourneyRefs ?? []) {
      const child = byId.get(childId);
      for (const stateRef of child?.stateRefs ?? []) {
        if (parent?.stateRefs.includes(stateRef)) fail('composite-child', `Parent ${short(parent['@id'])} directly lists child state ${short(stateRef)}`);
      }
    }
  }
  for (const transition of transitions) {
    const journeyId = ownerOf(owners.transition, transition['@id']);
    if (!journeyId) { fail('ownership', `Transition must have one owner: ${short(transition['@id'])}`); continue; }
    const owner = byId.get(journeyId);
    if (!owner.stateRefs.includes(transition.from)) fail('local-endpoint', `Transition source is not local: ${short(transition['@id'])} -> ${short(transition.from)}`);
    if (![...owner.stateRefs, ...(owner.exitRefs ?? [])].includes(transition.to)) fail('local-endpoint', `Transition target is not local: ${short(transition['@id'])} -> ${short(transition.to)}`);
    if (transition.toEntryRef) {
      const target = byId.get(transition.to);
      if (target?.['@type'] !== 'CompositeState') fail('to-entry', `toEntryRef target is not CompositeState: ${short(transition['@id'])}`);
      const matching = (owners.entry.get(transition.toEntryRef) ?? []).filter((id) => target?.subjourneyRefs?.includes(id));
      if (matching.length !== 1) fail('to-entry', `toEntryRef is not owned by exactly one target child: ${short(transition['@id'])}`);
    }
    if (transition.fromExitRef) {
      const source = byId.get(transition.from);
      if (source?.['@type'] !== 'CompositeState') fail('from-exit', `fromExitRef source is not CompositeState: ${short(transition['@id'])}`);
      const matching = (owners.exit.get(transition.fromExitRef) ?? []).filter((id) => source?.subjourneyRefs?.includes(id));
      if (matching.length !== 1) fail('from-exit', `fromExitRef is not owned by exactly one source child: ${short(transition['@id'])}`);
    }
  }
  const continuations = new Map();
  for (const transition of transitions.filter((t) => t.fromExitRef)) {
    const key = `${transition.from}\n${transition.fromExitRef}`;
    if (continuations.has(key)) fail('continuation-unique', `Multiple parent continuations share from/fromExitRef: ${short(continuations.get(key))}, ${short(transition['@id'])}`);
    else continuations.set(key, transition['@id']);
  }

  // Exits are real outcomes: reached inside the child and continued by a parent.
  for (const exit of exits) {
    if (!transitions.some((t) => t.to === exit['@id'])) fail('exit-reached', `JourneyExit is never reached: ${short(exit['@id'])}`);
    if (!transitions.some((t) => t.fromExitRef === exit['@id'])) fail('exit-continued', `JourneyExit is never continued by a parent: ${short(exit['@id'])}`);
  }
  // Child entries must be selectable: default entry or a parent's toEntryRef.
  const selectedEntries = new Set([
    ...transitions.map((t) => t.toEntryRef).filter(Boolean),
    ...journeys.map((j) => j.defaultEntryRef).filter(Boolean),
  ]);
  for (const journey of journeys.filter((j) => childJourneyIds.has(j['@id']))) {
    for (const entryRef of journey.entryRefs ?? []) {
      if (!selectedEntries.has(entryRef)) fail('child-entry-referenced', `Child JourneyEntry is never selected: ${short(entryRef)}`);
    }
  }

  // Reachability: every state is reachable from one of its journey's entries through local transitions.
  for (const journey of journeys) {
    const adjacency = new Map();
    for (const ref of journey.transitionRefs ?? []) {
      const t = byId.get(ref);
      if (t) adjacency.set(t.from, [...(adjacency.get(t.from) ?? []), t.to]);
    }
    const seen = new Set((journey.entryRefs ?? []).map((ref) => byId.get(ref)?.stateRef).filter(Boolean));
    const queue = [...seen];
    while (queue.length) {
      for (const next of adjacency.get(queue.pop()) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    for (const ref of journey.stateRefs ?? []) {
      if (!seen.has(ref)) fail('unreachable', `State cannot be reached from any entry of ${short(journey['@id'])}: ${short(ref)}`);
    }
  }

  // Duplicates and per-state budgets.
  const seenEdges = new Map();
  const outgoing = new Map();
  for (const t of transitions) {
    const key = JSON.stringify([t.from, t.to, t.toEntryRef, t.fromExitRef, t.label]);
    if (seenEdges.has(key)) fail('duplicate-transition', `Duplicate transition: ${short(seenEdges.get(key))}, ${short(t['@id'])}`);
    else seenEdges.set(key, t['@id']);
    outgoing.set(t.from, (outgoing.get(t.from) ?? 0) + 1);
    // The viewer groups a state's transitions by destination and annotates child entry/exit, so the
    // same label to different destinations is not ambiguous; only a repeated edge+label is.
  }
  for (const [stateId, count] of outgoing) {
    if (count > profile.transitionsPerStateFail) fail('budget', `${short(stateId)} has ${count} outgoing transitions (limit ${profile.transitionsPerStateFail}).`);
    else if (count > profile.transitionsPerStateWarn) warn('budget', `${short(stateId)} has ${count} outgoing transitions (soft limit ${profile.transitionsPerStateWarn}).`);
  }
  const stateLabels = new Map();
  for (const journey of journeys) {
    stateLabels.clear();
    for (const ref of journey.stateRefs ?? []) {
      const label = byId.get(ref)?.label;
      if (label && stateLabels.has(label)) fail('duplicate-state-label', `States ${short(stateLabels.get(label))} and ${short(ref)} share the label "${label}" in ${short(journey['@id'])}`);
      else if (label) stateLabels.set(label, ref);
    }
  }

  // Surfaces: one per State, bound to a State, named after it.
  const surfaceByState = new Map();
  for (const surface of surfaces) {
    const target = byId.get(surface.graphNodeRef);
    if (!target) continue;
    if (target['@type'] === 'CompositeState') fail('surface-composite', `Composite states do not get a Surface: ${short(surface['@id'])}`);
    if (target['@type'] !== 'State') continue;
    if (surfaceByState.has(target['@id'])) fail('surface-duplicate', `State has more than one Surface: ${short(target['@id'])}`);
    surfaceByState.set(target['@id'], surface['@id']);
    const expected = `${NS}Surface:state-${target['@id'].slice(`${NS}State:`.length)}`;
    if (surface['@id'] !== expected) fail('surface-id', `Surface id must be ${short(expected)}: ${short(surface['@id'])}`);
  }

  // Labels.
  for (const node of doc.nodes) {
    const budget = profile.labelBudget[node['@type']];
    if (!budget) continue;
    const label = node.label;
    const needed = ['State', 'CompositeState', 'Journey', 'Touchpoint'].includes(node['@type']);
    if (needed && typeof label !== 'string') fail('label-missing', `${node['@type']} needs a label: ${short(node['@id'])}`);
    if (typeof label === 'string' && label.length > budget) fail('label-budget', `${node['@type']} label is ${label.length} > ${budget} characters: ${short(node['@id'])} "${label}"`);
  }

  // Touchpoints: used, and every journey is named by one (the viewer inherits nothing).
  const named = new Set();
  for (const touchpoint of touchpoints) {
    if (!touchpoint.journeyRefs?.length) fail('touchpoint-used', `Touchpoint names no journey: ${short(touchpoint['@id'])}`);
    for (const ref of touchpoint.journeyRefs ?? []) named.add(ref);
  }
  if (touchpoints.length) {
    for (const journey of journeys) if (!named.has(journey['@id'])) fail('journey-touchpoint', `Journey is named by no touchpoint: ${short(journey['@id'])}`);
  }

  const roots = journeys.filter((j) => !childJourneyIds.has(j['@id']));
  const maxOut = Math.max(0, ...outgoing.values());
  const stats = {
    nodes: doc.nodes.length,
    journeys: journeys.length,
    rootJourneys: roots.length,
    states: states.length,
    composites: composites.length,
    entries: entries.length,
    exits: exits.length,
    transitions: transitions.length,
    selfLoops: transitions.filter((t) => t.from === t.to).length,
    maxOutgoing: maxOut,
    statesOver12: [...outgoing.values()].filter((n) => n > profile.transitionsPerStateWarn).length,
    surfaces: surfaces.length,
    statesWithoutSurface: states.filter((s) => !surfaceByState.has(s['@id'])).length,
    touchpoints: touchpoints.length,
  };
  return { errors, warnings, stats };
}

// The viewer's touchpoint presentation (short label and colour) must have exactly one entry per Touchpoint.
export function touchpointPresentationErrors(doc, presentation) {
  const short = (id) => String(id).replace(NS, '');
  const ids = new Set(doc.nodes.filter((node) => node['@type'] === 'Touchpoint').map((node) => node['@id']));
  const keys = new Set(Object.keys(presentation));
  return [
    ...[...ids].filter((id) => !keys.has(id)).map((id) => `[touchpoint-presentation] No presentation entry for ${short(id)}.`),
    ...[...keys].filter((key) => !ids.has(key)).map((key) => `[touchpoint-presentation] Presentation entry for a Touchpoint that is not in the document: ${short(key)}.`),
  ];
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const file = process.argv[2] ?? new URL('../generated/user-journeys.ujg.jsonld', import.meta.url);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { errors, warnings, stats } = validateDocument(doc);
  // The bundle's own presentation file only describes the bundle's own document.
  const presentation = new URL('../generated/user-journeys.touchpoints.json', import.meta.url);
  if (!process.argv[2] && fs.existsSync(presentation)) errors.push(...touchpointPresentationErrors(doc, JSON.parse(fs.readFileSync(presentation, 'utf8'))));
  for (const message of warnings) console.warn(`warning ${message}`);
  if (errors.length) {
    console.error(errors.join('\n'));
    console.error(`\n${errors.length} error(s), ${warnings.length} warning(s).`);
    process.exit(1);
  }
  console.log(JSON.stringify(stats, null, 2));
}
