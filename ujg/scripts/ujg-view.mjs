// Opens the document in the real Journey Viewer (`journey-viewer run`) with its screenshots and
// touchpoints. Needs JOURNEY_VIEWER_DIR (a built journey-viewer checkout).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = process.env.JOURNEY_VIEWER_DIR;
const cli = dir && path.join(dir, 'packages/app/dist/cli/cli.js');
if (!cli || !fs.existsSync(cli)) {
  console.error('Set JOURNEY_VIEWER_DIR to a built journey-viewer checkout (pnpm build).');
  process.exit(1);
}
const generated = new URL('../generated/', import.meta.url).pathname;
const args = ['run', path.join(generated, 'user-journeys.ujg.jsonld')];
for (const [flag, name] of [['--screenshots', 'user-journeys.screenshots.json'], ['--touchpoints', 'user-journeys.touchpoints.json']]) {
  if (fs.existsSync(path.join(generated, name))) args.push(flag, path.join(generated, name));
}
const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' });
// Forward termination so the server (and its temporary folder) never outlives this wrapper.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
