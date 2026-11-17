/** Run the complete gate against a disposable database, never the host database. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env['SHILING_DOCKER_CONTEXT'] ?? 'default';
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(SHILING_|PG|DATABASE_URL|COMPOSE_)/.test(key)),
);
function docker(args, options = {}) {
  try {
    return execFileSync('docker', ['--context', context, ...args], {
      encoding: 'utf8',
      env,
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch {
    // Never include child env, input or connection credentials.
    throw new Error('Isolated Docker check failed; inspect the dedicated check container locally.');
  }
}
const endpoint = JSON.parse(docker(['context', 'inspect', context]))[0].Endpoints.docker.Host;
assert.ok(endpoint.startsWith('unix://'), 'Only a local Docker socket is allowed.');
const name = `shiling-check-${randomBytes(6).toString('hex')}`;
const directory = await mkdtemp(join(tmpdir(), 'shiling-check-'));
await chmod(directory, 0o700);
const password = randomBytes(32).toString('hex');
const baseImages = JSON.parse(
  await readFile(join(root, 'deploy/releases/base-images.json'), 'utf8'),
);
assert.match(baseImages.POSTGRES_IMAGE, /^postgres:[^@]+@sha256:[a-f0-9]{64}$/);
await writeFile(join(directory, 'postgres-password'), randomBytes(32).toString('hex'), {
  mode: 0o600,
});
await writeFile(
  join(directory, 'test.env'),
  `POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password\nSHILING_TEST_DB_PASSWORD=${password}\n`,
  { mode: 0o600 },
);
let created = false;
try {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    `shiling.check=${name}`,
    '--publish',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql',
    '--env-file',
    join(directory, 'test.env'),
    '--mount',
    `type=bind,src=${join(directory, 'postgres-password')},dst=/run/secrets/postgres-password,readonly`,
    baseImages.POSTGRES_IMAGE,
  ]);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
      ready = true;
      break;
    } catch {
      await delay(500);
    }
  }
  assert.ok(ready, 'Dedicated test PostgreSQL did not become ready.');
  docker(['exec', '-i', name, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-f', '-'], {
    input: await readFile(join(root, 'deploy/postgres/bootstrap-test.sql')),
  });
  const bindings = JSON.parse(docker(['inspect', name]))[0].NetworkSettings.Ports['5432/tcp'];
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].HostIp, '127.0.0.1');
  const url = `postgresql://shiling_test:${password}@127.0.0.1:${bindings[0].HostPort}/shiling_test`;
  console.info('Running all checks with a new isolated shiling_test database.');
  const code = await new Promise((resolveCode, reject) => {
    const child = spawn('corepack', ['pnpm', 'check'], {
      cwd: root,
      env: { ...env, SHILING_TEST_DATABASE_URL: url },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => resolveCode(code ?? 1));
  });
  process.exitCode = code;
} finally {
  if (created) {
    const labels = JSON.parse(docker(['inspect', name]))[0].Config.Labels;
    assert.equal(labels['shiling.check'], name);
    docker(['rm', '-f', name]);
  }
  await rm(directory, { recursive: true, force: true });
}
