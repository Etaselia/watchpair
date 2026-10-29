import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildServer } from '../src/server.js';
import { WebSocket } from 'ws';
const key = () => randomBytes(32).toString('base64url');
const headers = { 'x-watchpair-protocol': '2' };

test('HTTP boundary enforces protocol, input validation and membership before accepting shared commands', async t => {
  const { app } = await buildServer(); t.after(() => app.close()); await app.ready();
  const wrongVersion = await app.inject({ method: 'POST', url: '/v2/rooms', payload: {} });
  assert.equal(wrongVersion.statusCode, 426); assert.equal(wrongVersion.json().error.code, 'UPDATE_REQUIRED');
  const badInput = await app.inject({ method: 'POST', url: '/v2/rooms', headers, payload: { name: 'Test', memberName: 'Host', retryKey: key(), hostId: 'spoof' } });
  assert.equal(badInput.statusCode, 400);
  const created = await app.inject({ method: 'POST', url: '/v2/rooms', headers, payload: { name: 'Test', memberName: 'Host', retryKey: key() } });
  assert.equal(created.statusCode, 200); const room = created.json();
  const unauthorized = await app.inject({ method: 'GET', url: `/v2/rooms/${room.roomId}`, headers }); assert.equal(unauthorized.statusCode, 401);
  const inviteAsAuth = await app.inject({ method: 'GET', url: `/v2/rooms/${room.roomId}`, headers: { ...headers, authorization: `Bearer ${room.invite}` } }); assert.equal(inviteAsAuth.statusCode, 401);
  const auth = { ...headers, authorization: `Bearer ${room.token}` };
  const snapshot = await app.inject({ method: 'GET', url: `/v2/rooms/${room.roomId}`, headers: auth });
  assert.equal(snapshot.statusCode, 200); assert.equal(snapshot.json().hostId, room.memberId);
  assert.ok(!snapshot.body.includes(room.token)); assert.ok(!snapshot.body.includes(room.recovery));
  const renamed = await app.inject({ method: 'POST', url: `/v2/rooms/${room.roomId}/commands`, headers: auth,
    payload: { operationId: randomUUID(), command: { type: 'room.rename', name: 'Renamed' } } });
  assert.equal(renamed.statusCode, 200);
});

test('real WebSocket snapshots, heartbeat and credential revocation use authenticated connections', async t => {
  const { app, engine } = await buildServer(); let ws: WebSocket | undefined;
  t.after(async () => { ws?.terminate(); await app.close(); });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const room = engine.create('Socket room', 'Host', key());
  const messages: Record<string, unknown>[] = [];
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  ws = new WebSocket(`ws://127.0.0.1:${address.port}/v2/rooms/${room.roomId}/events`, { headers: { ...headers, authorization: `Bearer ${room.token}` } });
  ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
  await new Promise<void>((resolve, reject) => { ws!.once('open', resolve); ws!.once('error', reject); });
  await waitFor(() => messages.some(m => m.type === 'snapshot'));
  ws.send(JSON.stringify({ type: 'ping', clientTime: 123 })); await waitFor(() => messages.some(m => m.type === 'pong'));
  assert.equal(messages.find(m => m.type === 'pong')!.clientTime, 123);
  const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)));
  engine.recover(room.roomId, room.recovery, key());
  assert.equal(await closed, 4003);
});

async function waitFor(fn: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!fn() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fn(), 'Expected a WebSocket event before timeout');
}

test('large packs cross the actual HTTP boundary and browser invites keep capabilities in the fragment',async t=>{
  const {app,engine}=await buildServer();t.after(()=>app.close());
  const room=engine.create('Large pack','Host',key());
  const files=Array.from({length:10000},(_,i)=>({mediaId:`media:${i}`,path:`Season ${Math.floor(i/100)}/Episode ${i}.mkv`,label:`Episode ${i}`,fileIndex:i,size:1000000,duration:null,selected:true}));
  const result=await app.inject({method:'POST',url:`/v2/rooms/${room.roomId}/commands`,headers:{...headers,authorization:`Bearer ${room.token}`},
    payload:{operationId:randomUUID(),queueRevision:0,command:{type:'queue.add',source:{id:'torrent:pack',kind:'torrent',identity:'torrent:pack',label:'Pack',uri:'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},files}}});
  assert.equal(result.statusCode,200,result.body);assert.equal(engine.room(room.roomId).entries.length,10000);
  const landing=await app.inject(`/r/${room.roomId}`);assert.equal(landing.statusCode,200);
  assert.ok(landing.headers['content-security-policy']);assert.equal(landing.headers['referrer-policy'],'no-referrer');
  assert.ok(!landing.body.includes(room.token));assert.ok(!landing.body.includes(room.invite));assert.ok(landing.body.includes('location.hash'));
});
