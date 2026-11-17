/** Isolated, local Docker acceptance. Never targets an existing deployment or host database. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [phase, statePath] = process.argv.slice(2);
const context = process.env['SHILING_DOCKER_CONTEXT'] ?? 'desktop-linux';
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(SHILING_|COMPOSE_)/.test(key)),
);
function docker(args, options = {}) {
  try {
    return execFileSync('docker', ['--context', context, ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      timeout: 240000,
      ...options,
    });
  } catch (error) {
    // Keep Docker progress bounded; never print the child error object or its input buffer.
    const stderr = String(error.stderr ?? '')
      .split('\n')
      .slice(-18)
      .join('\n');
    // eslint-disable-next-line preserve-caught-error -- Child input may contain backup data; do not retain it in an error cause.
    throw new Error(`Docker command failed (${error.status ?? 'timeout'}): ${stderr}`);
  }
}
const endpoint = JSON.parse(docker(['context', 'inspect', context]))[0].Endpoints.docker.Host;
assert.ok(endpoint.startsWith('unix://'), 'Only a local Unix Docker socket is allowed.');
const secretFiles = {
  POSTGRES_PASSWORD: 'postgres-password',
  APP_PASSWORD: 'app-password',
  MIGRATION_PASSWORD: 'migration-password',
  DATABASE_URL: 'database-url',
  MIGRATION_DATABASE_URL: 'migration-database-url',
  SETUP_TOKEN: 'setup-token',
  CSRF_SECRET: 'csrf-secret',
  DELIVERY_SECRET: 'delivery-secret',
};
if (phase === 'prepare') {
  const directory = await mkdtemp(join(tmpdir(), 'shiling-docker-'));
  await chmod(directory, 0o700);
  const suffix = randomBytes(5).toString('hex');
  const state = {
    directory,
    context,
    release: process.env['SHILING_DOCKER_RELEASE'] ?? 'acceptance-local',
    source: `shiling-acceptance-${suffix}`,
    restored: `shiling-acceptance-${suffix}-restore`,
    sourcePort: 18080,
    restoredPort: 18081,
    passed: [],
  };
  for (const target of ['source', 'restored']) {
    assert.equal(
      docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${state[target]}`]).trim(),
      '',
    );
    assert.equal(
      docker([
        'volume',
        'ls',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${state[target]}`,
      ]).trim(),
      '',
    );
    const secrets = join(directory, `${target}-secrets`);
    execFileSync(process.execPath, ['deploy/compose/create-secrets.mjs', '--output', secrets], {
      cwd: root,
    });
    const port = state[`${target}Port`];
    const values = {
      COMPOSE_PROJECT_NAME: state[target],
      SHILING_RELEASE: state.release,
      SHILING_BIND_ADDRESS: '127.0.0.1',
      SHILING_HTTP_PORT: port,
      SHILING_HTTPS_PORT: port + 363,
      SHILING_SITE_ADDRESS: 'http://127.0.0.1',
      SHILING_APP_ORIGIN: `http://127.0.0.1:${port}`,
      SHILING_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      SHILING_PREVIEW_ORIGIN: `http://preview.localhost:${port}`,
      SHILING_COOKIE_SECURE: false,
      ...Object.fromEntries(
        Object.entries(secretFiles).map(([key, name]) => [
          `SHILING_${key}_FILE`,
          join(secrets, name),
        ]),
      ),
    };
    await writeFile(
      join(directory, `${target}.env`),
      Object.entries(values)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
      { mode: 0o600 },
    );
  }
  // Long enough to prove restore revocation while the original grant is still unexpired.
  await writeFile(
    join(directory, 'override.json'),
    JSON.stringify({
      services: { api: { environment: { SHILING_DELIVERY_GRANT_TTL_SECONDS: '600' } } },
    }),
  );
  await writeFile(
    join(directory, 'credentials.json'),
    JSON.stringify({
      fixtureKind: 'docker-acceptance',
      baseUrl: `http://127.0.0.1:${state.sourcePort}`,
      origin: `http://127.0.0.1:${state.sourcePort}`,
      loginName: 'admin',
      password: `Acceptance-${randomBytes(24).toString('base64url')}`,
      setupToken: (await readFile(join(directory, 'source-secrets/setup-token'), 'utf8')).trim(),
      directory,
    }),
    { mode: 0o600 },
  );
  const path = join(directory, 'state.json');
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.info(JSON.stringify({ statePath: path, source: state.source, restored: state.restored }));
  process.exit(0);
}
assert.ok(statePath, 'Usage: docker-acceptance.mjs prepare | <phase> <state.json>');
const state = JSON.parse(await readFile(statePath, 'utf8'));
assert.equal(state.context, context);
assert.match(state.source, /^shiling-acceptance-[a-f0-9]{10}$/);
assert.equal(state.restored, `${state.source}-restore`);
assert.equal(resolve(state.directory, 'state.json'), resolve(statePath));
const directory = state.directory;
function compose(target, args, options = {}) {
  assert.ok(['source', 'restored'].includes(target));
  return docker(
    [
      'compose',
      '--project-name',
      state[target],
      '--env-file',
      join(directory, `${target}.env`),
      '-f',
      'deploy/compose/compose.yaml',
      '-f',
      join(directory, 'override.json'),
      ...args,
    ],
    options,
  );
}
function sql(target, query) {
  return compose(target, [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '-U',
    'postgres',
    '-d',
    'shiling',
    '-v',
    'ON_ERROR_STOP=1',
    '-Atc',
    query,
  ]).trim();
}
async function save(name) {
  if (!state.passed.includes(name)) state.passed.push(name);
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.info(`PASS ${name}`);
}
async function ready(target) {
  const base = `http://127.0.0.1:${state[`${target}Port`]}`;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      /* The new container may still be starting. */
    }
    await delay(1000);
  }
  throw new Error(`Readiness failed: ${target}`);
}
function http(phase) {
  execFileSync(process.execPath, ['tests/deployment/recovery-http.mjs', phase, statePath], {
    cwd: root,
    stdio: 'inherit',
  });
}
function volume(target, action) {
  const name = `${state[target]}_objects`;
  const info = JSON.parse(docker(['volume', 'inspect', name]))[0];
  assert.equal(info.Labels['com.docker.compose.project'], state[target]);
  return docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '0:0',
    '--entrypoint',
    'tar',
    '--mount',
    `type=volume,src=${name},dst=/objects${action === 'backup' ? ',readonly' : ''}`,
    '--mount',
    `type=bind,src=${join(directory, 'backup')},dst=/backup${action === 'restore' ? ',readonly' : ''}`,
    `shiling-runtime:${state.release}`,
    '-C',
    '/objects',
    action === 'backup' ? '-czf' : '-xzf',
    '/backup/objects.tar.gz',
    ...(action === 'backup' ? ['.'] : []),
  ]);
}

if (phase === 'build') {
  compose('source', ['build'], { timeout: 900000 });
  await save('三类部署镜像构建');
} else if (phase === 'recovery') {
  // Keep checkpoint-to-verification bounded so old grants are tested before expiry.
  for (const step of ['checkpoint', 'backup', 'post-backup', 'restore']) {
    execFileSync(process.execPath, ['tests/deployment/docker-acceptance.mjs', step, statePath], {
      cwd: root,
      stdio: 'inherit',
    });
  }
  http('after-restore');
  execFileSync(process.execPath, ['tests/deployment/docker-acceptance.mjs', 'rotate', statePath], {
    cwd: root,
    stdio: 'inherit',
  });
  http('republish');
} else if (phase === 'start') {
  compose('source', ['config', '--quiet']);
  compose('source', ['up', '-d', '--wait', '--wait-timeout', '120', 'postgres']);
  compose('source', ['run', '--rm', 'migrate']);
  compose('source', ['run', '--rm', 'migrate']);
  compose('source', [
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
  await ready('source');
  await save('容器首次启动、正式三角色迁移与重复迁移');
} else if (phase === 'regression') {
  execFileSync(
    process.execPath,
    ['tests/e2e/workbench-regression.mjs', join(directory, 'credentials.json')],
    { cwd: root, env: process.env, stdio: 'inherit' },
  );
  await save('Caddy 同源入口通过三批工作台 12 组真实 API 回归');
} else if (phase === 'audit') {
  for (const service of ['api', 'worker', 'preview']) {
    const id = compose('source', ['ps', '-q', service]).trim();
    const item = JSON.parse(docker(['inspect', id]))[0];
    assert.equal(item.Config.User, 'node');
    assert.equal(item.HostConfig.ReadonlyRootfs, true);
    assert.ok(item.HostConfig.CapDrop.includes('ALL'));
    assert.ok(item.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.equal(Object.keys(item.HostConfig.PortBindings ?? {}).length, 0);
    assert.ok(item.Config.Env.includes('SHILING_PREVIEW_EXECUTION_ENABLED=false'));
    if (service === 'preview') assert.equal(item.Mounts.length, 0);
  }
  const db = JSON.parse(docker(['inspect', compose('source', ['ps', '-q', 'postgres']).trim()]))[0];
  assert.equal(Object.keys(db.HostConfig.PortBindings ?? {}).length, 0);
  assert.equal(
    sql(
      'source',
      `SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT pg_has_role('shiling_app','shiling_owner','MEMBER') AND NOT has_schema_privilege('shiling_app','shiling','CREATE') FROM pg_roles WHERE rolname='shiling_app'`,
    ),
    't',
  );
  assert.equal(
    sql(
      'source',
      `SELECT bool_and(tableowner='shiling_owner') FROM pg_tables WHERE schemaname IN ('shiling','pgboss')`,
    ),
    't',
  );
  const base = `http://127.0.0.1:${state.sourcePort}`;
  for (const path of ['/objects/probe', '/preview/probe', '/internal/probe', '/uploads/probe'])
    assert.equal((await fetch(`${base}${path}`)).status, 404);
  for (const path of ['/app/login', '/app/library', '/public/library']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<script[^>]+src="\/assets\//);
  }
  const credentials = JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8'));
  execFileSync(process.execPath, ['tests/e2e/http-regression.mjs'], {
    cwd: root,
    env: { ...process.env, SHILING_E2E_BASE_URL: base, SHILING_E2E_PASSWORD: credentials.password },
    stdio: 'inherit',
  });
  await save('容器最小权限、数据库所有权、静态路径隔离、HTTP 回归与动效 403');
} else if (phase === 'restart') {
  const before = sql(
    'source',
    `SELECT json_build_object('epoch',runtime_epoch,'values',values)::text FROM shiling.product_settings`,
  );
  state.persistence = before;
  compose('source', ['restart', 'postgres', 'api', 'worker', 'preview', 'web']);
  await ready('source');
  assert.equal(
    sql(
      'source',
      `SELECT json_build_object('epoch',runtime_epoch,'values',values)::text FROM shiling.product_settings`,
    ),
    before,
  );
  compose('source', ['down']);
  compose('source', ['up', '-d', '--no-build', '--wait', '--wait-timeout', '120']);
  await ready('source');
  assert.equal(
    sql(
      'source',
      `SELECT json_build_object('epoch',runtime_epoch,'values',values)::text FROM shiling.product_settings`,
    ),
    before,
  );
  await save('数据库及全部服务重启、移除重建容器后命名卷持久化');
} else if (phase === 'checkpoint') {
  compose('source', ['stop', 'worker']);
  http('checkpoint');
} else if (phase === 'post-backup') {
  compose('source', ['up', '-d', '--no-build', '--wait', '--wait-timeout', '120']);
  await ready('source');
  http('post-backup');
  compose('source', ['stop', 'web', 'api', 'worker', 'preview']);
} else if (phase === 'backup') {
  assert.ok(state.passed.includes('恢复前凭据、公开 grant 与待处理任务采样'));
  compose('source', ['stop', 'web', 'api', 'worker', 'preview']);
  assert.equal(
    sql(
      'source',
      `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()`,
    ),
    '0',
  );
  const backup = join(directory, 'backup');
  await mkdir(backup, { mode: 0o700 });
  const fd = openSync(join(backup, 'database.dump'), 'wx', 0o600);
  try {
    compose(
      'source',
      ['exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-d', 'shiling', '-Fc'],
      { stdio: ['pipe', fd, 'pipe'] },
    );
  } finally {
    closeSync(fd);
  }
  volume('source', 'backup');
  await chmod(join(backup, 'objects.tar.gz'), 0o600);
  const dump = await readFile(join(backup, 'database.dump'));
  compose('source', ['exec', '-T', 'postgres', 'pg_restore', '--list'], { input: dump });
  const archive = docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    'tar',
    '--mount',
    `type=bind,src=${backup},dst=/backup,readonly`,
    `shiling-runtime:${state.release}`,
    '-tzf',
    '/backup/objects.tar.gz',
  ]);
  assert.ok(archive.includes('./objects/'));
  const checksums = {};
  for (const file of ['database.dump', 'objects.tar.gz'])
    checksums[file] = createHash('sha256')
      .update(await readFile(join(backup, file)))
      .digest('hex');
  state.backupAt = new Date().toISOString();
  state.backupRuntimeEpoch = sql('source', 'SELECT runtime_epoch FROM shiling.product_settings');
  state.checksums = checksums;
  await writeFile(
    join(backup, 'manifest.json'),
    JSON.stringify(
      {
        createdAt: state.backupAt,
        checksums,
        versions: {
          postgres: sql('source', 'SHOW server_version'),
          migrations: JSON.parse(
            sql('source', 'SELECT json_agg(id ORDER BY id) FROM shiling.schema_migrations'),
          ),
          images: JSON.parse(
            docker([
              'image',
              'inspect',
              `shiling-runtime:${state.release}`,
              `shiling-web:${state.release}`,
              `shiling-postgres:${state.release}`,
            ]),
          ).map(({ RepoTags, Id }) => ({ tags: RepoTags, id: Id })),
        },
      },
      null,
      2,
    ),
  );
  await save('停止全部写入者后数据库与 Local 对象一致备份、归档与摘要校验');
} else if (phase === 'restore') {
  state.restoreStartedAt = new Date().toISOString();
  for (const [name, digest] of Object.entries(state.checksums))
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(directory, 'backup', name)))
        .digest('hex'),
      digest,
    );
  assert.equal(
    docker([
      'volume',
      'ls',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${state.restored}`,
    ]).trim(),
    '',
    'Restore must use completely new volumes.',
  );
  compose('restored', ['up', '-d', '--wait', '--wait-timeout', '120', 'postgres']);
  compose('restored', ['create', '--no-build', 'api']);
  volume('restored', 'restore');
  compose(
    'restored',
    [
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '-U',
      'postgres',
      '-d',
      'shiling',
      '--clean',
      '--if-exists',
      '--exit-on-error',
    ],
    { input: await readFile(join(directory, 'backup/database.dump')) },
  );
  assert.equal(
    sql('restored', 'SELECT runtime_epoch FROM shiling.product_settings'),
    state.backupRuntimeEpoch,
  );
  compose('restored', ['run', '--rm', '--no-deps', 'migrate']);
  const safety = (flag) =>
    JSON.parse(
      compose('restored', [
        'run',
        '--rm',
        '--no-deps',
        'api',
        'node',
        'apps/api/dist/restore-safety.js',
        ...(flag ? [flag] : []),
      ]),
    );
  const dry = safety();
  assert.equal(dry.safe, false);
  await writeFile(join(directory, 'restore-dry-run.json'), JSON.stringify(dry, null, 2));
  const applied = safety('--apply');
  assert.equal(applied.safe, true);
  assert.equal(safety('--verify').safe, true);
  assert.notEqual(
    sql('restored', 'SELECT runtime_epoch FROM shiling.product_settings'),
    state.backupRuntimeEpoch,
  );
  await writeFile(join(directory, 'restore-applied.json'), JSON.stringify(applied, null, 2));
  // Retain signing secrets ONLY for this isolated negative test: the database epoch must invalidate
  // the still-unexpired grant. Rotate before the controlled reopen phase. Never expose this fixture.
  for (const name of ['csrf-secret', 'delivery-secret']) {
    const target = join(directory, 'restored-secrets', name);
    await chmod(target, 0o600);
    await writeFile(target, await readFile(join(directory, 'source-secrets', name)));
    await chmod(target, 0o444);
  }
  compose('restored', [
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
  await ready('restored');
  state.restoreReadyAt = new Date().toISOString();
  await save('全新卷还原、灾备安全 dry-run/apply/verify 后启动新服务');
} else if (phase === 'rotate') {
  assert.ok(
    state.passed.includes(
      '旧会话/邀请/恢复令牌/未到期 grant 失效，旧任务撤销，公开撤回且数据回到备份点',
    ),
  );
  compose('restored', ['stop', 'web', 'api', 'worker', 'preview']);
  for (const name of ['csrf-secret', 'delivery-secret', 'setup-token']) {
    const path = join(directory, 'restored-secrets', name);
    await chmod(path, 0o600);
    await writeFile(path, `${randomBytes(32).toString('base64url')}\n`);
    await chmod(path, 0o444);
  }
  compose('restored', [
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
  await ready('restored');
  await save('恢复实例签名与初始化密钥轮换并重建应用容器');
} else if (phase === 'stop') {
  for (const target of ['source', 'restored']) compose(target, ['stop']);
  await save('停止本次两组验收容器，保留私有备份和命名卷');
} else if (phase === 'database-restart') {
  assert.ok(
    state.passed.includes(
      '轮换密钥后重新认证、公开重开不复活快照、管理员不得代发布、所有者重新公开与游客下载',
    ),
  );
  compose('restored', ['restart', 'postgres']);
  await ready('restored');
  http('availability');
} else if (phase === 'refresh') {
  compose('restored', [
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
  await ready('restored');
  http('availability');
  await save('最终镜像重建应用后业务复验');
} else if (phase === 'status') {
  for (const target of ['source', 'restored']) console.info(compose(target, ['ps', '-a']));
  console.info(
    JSON.stringify(
      {
        passed: state.passed,
        backupAt: state.backupAt,
        restoreStartedAt: state.restoreStartedAt,
        restoreReadyAt: state.restoreReadyAt,
      },
      null,
      2,
    ),
  );
} else {
  throw new Error('Unknown phase. See tests/deployment/README.md for the supported sequence.');
}
