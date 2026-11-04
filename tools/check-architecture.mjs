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
    ],
  ],
  [
    'nexo-application',
    ['nexo-infrastructure', 'nexo-http', 'axum', 'rusqlite', 'tauri', 'reqwest'],
  ],
  ['nexo-http', ['nexo-infrastructure', 'nexo-engine', 'rusqlite', 'reqwest']],
  // The engine is an adapter: it implements application ports and never reaches the
  // HTTP layer, the other adapters or the desktop shell.
  ['nexo-engine', ['nexo-infrastructure', 'nexo-http', 'nexo-server', 'tauri']],
  ['nexo-infrastructure', ['nexo-http', 'nexo-engine', 'nexo-server', 'tauri']],
]) {
  const manifest = await readFile(`backend/crates/${crate}/Cargo.toml`, 'utf8');
  const dependencies = manifest.split(/^\[dev-dependencies\]/m)[0];
  for (const dependency of forbidden)
    if (new RegExp(`^${dependency}\\s*=`, 'm').test(dependencies))
      failures.push(`${crate}: forbidden dependency ${dependency}`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Architecture boundaries verified: Angular layers and Rust hexagonal crates.');
