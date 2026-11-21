// Local native-client integration fixture. The private control pipe only arms
// lost-response faults; it never accepts room operations or prints credentials.
import { createInterface } from 'node:readline';
import { buildServer } from '../src/server.js';
import { buildRelay } from '../src/relay.js';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as createTcpServer, connect as connectTcp, type Socket } from 'node:net';
import { SeriesProviderError, verifySeriesMetainfo, type SeriesCatalog, type SeriesListing, type SeriesProvider } from '../src/series-provider.js';

function seriesFixture(): SeriesProvider {
  const catalog: SeriesCatalog = { id: 101, title: 'Test Anime', status: 'currently_airing', episodeCount: 12,
    broadcastDayJapan: null, broadcastTimeJapan: null };
  const releases = new Map<number, { listing: SeriesListing; bytes: Buffer }>();
  for (const [id, title, uploader] of [
    [100, '[Origin] Test Anime - 07 (1080p)', 'Original'],
    [101, '[Other] Test Anime - 08 (1080p)', 'Alternative'],
  ] as const) {
    const name = title + '.mkv';
    const info = Buffer.concat([Buffer.from('d6:lengthi123e4:name' + Buffer.byteLength(name) + ':' + name + '12:piece lengthi16384e6:pieces20:'),
      Buffer.alloc(20, id), Buffer.from('e')]);
    const listing = { id, title, uploader, publishedAt: Date.now() - 60_000, infoHash: createHash('sha1').update(info).digest('hex') };
    releases.set(id, { listing, bytes: Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]) });
  }
  const get = (id: number) => {
    const release = releases.get(id);
    if (!release) throw new SeriesProviderError('No fixture release', 404);
    return release;
  };
  return {
    searchCatalog: async () => [catalog],
    catalog: async () => catalog,
    season: async () => [catalog],
    searchReleases: async (_query, uploader) => [...releases.values()].map(record => record.listing)
      .filter(listing => !uploader || listing.uploader === uploader),
    listing: async id => get(id).listing,
    metadata: async listing => verifySeriesMetainfo(get(listing.id).bytes, listing),
  };
}

const relayKey=randomBytes(32),relay=await buildRelay(relayKey);
await relay.listen({host:'127.0.0.1',port:0});
const relayAddress=relay.server.address();if(!relayAddress||typeof relayAddress==='string')throw new Error('No test relay');
let clockOffset=0;
const { app,engine,series } = await buildServer({ database: process.argv[2], now: () => Date.now() + clockOffset, relayKey,
  relayUrl: 'http://127.0.0.1:' + relayAddress.port,
  ...(process.argv.includes('--series-fixture') ? { seriesProvider: seriesFixture(), seriesTimer: false } : {}) });
// Test-only direct-route faults retain actual encrypted TCP transfers. The
// production coordinator neither proxies direct bytes nor exposes this pipe.
const directSockets = new Set<Socket>();
const watchSocket = (socket: Socket) => {
  directSockets.add(socket); socket.setTimeout(4000, () => socket.destroy());
  socket.on('error', () => socket.destroy()); socket.on('close', () => directSockets.delete(socket));
};
const blackhole = createTcpServer(socket => { watchSocket(socket); socket.on('data', () => {}); });
await new Promise<void>(accept => blackhole.listen(0, '127.0.0.1', accept));
const blackholeAddress = blackhole.address();
if (!blackholeAddress || typeof blackholeAddress === 'string') throw new Error('No direct fault listener');
type HeldDirect = { socket: Socket; bytes: Buffer; address: string; port: number; from: string };
const heldDirect = new Map<string, HeldDirect[]>();
const simultaneous = createTcpServer(socket => {
  watchSocket(socket); let bytes = Buffer.alloc(0);
  const receive = (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > 4096) { socket.destroy(); return; }
    if (bytes.length < 4) return;
    const size = bytes.readUInt32BE(0);
    if (size < 2 || size > 1024) { socket.destroy(); return; }
    if (bytes.length < size + 4) return;
    try {
      const hello = JSON.parse(bytes.subarray(4, size + 4).toString()) as {room:string;from:string;to:string};
      const target = engine.room(hello.room).members.find(member => member.id === hello.to)?.endpoint;
      if (!target) { socket.destroy(); return; }
      const key = JSON.stringify([hello.room, ...[hello.from, hello.to].sort()]);
      const held = (heldDirect.get(key) ?? []).filter(peer => !peer.socket.destroyed);
      if (held.some(peer => peer.from === hello.from)) { socket.destroy(); return; }
      held.push({ socket, bytes, address:target.address, port:target.port, from:hello.from });
      socket.off('data', receive); socket.pause(); heldDirect.set(key, held);
      if (held.length < 2) return;
      heldDirect.delete(key);
      for (const peer of held) {
        const canonical = peer.from === [hello.from, hello.to].sort()[0];
        const destination = connectTcp({host:peer.address,port:peer.port}); watchSocket(destination);
        destination.on('error', () => peer.socket.destroy());
        destination.on('close', () => peer.socket.destroy());
        // Keep the alternative looking connected after its remote endpoint
        // closes, while the canonical return hello crosses a slower route.
        // A timer alone must not promote that stale alternative.
        peer.socket.on('close', () => {
          if (canonical) destination.destroy();
          else setTimeout(() => destination.destroy(), 1100);
        });
        destination.once('connect', () => {
          const start = () => {
            if (peer.socket.destroyed || destination.destroyed) return;
            destination.write(peer.bytes);
            peer.socket.pipe(destination, {end:canonical});
            peer.socket.setTimeout(0); destination.setTimeout(0); peer.socket.resume();
          };
          if (canonical) {
            destination.once('data', bytes => {
              destination.pause();
              setTimeout(() => {
                if (peer.socket.destroyed || destination.destroyed) return;
                peer.socket.write(bytes); destination.pipe(peer.socket); destination.resume();
              }, 750);
            });
            // Let the alternate encrypted hello arrive before canonical input.
            setTimeout(start, 100);
          } else {
            destination.pipe(peer.socket); start();
          }
        });
      }
    } catch { socket.destroy(); }
  };
  socket.on('data', receive);
});
await new Promise<void>(accept => simultaneous.listen(0, '127.0.0.1', accept));
const simultaneousAddress = simultaneous.address();
if (!simultaneousAddress || typeof simultaneousAddress === 'string') throw new Error('No simultaneous direct listener');
let dropPath: string | null = null;
let directFault = 'none';
app.addHook('onSend', async (request, reply, payload) => {
  if (request.method === 'POST' && dropPath && request.url.endsWith(dropPath)) {
    dropPath = null; reply.raw.destroy();
  }
  if (directFault !== 'none' && request.url.endsWith('/transfer-ticket') && typeof payload === 'string') {
    const ticket = JSON.parse(payload) as Record<string, unknown>;
    if ('peerEndpoint' in ticket) {
      if (directFault === 'blocked') ticket.peerEndpoint = { address: '127.0.0.1', port: 1 };
      if (directFault === 'simultaneous') ticket.peerEndpoint = { address: '127.0.0.1', port: simultaneousAddress.port };
      if (directFault === 'oneway') {
        const { roomId } = request.params as { roomId: string };
        const { peerId } = request.body as { peerId: string };
        const member = engine.authenticate(roomId, (request.headers.authorization ?? '').slice(7));
        if (member.id < peerId) ticket.peerEndpoint = { address:'127.0.0.1',port:blackholeAddress.port };
        else await new Promise(accept => setTimeout(accept, 1800));
      }
      return JSON.stringify(ticket);
    }
  }
  return payload;
});
await app.listen({ host: '127.0.0.1', port: Number(process.argv[3] ?? 0) });
const address = app.server.address();
if (!address || typeof address === 'string') throw new Error('No local test listener');
process.stdout.write(JSON.stringify({ port: address.port }) + '\n');
const input = createInterface({ input: process.stdin });
input.on('line', text => {
  const value = JSON.parse(text) as { dropPath?: string;advanceTimeMs?:number;inspectRoom?:string;directFault?:string;runSeries?:boolean };
  if (['none','blocked','oneway','simultaneous'].includes(value.directFault ?? '')) { directFault = value.directFault!; process.stdout.write(JSON.stringify({directFault})+'\n'); }
  if (value.dropPath === '/commands' || value.dropPath === '/v2/rooms') { dropPath = value.dropPath; process.stdout.write('{"armed":true}\n'); }
  if(typeof value.advanceTimeMs==='number'&&value.advanceTimeMs>0&&value.advanceTimeMs<=60000){clockOffset+=value.advanceTimeMs;engine.tick();process.stdout.write('{"advanced":true}\n');}
  if(value.inspectRoom) {const room=engine.room(value.inspectRoom);process.stdout.write(JSON.stringify({diagnostics:{entries:room.entries.map(e=>({duration:e.duration,watchedAt:e.watchedAt,coverage:e.coverage,seconds:e.coverage.reduce((n,[a,b])=>n+b-a,0)}))}})+'\n');}
  if (value.runSeries && series) void series.runOnce().then(
    () => process.stdout.write('{"seriesChecked":true}\n'),
    () => process.stdout.write('{"seriesChecked":false}\n'));
});
const stop = async () => { input.close();for(const socket of directSockets)socket.destroy();blackhole.close();simultaneous.close();await app.close();await relay.close(); process.exit(0); };
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
