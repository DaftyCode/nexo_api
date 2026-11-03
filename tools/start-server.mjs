import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
const executable=resolve(`target/release/nexo-server${process.platform==='win32'?'.exe':''}`);
const node=existsSync('tools/runtime/node.exe')?resolve('tools/runtime/node.exe'):process.execPath;
const child=spawn(executable,[],{stdio:'inherit',env:{...process.env,NEXO_NODE:process.env.NEXO_NODE??node,NEXO_MODE:process.env.NEXO_MODE??'server'}});child.on('exit',code=>process.exit(code??1));
