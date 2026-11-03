import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {homedir} from 'node:os';
const child=spawn(process.execPath,['node_modules/@tauri-apps/cli/tauri.js',...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,PATH:`${join(homedir(),'.cargo/bin')}${process.platform==='win32'?';':':'}${process.env.PATH??''}`}});
child.on('exit',code=>process.exit(code??1));
