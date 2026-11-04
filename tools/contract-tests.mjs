// Builds nexo-server and runs the contract tests in tests/contract against it.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const cargo = process.platform === 'win32' ? join(homedir(), '.cargo/bin/cargo.exe') : 'cargo';
const build = spawnSync(cargo, ['build', '--locked', '-p', 'nexo-server'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const files = readdirSync('tests/contract')
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => join('tests/contract', name));
const filter = process.argv.slice(2);
const run = spawnSync(process.execPath, ['--test', ...filter, ...files], { stdio: 'inherit' });
process.exit(run.status ?? 1);
