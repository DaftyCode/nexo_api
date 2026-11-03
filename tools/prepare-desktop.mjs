import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
await mkdir('src-tauri/binaries', { recursive: true });
const runtimeDirectory = resolve('src-tauri/runtime');
if (dirname(runtimeDirectory) !== resolve('src-tauri'))
  throw new Error('Unexpected runtime output path');
await rm(runtimeDirectory, { recursive: true, force: true });
await mkdir('src-tauri/runtime', { recursive: true });
if (!['x64', 'arm64'].includes(process.arch)) throw new Error('Unsupported native architecture');
const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const target =
  process.platform === 'win32'
    ? `${architecture}-pc-windows-msvc`
    : process.platform === 'darwin'
      ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
      : `${architecture}-unknown-linux-gnu`;
const binary = `src-tauri/binaries/nexo-node-${target}${process.platform === 'win32' ? '.exe' : ''}`;
await copyFile(
  process.env.NEXO_NODE_BINARY ??
    (process.platform === 'win32' && existsSync('tools/runtime/node.exe')
      ? 'tools/runtime/node.exe'
      : process.execPath),
  binary,
);
if (process.platform !== 'win32') await chmod(binary, 0o755);
const pkg = JSON.parse(await readFile('engine/package.json', 'utf8'));
delete pkg.workspaces;
await writeFile('src-tauri/runtime/package.json', JSON.stringify(pkg, null, 2));
await copyFile('LICENSE', 'src-tauri/runtime/LICENSE');
await cp('engine/dist', 'src-tauri/runtime', { recursive: true });
const npmCli =
  process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const result = spawnSync(
  process.execPath,
  [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--prefix', 'src-tauri/runtime'],
  { stdio: 'inherit' },
);
if (result.status) process.exit(result.status);
