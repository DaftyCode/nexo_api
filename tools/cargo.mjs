import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {homedir} from 'node:os';
const child=spawn(process.platform==='win32'?join(homedir(),'.cargo/bin/cargo.exe'):'cargo',process.argv.slice(2),{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));
