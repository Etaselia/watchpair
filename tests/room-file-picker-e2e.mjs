import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import electronPath from 'electron';
import {terminateChildProcess} from './process-helpers.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'watchpair-room-picker-'));
await mkdir('test-results',{recursive:true});
await mkdir(path.join(directory,'electron'),{recursive:true});
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const server=spawn(process.execPath,['scripts/start-container.mjs'],{windowsHide:true,env:{...process.env,PORT:String(port),WATCHPAIR_SESSION_FILE:path.join(directory,'sessions.json')},stdio:['ignore','pipe','pipe']});
let output='';server.stdout.on('data',data=>output+=data);server.stderr.on('data',data=>output+=data);
try {
  for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  const runtimeArguments=process.platform==='linux'&&process.env.CI?['--no-sandbox']:[];
  const child=spawn(electronPath,[...runtimeArguments,'tests/fixtures/room-file-picker-main.mjs'],{windowsHide:true,env:{...process.env,WATCHPAIR_PICKER_TEST_PORT:String(port),WATCHPAIR_ROOM_TEST_DIR:directory},stdio:'inherit'});
  const timer=setTimeout(()=>void terminateChildProcess(child),90000);
  const code=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer);process.exitCode=code??1;
} catch(error){console.error(error,output);process.exitCode=1;}
finally {await terminateChildProcess(server);await rm(directory,{recursive:true,force:true});}
