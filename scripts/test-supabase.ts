// Runs the test suite against the LOCAL Supabase stack (supabase start). Connection details come from
// `supabase status -o env` and reach the tests through the environment; none of them are printed.
// Any database host that isn't local is refused, because these tests create and delete rows.
//
//   supabase start && supabase migration up --local && npm run test:supabase
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

let statusOutput = '';
try {
  statusOutput = execFileSync('supabase', ['status', '-o', 'env'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch {
  console.error('Local Supabase is not running. Start it with: supabase start && supabase migration up --local');
  process.exit(2);
}

const stack: Record<string, string> = {};
for (const line of statusOutput.split('\n')) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) stack[m[1]] = m[2];
}

const dbUrl = stack.DB_URL;
if (!dbUrl || !/@(127\.0\.0\.1|localhost)[:/]/.test(dbUrl)) {
  console.error('Refusing to run: DB_URL is not a local Supabase database.');
  process.exit(2);
}

const requested = process.argv.slice(2);
const files = requested.length ? requested : ['test/'];
const testArgs = files[0] === 'test/' ? ['test/*.test.ts'] : files;
const result = spawnSync(process.execPath, ['--test', ...testArgs], {
  cwd: repo,
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    CONTINUITY_TEST_DB_URL: dbUrl,
    CONTINUITY_TEST_SUPABASE_URL: stack.API_URL,
    CONTINUITY_TEST_SUPABASE_KEY: stack.SECRET_KEY || stack.SERVICE_ROLE_KEY,
    CONTINUITY_TEST_ANON_KEY: stack.PUBLISHABLE_KEY || stack.ANON_KEY,
  },
});
process.exit(result.status ?? 1);
