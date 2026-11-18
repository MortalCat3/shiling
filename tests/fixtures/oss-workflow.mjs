/** Formal API + worker + PostgreSQL, with either an OSS protocol fixture or explicitly authorized OSS. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDatabase,
  createStorage,
  readStorageConfig,
  runMigrations,
  TASK_NAMES,
  exportStorageBackup,
  restoreStorageBackup,
  assertStorageBinding,
} from '../../packages/backend/dist/index.js';
import { readApiConfig } from '../../apps/api/dist/config.js';
import { createApiRuntime } from '../../apps/api/dist/runtime.js';
import { createApi } from '../../apps/api/dist/app.js';
import { readWorkerConfig } from '../../apps/worker/dist/config.js';
import { createWorkerRuntime } from '../../apps/worker/dist/app.js';
import { createOssProtocolFixture } from './oss-protocol-server.mjs';

function command(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', () => reject(new Error(`${file} could not start.`)));
    child.once('close', (code) => {
      if (code === 0) resolve(output);
      else
        reject(
          new Error(`${file} failed with code ${code}.`, {
            cause:
              file === process.execPath
                ? output
                : output
                    .split('\n')
                    .filter((line) => /^pg_restore: error:/.test(line))
                    .join('\n'),
          }),
        );
    });
  });
}

export async function runOssWorkflow({ real = false } = {}) {
  const databaseUrl = process.env['SHILING_TEST_DATABASE_URL'];
  assert.ok(databaseUrl, 'Explicit SHILING_TEST_DATABASE_URL is required.');
  const target = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.equal(target.pathname, '/shiling_test');
  assert.equal(target.username, 'shiling_test');
  if (real) {
    assert.equal(
      process.env['SHILING_OSS_ACCEPTANCE'],
      '1',
      'Real OSS writes require SHILING_OSS_ACCEPTANCE=1.',
    );
    assert.equal(process.env['SHILING_STORAGE_DRIVER'], 'oss');
  }
  const directory = await mkdtemp(join(tmpdir(), 'shiling-oss-workflow-'));
  const id = randomBytes(5).toString('hex');
  const protocol = real ? undefined : await createOssProtocolFixture(join(directory, 'tmp'));
  const baseStorageConfig = real ? readStorageConfig(process.env) : undefined;
  const sourceConfig = real
    ? readStorageConfig({
        ...process.env,
        SHILING_OSS_PREFIX: `${baseStorageConfig.prefix}acceptance-${id}/source/`,
        SHILING_OSS_TEMP_ROOT: join(directory, 'source-tmp'),
      })
    : undefined;
  const destinationConfig = real
    ? readStorageConfig({
        ...process.env,
        SHILING_OSS_PREFIX: `${baseStorageConfig.prefix}acceptance-${id}/restored/`,
        SHILING_OSS_TEMP_ROOT: join(directory, 'restored-tmp'),
      })
    : undefined;
  let app, worker, database;
  const makeDb = () =>
    createDatabase({
      connectionString: databaseUrl,
      applicationName: 'shiling-oss-workflow',
      maxConnections: 1,
    });
  const sourceStorage = real
    ? await createStorage(sourceConfig)
    : await protocol.storage('source/');
  const restoredStorage = real
    ? await createStorage(destinationConfig)
    : await protocol.storage('restored/');
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    SHILING_DATABASE_URL: databaseUrl,
    SHILING_STORAGE_DRIVER: 'local',
    SHILING_API_PORT: String(port),
    SHILING_API_HOST: '127.0.0.1',
    SHILING_APP_ORIGIN: base,
    SHILING_PUBLIC_ORIGIN: base,
    SHILING_PREVIEW_ORIGIN: 'http://preview.localhost:3001',
    SHILING_LOCAL_STORAGE_ROOT: join(directory, 'unused-local'),
    SHILING_MEDIA_TEMP_ROOT: join(directory, 'media'),
    SHILING_COOKIE_SECURE: 'false',
    SHILING_SETUP_TOKEN: randomBytes(32).toString('hex'),
    SHILING_CSRF_SECRET: randomBytes(32).toString('hex'),
    SHILING_DELIVERY_SECRET: randomBytes(32).toString('hex'),
    SHILING_DELIVERY_GRANT_TTL_SECONDS: '600',
    SHILING_LOG_LEVEL: 'silent',
    SHILING_VERIFY_CONCURRENCY: '2',
    SHILING_PROCESS_CONCURRENCY: '2',
  };
  const config = readApiConfig(env);
  const pgEnv = {
    ...process.env,
    PGHOST: target.hostname,
    PGPORT: target.port || '5432',
    PGUSER: 'shiling_test',
    PGDATABASE: 'shiling_test',
    PGPASSWORD: decodeURIComponent(target.password),
    PGSSLMODE: 'disable',
  };
  const statePath = join(directory, 'state.json');
  const backup = join(directory, 'backup');
  const recovery = (phase) =>
    command(
      process.execPath,
      ['tests/deployment/recovery-http.mjs', phase, statePath],
      process.env,
    );
  async function start(storage, withWorker = true) {
    app = createApi(config, await createApiRuntime(config, storage));
    await app.listen({ host: '127.0.0.1', port });
    if (withWorker) {
      worker = await createWorkerRuntime(readWorkerConfig(env), storage);
      await worker.start();
    }
  }
  async function stop() {
    if (worker) {
      await worker.close();
      worker = undefined;
    }
    if (app) {
      await app.close();
      app = undefined;
    }
  }
  try {
    // Cross a multipart boundary through the real SDK, including concurrent writes and Range.
    await Promise.all(
      [1, 2, 3].map(async (value) => {
        const bytes = Buffer.alloc(9 * 1024 ** 2 + value, value);
        const key = `acceptance-probes/multipart-${value}`;
        const expected = {
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
        assert.deepEqual(
          await sourceStorage.put(key, Readable.from([bytes]), { maxBytes: bytes.length }),
          expected,
        );
        assert.deepEqual(await sourceStorage.inspect(key), expected);
        const range = await sourceStorage.open(key, {
          start: 8 * 1024 ** 2 - 2,
          end: 8 * 1024 ** 2 + 2,
        });
        assert.deepEqual(
          Buffer.concat(await Array.fromAsync(range.stream)),
          Buffer.alloc(5, value),
        );
        await assert.rejects(
          sourceStorage.put(key, Readable.from([Buffer.from('overwrite')]), { maxBytes: 20 }),
        );
        await sourceStorage.remove(key);
        await assert.rejects(sourceStorage.inspect(key), { code: 'STORAGE_OBJECT_UNAVAILABLE' });
      }),
    );
    database = makeDb();
    const clients = await database.query(
      'SELECT count(*)::int count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
    );
    assert.equal(clients.rows[0].count, 0, 'Refusing reset with other test DB clients.');
    await database.query('DROP SCHEMA IF EXISTS shiling CASCADE');
    await database.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
    await database.query('CREATE SCHEMA shiling AUTHORIZATION shiling_test');
    await runMigrations(database);
    await database.close();
    database = undefined;
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
    await start(sourceStorage);
    const fixture = {
      fixtureKind: 'local-acceptance',
      baseUrl: base,
      origin: base,
      password: `Test-${randomBytes(24).toString('hex')}`,
      setupToken: env.SHILING_SETUP_TOKEN,
      directory,
    };
    const fixturePath = join(directory, 'fixture.json');
    await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
    await command(
      process.execPath,
      ['tests/e2e/workbench-regression.mjs', fixturePath],
      process.env,
    );
    await writeFile(
      statePath,
      JSON.stringify({
        source: `shiling-acceptance-${id}`,
        directory,
        sourcePort: port,
        restoredPort: port,
        passed: [],
      }),
      { mode: 0o600 },
    );
    await stop();
    await start(sourceStorage);
    await recovery('baseline');
    await worker.close();
    worker = undefined;
    await recovery('checkpoint');
    await stop();
    database = makeDb();
    await assert.rejects(assertStorageBinding(database, restoredStorage), {
      code: 'STORAGE_LOCATION_MISMATCH',
    });
    if (real) {
      const rows = await database.query(
        "SELECT object_key FROM shiling.storage_objects WHERE state='stored' LIMIT 1",
      );
      const key = sourceConfig.prefix + rows.rows[0].object_key;
      const url = new URL(sourceConfig.endpoint);
      url.hostname = sourceConfig.bucket + '.' + url.hostname;
      url.pathname = '/' + key;
      const anonymous = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
      await anonymous.body?.cancel();
      assert.equal(
        anonymous.status,
        403,
        'Existing private OSS object must deny anonymous access.',
      );
    }
    const exported = await exportStorageBackup(database, sourceStorage, backup);
    assert.ok(exported.objects >= 6);
    await database.close();
    database = undefined;
    await command(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-acl',
        '--schema=shiling',
        '--schema=pgboss',
        '--file',
        join(directory, 'database.dump'),
      ],
      pgEnv,
    );
    await start(sourceStorage, false);
    await recovery('post-backup');
    await stop();
    database = makeDb();
    await database.query('DROP SCHEMA pgboss CASCADE');
    await database.query('DROP SCHEMA shiling CASCADE');
    await database.close();
    database = undefined;
    await command(
      'pg_restore',
      ['--no-owner', '--no-acl', '--dbname=shiling_test', join(directory, 'database.dump')],
      pgEnv,
    );
    database = makeDb();
    const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
    const samplePath = join(backup, 'objects', manifest.objects[0].id);
    const sample = await readFile(samplePath);
    await writeFile(samplePath, Buffer.from('corrupted'));
    await assert.rejects(restoreStorageBackup(database, restoredStorage, backup), /SHA-256/);
    await writeFile(samplePath, sample);
    await assert.rejects(restoreStorageBackup(database, sourceStorage, backup), /新的存储位置/);
    await assert.rejects(
      restoreStorageBackup(
        database,
        {
          ...restoredStorage,
          put: async () => {
            throw new Error('interrupted restore');
          },
        },
        backup,
      ),
      /interrupted restore/,
    );
    await assertStorageBinding(database, sourceStorage);
    const settings = await database.query(
      "SELECT values->>'publicEnabled' public_enabled FROM shiling.product_settings WHERE id=1",
    );
    assert.equal(settings.rows[0].public_enabled, 'false');
    const restored = await restoreStorageBackup(database, restoredStorage, backup);
    assert.deepEqual(restored, exported);
    await database.close();
    database = undefined;
    await start(restoredStorage);
    await recovery('after-restore');
    await recovery('republish');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (protocol) {
      assert.equal(protocol.uploads.size, 0);
      assert.ok(protocol.requests.some((r) => r.query.includes('uploadId')));
      assert.ok(protocol.requests.some((r) => r.method === 'GET'));
    }
    return {
      provider: real ? 'aliyun-oss' : 'local-oss-protocol-fixture',
      workbenchGroups: JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')).passed
        .length,
      recoveryGroups: state.passed.length,
      ...restored,
      ...(real ? { testPrefixSuffix: `acceptance-${id}/` } : {}),
    };
  } finally {
    await stop();
    if (database) await database.close();
    await protocol?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
