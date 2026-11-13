// Builds the database modules for this computer's platform and writes what a release
// publishes: each driver compressed with gzip, and the manifest that the app embeds when it
// is built with NEXO_MODULES_MANIFEST naming it (crates/nexo-modules/build.rs).
//
// A module is a package of backend/drivers with `[package.metadata.nexo] module = "<id>"`;
// the test driver has none and is never published. The name, version and protocol come from
// the driver itself (its `hello`), the licenses from what Cargo compiles into it.
//
// Usage: node tools/package-modules.mjs [--out target/modules]
// In GitHub Actions, it also sets NEXO_MODULES_MANIFEST for the next steps.
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { executableName, hostTarget, moduleEntry } from './modules/manifest.mjs';

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const out = resolve(option('--out', 'target/modules'));
const cargo =
  process.platform === 'win32' ? join(homedir(), '.cargo', 'bin', 'cargo.exe') : 'cargo';
const target = hostTarget();
const version = JSON.parse(await readFile('package.json', 'utf8')).version;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

const metadata = JSON.parse(
  run(cargo, ['metadata', '--locked', '--format-version', '1', '--filter-platform', target]),
);
const drivers = resolve('backend/drivers') + sep;
const modules = metadata.packages
  .filter((pkg) => resolve(pkg.manifest_path).startsWith(drivers))
  .filter((pkg) => typeof pkg.metadata?.nexo?.module === 'string')
  .map((pkg) => ({ pkg, id: pkg.metadata.nexo.module }));

/**
 * The licenses of everything compiled into a package: it and its normal dependencies. Cargo
 * resolves features for the whole workspace, so the list may name a few more than the driver
 * carries, never fewer.
 */
function licenses(rootId) {
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const seen = new Set();
  const pending = [rootId];
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dependency of nodes.get(id)?.deps ?? [])
      if (dependency.dep_kinds.some((kind) => kind.kind === null)) pending.push(dependency.pkg);
  }
  const found = [...seen]
    .map((id) => packages.get(id))
    // Procedural macros run while compiling; their code is not in the driver.
    .filter((pkg) => pkg && !pkg.targets.some((t) => t.kind.includes('proc-macro')))
    .map((pkg) => pkg.license ?? 'unknown');
  return [...new Set(found)].sort();
}

/** What a driver says about itself when it starts. */
async function hello(path) {
  const child = spawn(path, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(`${JSON.stringify({ id: 1, method: 'hello', params: null })}\n`);
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    for await (const line of lines) {
      const message = JSON.parse(line);
      if (message.id === 1) {
        if (message.error) throw new Error(`${path}: ${message.error.message}`);
        return message.result;
      }
    }
    throw new Error(`${path} did not say hello`);
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    lines.close();
  }
}

await mkdir(out, { recursive: true });
if (modules.length) {
  const packages = modules.flatMap(({ pkg }) => ['-p', pkg.name]);
  run(cargo, ['build', '--release', '--locked', ...packages], { stdio: 'inherit' });
}
const entries = [];
for (const { pkg, id } of modules) {
  const path = join(metadata.target_directory, 'release', executableName(id));
  const said = await hello(path);
  if (said.driver.id !== id) throw new Error(`${pkg.name} says it is the ${said.driver.id} driver`);
  const ext = process.platform === 'win32' ? '.exe' : '';
  const { entry, asset } = moduleEntry({
    id,
    name: said.driver.name,
    description: pkg.description ?? '',
    version: said.driver.version,
    driver: await readFile(path),
    file: `nexo-driver-${id}-${target}${ext}.gz`,
    licenses: licenses(pkg.id),
    protocol: said.protocol,
  });
  await writeFile(join(out, entry.file), asset);
  entries.push(entry);
  console.log(`${entry.file}: ${entry.compressedSize} bytes, ${entry.licenses.join(', ')}`);
}
const manifest = join(out, `modules-${target}.json`);
await writeFile(manifest, `${JSON.stringify({ version, target, modules: entries }, null, 2)}\n`);
console.log(`${entries.length} database modules for ${target}; manifest: ${manifest}`);
if (process.env.GITHUB_ENV)
  await appendFile(process.env.GITHUB_ENV, `NEXO_MODULES_MANIFEST=${manifest}\n`);
