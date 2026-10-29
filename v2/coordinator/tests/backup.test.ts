import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomBytes,randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';

test('online coordinator backup preserves room identity, history and private key material',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'watchpair-backup-')),source=join(directory,'live.sqlite'),target=join(directory,'backup.sqlite');
  const store=new Store(source),engine=new Engine(store);
  try {
    const room=engine.create('Backup room','Host',randomBytes(32).toString('base64url'));
    const secret=store.key('backup-check');
    await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../src/backup.js',import.meta.url)),target],{env:{...process.env,WATCHPAIR_DATABASE:source}});
    const saved=new Store(target);
    try {const restored=new Engine(saved);assert.equal(restored.authenticate(room.roomId,room.token).id,room.memberId);assert.equal(restored.snapshot(room.roomId).name,'Backup room');assert.deepEqual(saved.key('backup-check'),secret);}
    finally{saved.close();}
    await assert.rejects(()=>promisify(execFile)(process.execPath,[fileURLToPath(new URL('../src/backup.js',import.meta.url)),target],{env:{...process.env,WATCHPAIR_DATABASE:source}}));
    engine.command(room.roomId,room.memberId,{operationId:randomUUID(),command:{type:'room.rename',name:'Live database still usable'}});
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
