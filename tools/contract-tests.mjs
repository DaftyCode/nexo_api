// Builds nexo-server and the database drivers its module tests run (the test driver and
// PostgreSQL's), and runs the contract tests in tests/contract against it.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const cargo = process.platform === 'win32' ? join(homedir(), '.cargo/bin/cargo.exe') : 'cargo';
const build = spawnSync(
  cargo,
  [
    'build',
    '--locked',
    '-p',
    'nexo-server',
    '-p',
    'nexo-driver-test',
    '-p',
    'nexo-driver-postgres',
  ],
  { stdio: 'inherit' },
);
if (build.status !== 0) process.exit(build.status ?? 1);
const files = readdirSync('tests/contract')
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => join('tests/contract', name));
const filter = process.argv.slice(2);
// Each file starts its own server, so files run in parallel. The MongoDB files share the
// outside servers of tools/mongo-fixture.sh and run one after another.
const shared = files.filter((file) => /mongo-[^\\/]*\.test\.mjs$/.test(file));
const own = files.filter((file) => !shared.includes(file));
let status = 0;
for (const [group, concurrency] of [
  [own, []],
  [shared, ['--test-concurrency=1']],
]) {
  if (group.length === 0) continue;
  const run = spawnSync(process.execPath, ['--test', ...concurrency, ...filter, ...group], {
    stdio: 'inherit',
  });
  if (run.status !== 0) status = run.status ?? 1;
}
process.exit(status);
