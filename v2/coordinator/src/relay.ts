import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Readable, Transform } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const ticketSchema = z.object({ v: z.literal(2), channel: z.string().regex(/^[a-f0-9]{64}$/),
  side: z.union([z.literal(0), z.literal(1)]), exp: z.number().int() }).strict();
type Ticket = z.infer<typeof ticketSchema>;
export function issueTicket(key: Buffer, room: string, own: string, peer: string, now = Date.now()) {
  const members = [own, peer].sort();
  const channel = createHash('sha256').update(JSON.stringify([room, ...members])).digest('hex');
  const body = Buffer.from(JSON.stringify({ v: 2, channel, side: members.indexOf(own),
    exp: Math.floor(now / 1000) + 60 })).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
export function verifyTicket(key: Buffer, value: string, now = Date.now()): Ticket {
  if (value.length > 1024) throw new Error('Invalid ticket');
  const parts = value.split('.');
  if (parts.length !== 2) throw new Error('Invalid ticket');
  const expected = createHmac('sha256', key).update(parts[0]!).digest();
  const actual = Buffer.from(parts[1]!, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Invalid ticket');
  const ticket = ticketSchema.parse(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()));
  if (ticket.exp <= Math.floor(now / 1000) || ticket.exp > Math.floor(now / 1000) + 65) throw new Error('Expired ticket');
  return ticket;
}

class Bucket {
  private tokens = 0;
  private at = performance.now();
  constructor(readonly rate: number) {}
  available(now: number) {
    if (!this.rate) return Number.POSITIVE_INFINITY;
    this.tokens = Math.min(Math.max(1, this.rate / 5), this.tokens + (now - this.at) * this.rate / 1000);
    this.at = now;
    return Math.floor(this.tokens);
  }
  spend(bytes: number) { if (this.rate) this.tokens -= bytes; }
}
type Waiting = { finish: (bytes: Buffer | null) => void };
type Channel = {
  frames: [Buffer | null, Buffer | null]; waiting: [Waiting | null, Waiting | null];
  receiving: [boolean, boolean]; delivering: [boolean, boolean]; until: number;
  ingress: Bucket; egress: Bucket;
};
export type RelayOptions = {
  ingressBytesPerSecond?: number; egressBytesPerSecond?: number;
  channelIngressBytesPerSecond?: number; channelEgressBytesPerSecond?: number;
  maximumBufferedBytes?: number; maximumChannels?: number;
};
export async function buildRelay(key: Buffer, options: RelayOptions = {}) {
  if (key.length < 32) throw new Error('Configure a relay signing key of at least 32 random bytes');
  const rates = [options.ingressBytesPerSecond ?? 0, options.egressBytesPerSecond ?? 0,
    options.channelIngressBytesPerSecond ?? 0, options.channelEgressBytesPerSecond ?? 0];
  if (rates.some(n => !Number.isSafeInteger(n) || n < 0 || n > 2 ** 30)) throw new Error('Invalid relay bandwidth limit');
  const maximum = options.maximumBufferedBytes ?? 64 * 1024 * 1024;
  const maximumChannels = options.maximumChannels ?? 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 2 * 1024 * 1024 || maximum > 512 * 1024 * 1024 ||
      !Number.isSafeInteger(maximumChannels) || maximumChannels < 1 || maximumChannels > 10000)
    throw new Error('Invalid relay capacity');
  // A slow authorized body may outlive its admission ticket. Validate the
  // ticket before reading it, bound its declared size, and enforce an idle
  // deadline instead of terminating legitimate low-bandwidth uploads at 20 s.
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, requestTimeout: 0 });
  app.server.maxConnections = 256;
  app.server.headersTimeout = 15000;
  const channels = new Map<string, Channel>();
  const tickets = new WeakMap<FastifyRequest, Ticket>();
  const reservations = new WeakMap<FastifyRequest, () => void>();
  const streams = new Set<Readable>();
  const ingress = new Bucket(rates[0]!), egress = new Bucket(rates[1]!);
  let buffered = 0, incoming = 0, closing = false;
  const channel = (ticket: Ticket) => {
    let current = channels.get(ticket.channel);
    if (!current) {
      if (channels.size >= maximumChannels) return null;
      current = { frames: [null, null], waiting: [null, null], receiving: [false, false],
        delivering: [false, false], until: ticket.exp * 1000,
        ingress: new Bucket(rates[2]!), egress: new Bucket(rates[3]!) };
      channels.set(ticket.channel, current);
    }
    current.until = Math.max(current.until, ticket.exp * 1000);
    return current;
  };
  const allowance = async (a: Bucket, b: Bucket, wanted: number, aborted: () => boolean) => {
    while (!closing && !aborted()) {
      const now = performance.now();
      const amount = Math.min(wanted, 16384, a.available(now), b.available(now));
      if (amount >= 1) { a.spend(amount); b.spend(amount); return amount; }
      await delay(10);
    }
    throw new Error('Transfer closed');
  };
  const deliver = (c: Channel, side: 0 | 1, reply: FastifyReply, bytes: Buffer, counted: boolean) => {
    if (!counted) buffered += bytes.length;
    c.delivering[side] = true;
    let released = false;
    const release = () => { if (released) return; released = true; buffered -= bytes.length; c.delivering[side] = false; };
    reply.raw.once('finish', release); reply.raw.once('close', release);
    reply.type('application/octet-stream');
    if (!rates[1] && !rates[3]) return reply.send(bytes);
    const output = Readable.from((async function* () {
      let at = 0;
      while (at < bytes.length) {
        const amount = await allowance(egress, c.egress, bytes.length - at, () => reply.raw.destroyed);
        yield bytes.subarray(at, at + amount); at += amount;
      }
    })());
    streams.add(output); output.once('close', () => streams.delete(output));
    return reply.send(output);
  };
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v2/relay/')) return;
    let ticket: Ticket;
    try {
      if (!request.headers.authorization?.startsWith('Bearer ')) throw new Error();
      ticket = verifyTicket(key, request.headers.authorization.slice(7));
    } catch { return reply.header('Connection', 'close').code(401).send({ error: 'Transfer ticket expired or invalid.' }); }
    if (closing) return reply.code(503).send();
    const c = channel(ticket);
    if (!c) return reply.code(503).send();
    tickets.set(request, ticket);
    if (request.method === 'POST') {
      const length = Number(request.headers['content-length']);
      if (request.headers['transfer-encoding'] || !Number.isSafeInteger(length) || length < 28 || length > 2 * 1024 * 1024)
        return reply.header('Connection', 'close').code(411).send();
      if (c.receiving[ticket.side] || incoming + buffered + length > maximum) return reply.code(429).send();
      incoming += length; c.receiving[ticket.side] = true;
      let released = false;
      const release = () => { if (released) return; released = true; incoming -= length; c.receiving[ticket.side] = false; };
      reservations.set(request, release); reply.raw.once('finish', release); reply.raw.once('close', release);
    }
  });
  app.addHook('preParsing', async (request, _reply, payload) => {
    const ticket = tickets.get(request);
    if (!ticket || request.method !== 'POST') return payload;
    const c = channels.get(ticket.channel)!;
    let idle: NodeJS.Timeout;
    const transform = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        idle.refresh(); transform.receivedEncodedLength += chunk.length;
        if (!rates[0] && !rates[2]) { done(null, chunk); return; }
        void (async () => {
          let at = 0;
          while (at < chunk.length) {
            const amount = await allowance(ingress, c.ingress, chunk.length - at, () => transform.destroyed);
            idle.refresh(); transform.push(chunk.subarray(at, at + amount)); at += amount;
          }
        })().then(() => done(), error => done(error as Error));
      },
    }) as Transform & { receivedEncodedLength: number };
    transform.receivedEncodedLength = 0;
    idle = setTimeout(() => { payload.destroy(new Error('Idle transfer')); transform.destroy(); }, 30000); idle.unref();
    transform.once('close', () => clearTimeout(idle)); transform.once('end', () => clearTimeout(idle));
    payload.once('error', error => transform.destroy(error));
    return payload.pipe(transform);
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.setErrorHandler((_error, _request, reply) => reply.code(400).send({ error: 'The relay request could not be accepted.' }));
  app.get('/health', async () => ({ ok: true, protocol: 2, bufferedBytes: buffered, incomingBytes: incoming }));
  app.post('/v2/relay/send', async (request, reply) => {
    const ticket = tickets.get(request)!;
    const c = channels.get(ticket.channel), bytes = request.body;
    if (!c || closing) return reply.code(503).send();
    if (!Buffer.isBuffer(bytes) || bytes.length < 28 || bytes.length > 2 * 1024 * 1024) return reply.code(400).send();
    const target = ticket.side === 0 ? 1 : 0;
    if (c.frames[target]) return reply.code(429).send();
    reservations.get(request)?.();
    if (c.waiting[target]) c.waiting[target]!.finish(bytes);
    else { c.frames[target] = bytes; buffered += bytes.length; }
    return reply.code(202).send();
  });
  app.get('/v2/relay/receive', async (request, reply) => {
    const ticket = tickets.get(request)!, c = channels.get(ticket.channel)!;
    if (closing) return reply.code(503).send();
    const side = ticket.side;
    if (c.delivering[side] || c.waiting[side]) return reply.code(409).send();
    const frame = c.frames[side];
    if (frame) { c.frames[side] = null; return deliver(c, side, reply, frame, true); }
    return await new Promise<FastifyReply>(resolve => {
      let finished = false;
      let timer: NodeJS.Timeout;
      const finish = (bytes: Buffer | null) => {
        if (finished) return;
        finished = true; clearTimeout(timer); c.waiting[side] = null; reply.raw.off('close', abort);
        resolve(bytes ? deliver(c, side, reply, bytes, false) : reply.code(204).send());
      };
      const abort = () => finish(null);
      timer = setTimeout(() => finish(null), 10000); timer.unref();
      c.waiting[side] = { finish }; reply.raw.once('close', abort);
    });
  });
  const sweep = setInterval(() => {
    for (const [id, c] of channels) if (c.until < Date.now() && !c.receiving.some(Boolean) && !c.delivering.some(Boolean)) {
      for (const wait of c.waiting) wait?.finish(null);
      for (const bytes of c.frames) buffered -= bytes?.length ?? 0;
      channels.delete(id);
    }
  }, 5000); sweep.unref();
  app.addHook('preClose', async () => {
    closing = true; clearInterval(sweep);
    for (const c of channels.values()) { for (const wait of c.waiting) wait?.finish(null); for (const bytes of c.frames) buffered -= bytes?.length ?? 0; }
    for (const stream of streams) stream.destroy(); channels.clear();
  });
  return app;
}
