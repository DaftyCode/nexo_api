import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {dirname,join} from 'node:path';
import {existsSync} from 'node:fs';
await mkdir('src-tauri/binaries', { recursive: true });
await mkdir('src-tauri/runtime', { recursive: true });
const target =
  process.platform === 'win32'
    ? 'x86_64-pc-windows-msvc'
    : process.platform === 'darwin'
      ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
      : 'x86_64-unknown-linux-gnu';
await copyFile(
  process.env.NEXO_NODE_BINARY??(existsSync('tools/runtime/node.exe')?'tools/runtime/node.exe':process.execPath),
  `src-tauri/binaries/nexo-node-${target}${process.platform === 'win32' ? '.exe' : ''}`,
);
const pkg = JSON.parse(await readFile('engine/package.json', 'utf8'));
delete pkg.workspaces;
await writeFile('src-tauri/runtime/package.json', JSON.stringify(pkg, null, 2));
await cp('engine/dist', 'src-tauri/runtime', { recursive: true });
const npmCli=process.env.npm_execpath??join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const result=spawnSync(process.execPath,[npmCli,'install','--omit=dev','--no-audit','--no-fund','--prefix','src-tauri/runtime'],{stdio:'inherit'});
if (result.status) process.exit(result.status);
