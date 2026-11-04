// Starts the local Rust service (API only) and the Angular dev server for web development.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const cargo = process.platform === 'win32' ? join(homedir(), '.cargo/bin/cargo.exe') : 'cargo';
// The service only accepts requests carrying this per-run token; the Angular proxy
// (proxy.conf.mjs) adds it to every /api request.
const token = process.env.NEXO_LOCAL_TOKEN ?? randomBytes(32).toString('hex');
const children = [];

function start(command, args, env) {
  const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  children.push(child);
  child.on('exit', (code) => {
    if (code) console.error(`${command} exited: ${code}`);
  });
  return child;
}

start(cargo, ['run', '--locked', '-p', 'nexo-server', '--', '--api-only', '--port', '8080'], {
  NEXO_LOCAL_TOKEN: token,
  NEXO_ORIGINS: 'http://localhost:4200,http://127.0.0.1:4200',
  // Development data stays in this checkout, separate from the installed app.
  NEXO_DATA_DIR: process.env.NEXO_DATA_DIR ?? resolve('.nexo'),
});
start(
  process.execPath,
  ['node_modules/@angular/cli/bin/ng.js', 'serve', '--host', 'localhost', '--port', '4200'],
  { NEXO_LOCAL_TOKEN: token },
);

function stop() {
  for (const child of children) child.kill();
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stop();
    process.exit(0);
  });
