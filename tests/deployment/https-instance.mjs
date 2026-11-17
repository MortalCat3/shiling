/** Local HTTPS/capacity fixture. No host trust store, hosts file, existing DB or volumes are changed. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [phase, statePath] = process.argv.slice(2);
const context = process.env['SHILING_DOCKER_CONTEXT'] ?? 'desktop-linux';
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(SHILING_|COMPOSE_)/.test(k)),
);
function docker(args, options = {}) {
  try {
    return execFileSync('docker', ['--context', context, ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 240000,
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Child input can contain credentials; do not retain it in the error.
    throw new Error(
      `Docker failed (${error.status ?? 'timeout'}): ${String(error.stderr ?? '')
        .split('\n')
        .slice(-15)
        .join('\n')}`,
    );
  }
}
assert.ok(
  JSON.parse(docker(['context', 'inspect', context]))[0].Endpoints.docker.Host.startsWith(
    'unix://',
  ),
);
if (phase === 'prepare') {
  const directory = await mkdtemp(join(tmpdir(), 'shiling-https-'));
  await chmod(directory, 0o700);
  const state = {
    directory,
    context,
    project: `shiling-https-${randomBytes(5).toString('hex')}`,
    release: process.env['SHILING_DOCKER_RELEASE'] ?? 'acceptance-20261117',
    httpPort: 19080,
    httpsPort: 19443,
    origin: 'https://shiling.test',
    passed: [],
  };
  assert.equal(
    docker([
      'volume',
      'ls',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${state.project}`,
    ]).trim(),
    '',
  );
  const secrets = join(directory, 'secrets');
  execFileSync(process.execPath, ['deploy/compose/create-secrets.mjs', '--output', secrets], {
    cwd: root,
  });
  const names = {
    POSTGRES_PASSWORD: 'postgres-password',
    APP_PASSWORD: 'app-password',
    MIGRATION_PASSWORD: 'migration-password',
    DATABASE_URL: 'database-url',
    MIGRATION_DATABASE_URL: 'migration-database-url',
    SETUP_TOKEN: 'setup-token',
    CSRF_SECRET: 'csrf-secret',
    DELIVERY_SECRET: 'delivery-secret',
  };
  const values = {
    COMPOSE_PROJECT_NAME: state.project,
    SHILING_RELEASE: state.release,
    SHILING_BIND_ADDRESS: '127.0.0.1',
    SHILING_HTTP_PORT: state.httpPort,
    SHILING_HTTPS_PORT: state.httpsPort,
    SHILING_SITE_ADDRESS: 'https://shiling.test',
    SHILING_APP_ORIGIN: state.origin,
    SHILING_PUBLIC_ORIGIN: state.origin,
    SHILING_PREVIEW_ORIGIN: 'https://preview.shiling.test',
    SHILING_COOKIE_SECURE: 'true',
    ...Object.fromEntries(
      Object.entries(names).map(([key, name]) => [`SHILING_${key}_FILE`, join(secrets, name)]),
    ),
  };
  await writeFile(
    join(directory, 'compose.env'),
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    { mode: 0o600 },
  );
  const caddy = await readFile(join(root, 'deploy/images/Caddyfile'), 'utf8');
  assert.ok(caddy.includes('\tadmin off'));
  await writeFile(
    join(directory, 'Caddyfile'),
    caddy.replace('\tadmin off', '\tadmin off\n\tlocal_certs') +
      '\nhttps://preview.shiling.test {\n\trespond 404\n}\n',
  );
  await writeFile(
    join(directory, 'override.json'),
    JSON.stringify({
      services: {
        web: {
          volumes: [`${join(directory, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`],
          networks: { edge: { aliases: ['shiling.test', 'preview.shiling.test'] }, backend: {} },
        },
      },
    }),
  );
  await writeFile(
    join(directory, 'credentials.json'),
    JSON.stringify({
      loginName: 'admin',
      displayName: 'HTTPS 验收管理员',
      password: `Acceptance-${randomBytes(24).toString('base64url')}`,
      setupToken: (await readFile(join(secrets, 'setup-token'), 'utf8')).trim(),
    }),
    { mode: 0o600 },
  );
  const file = join(directory, 'state.json');
  await writeFile(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.info(JSON.stringify({ statePath: file, project: state.project }));
  process.exit(0);
}
const state = JSON.parse(await readFile(statePath, 'utf8'));
assert.match(state.project, /^shiling-https-[a-f0-9]{10}$/);
assert.equal(state.context, context);
assert.equal(resolve(state.directory, 'state.json'), resolve(statePath));
const composeArgs = [
  'compose',
  '-p',
  state.project,
  '--env-file',
  join(state.directory, 'compose.env'),
  '-f',
  'deploy/compose/compose.yaml',
  '-f',
  join(state.directory, 'override.json'),
];
const compose = (args, options) => docker([...composeArgs, ...args], options);
async function save(name) {
  if (!state.passed.includes(name)) state.passed.push(name);
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.info(`PASS ${name}`);
}
async function ready() {
  const ca = await readFile(join(state.directory, 'root.crt'));
  for (let i = 0; i < 90; i++) {
    const status = await new Promise((resolve) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: state.httpsPort,
          servername: 'shiling.test',
          ca,
          headers: { Host: 'shiling.test' },
          path: '/health/ready',
          timeout: 2000,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', () => resolve(0));
      req.on('timeout', () => req.destroy());
      req.end();
    });
    if (status === 200) return;
    await delay(1000);
  }
  throw new Error('HTTPS readiness failed.');
}
if (phase === 'start') {
  compose(['config', '--quiet']);
  compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '120', 'postgres']);
  compose(['run', '--rm', 'migrate']);
  compose([
    'up',
    '-d',
    '--no-build',
    '--wait',
    '--wait-timeout',
    '120',
    'api',
    'worker',
    'preview',
    'web',
  ]);
  const certificate = compose([
    'exec',
    '-T',
    'web',
    'cat',
    '/data/caddy/pki/authorities/local/root.crt',
  ]);
  assert.match(certificate, /BEGIN CERTIFICATE/);
  await writeFile(join(state.directory, 'root.crt'), certificate, { mode: 0o644 });
  await ready();
  await save('隔离 HTTPS 实例启动，客户端校验本地 CA 与主机名');
} else if (phase === 'build') {
  compose(['build'], { timeout: 900000 });
  await save('修复后的三类镜像构建');
} else if (phase === 'refresh') {
  compose([
    'up',
    '-d',
    '--no-build',
    '--force-recreate',
    '--wait',
    '--wait-timeout',
    '120',
    'api',
    'worker',
    'preview',
    'web',
  ]);
  await ready();
  await save('新镜像服务重建与 HTTPS 就绪');
} else if (phase === 'clients') {
  for (const name of ['client-a', 'client-b']) {
    docker([
      'run',
      '-d',
      '--name',
      `${state.project}-${name}`,
      '--label',
      `shiling.acceptance=${state.project}`,
      '--network',
      `${state.project}_edge`,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--mount',
      `type=bind,src=${join(state.directory, 'root.crt')},dst=/ca.crt,readonly`,
      '--entrypoint',
      'node',
      `shiling-runtime:${state.release}`,
      '-e',
      'setInterval(()=>{},60000)',
    ]);
  }
  await save('两个独立网络地址的受控客户端启动');
} else if (phase === 'capacity' || phase === 'limits') {
  const ids = compose(['ps', '-q']).trim().split('\n');
  const samples = [];
  let collecting = false;
  async function sample() {
    if (collecting) return;
    collecting = true;
    try {
      const lines = await new Promise((resolve) => {
        const p = spawn(
          'docker',
          ['--context', context, 'stats', '--no-stream', '--format', '{{json .}}', ...ids],
          { env, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        let text = '';
        p.stdout.on('data', (chunk) => (text += chunk));
        p.on('close', () => resolve(text));
      });
      samples.push({
        at: new Date().toISOString(),
        containers: String(lines)
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((s) => JSON.parse(s)),
      });
    } finally {
      collecting = false;
    }
  }
  await sample();
  const timer = setInterval(() => void sample(), 2500);
  const child = spawn(process.execPath, ['tests/deployment/https-capacity.mjs', phase, statePath], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  const status = await new Promise((resolve) => child.on('close', resolve));
  clearInterval(timer);
  while (collecting) await delay(100);
  await sample();
  const inspected = JSON.parse(docker(['inspect', ...ids])).map((item) => ({
    service: item.Config.Labels['com.docker.compose.service'],
    running: item.State.Running,
    oomKilled: item.State.OOMKilled,
    restarts: item.RestartCount,
    memoryLimit: item.HostConfig.Memory,
    cpuQuota: item.HostConfig.NanoCpus,
    pidsLimit: item.HostConfig.PidsLimit,
  }));
  await writeFile(
    join(state.directory, phase === 'capacity' ? 'resources.json' : 'limits-resources.json'),
    JSON.stringify({ samples, inspected }, null, 2),
  );
  assert.equal(status, 0, 'Capacity assertions failed; inspect the private report.');
  assert.ok(inspected.every((item) => item.running && !item.oomKilled && item.restarts === 0));
  console.info('PASS 并发验收期间容器无 OOM、无重启，资源采样已保存');
} else if (phase === 'stop') {
  compose(['stop']);
  for (const name of ['client-a', 'client-b']) {
    const id = docker([
      'ps',
      '-aq',
      '--filter',
      `name=^${state.project}-${name}$`,
      '--filter',
      `label=shiling.acceptance=${state.project}`,
    ]).trim();
    if (id) docker(['rm', '-f', id]);
  }
  await save('验收服务停止，保留专用卷及私密报告');
} else throw new Error('Unknown phase. See tests/deployment/https-capacity.md.');
