import Fastify, { LogController, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { WebSocket } from 'ws';
import { z, ZodError } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { issueTicket } from './relay.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { PROTOCOL, DomainError, socketMessageSchema, type Change } from './protocol.js';

const name = z.string().trim().min(1).max(100).refine(v => !/[\x00-\x1f\x7f]/.test(v));
const VERSION = '2.0.0-alpha.5';
const capability = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const createBody = z.object({ name, memberName: name, retryKey: capability }).strict();
const joinBody = z.object({ invite: capability, name, retryKey: capability }).strict();
const recoveryBody = z.object({ recovery: capability, retryKey: capability }).strict();
type Socket = { ws: WebSocket; roomId: string; memberId: string; token: string; connectionId: string };
export type ServerOptions = { database?: string; now?: () => number; logger?: boolean; trustProxy?: boolean; relayUrl?:string; relayKey?:Buffer };

export async function buildServer(options: ServerOptions = {}) {
  if (Boolean(options.relayUrl) !== Boolean(options.relayKey) ||
      (options.relayKey && options.relayKey.length < 32))
    throw new Error('Configure both WATCHPAIR_RELAY_URL and a relay secret of at least 32 random bytes');
  if (options.relayUrl) {
    const relay = new URL(options.relayUrl);
    if ((relay.protocol !== 'https:' && !(relay.protocol === 'http:' &&
        ['127.0.0.1', '[::1]', 'localhost'].includes(relay.hostname))) || relay.username || relay.password ||
        relay.search || relay.hash || relay.pathname !== '/')
      throw new Error('Use an HTTPS relay origin, or loopback HTTP for local testing');
  }
  const epoch = Date.now() - performance.now();
  const store = new Store(options.database ?? ':memory:');
  const engine = new Engine(store, options.now ?? (() => Math.trunc(epoch + performance.now())));
  const app = Fastify({
    logger: options.logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] } : false,
    logController: new LogController({ disableRequestLogging: true }), bodyLimit: 12 * 1024 * 1024, requestTimeout: 20_000,
    trustProxy: options.trustProxy ?? false, genReqId: () => randomUUID(),
  });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  const sockets = new Set<Socket>();
  let closing = false;
  const send = (ws: WebSocket, value: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013, 'Reconnect for a fresh snapshot'); return; }
    ws.send(JSON.stringify(value));
  };
  const token = (request: FastifyRequest) => {
    const value = request.headers.authorization;
    if (!value?.startsWith('Bearer ') || !/^[A-Za-z0-9_-]{43}$/.test(value.slice(7)))
      throw new DomainError('UNAUTHORIZED', 'Open your saved room or use a valid invite.', 401);
    return value.slice(7);
  };
  const roomId = (request: FastifyRequest) => (request.params as { roomId: string }).roomId;
  const auth = (request: FastifyRequest) => engine.authenticate(roomId(request), token(request));
  app.addHook('onRequest', async request => {
    if (request.url.startsWith('/v2/') && request.headers['x-watchpair-protocol'] !== String(PROTOCOL))
      throw new DomainError('UPDATE_REQUIRED', 'This coordinator requires WatchPair protocol 2. Update the desktop app.', 426);
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: { code: error.code, message: error.message }, requestId: request.id });
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Check the request fields.', fields: error.issues.slice(0, 8).map(i => ({ path: i.path.join('.'), message: i.message })) }, requestId: request.id });
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: { code: status === 429 ? 'RATE_LIMITED' : 'INVALID_REQUEST', message: status === 429 ? 'Too many requests. Try again shortly.' : 'The request could not be accepted.' }, requestId: request.id });
    app.log.error({ err: error, requestId: request.id }, 'Coordinator operation failed');
    return reply.code(503).send({ error: { code: 'STORAGE_UNAVAILABLE', message: 'The coordinator could not safely save this change. Try again after service recovery.' }, requestId: request.id });
  });
  app.get('/health', async () => ({ ok: true, protocol: PROTOCOL, version: VERSION }));
  app.get('/r/:roomId', async (request, reply) => {
    const id = z.string().uuid().parse((request.params as {roomId:string}).roomId);
    const nonce = randomBytes(24).toString('base64');
    return reply.type('text/html; charset=utf-8').header('Cache-Control','no-store')
      .header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff')
      .header('Content-Security-Policy',`default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`)
      .send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join WatchPair</title>
      <style nonce="${nonce}">:root{color-scheme:dark;font:17px system-ui;background:#0c1421;color:#dce8fa}body{max-width:620px;margin:12vh auto;padding:24px}h1{font-size:40px}p{line-height:1.6;color:#a8bdd8}a,button{display:inline-block;background:#5285cf;color:white;padding:14px 20px;border:0;border-radius:8px;font:inherit;text-decoration:none;cursor:pointer;margin:8px 8px 8px 0}input{width:100%;box-sizing:border-box;background:#14233a;border:1px solid #36506e;color:#dce8fa;padding:12px;border-radius:6px}small{color:#8ba4c5}#open{display:none}</style>
      <h1>Make room for a good watch.</h1><p id="message">Open this private invite in the WatchPair desktop app. Each person keeps their own video copy.</p>
      <a id="open">Open WatchPair</a><a href="/downloads/">Get the desktop app</a><p>Already installed? You can also paste this link into Join room.</p><input id="link" readonly aria-label="Private room link"><button id="copy">Copy link</button><p><small>The private part of this link stays in your browser. Share recovery links only with the room owner.</small></p>
      <script nonce="${nonce}">const fragment=location.hash.slice(1);const match=/^(invite|recovery)=([A-Za-z0-9_-]{43})$/.exec(fragment);const input=document.getElementById('link');input.value=location.href;if(match){const a=document.getElementById('open');a.href='watchpair://room?server='+encodeURIComponent(location.origin)+'&room=${id}#'+fragment;a.style.display='inline-block';if(match[1]==='recovery')document.getElementById('message').textContent='This private recovery link restores host control. Open it only on a device you trust.';}else document.getElementById('message').textContent='This link is incomplete. Ask the host for the full invite, including the private part after #.';document.getElementById('copy').onclick=async()=>{try{await navigator.clipboard.writeText(input.value);document.getElementById('copy').textContent='Copied';}catch{input.select();}};</script></html>`);
  });
  app.get('/v2/version', async () => ({ protocol: PROTOCOL, version: VERSION, operationRetryWindow: 10_000 }));
  app.post('/v2/rooms', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const body = createBody.parse(request.body); return engine.create(body.name, body.memberName, body.retryKey);
  });
  app.post('/v2/rooms/:roomId/join', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
    const body = joinBody.parse(request.body); return engine.join(roomId(request), body.invite, body.name, body.retryKey);
  });
  app.post('/v2/rooms/:roomId/recover', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const body = recoveryBody.parse(request.body); return engine.recover(roomId(request), body.recovery, body.retryKey);
  });
  app.get('/v2/rooms/:roomId', async request => { auth(request); return engine.snapshot(roomId(request)); });
  app.post('/v2/rooms/:roomId/commands', async request => engine.command(roomId(request), auth(request).id, request.body));
  app.post('/v2/rooms/:roomId/transfer-ticket',async request=>{
    const member=auth(request),id=roomId(request);
    const body=z.object({peerId:z.string().uuid(),listenPort:z.number().int().min(0).max(65535)}).strict().parse(request.body);
    const peer=engine.room(id).members.find(m=>m.id===body.peerId);
    if(!peer||peer.id===member.id||!member.publicKey||!peer.publicKey)throw new DomainError('PEER_NOT_READY','Wait for both devices to initialize private sharing.');
    engine.advertise(id,member.id,request.ip.replace(/^::ffff:/,''),body.listenPort);
    return {relayUrl:options.relayUrl??null,ticket:options.relayKey?issueTicket(options.relayKey,id,member.id,peer.id):null,
      expiresAt:Date.now()+60_000,peerEndpoint:peer.live?peer.endpoint??null:null,peerPublicKey:peer.publicKey};
  });
  app.get('/v2/rooms/:roomId/history', async request => {
    auth(request);
    const query = z.object({ beforeTime: z.coerce.number().int().min(0).optional(), beforeId: z.string().uuid().optional(), search: z.string().trim().max(200).optional() }).strict().parse(request.query);
    if ((query.beforeTime === undefined) !== (query.beforeId === undefined)) throw new DomainError('INVALID_CURSOR', 'Supply both history cursor fields.', 400);
    return { items: store.history(roomId(request), query.beforeTime !== undefined ? { time: query.beforeTime, id: query.beforeId! } : null, 200, query.search) };
  });
  app.get('/v2/rooms/:roomId/events', { websocket: true, preValidation: async request => { auth(request); } }, (ws, request) => {
    const id = roomId(request), credential = token(request), memberId = auth(request).id;
    const connectionId = engine.connect(id, memberId);
    for (const old of sockets) if (old.roomId === id && old.memberId === memberId) old.ws.close(4001, 'Connected from another session');
    const connection: Socket = { ws, roomId: id, memberId, token: credential, connectionId }; sockets.add(connection);
    let windowAt = engine.now(), messages = 0;
    ws.on('message', bytes => {
      try {
        if (engine.now() - windowAt >= 1000) { windowAt = engine.now(); messages = 0; }
        if (++messages > 20) { ws.close(1013, 'Status rate limit exceeded'); return; }
        engine.authenticate(id, credential);
        const message = socketMessageSchema.parse(JSON.parse(bytes.toString()));
        if (message.type === 'ping') {
          engine.ping(id, memberId, connectionId); send(ws, { type: 'pong', clientTime: message.clientTime, serverTime: engine.now() });
        } else engine.status(id, memberId, connectionId, message);
      } catch (error) {
        if(error instanceof DomainError&&error.code==='CONNECTION_REPLACED'){
          const live=engine.room(id).members.find(m=>m.id===memberId)?.live;
          ws.close(live?4001:1012,live?'Connected from another session':'Live session expired; reconnect');return;
        }
        if(error instanceof DomainError&&error.code==='ROOM_NOT_FOUND'){ws.close(4004,'Room deleted');return;}
        if (error instanceof DomainError && error.status === 401) { ws.close(4003, 'Room access revoked'); return; }
        send(ws, { type: 'error', error: { code: error instanceof DomainError ? error.code : 'INVALID_STATUS', message: error instanceof DomainError ? error.message : 'Send a valid version 2 status message.' } });
      }
    });
    ws.on('close', () => {
      sockets.delete(connection);
      if (closing) return;
      try { engine.disconnect(id, memberId, connectionId); } catch (error) { app.log.error({ err: error }, 'Could not checkpoint a disconnection'); }
    });
    ws.on('error', () => ws.close());
    send(ws, { type: 'snapshot', revision: engine.room(id).revision, data: engine.snapshot(id) });
  });
  const change = (event: Change) => {
    for (const connection of sockets) if (connection.roomId === event.roomId) {
      if (event.type === 'deleted') { send(connection.ws, event); connection.ws.close(4004, 'Room deleted'); continue; }
      try { engine.authenticate(event.roomId, connection.token); }
      catch { connection.ws.close(4003, 'Room access revoked'); continue; }
      send(connection.ws, event);
    }
  };
  engine.on('change', change);
  const timer = setInterval(() => { try { engine.tick(); } catch (error) { app.log.error({ err: error }, 'Room checkpoint failed'); } }, 500);
  timer.unref();
  app.addHook('onClose', async () => {
    closing = true; clearInterval(timer); engine.off('change', change);
    try {
      for (const connection of sockets) {
        engine.disconnect(connection.roomId, connection.memberId, connection.connectionId);
        connection.ws.terminate();
      }
      sockets.clear(); engine.tick();
    } finally { store.close(); }
  });
  return { app, engine, store };
}
