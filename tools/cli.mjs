import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
const node=existsSync('tools/runtime/node.exe')?resolve('tools/runtime/node.exe'):process.execPath;
const child=spawn(resolve(`target/release/nexo-cli${process.platform==='win32'?'.exe':''}`),process.argv.slice(2),{stdio:'inherit',env:{...process.env,NEXO_NODE:process.env.NEXO_NODE??node}});child.on('exit',code=>process.exit(code??1));
