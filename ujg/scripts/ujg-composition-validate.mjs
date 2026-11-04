import fs from 'node:fs';

const file = new URL('../user-journeys.ujg.jsonld', import.meta.url);
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const errors = [];
const expectedContexts = [
  'https://ujg.specs.openuji.org/ed/ns/core.context.jsonld',
  'https://ujg.specs.openuji.org/ed/ns/graph.context.jsonld',
  'https://ujg.specs.openuji.org/ed/ns/surface.context.jsonld',
  'https://ujg.specs.openuji.org/ed/ns/condition.context.jsonld',
  'https://ujg.specs.openuji.org/ed/ns/effect.context.jsonld',
  'https://ujg.specs.openuji.org/ed/ns/artifact.context.jsonld',
  'https://ujg.specs.openuji.org/ed/ns/entry-binding.context.jsonld',
  'https://ujg.specs.openuji.org/ed/ns/observability.context.jsonld',
  'https://ujg.specs.openuji.org/ed/ns/l10n.context.jsonld',
];
if (JSON.stringify(doc['@context']) !== JSON.stringify(expectedContexts)) {
  errors.push('Document must use exactly the active Editor Draft contexts required by this bundle.');
}
if (doc['@type'] !== 'UJGDocument' || !Array.isArray(doc.nodes)) {
  errors.push('Root must be a UJGDocument with a nodes array.');
}
const allowedTypes = new Set([
  'AccessibleFeature', 'AccessibleLocator', 'Artifact', 'Command', 'CompositeState',
  'Condition', 'ConditionalTransitionSet', 'Effect', 'EntryBinding', 'InputModality',
  'InputModalityProfile', 'Journey', 'JourneyEntry', 'JourneyEntryIndex', 'JourneyExit',
  'Locale', 'Message', 'MessageMeta', 'ObservationBinding', 'ObservationEvent',
  'OutgoingTransition', 'Persona', 'State', 'Surface', 'Touchpoint', 'Transition',
]);
const allowedProperties = new Set([
  '@id', '@type', 'accessibleFeatureName', 'accessibleFeatureRefs',
  'accessibleFeatureValue', 'accessibleNameRef', 'channel', 'commandRef',
  'conditionRef', 'conditionTransitionRefs', 'consumedRefs', 'defaultEntryRef',
  'defaultLocaleRef', 'effectRef', 'entryRef', 'entryRefs', 'entrybinding:value',
  'exitRefs', 'from', 'fromExitRef', 'graphNodeRef', 'inputModalityRefs',
  'journeyRefs', 'l10n:value', 'label', 'localeCode', 'localeRef', 'locatorRefs',
  'messageMetaRef', 'nameRef', 'observationEventRef', 'observeSurfaceRef',
  'outgoingTransitionRefs', 'producedRefs', 'requiredInputModalityProfileRefs',
  'role', 'sourceTouchpointRef', 'stateRef', 'stateRefs', 'subjourneyRefs', 'to',
  'toEntryRef', 'touchpointRefs', 'transitionRefs',
]);
const byId = new Map();
for (const node of doc.nodes) {
  if (!node['@id']) errors.push(`Node without @id: ${JSON.stringify(node)}`);
  else if (byId.has(node['@id'])) errors.push(`Duplicate @id: ${node['@id']}`);
  else byId.set(node['@id'], node);
  if (!allowedTypes.has(node['@type'])) errors.push(`Unknown module type ${node['@type']} on ${node['@id']}`);
  for (const key of Object.keys(node)) {
    if (!allowedProperties.has(key)) errors.push(`Unknown module property ${key} on ${node['@id']}`);
  }
}
const nodesOf = (type) => doc.nodes.filter((node) => node['@type'] === type);
const journeys = nodesOf('Journey');
const composites = nodesOf('CompositeState');
const transitions = nodesOf('Transition');
const exits = nodesOf('JourneyExit');
const entries = nodesOf('JourneyEntry');
const journeyByState = new Map();
const journeyByTransition = new Map();
const journeyByExit = new Map();
const journeyByEntry = new Map();

const referenceTypes = new Map([
  ['accessibleFeatureRefs', ['AccessibleFeature']],
  ['accessibleNameRef', ['MessageMeta']],
  ['commandRef', ['Command']],
  ['conditionRef', ['Condition']],
  ['conditionTransitionRefs', ['Transition']],
  ['consumedRefs', ['Artifact']],
  ['defaultEntryRef', ['JourneyEntry']],
  ['defaultLocaleRef', ['Locale']],
  ['effectRef', ['Effect']],
  ['entryRef', ['JourneyEntry']],
  ['entryRefs', ['JourneyEntry']],
  ['exitRefs', ['JourneyExit']],
  ['fromExitRef', ['JourneyExit']],
  ['graphNodeRef', ['State', 'CompositeState', 'Command']],
  ['inputModalityRefs', ['InputModality']],
  ['journeyRefs', ['Journey']],
  ['localeRef', ['Locale']],
  ['locatorRefs', ['AccessibleLocator']],
  ['messageMetaRef', ['MessageMeta']],
  ['nameRef', ['MessageMeta']],
  ['observationEventRef', ['ObservationEvent']],
  ['observeSurfaceRef', ['Surface']],
  ['outgoingTransitionRefs', ['OutgoingTransition']],
  ['producedRefs', ['Artifact']],
  ['requiredInputModalityProfileRefs', ['InputModalityProfile']],
  ['sourceTouchpointRef', ['Touchpoint']],
  ['stateRef', ['State', 'CompositeState']],
  ['stateRefs', ['State', 'CompositeState']],
  ['subjourneyRefs', ['Journey']],
  ['toEntryRef', ['JourneyEntry']],
  ['touchpointRefs', ['Touchpoint']],
  ['transitionRefs', ['Transition']],
]);
const allReferences = new Set();
for (const node of doc.nodes) {
  for (const [field, expectedTypes] of referenceTypes) {
    if (!(field in node)) continue;
    const refs = Array.isArray(node[field]) ? node[field] : [node[field]];
    for (const ref of refs) {
      allReferences.add(ref);
      const target = byId.get(ref);
      if (!target && field === 'inputModalityRefs' && /^observability:(keyboard|pointer)$/.test(ref)) continue;
      if (!target) errors.push(`Unresolved ${field} on ${node['@id']}: ${ref}`);
      else if (!expectedTypes.includes(target['@type'])) errors.push(`Wrong type for ${field} on ${node['@id']}: ${ref} is ${target['@type']}`);
    }
  }
  for (const field of ['from', 'to']) {
    if (!node[field]) continue;
    allReferences.add(node[field]);
    const target = byId.get(node[field]);
    if (!target || !['State', 'CompositeState', 'JourneyExit'].includes(target['@type'])) {
      errors.push(`Invalid ${field} target on ${node['@id']}: ${node[field]}`);
    }
  }
}

function own(map, ref, journeyId, kind) {
  const owners = map.get(ref) ?? [];
  owners.push(journeyId);
  map.set(ref, owners);
  if (owners.length > 1) errors.push(`${kind} ${ref} has multiple owning journeys: ${owners.join(', ')}`);
}

for (const journey of journeys) {
  if (!journey.entryRefs?.length) errors.push(`Journey has no entryRefs: ${journey['@id']}`);
  if (!journey.stateRefs?.length) errors.push(`Journey has no stateRefs: ${journey['@id']}`);
  if (journey.defaultEntryRef && !journey.entryRefs.includes(journey.defaultEntryRef)) {
    errors.push(`Journey defaultEntryRef is not in entryRefs: ${journey['@id']}`);
  }
  for (const ref of journey.entryRefs ?? []) {
    if (byId.get(ref)?.['@type'] !== 'JourneyEntry') errors.push(`Invalid JourneyEntry ref ${ref} in ${journey['@id']}`);
    own(journeyByEntry, ref, journey['@id'], 'JourneyEntry');
  }
  for (const ref of journey.stateRefs ?? []) {
    if (!['State', 'CompositeState'].includes(byId.get(ref)?.['@type'])) {
      errors.push(`Invalid state ref ${ref} in ${journey['@id']}`);
    }
    own(journeyByState, ref, journey['@id'], 'State');
  }
  for (const ref of journey.transitionRefs ?? []) {
    if (byId.get(ref)?.['@type'] !== 'Transition') errors.push(`Invalid Transition ref ${ref} in ${journey['@id']}`);
    own(journeyByTransition, ref, journey['@id'], 'Transition');
  }
  for (const ref of journey.exitRefs ?? []) {
    if (byId.get(ref)?.['@type'] !== 'JourneyExit') errors.push(`Invalid JourneyExit ref ${ref} in ${journey['@id']}`);
    own(journeyByExit, ref, journey['@id'], 'JourneyExit');
  }
}

for (const entry of entries) {
  const owners = journeyByEntry.get(entry['@id']) ?? [];
  if (owners.length !== 1) errors.push(`JourneyEntry must have one owner: ${entry['@id']}`);
  const owner = byId.get(owners[0]);
  if (owner && !owner.stateRefs.includes(entry.stateRef)) {
    errors.push(`JourneyEntry target is not local: ${entry['@id']} -> ${entry.stateRef}`);
  }
}

for (const composite of composites) {
  if (!composite.subjourneyRefs?.length) errors.push(`Composite has no subjourneyRefs: ${composite['@id']}`);
  for (const ref of composite.subjourneyRefs ?? []) {
    if (byId.get(ref)?.['@type'] !== 'Journey') errors.push(`Composite child is not a Journey: ${composite['@id']} -> ${ref}`);
  }
  const parentIds = journeyByState.get(composite['@id']) ?? [];
  for (const parentId of parentIds) {
    const parent = byId.get(parentId);
    for (const childId of composite.subjourneyRefs ?? []) {
      const child = byId.get(childId);
      for (const stateRef of child?.stateRefs ?? []) {
        if (parent.stateRefs.includes(stateRef)) {
          errors.push(`Parent ${parentId} directly lists child state ${stateRef}`);
        }
      }
    }
  }
}

for (const state of nodesOf('State')) {
  const owners = journeyByState.get(state['@id']) ?? [];
  const isExternalTarget = nodesOf('OutgoingTransition').some((edge) => edge.to === state['@id']);
  if (owners.length !== 1 && !(owners.length === 0 && isExternalTarget)) {
    errors.push(`State must have one owner or be an explicit outgoing target: ${state['@id']}`);
  }
}

for (const transition of transitions) {
  const owners = journeyByTransition.get(transition['@id']) ?? [];
  if (owners.length !== 1) {
    errors.push(`Transition must have one owner: ${transition['@id']} (${owners.length})`);
    continue;
  }
  const owner = byId.get(owners[0]);
  if (!owner.stateRefs.includes(transition.from)) {
    errors.push(`Transition source is not local: ${transition['@id']} -> ${transition.from}`);
  }
  if (![...owner.stateRefs, ...(owner.exitRefs ?? [])].includes(transition.to)) {
    errors.push(`Transition target is not local: ${transition['@id']} -> ${transition.to}`);
  }
  if (transition.toEntryRef) {
    const target = byId.get(transition.to);
    if (target?.['@type'] !== 'CompositeState') errors.push(`toEntryRef target is not CompositeState: ${transition['@id']}`);
    const childOwners = journeyByEntry.get(transition.toEntryRef) ?? [];
    const matching = childOwners.filter((journeyId) => target?.subjourneyRefs?.includes(journeyId));
    if (matching.length !== 1) errors.push(`toEntryRef is not owned by exactly one target child: ${transition['@id']}`);
  }
  if (transition.fromExitRef) {
    const source = byId.get(transition.from);
    if (source?.['@type'] !== 'CompositeState') errors.push(`fromExitRef source is not CompositeState: ${transition['@id']}`);
    const childOwners = journeyByExit.get(transition.fromExitRef) ?? [];
    const matching = childOwners.filter((journeyId) => source?.subjourneyRefs?.includes(journeyId));
    if (matching.length !== 1) errors.push(`fromExitRef is not owned by exactly one source child: ${transition['@id']}`);
  }
}

const parentContinuationPairs = new Map();
for (const transition of transitions.filter((candidate) => candidate.fromExitRef)) {
  const key = `${transition.from}\n${transition.fromExitRef}`;
  const prior = parentContinuationPairs.get(key);
  if (prior) {
    errors.push(
      `Multiple parent continuations share from/fromExitRef: ${prior}, ${transition['@id']}`,
    );
  } else {
    parentContinuationPairs.set(key, transition['@id']);
  }
}

for (const exit of exits) {
  if ((journeyByExit.get(exit['@id']) ?? []).length !== 1) errors.push(`JourneyExit must have one owner: ${exit['@id']}`);
  const outgoing = transitions.filter((transition) => transition.from === exit['@id']);
  if (outgoing.length) errors.push(`JourneyExit has outgoing transitions: ${exit['@id']}`);
}

for (const surface of nodesOf('Surface')) {
  if (!['State', 'CompositeState', 'Command'].includes(byId.get(surface.graphNodeRef)?.['@type'])) {
    errors.push(`Surface graphNodeRef has invalid target: ${surface['@id']} -> ${surface.graphNodeRef}`);
  }
}

for (const binding of nodesOf('ObservationBinding')) {
  if (!binding.observeSurfaceRef || !binding.observationEventRef || !binding.locatorRefs?.length) {
    errors.push(`ObservationBinding must define one Surface, one event, and locators: ${binding['@id']}`);
  }
  if (new Set(binding.locatorRefs ?? []).size !== (binding.locatorRefs ?? []).length) {
    errors.push(`ObservationBinding repeats a conjunctive locator: ${binding['@id']}`);
  }
}

for (const locator of nodesOf('AccessibleLocator')) {
  if (!locator.role && !locator.accessibleNameRef && !locator.accessibleFeatureRefs?.length) {
    errors.push(`AccessibleLocator must define at least one accessible-object constraint: ${locator['@id']}`);
  }
}

const messagesByKey = new Map();
for (const message of nodesOf('Message')) {
  if (!message.messageMetaRef || !message.localeRef || typeof message['l10n:value'] !== 'string') {
    errors.push(`Message must define meta, locale, and l10n:value: ${message['@id']}`);
    continue;
  }
  const key = `${message.messageMetaRef}\n${message.localeRef}`;
  if (messagesByKey.has(key)) errors.push(`Duplicate Message for meta/locale: ${message['@id']}`);
  messagesByKey.set(key, message['@id']);
}
for (const meta of nodesOf('MessageMeta')) {
  if (!meta.defaultLocaleRef || !messagesByKey.has(`${meta['@id']}\n${meta.defaultLocaleRef}`)) {
    errors.push(`MessageMeta has no default-locale Message: ${meta['@id']}`);
  }
}

for (const type of ['Command', 'Condition', 'Effect', 'AccessibleLocator', 'MessageMeta']) {
  for (const node of nodesOf(type)) {
    if (!allReferences.has(node['@id'])) errors.push(`Orphan ${type}: ${node['@id']}`);
  }
}

for (const index of nodesOf('JourneyEntryIndex')) {
  for (const ref of index.entryRefs ?? []) {
    if (byId.get(ref)?.['@type'] !== 'JourneyEntry') errors.push(`Index has invalid entry: ${index['@id']} -> ${ref}`);
  }
}

for (const set of nodesOf('ConditionalTransitionSet')) {
  for (const ref of set.conditionTransitionRefs ?? []) {
    if (byId.get(ref)?.['@type'] !== 'Transition') errors.push(`Conditional set has invalid transition: ${set['@id']} -> ${ref}`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(JSON.stringify({
  nodes: doc.nodes.length,
  journeys: journeys.length,
  composites: composites.length,
  exits: exits.length,
  transitions: transitions.length,
}, null, 2));
