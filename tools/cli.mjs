// Runs the release build of the Nexo command line tool.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const child = spawn(
  resolve(`target/release/nexo-cli${process.platform === 'win32' ? '.exe' : ''}`),
  process.argv.slice(2),
  { stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 1));
