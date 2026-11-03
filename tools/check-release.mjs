import { readFile } from 'node:fs/promises';
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const desktop = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
const cargo = await readFile('Cargo.toml', 'utf8');
const version = packageJson.version;
if (
  !/^\d+\.\d+\.\d+$/.test(version) ||
  desktop.version !== version ||
  !cargo.includes(`version = "${version}"`)
)
  throw new Error('Package, Rust and desktop versions must match');
if (process.env.GITHUB_REF_NAME !== `v${version}`)
  throw new Error('Release tag must match the application version');
console.log(`Release versions verified: ${version}`);
