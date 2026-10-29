import { buildServer } from './server.js';
process.umask(0o077);
const { app } = await buildServer({ database: process.env.WATCHPAIR_DATABASE ?? './data/watchpair-v2.sqlite', logger: true,
  trustProxy: process.env.WATCHPAIR_TRUST_PROXY === 'true',relayUrl:process.env.WATCHPAIR_RELAY_URL,
  relayKey:process.env.WATCHPAIR_RELAY_SECRET?Buffer.from(process.env.WATCHPAIR_RELAY_SECRET,'base64'):undefined });
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 8787) });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close(); });
