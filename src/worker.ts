// Job worker without the HTTP API: interprets mail, fires deadline wake-ups, reconciles sends.
// Any number of these can share one Supabase database (set CONTINUITY_WORKER=off on API servers).
//   npm run worker
import { buildApp } from './server.ts';

const { engine, backend, shutdown } = await buildApp({ worker: true });
console.log(`[worker ${engine.workerId}] processing jobs from ${backend.mode} (${backend.target})`);

const stop = () => { void shutdown().finally(() => process.exit(0)); };
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
