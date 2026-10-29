import { buildRelay } from './relay.js';

const integer = (name: string, fallback: number) => {
  const text = process.env[name];
  if (text === undefined) return fallback;
  if (!/^\d+$/.test(text)) throw new Error(`Invalid ${name}`);
  return Number(text);
};
const key = Buffer.from(process.env.WATCHPAIR_RELAY_SECRET ?? '', 'base64');
const app = await buildRelay(key, {
  ingressBytesPerSecond: integer('WATCHPAIR_RELAY_INGRESS_BPS', 0),
  egressBytesPerSecond: integer('WATCHPAIR_RELAY_EGRESS_BPS', 0),
  channelIngressBytesPerSecond: integer('WATCHPAIR_RELAY_CHANNEL_INGRESS_BPS', 0),
  channelEgressBytesPerSecond: integer('WATCHPAIR_RELAY_CHANNEL_EGRESS_BPS', 0),
  maximumBufferedBytes: integer('WATCHPAIR_RELAY_BUFFER_BYTES', 64 * 1024 * 1024),
  maximumChannels: integer('WATCHPAIR_RELAY_MAX_CHANNELS', 1024),
});
await app.listen({ host: process.env.WATCHPAIR_RELAY_HOST ?? '127.0.0.1',
  port: integer('WATCHPAIR_RELAY_PORT', 8788) });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => void app.close().then(() => process.exit(0)));
