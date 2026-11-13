// Verifies the dependency rules described in AGENTS.md.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const failures = [];
async function files(directory, extension) {
  const results = [];
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, file.name);
    if (file.isDirectory()) results.push(...(await files(path, extension)));
    else if (path.endsWith(extension)) results.push(path);
  }
  return results;
}
/** Static `from '...'` imports and dynamic `import('...')` calls. */
const imports = (pattern) => new RegExp(`(?:from\\s+|import\\s*\\(\\s*)['"](?:${pattern})`);

// Angular: domain and application are framework-free and never reach outer layers.
for (const layer of ['domain', 'application'])
  for (const path of await files(`src/app/${layer}`, '.ts')) {
    const text = await readFile(path, 'utf8');
    if (imports('@angular|.*(?:presentation|infrastructure|composition)/').test(text))
      failures.push(`${path}: inward layer imports framework or outward layer`);
  }
// Angular: presentation uses application contracts, never adapters or HttpClient.
for (const path of await files('src/app/presentation', '.ts')) {
  if (path.endsWith('.spec.ts')) continue;
  const text = await readFile(path, 'utf8');
  if (imports('@angular/common/http|.*infrastructure/').test(text))
    failures.push(`${path}: presentation bypasses use cases`);
  // Presentation reaches the backend only through application use cases (ARQ-01).
  if (/cases\.api\b|\bstate\.execute\s*[<(]/.test(text))
    failures.push(`${path}: call a use case instead of the API port or engine operations`);
}
// Rust: hexagonal crate dependencies.
for (const [crate, forbidden] of [
  [
    'nexo-domain',
    [
      'nexo-application',
      'nexo-infrastructure',
      'nexo-http',
      'axum',
      'rusqlite',
      'tauri',
      'reqwest',
      'tokio',
      'mongodb',
      'nexo-mongo',
    ],
  ],
  [
    'nexo-application',
    [
      'nexo-infrastructure',
      'nexo-http',
      'axum',
      'rusqlite',
      'tauri',
      'reqwest',
      'mongodb',
      'nexo-mongo',
    ],
  ],
  [
    'nexo-http',
    ['nexo-infrastructure', 'nexo-engine', 'rusqlite', 'reqwest', 'mongodb', 'nexo-mongo'],
  ],
  // The engine is an adapter: it implements application ports and never reaches the
  // HTTP layer, the other adapters or the desktop shell.
  [
    'nexo-engine',
    ['nexo-infrastructure', 'nexo-http', 'nexo-server', 'tauri', 'mongodb', 'nexo-mongo'],
  ],
  [
    'nexo-infrastructure',
    ['nexo-http', 'nexo-engine', 'nexo-server', 'tauri', 'mongodb', 'nexo-mongo'],
  ],
  // MongoDB is one more adapter: only it uses the driver, and nexo-server composes it.
  ['nexo-mongo', ['nexo-infrastructure', 'nexo-http', 'nexo-engine', 'nexo-server', 'tauri']],
  // The host of the database drivers is one more adapter too.
  [
    'nexo-modules',
    [
      'nexo-infrastructure',
      'nexo-http',
      'nexo-engine',
      'nexo-server',
      'nexo-mongo',
      'tauri',
      'mongodb',
      'axum',
      'rusqlite',
    ],
  ],
]) {
  const manifest = await readFile(`backend/crates/${crate}/Cargo.toml`, 'utf8');
  const dependencies = manifest.split(/^\[dev-dependencies\]/m)[0];
  for (const dependency of forbidden)
    if (new RegExp(`^${dependency}\\s*=`, 'm').test(dependencies))
      failures.push(`${crate}: forbidden dependency ${dependency}`);
}
// Rust: database drivers are separate processes (backend/drivers). Only the host of the
// drivers (nexo-modules) and the drivers know the protocol crate, which knows no other Nexo
// crate; a driver depends on nothing else of Nexo; and nothing of the product depends on a
// driver, so none is ever compiled into nexo-server or the desktop app.
const directories = async (path) =>
  (await readdir(path, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
const nexoDependencies = async (manifestPath) => {
  const manifest = await readFile(manifestPath, 'utf8');
  const dependencies = manifest.split(/^\[dev-dependencies\]/m)[0];
  return [...dependencies.matchAll(/^(nexo-[a-z0-9-]+)\s*=/gm)].map((match) => match[1]);
};
const isDriver = (name) => name.startsWith('nexo-driver-') && name !== 'nexo-driver-sdk';
for (const crate of await directories('backend/crates'))
  for (const dependency of await nexoDependencies(`backend/crates/${crate}/Cargo.toml`)) {
    if (isDriver(dependency))
      failures.push(`${crate}: a database driver (${dependency}) is never a dependency`);
    if (dependency === 'nexo-driver-sdk' && crate !== 'nexo-modules')
      failures.push(`${crate}: only nexo-modules speaks the driver protocol`);
    if (dependency === 'nexo-modules' && crate !== 'nexo-server')
      failures.push(`${crate}: only the composition root depends on nexo-modules`);
    if (crate === 'nexo-driver-sdk')
      failures.push(`nexo-driver-sdk: depends on no other Nexo crate (${dependency})`);
  }
for (const driver of await directories('backend/drivers'))
  for (const dependency of await nexoDependencies(`backend/drivers/${driver}/Cargo.toml`))
    if (dependency !== 'nexo-driver-sdk')
      failures.push(`${driver}: a driver depends only on nexo-driver-sdk, not on ${dependency}`);
for (const dependency of await nexoDependencies('src-tauri/Cargo.toml'))
  if (isDriver(dependency) || dependency === 'nexo-driver-sdk')
    failures.push(`src-tauri: the desktop app never carries a database driver (${dependency})`);

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  'Architecture boundaries verified: Angular layers, Rust hexagonal crates and database drivers.',
);
