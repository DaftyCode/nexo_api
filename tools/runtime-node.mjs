import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const executable = existsSync('tools/runtime/node.exe')
  ? resolve('tools/runtime/node.exe')
  : process.execPath;
const child = spawn(executable, process.argv.slice(2), { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
