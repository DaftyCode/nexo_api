import { readFile, writeFile, mkdir } from 'node:fs/promises';
const npmPackages = [
  '@angular/common',
  '@angular/compiler',
  '@angular/core',
  '@angular/forms',
  '@angular/platform-browser',
  '@angular/platform-server',
  '@angular/router',
  '@angular/ssr',
  'express',
  'rxjs',
  'tslib',
  '@tauri-apps/api',
];
const npmDev = [
  '@angular/build',
  '@angular/cli',
  '@angular/compiler-cli',
  '@types/express',
  '@types/node',
  'jsdom',
  'prettier',
  'typescript',
  'vitest',
  '@tauri-apps/cli',
  'esbuild',
  '@playwright/test',
  'http-proxy-middleware',
];
const enginePackages = [
  'undici',
  'tough-cookie',
  'yaml',
  'ws',
  'mqtt',
  'socket.io-client',
  '@grpc/grpc-js',
  '@grpc/proto-loader',
  'shell-quote',
  'duckdb',
  'jose',
];
const crateNames = [
  'serde',
  'serde_json',
  'async-trait',
  'thiserror',
  'uuid',
  'tokio',
  'axum',
  'tower-http',
  'rusqlite',
  'reqwest',
  'argon2',
  'rand',
  'sha2',
  'hex',
  'keyring',
  'tauri',
  'tauri-build',
  'tracing',
  'tracing-subscriber',
  'directories',
  'futures-util',
  'base64',
];
const versions = { checkedAt: new Date().toISOString(), npm: {}, crates: {} };
async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}
await Promise.all(
  [...npmPackages, ...npmDev, ...enginePackages].map(async (name) => {
    const p = await get(`https://registry.npmjs.org/${name}/latest`);
    versions.npm[name] = p.version;
  }),
);
await Promise.all(
  crateNames.map(async (name) => {
    const prefix =
      name.length === 1
        ? '1'
        : name.length === 2
          ? '2'
          : name.length === 3
            ? `3/${name[0]}`
            : `${name.slice(0, 2)}/${name.slice(2, 4)}`;
    const response = await fetch(`https://index.crates.io/${prefix}/${name}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Cargo sparse index ${name}: ${response.status}`);
    const releases = (await response.text())
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x))
      .filter((x) => !x.yanked && /^\d+\.\d+\.\d+$/.test(x.vers));
    releases.sort((a, b) => a.vers.localeCompare(b.vers, undefined, { numeric: true }));
    versions.crates[name] = releases.at(-1).vers;
  }),
);
const root = JSON.parse(await readFile('package.json', 'utf8'));
root.dependencies = Object.fromEntries(npmPackages.map((x) => [x, versions.npm[x]]));
root.devDependencies = Object.fromEntries(npmDev.map((x) => [x, versions.npm[x]]));
// Angular 22's compiler peer contract defines which stable TypeScript release is supported.
const compiler = await get('https://registry.npmjs.org/@angular/compiler-cli/latest');
const tsRange = compiler.peerDependencies.typescript;
const ts = await get('https://registry.npmjs.org/typescript');
const major = Number(tsRange.match(/>=\s*(\d+)/)?.[1] ?? 6);
root.devDependencies.typescript = Object.keys(ts.versions)
  .filter((v) => new RegExp(`^${major}\\.\\d+\\.\\d+$`).test(v))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .at(-1);
versions.npm.typescript = root.devDependencies.typescript;
root.workspaces = ['engine'];
root.scripts = {
  ...root.scripts,
  'engine:build': 'node tools/build-engine.mjs',
  'engine:test': 'node --test engine/test/*.test.mjs',
  dev: 'node tools/dev.mjs',
  'backend:build': 'cargo build --locked --release -p nexo-server',
  'backend:test': 'cargo test --workspace --exclude nexo-desktop',
  'desktop:prepare': 'node tools/prepare-desktop.mjs',
  'desktop:dev': 'tauri dev',
  'desktop:build': 'npm run engine:build && npm run desktop:prepare && tauri build',
  'test:architecture': 'node tools/check-architecture.mjs',
  e2e: 'playwright test',
  check: 'npm run test:architecture && ng build',
};
await writeFile('package.json', JSON.stringify(root, null, 2) + '\n');
await mkdir('engine', { recursive: true });
await writeFile(
  'engine/package.json',
  JSON.stringify(
    {
      name: '@nexo/engine',
      version: '0.1.0',
      private: true,
      type: 'module',
      dependencies: Object.fromEntries(
        enginePackages.filter((x) => x !== 'duckdb').map((x) => [x, versions.npm[x]]),
      ),
    },
    null,
    2,
  ) + '\n',
);
await mkdir('.verification', { recursive: true });
await writeFile('.verification/dependency-versions.json', JSON.stringify(versions, null, 2) + '\n');
let cargo = await readFile('Cargo.toml', 'utf8');
for (const [name, version] of Object.entries(versions.crates))
  cargo = cargo.replaceAll(`@@${name}@@`, version);
await writeFile('Cargo.toml', cargo);
console.log(
  JSON.stringify(
    {
      angular: versions.npm['@angular/core'],
      tauri: versions.crates.tauri,
      typescript: versions.npm.typescript,
      crates: versions.crates,
    },
    null,
    2,
  ),
);
