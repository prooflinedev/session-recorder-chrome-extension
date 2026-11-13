// Runs the model-regeneration task with either agent, then the shared gates. The contract
// (AGENTS.md) and the task (prompts/recalculate-model.md) are identical for both; only the launch
// command and its permission flags differ. Acceptance is decided by the gates, never by the agent.
//
//   node scripts/ujg-generate.mjs <codex|claude> [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prompt = path.join(bundle, 'prompts/recalculate-model.md');

// Claude Code: edits and the bundle's own tooling are allowed; anything that rewrites history or moves
// the branch is denied. (Codex gets the equivalent through its workspace-write sandbox plus AGENTS.md.)
const claudeAllowed = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(pnpm *)', 'Bash(node *)', 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git rev-parse *)', 'Bash(ls *)', 'Bash(cat *)',
  'WebFetch(domain:ujg.specs.openuji.org)',
];
const claudeDenied = ['Bash(git commit *)', 'Bash(git push *)', 'Bash(git checkout *)', 'Bash(git switch *)', 'Bash(git branch *)', 'Bash(git reset *)', 'Bash(git stash *)', 'Bash(git add *)', 'Bash(rm -rf *)'];

export function buildCommand(agent) {
  if (agent === 'codex') return { command: 'codex', args: ['exec', '--sandbox', 'workspace-write', '--cd', bundle, '-'] };
  if (agent === 'claude') {
    return {
      command: 'claude',
      args: ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', claudeAllowed.join(','), '--disallowedTools', claudeDenied.join(',')],
    };
  }
  throw new Error(`Unknown agent "${agent}". Use codex or claude.`);
}

export const gates = [
  ['profile', ['scripts/ujg-viewer-profile.mjs', '--check']],
  ['validate', ['scripts/ujg-composition-validate.mjs']],
  ['test', ['--test', 'scripts/ujg-composition-validate.test.mjs']],
  ['viewer', ['scripts/ujg-viewer-gate.mjs']],
];

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [agent, ...flags] = process.argv.slice(2);
  try {
    const { command, args } = buildCommand(agent);
    if (flags.includes('--dry-run')) {
      console.log(`cd ${bundle} && ${command} ${args.map((a) => (/[\s*()]/.test(a) ? JSON.stringify(a) : a)).join(' ')} < ${path.relative(bundle, prompt)}`);
      console.log(`then gates: ${gates.map(([name]) => name).join(' -> ')}`);
      process.exit(0);
    }
    if (!process.env.JOURNEY_VIEWER_DIR) throw new Error('Set JOURNEY_VIEWER_DIR (built journey-viewer checkout); the viewer gate is part of every run.');
    const run = spawnSync(command, args, { cwd: bundle, input: fs.readFileSync(prompt), stdio: ['pipe', 'inherit', 'inherit'] });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`${command} exited with status ${run.status}.`);
    for (const [name, nodeArgs] of gates) {
      console.log(`\n== gate: ${name} ==`);
      const result = spawnSync(process.execPath, nodeArgs, { cwd: bundle, stdio: 'inherit', env: process.env });
      if (result.status !== 0) throw new Error(`Gate "${name}" failed.`);
    }
    console.log('\nAll gates passed.');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
