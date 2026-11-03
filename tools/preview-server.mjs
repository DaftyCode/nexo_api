import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
const node=existsSync('tools/runtime/node.exe')?resolve('tools/runtime/node.exe'):process.execPath;
const children=[];
function start(command,args,env){const child=spawn(command,args,{stdio:'inherit',env:{...process.env,...env}});children.push(child);return child;}
start(resolve(`target/release/nexo-server${process.platform==='win32'?'.exe':''}`),[],{NEXO_MODE:'server',NEXO_BIND:'127.0.0.1:8081',NEXO_NODE:node,NEXO_DATA_DIR:resolve('.nexo-server'),NEXO_ENGINE_SCRIPT:resolve('engine/dist/engine.mjs')});
start(node,['dist/nexo/server/server.mjs'],{PORT:'4000',NG_ALLOWED_HOSTS:'localhost,127.0.0.1',NEXO_API_URL:'http://127.0.0.1:8081'});
function stop(){for(const child of children)child.kill();}
process.on('SIGINT',()=>{stop();process.exit(0);});process.on('SIGTERM',()=>{stop();process.exit(0);});
