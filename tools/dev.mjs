import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
const cargo = process.platform === 'win32' ? join(homedir(), '.cargo/bin/cargo.exe') : 'cargo';
const children = [];
function start(command, args, extra = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...extra });
  children.push(child);
  child.on('exit', (code) => {
    if (code) console.error(`${command} exited: ${code}`);
  });
  return child;
}
start(cargo, ['run', '--locked', '-p', 'nexo-server'], {
  env: { ...process.env, NEXO_MODE: process.env.NEXO_MODE ?? 'local',NEXO_NODE:process.env.NEXO_NODE??(existsSync('tools/runtime/node.exe')?resolve('tools/runtime/node.exe'):process.execPath) },
});
start(process.execPath, [
  'node_modules/@angular/cli/bin/ng.js',
  'serve',
  '--host',
  'localhost',
  '--port',
  '4200',
]);
function stop() {
  for (const child of children) child.kill();
}
process.on('SIGINT', () => {
  stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stop();
  process.exit(0);
});
