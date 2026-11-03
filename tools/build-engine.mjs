import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
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
    target: 'node24',
    format: out.endsWith('.mjs') ? 'esm' : 'cjs',
    packages: 'external',
    sourcemap: true,
    banner: { js: '// Nexo compatibility adapter. Dependencies are distributed separately.' },
  });
}
