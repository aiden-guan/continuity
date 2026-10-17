// Choosing a store. Hosted operation uses Supabase Postgres; SQLite and memory are used only when asked
// for explicitly. A missing or broken Postgres configuration is an error, never a quiet fallback to a
// local file that would report success while losing shared state.
import type { Backend, StorageMode } from './backend.ts';

export class StorageConfigError extends Error {}

export interface StorageConfig {
  mode: StorageMode;
  /** Postgres connection string (never logged). */
  url?: string;
  /** SQLite file. */
  path?: string;
  /** Supabase Storage for the private attachment cache (postgres mode). */
  storage?: { url: string; key: string; bucket: string } | null;
  /** What selected this mode, for health output. */
  explicit: string;
}

const SELECTORS = ['postgres', 'supabase', 'sqlite', 'memory'];

export function storageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const selected = (env.CONTINUITY_STORE || '').trim().toLowerCase();
  const dbUrl = env.SUPABASE_DB_URL || env.CONTINUITY_DATABASE_URL || '';
  const storageKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  const storage = env.SUPABASE_URL && storageKey
    ? { url: env.SUPABASE_URL.replace(/\/$/, ''), key: storageKey, bucket: env.CONTINUITY_ATTACHMENT_BUCKET || 'continuity-attachments' }
    : null;

  if (selected && !SELECTORS.includes(selected)) {
    throw new StorageConfigError(`CONTINUITY_STORE=${selected} is not one of postgres | sqlite | memory`);
  }
  if (selected === 'postgres' || selected === 'supabase' || (!selected && dbUrl)) {
    if (!dbUrl) throw new StorageConfigError('CONTINUITY_STORE=postgres but SUPABASE_DB_URL is not set');
    return { mode: 'postgres', url: dbUrl, storage, explicit: selected ? `CONTINUITY_STORE=${selected}` : 'SUPABASE_DB_URL set' };
  }
  if (selected === 'sqlite' || (!selected && env.CONTINUITY_DB)) {
    return { mode: 'sqlite', path: env.CONTINUITY_DB || 'data/continuity.db', explicit: selected ? 'CONTINUITY_STORE=sqlite' : 'CONTINUITY_DB set (offline SQLite mode)' };
  }
  if (selected === 'memory') return { mode: 'memory', explicit: 'CONTINUITY_STORE=memory' };
  throw new StorageConfigError(
    'No storage configured. Hosted: set SUPABASE_DB_URL (see README "Supabase"). Offline: set CONTINUITY_STORE=sqlite (with CONTINUITY_DB=<file>) or CONTINUITY_STORE=memory.',
  );
}

export async function openBackend(cfg: StorageConfig): Promise<Backend> {
  let backend: Backend;
  if (cfg.mode === 'postgres') {
    const { PostgresBackend } = await import('./postgres.ts');
    backend = new PostgresBackend(cfg.url!, { storage: cfg.storage ?? null });
  } else if (cfg.mode === 'sqlite') {
    const { SqliteBackend } = await import('./sqlite.ts');
    backend = new SqliteBackend(cfg.path!);
  } else {
    const { MemoryBackend } = await import('./memory-backend.ts');
    backend = new MemoryBackend();
  }
  await backend.init(); // throws when the database is unreachable or the schema is missing
  return backend;
}

/** protocol://host:port/db, without credentials. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}
