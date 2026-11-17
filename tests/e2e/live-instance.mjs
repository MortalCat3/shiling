/** Disposable real API + pg-boss worker. Never targets the development database. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createDatabase, runMigrations, TASK_NAMES } from '../../packages/backend/dist/index.js';

if (process.env['SHILING_E2E_RESET_TEST_DATABASE'] !== '1') {
  throw new Error(
    'Set SHILING_E2E_RESET_TEST_DATABASE=1 to reset the dedicated shiling_test schemas.',
  );
}
const databaseUrl =
  process.env['SHILING_TEST_DATABASE_URL'] ??
  'postgresql://shiling_test@127.0.0.1:5432/shiling_test';
const target = new URL(databaseUrl);
assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
assert.equal(decodeURIComponent(target.pathname), '/shiling_test');
assert.equal(decodeURIComponent(target.username), 'shiling_test');
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'shiling-live-e2e-'));
const credentialsPath = join(directory, 'credentials.json');
const children = [];
const logs = [];
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(
    children.map(async (child) => {
      for (let n = 0; n < 100 && child.exitCode === null && child.signalCode === null; n++)
        await delay(100);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }),
  );
  logs.forEach((stream) => stream.end());
  await rm(credentialsPath, { force: true });
  await rm(join(directory, 'browser-fixture.json'), { force: true });
  console.info(JSON.stringify({ event: 'live-e2e.stopped', credentialsRemoved: true }));
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

try {
  // Do not accidentally drive another instance already serving the browser proxy target.
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(3000, '127.0.0.1', () => probe.close(resolve));
  });
  const db = createDatabase({
    connectionString: databaseUrl,
    applicationName: 'shiling-live-e2e-setup',
    maxConnections: 1,
  });
  try {
    const current = await db.query(
      'SELECT current_database() AS db, current_user AS role, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser',
    );
    assert.deepEqual(current.rows[0], {
      db: 'shiling_test',
      role: 'shiling_test',
      superuser: false,
    });
    const clients = await db.query(
      'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
    );
    assert.equal(
      clients.rows[0].count,
      0,
      'Other test database clients are active; refusing reset.',
    );
    const owners = await db.query(
      "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname IN ('shiling','pgboss')",
    );
    assert.ok(
      owners.rows.every((row) => row.owner === 'shiling_test'),
      'Refusing schemas owned by another role.',
    );
    await db.query('DROP SCHEMA IF EXISTS shiling CASCADE');
    await db.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
    await db.query('CREATE SCHEMA shiling AUTHORIZATION shiling_test');
    await runMigrations(db);
  } finally {
    await db.close();
  }

  // Test-only queue bootstrap. Deployment owner/runtime role separation is tested separately.
  const require = createRequire(new URL('../../packages/backend/package.json', import.meta.url));
  const { PgBoss } = require('pg-boss');
  const boss = new PgBoss({
    connectionString: databaseUrl,
    schema: 'pgboss',
    schedule: false,
    supervise: false,
    registerInstance: false,
  });
  await boss.start();
  for (const name of Object.values(TASK_NAMES))
    await boss.createQueue(name, { retryLimit: 2, retryDelay: 1, expireInSeconds: 900 });
  await boss.stop();
  const password = `E2e-${randomBytes(24).toString('hex')}`;
  const setupToken = randomBytes(32).toString('hex');
  const env = {
    ...process.env,
    SHILING_DATABASE_URL: databaseUrl,
    SHILING_API_HOST: '127.0.0.1',
    SHILING_API_PORT: '3000',
    SHILING_APP_ORIGIN: 'http://127.0.0.1:5173',
    SHILING_PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
    SHILING_STORAGE_DRIVER: 'local',
    SHILING_LOCAL_STORAGE_ROOT: join(directory, 'storage'),
    SHILING_MEDIA_TEMP_ROOT: join(directory, 'media'),
    SHILING_SETUP_TOKEN: setupToken,
    SHILING_CSRF_SECRET: randomBytes(32).toString('hex'),
    SHILING_DELIVERY_SECRET: randomBytes(32).toString('hex'),
    SHILING_COOKIE_SECURE: 'false',
  };
  await mkdir(env.SHILING_MEDIA_TEMP_ROOT, { recursive: true });
  for (const service of ['api', 'worker']) {
    const log = createWriteStream(join(directory, `${service}.log`), { mode: 0o600 });
    logs.push(log);
    const child = spawn(process.execPath, [`apps/${service}/dist/index.js`], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on('error', () => {
      process.exitCode = 1;
      void stop();
    });
    child.on('exit', () => {
      if (!stopping) {
        process.exitCode = 1;
        void stop();
      }
    });
    children.push(child);
  }
  let ready = false;
  for (let n = 0; n < 100 && !stopping; n++) {
    ready = await fetch('http://127.0.0.1:3000/health/ready')
      .then((r) => r.ok)
      .catch(() => false);
    if (ready) break;
    await delay(200);
  }
  assert.ok(ready, 'API startup failed; inspect the temporary service logs.');
  await writeFile(
    credentialsPath,
    JSON.stringify({
      baseUrl: 'http://127.0.0.1:3000',
      origin: 'http://127.0.0.1:5173',
      loginName: 'admin',
      password,
      setupToken,
      directory,
      pid: process.pid,
    }),
    { mode: 0o600 },
  );
  console.info(
    JSON.stringify({ event: 'live-e2e.ready', credentialsPath, database: 'shiling_test' }),
  );
} catch (error) {
  await stop();
  throw error;
}
