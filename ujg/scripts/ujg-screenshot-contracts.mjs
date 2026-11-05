// Presentation contracts; these do not add graph topology or recognition data.
const prefix = 'urn:proofline:session-recorder:Surface:state-';
const req = (css, options = {}) => ({ css, ...options });
const button = (name, options = {}) => ({ role: 'button', name, ...options });
const text = (value, options = {}) => ({ text: value, ...options });
const panel = {
  group: 'recorder', frame: 'panel', root: '.app',
  fixture: 'Independent recorder setup; fictional Northstar checkout for live capture.',
  source: 'entrypoints/sidepanel/App.tsx', regions: [], required: [],
};
const entries = [];
function define(name, base, details) {
  entries.push([prefix + name, { name, ...base, ...details }]);
}
const recordCases = {
  loading: [text('Loading…')],
  'idle-empty': [button('Start recording'), req('.session-list', { absent: true })],
  'idle-list': [button('Start recording'), text('Northstar · Checkout', { first: true })],
  'capture-options': [{ role: 'dialog', name: 'Capture options' }],
  starting: [button('Start recording', { contains: 'Starting' })],
  'start-error': [{ role: 'alert', contains: 'This page cannot be recorded.' }],
  recording: [button('Pause'), button('Stop'), req('.rec-badge', { contains: 'REC' })],
  paused: [button('Resume'), button('Stop'), req('.rec-badge', { contains: 'Paused' })],
  'voice-setup-idle': [{ role: 'dialog', name: 'Voice setup' }, button('Keep raw audio only'), button('Start recording')],
  'voice-setup-live': [{ role: 'dialog', name: 'Voice setup' }, button('Keep raw audio only'), button('Pause')],
  stopping: [button('Stopping…', { disabled: true }), button('Pause', { disabled: true })],
  crashed: [{ role: 'alert' }, button('Reload panel')],
};
for (const [name, required] of Object.entries(recordCases)) {
  define(`recorder-${name}`, panel, {
    root: name === 'crashed' ? '#root' : '.app', required,
    setup: `Recorder workflow: ${name.replaceAll('-', ' ')}; final invocation through production controls.`,
    pending: ['loading', 'starting', 'stopping'].includes(name),
  });
}
for (const kind of ['picking', 'editing', 'saving', 'error']) {
  const host = '#__session_recorder_point_annotation_host__';
  define(`recorder-comments-${kind}`, panel, {
    frame: 'pair', source: 'lib/annotations/point-overlay.ts',
    setup: `Start recording; enable page comments; ${kind === 'picking' ? 'select a target' : 'select the Apply button and type a comment'}${kind === 'saving' ? '; hold the actual background save dependency' : kind === 'error' ? '; remove its target before saving' : ''}.`,
    root: host, pending: kind === 'saving',
    required: [req(`${host} .exit`, { absent: kind === 'saving' }), ...(kind === 'editing' || kind === 'error' ? [req(`${host} .composer`)] : [req(`${host} .composer`, { absent: true })]), ...(kind === 'error' ? [req(`${host} .status`, { contains: 'no longer on the page' })] : [])],
    ...(kind === 'saving' ? { equivalence: 'During the actual save the complete page-comment overlay hides so it cannot contaminate the captured evidence. Absence of the picker/composer plus the held save dependency identifies this phase.' } : {}),
    contextRequired: [button('Pause'), req('.rec-badge', { contains: 'REC' })],
  });
}
for (const paused of [false, true]) for (const editing of [false, true]) {
  define(`recorder-${paused ? 'paused-' : ''}markup${editing ? '-text' : ''}`, panel, {
    frame: 'pair', source: 'entrypoints/annotations.content.ts',
    root: '#__session_recorder_annotation_host__',
    setup: `Open Markup through the recorder; ${editing ? 'enter text editing' : 'leave text editing'}${paused ? '; pause the recorder while retaining the editor' : ''}.`,
    required: [req('#__session_recorder_annotation_host__ .bar'), req('#__session_recorder_annotation_host__ .stage', { minWidth: 900 })],
    contextRequired: [button(paused ? 'Resume' : 'Pause'), req('.rec-badge', { contains: paused ? 'Paused' : 'REC' })],
    editing,
  });
}
const microphone = { group: 'microphone', frame: 'region', root: 'main', regions: ['main'], source: 'entrypoints/mic-permission/main.ts', fixture: 'Isolated extension permission page.', setup: 'Invoke the production microphone request at the media dependency boundary.' };
define('microphone-requesting', microphone, { frame: 'native', required: [text('Requesting microphone permission…')], pending: true });
define('microphone-granted', microphone, { required: [text('Microphone enabled — you can close this tab.')] });
define('microphone-blocked', microphone, { required: [req('#status.error', { contains: 'Microphone access was blocked' })] });

const sectionPhases = {
  proofline: ['', '-loading', '-saving', '-error'],
  services: ['', '-loading', '-error'],
  capture: ['', '-loading', '-saving', '-saved', '-error'],
  redaction: ['', '-loading', '-saving', '-saved', '-error'],
  transcription: ['', '-loading', '-saving', '-saved', '-error'],
  publishing: ['', '-loading', '-saving', '-saved', '-error'],
  summaries: ['', '-loading', '-saving', '-saved', '-error'],
  github: ['', '-loading', '-saving', '-saved', '-error'],
  storage: ['', '-loading', '-saving', '-error'],
};
const settings = { group: 'settings', frame: 'region', root: '.options-page', regions: ['#settings-page > [role="alert"]', '#settings-page .settings__section'], source: 'entrypoints/sidepanel/components/SettingsForm.tsx', fixture: 'Fresh section defaults or the explicitly declared fictional provider/account fixture.' };
for (const [section, phases] of Object.entries(sectionPhases)) for (const phase of phases) {
  const required = phase === '-loading' && section === 'services'
    ? [{ role: 'status', contains: 'Loading services' }]
    : phase === '-loading' && ['publishing', 'summaries', 'github'].includes(section)
      ? [{ role: 'status', contains: 'Loading settings' }]
      : phase === '-loading' && section === 'transcription'
        ? [req('a[aria-current="page"]', { contains: 'Transcription' }), req('#settings-page')]
        : phase === '-error' && section === 'services'
          ? []
          : [req('#settings-page h2, #settings-page h3', { first: true })];
  if (phase === '-loading' && section !== 'transcription') required.push(req('fieldset.settings-fields', { disabled: true }));
  if (phase === '-error') required.push(section === 'services'
    ? text('Error: Fixture service load failed.')
    : { role: 'alert' });
  if (phase === '-saving') {
    if (['capture', 'redaction', 'transcription', 'storage'].includes(section)) required.push(req('fieldset.settings-fields', { disabled: true }));
    else required.push(button(section === 'proofline' ? 'Disconnect' : section === 'summaries' ? 'Save summary settings' : 'Checking…', { disabled: true }));
  }
  if (phase === '-saved') {
    if (['capture', 'redaction', 'transcription'].includes(section)) required.push(text('Saved', { exact: true }));
    if (['publishing', 'github', 'summaries'].includes(section)) required.push({ role: 'status' });
  }
  define(`settings-${section}${phase}`, settings, {
    required, section, pending: phase === '-loading' || phase === '-saving',
    setup: `Open #${section}; ${phase ? phase.slice(1) + ' through the real section action/dependency.' : 'wait for initial reads and report preparation.'}`,
  });
}
const specialSettings = {
  'proofline-connected': [text('Northstar QA', { exact: true, first: true }), button('Disconnect')],
  'proofline-expired': [button('Reconnect')],
  'proofline-connecting': [{ role: 'status', contains: 'Approve in your browser' }, button('Cancel')],
  'services-connected': [text('Using Proofline for all AI services, private report hosting and GitHub issues.'), { role: 'link', name: 'Manage connection' }],
  'transcription-proofline': [text('Using Proofline credits for transcription.'), { role: 'link', name: 'Manage connection' }],
  'publishing-proofline': [text('Using Proofline for private report hosting.'), { role: 'link', name: 'Manage connection' }],
  'summaries-proofline': [text('Using Proofline for AI summaries.'), { role: 'link', name: 'Manage connection' }],
  'github-proofline': [text('Using Proofline for GitHub issues.'), { role: 'link', name: 'Manage connection' }],
  'summaries-compatible': [{ label: 'API base URL' }],
  'github-empty': [req('.repository-settings', { absent: true })],
  'transcription-testing': [button('Testing…', { disabled: true })],
  'transcription-test-ok': [req('.settings__result', { contains: 'Success:' })],
  'transcription-test-error': [req('.settings__result--error')],
  'storage-empty': [text('No recorded sessions.'), button('Delete all sessions', { disabled: true })],
  'storage-confirm': [button('Delete all sessions')],
};
for (const [name, required] of Object.entries(specialSettings)) {
  define(`settings-${name}`, settings, {
    required, section: name.split('-')[0], setup: `Open the section and reach ${name.replaceAll('-', ' ')} using fictional data and real controls.`,
    ...(name === 'storage-confirm' ? { frame: 'native' } : {}),
    pending: name.endsWith('testing') || name.endsWith('connecting'),
  });
}

const workspace = { group: 'workspace', frame: 'region', root: '.report-workspace', regions: ['.report-toolbar', '.issue-draft', '.report-details', '.report-feedback'], source: 'entrypoints/share/App.tsx', fixture: 'Stopped 62-second fictional recording with one note, no unrelated screenshot evidence.' };
const workspaceCases = {
  loading: [text('Loading recording…')],
  unavailable: [{ role: 'alert', contains: 'Open Share report' }],
  'still-live': [{ role: 'alert', contains: 'Stop the recording' }],
  preparing: [button('File GitHub issue', { disabled: true })],
  draft: [button('File GitHub issue', { disabled: false }), text('Saved locally'), { label: 'Issue title' }],
  editing: [{ label: 'Issue summary · Markdown' }, button('Done')],
  'cloudflare-pending': [text('Deployment created'), button('Check deployment')],
  'managed-partial': [text('Upload incomplete', { first: true }), text('Open partial report'), button('Resume upload')],
  published: [text('Open published report'), text('Published', { exact: true, first: true })],
  uncertain: [button('Check GitHub issue'), { label: 'GitHub repository', disabled: true }, text('Open published report')],
  filed: [{ role: 'link', name: 'View issue #42' }, text('Filed', { exact: true, first: true })],
  'filed-unpublished': [{ role: 'link', name: 'View issue #42' }, text('Open published report', { absent: true })],
  'uncertain-unpublished': [text('Saved locally'), button('Check GitHub issue'), { label: 'GitHub repository', disabled: true }, text('Open published report', { absent: true }), text('Deployment created', { absent: true })],
  'summary-running': [{ role: 'status', contains: 'Generating issue summary' }, button('Cancel'), button('Regenerate summary', { disabled: true })],
  'publish-running': [{ role: 'status' }, button('Cancel'), button('Publish report only', { disabled: true })],
  'deployment-checking': [{ role: 'status' }, button('Cancel'), button('Check deployment', { disabled: true })],
  copying: [{ role: 'status', contains: 'Preparing…' }, button('Cancel'), button('Copy issue Markdown', { disabled: true })],
  'delete-confirm': [text('Delete this deployment? Existing report links will stop working.'), button('Delete deployment')],
  'delete-running': [{ role: 'status' }, button('Cancel'), button('Delete deployment', { disabled: true })],
  cancelling: [{ role: 'status', contains: 'Cancelling' }, button('Cancel')],
};
for (const [name, required] of Object.entries(workspaceCases)) {
  const options = ['summary-running', 'publish-running', 'copying', 'delete-confirm', 'delete-running', 'cancelling'].includes(name);
  define(`workspace-${name}`, workspace, {
    required, setup: `Restore a fresh ${name.replaceAll('-', ' ')} fixture; invoke its production action when applicable.`,
    pending: ['loading', 'preparing', 'summary-running', 'publish-running', 'deployment-checking', 'copying', 'delete-running', 'cancelling'].includes(name),
    regions: [...workspace.regions, ...(options ? ['.advanced-report'] : [])],
    ...(name === 'managed-partial' ? { equivalence: 'The partial Proofline report is durable and openable while incomplete attachments resume from the saved checkpoint.' } : {}),
  });
}
for (const [name, stage] of [['connection', 'Check repository access'], ['summary', 'Prepare issue summary'], ['publish', 'Publish protected report'], ['issue', 'Create GitHub issue'], ['cancelling', 'Create GitHub issue']]) {
  define(`workspace-filing-${name}`, workspace, {
    group: 'filing', root: '.filing-screen', regions: ['.filing-progress'], source: 'entrypoints/share/FilingProgress.tsx', pending: true,
    setup: `Click File GitHub issue; hold the ${name} dependency after it is reached.`,
    required: [req('.filing-heading', { contains: name === 'cancelling' ? 'Cancelling…' : 'Filing your issue' }), req('li[data-state="active"]', { contains: stage }), req('.filing-phase'), button(name === 'cancelling' ? 'Cancelling…' : 'Cancel', { disabled: name === 'cancelling' })],
  });
}
for (const [name, required] of Object.entries({
  loading: [text('Loading report…')], missing: [text('No session specified.')],
  ready: [button('Download .zip', { disabled: false }), req('#bar-title', { contains: 'Checkout' })],
  'preparing-zip': [button('Preparing…', { disabled: true })],
})) define(`timeline-${name}`, { group: 'timeline', frame: 'region', root: '#report', regions: ['.bar', '#report'], source: 'entrypoints/report/main.ts', fixture: 'Short stopped recording with a single note.', setup: `Open report; ${name === 'preparing-zip' ? 'click Download and hold the real ZIP/download dependency' : 'wait at ' + name}.` }, { required, pending: ['loading', 'preparing-zip'].includes(name) });

export const contracts = new Map(entries);
if (contracts.size !== entries.length) throw new Error('Duplicate Surface capture contract.');
export function surfaceId(name) { return prefix + name; }
