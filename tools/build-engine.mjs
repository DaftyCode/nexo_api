import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const outputDirectory = resolve('engine/dist');
if (dirname(outputDirectory) !== resolve('engine'))
  throw new Error('Unexpected engine output path');
await rm(outputDirectory, { recursive: true, force: true });
await mkdir('engine/dist', { recursive: true });
for (const [entry, out] of [
  ['engine/src/index.mjs', 'engine.mjs'],
  ['engine/src/adapters/runtime-worker.mjs', 'runtime-worker.mjs'],
  ['engine/src/adapters/dataset-worker.mjs', 'dataset-worker.mjs'],
]) {
  await build({
    entryPoints: [entry],
    outfile: `engine/dist/${out}`,
    bundle: true,
    platform: 'node',
    target: 'node26',
    format: out.endsWith('.mjs') ? 'esm' : 'cjs',
    packages: 'external',
    sourcemap: true,
    banner: { js: '// Nexo API execution engine. Dependencies are distributed separately.' },
  });
}
