import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
let window;
app.setPath('userData', path.join(process.env.WATCHPAIR_ROOM_TEST_DIR, 'electron'));
const logs=[];
const js = source => window.webContents.executeJavaScript(source,true);
async function until(source) {
  for(let i=0;i<200;i++) { if(await js(`Boolean(${source})`))return;await new Promise(resolve=>setTimeout(resolve,100)); }
  throw new Error('Timed out: '+source+'\n'+await js('document.body.innerText'));
}
const click = text => js(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(text)}).click()`);
app.whenReady().then(async()=>{
  window=new BrowserWindow({show:false,webPreferences:{preload:path.join(fixtureDirectory,'room-file-picker-preload.cjs'),contextIsolation:false,nodeIntegration:false,sandbox:true}});
  window.webContents.on('console-message',event=>logs.push(event.message));
  try {
    await window.loadURL('http://127.0.0.1:'+process.env.WATCHPAIR_PICKER_TEST_PORT);
    await until(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='Create new'&&!button.disabled)`);
    await until(`localStorage.getItem('watchpair-device-id')`);
    await click('Create new');
    await until(`document.querySelector('input[aria-label="Media source"]')`);
    await js(`(()=>{const input=document.querySelector('input[aria-label="Media source"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'https://nyaa.si/view/1748119');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(`!document.querySelector('.source-form button').disabled`);
    await click('Add');
    await until(`document.querySelector('.queue-item')`);
    await until(`window.pickerFixture.jobs.length===1`);
    assert.equal(await js(`Array.from(document.querySelectorAll('.queue-actions button')).some(button=>button.textContent.trim()==='Choose files')`),true,'Choose files must exist before metadata');
    await click('Choose files');
    await until(`document.querySelector('dialog[open]')`);
    assert.match(await js(`document.querySelector('dialog').innerText`),/Loading file list/);
    assert.equal(await js(`Array.from(document.querySelector('dialog').querySelectorAll('button')).some(button=>button.textContent.includes('Apply selection'))`),false);
    assert.deepEqual(await js(`window.pickerFixture.jobs[0].downloadFileIndexes`),[]);
    await click('Close');
    await until(`!document.querySelector('dialog')`);
    await js(`window.pickerFixture.failManifest=true;window.pickerFixture.metadataReady=true`);
    await until(`document.querySelector('.queue-item').textContent.includes('Simulated room file-list failure')`);
    assert.equal(await js(`Boolean(document.querySelector('dialog'))`),false,'Closing a manually opened picker must not reopen it when metadata arrives');
    await click('Choose files');
    await until(`document.querySelector('dialog').textContent.includes('Simulated room file-list failure')`);
    await js(`window.pickerFixture.failManifest=false`);
    await until(`document.querySelectorAll('.torrent-picker-file').length===48`);
    assert.equal(await js(`document.querySelectorAll('.torrent-picker-file input:checked').length`),48,'Files arriving while dialog is open must initialize selection');
    await click('Select none');
    await js(`document.querySelector('input[aria-label="Download Season 2"]').click()`);
    assert.equal(await js(`document.querySelectorAll('.torrent-picker-file input:checked').length`),12);
    await click('Apply selection');
    await until(`!document.querySelector('dialog')`);
    await until(`window.pickerFixture.jobs[0].downloadFileIndexes.length===12`);
    assert.deepEqual(await js(`window.pickerFixture.jobs[0].downloadFileIndexes`),Array.from({length:12},(_,index)=>index+12));
    await until(`window.pickerFixture.roomSelections.some(selection=>selection.status===200)`);
    const selectedMedia = await js(`window.pickerFixture.roomSelections.find(selection=>selection.status===200).media`);
    assert.equal(selectedMedia.fileIndex,12);
    assert.equal(selectedMedia.itemId,await js(`window.pickerFixture.jobs[0].id+'-f12'`),
      'A reused transfer must select the current room manifest item, including with older companions');
    await click('Manage files');
    await until(`document.querySelectorAll('.torrent-picker-file input:checked').length===12`);
    const report={ok:true,checks:['file chooser visible before metadata','loading dialog opens','no apply or payload selection while metadata missing','room manifest errors visible','48 files arrive in an open dialog with initialized selection','one season applies exactly 12 indexes','reused transfer selects the current room manifest identity','saved selection survives reopening'],logs};
    fs.writeFileSync(path.resolve('test-results/room-file-picker-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
    app.exit(0);
  } catch(error) {
    console.error(error.stack);console.error(logs.join('\n'));app.exit(1);
  }
});
