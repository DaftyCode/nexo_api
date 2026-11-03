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
for (const layer of ['domain', 'application'])
  for (const path of await files(`src/app/${layer}`, '.ts')) {
    const text = await readFile(path, 'utf8');
    if (/from\s+['"](?:@angular|.*(?:presentation|infrastructure|composition)\/)/.test(text))
      failures.push(`${path}: inward layer imports framework or outward layer`);
  }
for (const path of await files('src/app/presentation', '.ts')) {
  if (path.endsWith('.spec.ts')) continue;
  const text = await readFile(path, 'utf8');
  if (/from\s+['"](?:@angular\/common\/http|.*infrastructure\/)/.test(text))
    failures.push(`${path}: presentation bypasses use cases`);
}
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
    ],
  ],
  [
    'nexo-application',
    ['nexo-infrastructure', 'nexo-http', 'axum', 'rusqlite', 'tauri', 'reqwest'],
  ],
  ['nexo-http', ['nexo-infrastructure', 'rusqlite']],
]) {
  const manifest = await readFile(`backend/crates/${crate}/Cargo.toml`, 'utf8');
  for (const dependency of forbidden)
    if (new RegExp(`^${dependency}\\s*=`, 'm').test(manifest))
      failures.push(`${crate}: forbidden dependency ${dependency}`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  'Architecture boundaries verified: Angular domain/application and Rust hexagonal crates.',
);
