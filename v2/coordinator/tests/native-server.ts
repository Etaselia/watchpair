// Local native-client integration fixture. The private control pipe only arms
// lost-response faults; it never accepts room operations or prints credentials.
import { createInterface } from 'node:readline';
import { buildServer } from '../src/server.js';
import { buildRelay } from '../src/relay.js';
import { randomBytes } from 'node:crypto';
const relayKey=randomBytes(32),relay=await buildRelay(relayKey);
await relay.listen({host:'127.0.0.1',port:0});
const relayAddress=relay.server.address();if(!relayAddress||typeof relayAddress==='string')throw new Error('No test relay');
let clockOffset=0;
const { app,engine } = await buildServer({ database: process.argv[2],now:()=>Date.now()+clockOffset,relayKey,relayUrl:`http://127.0.0.1:${relayAddress.port}` });
let dropPath: string | null = null;
app.addHook('onSend', async (request, reply, payload) => {
  if (request.method === 'POST' && dropPath && request.url.endsWith(dropPath)) {
    dropPath = null; reply.raw.destroy();
  }
  return payload;
});
await app.listen({ host: '127.0.0.1', port: Number(process.argv[3] ?? 0) });
const address = app.server.address();
if (!address || typeof address === 'string') throw new Error('No local test listener');
process.stdout.write(JSON.stringify({ port: address.port }) + '\n');
const input = createInterface({ input: process.stdin });
input.on('line', text => {
  const value = JSON.parse(text) as { dropPath?: string;advanceTimeMs?:number;inspectRoom?:string };
  if (value.dropPath === '/commands' || value.dropPath === '/v2/rooms') { dropPath = value.dropPath; process.stdout.write('{"armed":true}\n'); }
  if(typeof value.advanceTimeMs==='number'&&value.advanceTimeMs>0&&value.advanceTimeMs<=60000){clockOffset+=value.advanceTimeMs;engine.tick();process.stdout.write('{"advanced":true}\n');}
  if(value.inspectRoom) {const room=engine.room(value.inspectRoom);process.stdout.write(JSON.stringify({diagnostics:{entries:room.entries.map(e=>({duration:e.duration,watchedAt:e.watchedAt,coverage:e.coverage,seconds:e.coverage.reduce((n,[a,b])=>n+b-a,0)}))}})+'\n');}
});
const stop = async () => { input.close(); await app.close();await relay.close(); process.exit(0); };
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
