import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const releases = await (await fetch('https://nodejs.org/dist/index.json')).json();
const release = releases.find((r) => r.lts && /^v\d+\.\d+\.\d+$/.test(r.version));
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Use the official Node LTS runtime for your platform.');
const base = `https://nodejs.org/dist/${release.version}`;
const manifest = await (await fetch(`${base}/SHASUMS256.txt`)).text();
const line = manifest.split('\n').find((x) => x.endsWith('  win-x64/node.exe'));
if (!line) throw new Error('No official SHA256 found for Windows Node runtime');
const expected = line.split(/\s+/)[0];
await mkdir('tools/runtime', { recursive: true });
let bytes;
try {
  bytes = await readFile('tools/runtime/node.exe');
} catch {}
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
  const response = await fetch(`${base}/win-x64/node.exe`);
  if (!response.ok) throw new Error(`Node download: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Node checksum mismatch');
  await writeFile('tools/runtime/node.exe', bytes);
}
await writeFile(
  'tools/runtime/node-runtime.json',
  JSON.stringify(
    {
      version: release.version,
      lts: release.lts,
      sha256: expected,
      source: `${base}/win-x64/node.exe`,
    },
    null,
    2,
  ),
);
console.log(`Verified Node ${release.version} LTS (${release.lts})`);
