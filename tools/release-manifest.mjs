import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

const paths = [
  'target/release/bundle/nsis/Nexo API_0.1.0_x64-setup.exe',
  'target/release/nexo-desktop.exe',
  'target/release/nexo-server.exe',
  'target/release/nexo-cli.exe',
  'target/release/nexo-node.exe',
  'target/release/runtime/engine.mjs',
  'target/release/runtime/runtime-worker.mjs',
  'target/release/runtime/dataset-worker.mjs',
];
const artifacts = [];
for (const path of paths) {
  const bytes = await readFile(path);
  const info = await stat(path);
  artifacts.push({
    path,
    bytes: info.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
const node = JSON.parse(await readFile('tools/runtime/node-runtime.json', 'utf8'));
if (artifacts.find((item) => item.path.endsWith('/nexo-node.exe')).sha256 !== node.sha256) {
  throw new Error('Bundled Node does not match the verified official runtime');
}
for (const name of ['engine.mjs', 'runtime-worker.mjs', 'dataset-worker.mjs']) {
  const source = await readFile(`engine/dist/${name}`);
  const packaged = await readFile(`target/release/runtime/${name}`);
  if (!source.equals(packaged)) throw new Error(`Stale packaged runtime: ${name}`);
}
await mkdir('.verification', { recursive: true });
await writeFile(
  '.verification/artifacts.json',
  JSON.stringify(
    {
      version: '0.1.0',
      platform: 'windows-x64',
      generatedAt: new Date().toISOString(),
      node: node.version,
      artifacts,
    },
    null,
    2,
  ) + '\n',
);
console.log('Release manifest written; official Node and packaged engine verified.');
