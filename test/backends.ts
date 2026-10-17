// Shared backend matrix for the store-agnostic suites.
//
// The in-memory backend is always exercised. A real Supabase Postgres database joins the matrix
// only when CONTINUITY_TEST_DB_URL points at one (`npm run test:supabase` fills it in from
// `supabase status`). Tests isolate themselves by org id, so nothing has to be reset between runs.
import { randomBytes } from 'node:crypto';
import { MemoryBackend } from '../src/store/memory-backend.ts';
import type { Backend } from '../src/store/backend.ts';

export interface BackendCase {
  name: string;
  make: () => Promise<Backend>;
}

const env = process.env;

export const PG_URL = env.CONTINUITY_TEST_DB_URL || '';

// Attachment storage is optional on top of Postgres and needs both the project URL and a key.
const storageUrl = env.CONTINUITY_TEST_SUPABASE_URL;
const storageKey = env.CONTINUITY_TEST_SUPABASE_KEY;
export const STORAGE = storageUrl && storageKey
  ? { url: storageUrl, key: storageKey, bucket: 'continuity-attachments' }
  : null;

// Every Postgres backend we open is remembered so the suite can shut the pools down at the end.
const liveBackends: Backend[] = [];

export async function pg(opts: { storage?: boolean } = {}): Promise<Backend> {
  // Imported lazily so the memory-only run never loads the Postgres driver.
  const { PostgresBackend } = await import('../src/store/postgres.ts');
  const backend = new PostgresBackend(PG_URL, { storage: opts.storage ? STORAGE : null, max: 4 });
  await backend.init();
  liveBackends.push(backend);
  return backend;
}

export async function closeAll() {
  const toClose = liveBackends.splice(0);
  await Promise.all(toClose.map((backend) => backend.close()));
}

export function backendCases(): BackendCase[] {
  const cases: BackendCase[] = [{ name: 'memory', make: async () => new MemoryBackend() }];
  if (PG_URL) {
    cases.push({ name: 'postgres', make: () => pg() });
  } else if (!env.CONTINUITY_QUIET_SKIP) {
    console.log('# Supabase Postgres cases skipped: CONTINUITY_TEST_DB_URL not set (npm run test:supabase)');
  }
  return cases;
}

// An org id nobody else will pick: prefix, a base-36 timestamp, then six random hex characters.
export const uniqueOrg = (prefix: string) =>
  `org_${prefix}_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
