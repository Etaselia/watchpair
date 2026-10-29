import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(new URL('../coordinator/package.json', import.meta.url));
const { WebSocket } = require('ws');
const [base, statePath, phase = 'create'] = process.argv.slice(2);
if (!base || !statePath || !['create', 'verify'].includes(phase)) throw new Error('Pass base URL, private state path and create/verify');
const headers = { 'x-watchpair-protocol': '2' };
async function request(path, credential, body) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(credential ? { authorization: `Bearer ${credential.token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, `Unexpected HTTP status for ${path}`);
  return response.json();
}
const retryKey = () => randomBytes(32).toString('base64url');
let health;
for (let attempt = 0; attempt < 20; ++attempt) {
  try { health = await request('/health'); break; }
  catch (error) {
    if (attempt === 19) throw error;
    // A fresh local CA can be a second ahead of the Windows host clock.
    // Wait for validity and service readiness; TLS verification stays enabled.
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
assert.equal(health.protocol, 2);
if (phase === 'verify') {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const snapshot = await request(`/v2/rooms/${state.host.roomId}`, state.host);
  assert.equal(snapshot.name, 'Container backup verified');
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.history.length, 1);
  assert.equal(snapshot.entries[0].watchedAt, snapshot.history[0].watchedAt);
  await request(`/v2/rooms/${state.host.roomId}`, state.guest);
  console.log('PASS: restored host/guest authority, queue, watched timestamp and history through verified TLS');
} else {
  const host = await request('/v2/rooms', null, { name: 'Container smoke', memberName: 'Host', retryKey: retryKey() });
  const guest = await request(`/v2/rooms/${host.roomId}/join`, null, { invite: host.invite, name: 'Guest', retryKey: retryKey() });
  const sockets = [];
  try {
    for (const credential of [host, guest]) {
      const ws = new WebSocket(base.replace(/^http/, 'ws') + `/v2/rooms/${host.roomId}/events`,
        { headers: { ...headers, authorization: `Bearer ${credential.token}` } });
      sockets.push(ws);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket snapshot timeout')), 5000);
        ws.once('error', reject);
        ws.on('message', data => {
          if (JSON.parse(data.toString()).type === 'snapshot') { clearTimeout(timer); resolve(); }
        });
      });
      const publicKey = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
      await request(`/v2/rooms/${host.roomId}/commands`, credential,
        { operationId: randomUUID(), command: { type: 'member.key', publicKey } });
    }
    await request(`/v2/rooms/${host.roomId}/commands`, host, { operationId: randomUUID(), queueRevision: 0,
      command: { type: 'queue.add', source: { id: 'torrent:smoke', kind: 'torrent', identity: 'torrent:smoke',
        label: 'Smoke fixture', uri: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      files: [{ mediaId: 'media:smoke', path: 'Season 1/E01.mkv', label: 'Smoke episode', fileIndex: 0,
        size: 1024, duration: 600, selected: true }] } });
    const snapshot = await request(`/v2/rooms/${host.roomId}`, host);
    await request(`/v2/rooms/${host.roomId}/commands`, guest, { operationId: randomUUID(), queueRevision: snapshot.queueRevision,
      command: { type: 'history.mark', ids: [snapshot.entries[0].id], watched: true } });
    await request(`/v2/rooms/${host.roomId}/commands`, host, { operationId: randomUUID(),
      command: { type: 'room.rename', name: 'Container backup verified' } });
    const a = await request(`/v2/rooms/${host.roomId}/transfer-ticket`, host, { peerId: guest.memberId, listenPort: 0 });
    const b = await request(`/v2/rooms/${host.roomId}/transfer-ticket`, guest, { peerId: host.memberId, listenPort: 0 });
    const frame = randomBytes(64);
    const sent = await fetch(base + '/v2/relay/send', { method: 'POST', headers: {
      authorization: `Bearer ${a.ticket}`, 'content-type': 'application/octet-stream' }, body: frame,
      signal: AbortSignal.timeout(5000) });
    assert.equal(sent.status, 202);
    const received = await fetch(base + '/v2/relay/receive', { headers: { authorization: `Bearer ${b.ticket}` }, signal: AbortSignal.timeout(5000) });
    assert.equal(received.status, 200);
    assert.deepEqual(Buffer.from(await received.arrayBuffer()), frame);
    writeFileSync(statePath, JSON.stringify({ host, guest }), { mode: 0o600, flag: 'wx' });
    console.log('PASS: verified TLS, HTTP authority, WebSocket snapshots, shared queue/history and separate relay container');
  } finally { for (const socket of sockets) socket.terminate(); }
}
