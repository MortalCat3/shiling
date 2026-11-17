/** HTTPS and bounded capacity assertions against the isolated fixture only. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { Agent, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32 } from 'node:zlib';

const [phase, statePath] = process.argv.slice(2);
const state = JSON.parse(await readFile(statePath, 'utf8'));
assert.match(state.project, /^shiling-https-[a-f0-9]{10}$/);
assert.equal(state.origin, 'https://shiling.test');
const ca = await readFile(join(state.directory, 'root.crt'));
const agent = new Agent({ ca, keepAlive: true, maxSockets: 32 });
const credentials = JSON.parse(await readFile(join(state.directory, 'credentials.json'), 'utf8'));
const admin = {};
const member = {};
const api = '/api/v1';
const team = `${api}/team`;
const management = `${team}/admin`;
const metrics = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function request(actor, path, options = {}) {
  const url = new URL(path, state.origin);
  assert.equal(url.origin, state.origin, 'No external requests allowed.');
  const method = options.method ?? 'GET';
  const headers = {
    Host: url.host,
    ...(actor.cookie ? { Cookie: actor.cookie } : {}),
    ...options.headers,
  };
  if (!['GET', 'HEAD'].includes(method)) {
    headers.Origin ??= state.origin;
    if (actor.csrfToken) headers['X-CSRF-Token'] ??= actor.csrfToken;
  }
  if (options.revision) headers['If-Match'] = `"${options.revision}"`;
  if (options.key) headers['Idempotency-Key'] = options.key === true ? randomUUID() : options.key;
  let body = options.body;
  if (body !== undefined && !options.raw) {
    headers['Content-Type'] = 'application/json';
    body = Buffer.from(JSON.stringify(body));
  }
  if (body) headers['Content-Length'] ??= body.length;
  const started = performance.now();
  const result = await new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: '127.0.0.1',
        port: state.httpsPort,
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        agent,
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: res.headers['content-type']?.includes('json') ? JSON.parse(bytes) : bytes,
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTPS request timed out')));
    req.end(body);
  });
  metrics.push({
    method,
    route: url.pathname.replace(/[a-f0-9-]{36}/g, ':id'),
    status: result.status,
    ms: performance.now() - started,
  });
  assert.equal(
    result.status,
    options.status ?? 200,
    `${method} ${url.pathname}: ${result.status} ${result.data?.code ?? ''}`,
  );
  return result;
}
const get = async (actor, path, options) => (await request(actor, path, options)).data;
const post = async (actor, path, body, options = {}) =>
  (await request(actor, path, { method: 'POST', body, ...options })).data;
async function login(actor, credentials) {
  const response = await request({}, `${api}/auth/login`, {
    method: 'POST',
    body: { loginName: credentials.loginName, password: credentials.password },
  });
  const cookie = response.headers['set-cookie'][0];
  assert.ok(/^__Host-shiling_session=/.test(cookie), 'Expected a __Host- session cookie.');
  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/'])
    assert.ok(cookie.includes(attribute));
  assert.ok(!/;\s*Domain=/i.test(cookie), 'Session cookie must be host-only.');
  actor.cookie = cookie.split(';')[0];
  actor.csrfToken = response.data.csrfToken;
  actor.session = response.data;
  return response;
}
async function save(name) {
  if (!state.passed.includes(name)) state.passed.push(name);
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.info(`PASS ${name}`);
}
function docker(args, options = {}) {
  return execFileSync('docker', ['--context', state.context, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}
async function pool(items, concurrency, operation) {
  let cursor = 0;
  const results = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await operation(items[i], i);
      }
    }),
  );
  return results;
}
const percentile = (values, p) =>
  Number(
    [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)]?.toFixed(1),
  );
async function fixtures() {
  const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
  const sharp = require('sharp');
  // Deterministic noise is deliberately less compressible than a flat colour canvas.
  const raw = Buffer.alloc(1536 * 1024 * 3);
  let value = 42;
  for (let i = 0; i < raw.length; i++) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    raw[i] = value & 255;
  }
  const source = () => sharp(raw, { raw: { width: 1536, height: 1024, channels: 3 } });
  const videoPath = join(state.directory, 'capacity-720p.mp4');
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=24:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=6',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '22',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      videoPath,
    ],
    { stdio: 'ignore' },
  );
  return [
    {
      name: 'noise.png',
      media: 'image/png',
      type: 'image',
      bytes: await source().png().toBuffer(),
    },
    {
      name: 'noise.jpg',
      media: 'image/jpeg',
      type: 'image',
      bytes: await source().jpeg({ quality: 90 }).toBuffer(),
    },
    {
      name: 'noise.webp',
      media: 'image/webp',
      type: 'image',
      bytes: await source().webp({ quality: 85 }).toBuffer(),
    },
    {
      name: 'test-pattern.mp4',
      media: 'video/mp4',
      type: 'video',
      bytes: await readFile(videoPath),
    },
  ].map((item) => ({ ...item, sha256: hash(item.bytes) }));
}
const batch = async () =>
  post(
    member,
    `${team}/upload-batches`,
    { clientBatchId: randomUUID() },
    { key: true, status: 201 },
  );
async function itemIn(batchId, fixture, overrides = {}, status = 201) {
  return post(
    member,
    `${team}/upload-batches/${batchId}/items`,
    {
      clientItemId: randomUUID(),
      fileName: fixture.name,
      declaredBytes: String(fixture.bytes.length),
      declaredMediaType: fixture.media,
      typeHint: fixture.type,
      expectedSha256: fixture.sha256,
      initialMetadata: {
        title: fixture.name,
        description: 'HTTPS 容量合成素材',
        tagIds: [],
        collectionIds: [],
      },
      ...overrides,
    },
    { key: true, status },
  );
}
async function sendItem(batchId, fixture) {
  const started = performance.now();
  const item = await itemIn(batchId, fixture);
  const attempt = await post(member, `${team}/upload-items/${item.id}/attempts`, undefined, {
    key: true,
    status: 201,
  });
  const transferStart = performance.now();
  await request(member, `${team}/upload-attempts/${attempt.attemptId}/content`, {
    method: 'PUT',
    raw: true,
    body: fixture.bytes,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  const transferMs = performance.now() - transferStart;
  await post(
    member,
    `${team}/upload-attempts/${attempt.attemptId}/complete`,
    {},
    { key: true, status: 202 },
  );
  return { itemId: item.id, fixture, started, submitted: performance.now(), transferMs };
}
async function finished(entry, expected = 'ready') {
  for (let n = 0; n < 600; n++) {
    const item = await get(member, `${team}/upload-items/${entry.itemId}`);
    if (['ready', 'failed', 'canceled', 'expired'].includes(item.uiState)) {
      assert.equal(
        item.uiState,
        expected,
        `Upload terminal state: ${item.safeError?.code ?? item.uiState}`,
      );
      return { ...entry, item, readyAt: performance.now() };
    }
    await delay(500);
  }
  throw new Error('Queue did not drain within five minutes.');
}
async function checkArtifacts(result) {
  const asset = await get(member, `${team}/assets/${result.item.assetId}`);
  const expected =
    result.fixture.type === 'image'
      ? ['original', 'preview_image', 'thumbnail']
      : ['original', 'playback_video', 'poster'];
  assert.deepEqual(asset.artifacts.map((a) => a.role).sort(), expected.sort());
  for (const artifact of asset.artifacts) {
    const purpose =
      artifact.role === 'original'
        ? 'download'
        : artifact.role === 'playback_video'
          ? 'playback'
          : 'preview';
    const grant = await post(member, `${team}/assets/${asset.id}/delivery-grants`, {
      artifactId: artifact.id,
      purpose,
    });
    if (artifact.role === 'original')
      assert.equal(hash(await get(member, grant.url)), result.fixture.sha256);
    else
      assert.equal(
        (await get(member, grant.url, { headers: { Range: 'bytes=0-31' }, status: 206 })).length,
        32,
      );
    assert.equal(new URL(grant.url, state.origin).origin, state.origin);
  }
  return asset;
}
if (phase === 'seed') {
  assert.equal((await get({}, `${api}/bootstrap`)).initialized, false);
  await post({}, `${api}/setup/initialize`, credentials, { status: 201 });
  await login(admin, credentials);
  const roles = (await get(admin, `${management}/roles`)).items;
  const role = roles.find((r) => r.key === 'member' || r.name === '成员');
  assert.ok(role);
  const invited = await post(
    admin,
    `${management}/invitations`,
    { loginName: 'capacity.creator', roleId: role.id },
    { key: true, status: 201 },
  );
  const creator = {
    loginName: 'capacity.creator',
    displayName: '容量验收创作者',
    password: `Capacity-${randomUUID()}`,
  };
  await post(
    {},
    `${api}/auth/invitations/accept`,
    { ...creator, token: invited.token },
    { status: 201 },
  );
  await writeFile(join(state.directory, 'member.json'), JSON.stringify(creator), { mode: 0o600 });
  await save('HTTPS 初始化与成员邀请，Secure/HttpOnly/Host-only Cookie');
} else if (['proxy-probe', 'proxy'].includes(phase)) {
  const probe = async (client, spoof) => {
    const code = `const fs=require('node:fs'),https=require('node:https');let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const body=JSON.parse(data);const req=https.request({hostname:'shiling.test',ca:fs.readFileSync('/ca.crt'),path:'/api/v1/auth/login',method:'POST',headers:{Origin:'https://shiling.test','Content-Type':'application/json',...(body.spoof?{'X-Forwarded-For':body.spoof,'X-Real-IP':body.spoof}:{})}},res=>{res.resume();res.on('end',()=>console.log(res.statusCode))});req.end(JSON.stringify({loginName:'missing.user',password:'Invalid-password-0000'}));});`;
    return Number(
      docker(['exec', '-i', `${state.project}-${client}`, 'node', '-e', code], {
        input: JSON.stringify({ spoof }),
      }).trim(),
    );
  };
  const a = [];
  for (let i = 0; i < 11; i++) a.push(await probe('client-a', `198.51.100.${i + 1}`));
  const b = await probe('client-b', '203.0.113.15');
  await writeFile(
    join(state.directory, `${phase}.json`),
    JSON.stringify({ clientA: a, clientB: b }, null, 2),
  );
  if (phase === 'proxy') {
    assert.deepEqual(a, [...Array(10).fill(401), 429]);
    assert.equal(b, 401, 'A limited client must not exhaust another client quota.');
    await save('真实代理客户端地址分离限流，伪造转发头不能绕过');
  } else console.info(JSON.stringify({ clientA: a, clientB: b, sharedQuotaBug: b === 429 }));
} else if (phase === 'https') {
  await login(admin, credentials);
  await get(admin, `${api}/auth/session`);
  await request({}, `${api}/auth/session`, { status: 401 });
  await request({ cookie: admin.cookie }, `${api}/auth/logout`, {
    method: 'POST',
    body: {},
    status: 403,
  });
  await post(
    admin,
    `${api}/auth/logout`,
    {},
    { headers: { Origin: 'https://untrusted.test' }, status: 403 },
  );
  for (const path of ['/objects/probe', '/uploads/probe', '/preview/probe', '/internal/probe'])
    await request({}, path, { status: 404 });
  const insecure = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: state.httpPort,
        headers: { Host: 'shiling.test' },
        path: '/app/library?view=grid',
      },
      (res) => {
        res.resume();
        resolve({
          status: res.statusCode,
          location: res.headers.location,
          cookie: res.headers['set-cookie'],
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(insecure.status, 308);
  assert.equal(insecure.location, 'https://shiling.test/app/library?view=grid');
  assert.equal(insecure.cookie, undefined);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = httpsRequest(
        { hostname: '127.0.0.1', port: state.httpsPort, servername: 'shiling.test', agent: false },
        resolve,
      );
      req.on('error', reject);
      req.end();
    }),
  );
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: '127.0.0.1',
          port: state.httpsPort,
          servername: 'wrong.test',
          ca,
          agent: false,
        },
        resolve,
      );
      req.on('error', reject);
      req.end();
    }),
  );
  const jar = join(state.directory, 'cookies.txt');
  const common = [
    '--silent',
    '--show-error',
    '--noproxy',
    '*',
    '--cacert',
    join(state.directory, 'root.crt'),
    '--connect-to',
    `shiling.test:443:127.0.0.1:${state.httpsPort}`,
    '--connect-to',
    `shiling.test:80:127.0.0.1:${state.httpPort}`,
    '--connect-to',
    `preview.shiling.test:443:127.0.0.1:${state.httpsPort}`,
  ];
  const cookieLogin = spawnSync(
    'curl',
    [
      ...common,
      '--cookie-jar',
      jar,
      '-H',
      `Origin: ${state.origin}`,
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      '@-',
      `${state.origin}${api}/auth/login`,
    ],
    {
      input: JSON.stringify({ loginName: credentials.loginName, password: credentials.password }),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  assert.equal(cookieLogin.status, 0, 'Curl HTTPS login failed.');
  await chmod(jar, 0o600);
  const cookieRow = (await readFile(jar, 'utf8'))
    .split('\n')
    .find((line) => line.includes('__Host-shiling_session'));
  assert.ok(
    cookieRow && /^#HttpOnly_shiling\.test\s+FALSE\s+\/\s+TRUE\s+/.test(cookieRow),
    'Cookie engine must store a secure host-only cookie.',
  );
  // Curl's actual cookie engine, not a manually attached header, must withhold it over HTTP and from a sibling host.
  for (const url of ['http://shiling.test/app/login', 'https://preview.shiling.test/']) {
    const response = spawnSync(
      'curl',
      [...common, '--cookie', jar, '--verbose', '--output', '/dev/null', url],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.equal(response.status, 0);
    assert.ok(
      !/^> (?:Cookie:|.*__Host-shiling_session)/im.test(response.stderr),
      'Cookie engine sent the session to an insecure or sibling origin.',
    );
  }
  const session = execFileSync(
    'curl',
    [...common, '--cookie', jar, `${state.origin}${api}/auth/session`],
    { encoding: 'utf8' },
  );
  const curlSession = JSON.parse(session);
  assert.equal(curlSession.user.id, admin.session.user.id);
  const logoutHeaders = join(state.directory, 'logout-headers.txt');
  await writeFile(
    logoutHeaders,
    `Origin: ${state.origin}\nContent-Type: application/json\nX-CSRF-Token: ${curlSession.csrfToken}\n`,
    { mode: 0o600 },
  );
  const curlLogout = spawnSync(
    'curl',
    [
      ...common,
      '--cookie',
      jar,
      '--cookie-jar',
      jar,
      '-H',
      `@${logoutHeaders}`,
      '--data',
      '{}',
      '--write-out',
      '%{http_code}',
      `${state.origin}${api}/auth/logout`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.equal(curlLogout.status, 0);
  assert.equal(curlLogout.stdout, '204');
  assert.ok(
    !(await readFile(jar, 'utf8')).includes('__Host-shiling_session'),
    'Logout must clear the cookie jar.',
  );
  const logout = await request(admin, `${api}/auth/logout`, {
    method: 'POST',
    body: {},
    status: 204,
  });
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.match(logout.headers['set-cookie'][0], /Secure/);
  await request(admin, `${api}/auth/session`, { status: 401 });
  await save('HTTPS 重定向/证书校验、Secure Cookie、CSRF/Origin、退出与私有路径隔离');
} else if (phase === 'limits') {
  await login(admin, credentials);
  await login(member, JSON.parse(await readFile(join(state.directory, 'member.json'), 'utf8')));
  const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#244bc5' } })
    .png()
    .toBuffer();
  // Valid private ancillary PNG chunks add inert bytes, without a huge decoded pixel allocation.
  const limit = 100 * 1024 * 1024;
  const chunks = [png.subarray(0, -12)];
  let remaining = limit - png.length;
  while (remaining > 0) {
    let total = Math.min(1024 * 1024 + 12, remaining);
    if (remaining - total > 0 && remaining - total < 12) total -= 12 - (remaining - total);
    assert.ok(total >= 12);
    const chunk = Buffer.alloc(total);
    chunk.writeUInt32BE(total - 12, 0);
    chunk.write('npAD', 4, 'ascii');
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), total - 4);
    chunks.push(chunk);
    remaining -= total;
  }
  chunks.push(png.subarray(-12));
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.length, limit);
  assert.equal((await sharp(bytes).metadata()).width, 16);
  const fixture = {
    name: 'byte-boundary.png',
    media: 'image/png',
    type: 'image',
    bytes,
    sha256: hash(bytes),
  };
  const current = await batch();
  const started = performance.now();
  const result = await finished(await sendItem(current.id, fixture));
  await checkArtifacts(result);
  await itemIn(current.id, fixture, { declaredBytes: String(limit + 1) }, 413);
  const extra = await itemIn(current.id, { ...fixture, bytes: png, sha256: hash(png) });
  const attempt = await post(member, `${team}/upload-items/${extra.id}/attempts`, undefined, {
    key: true,
    status: 201,
  });
  await request(member, `${team}/upload-attempts/${attempt.attemptId}/content`, {
    method: 'PUT',
    raw: true,
    body: png,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': limit + 1 },
    status: 413,
  });
  await post(member, `${team}/upload-items/${extra.id}/cancel`, {}, { key: true });
  const boundary = `boundary-${randomUUID()}`;
  const multipart = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nlogo\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    Buffer.alloc(2 * 1024 * 1024 + 1),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  await post(admin, `${management}/branding-assets`, multipart, {
    raw: true,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    status: 413,
  });
  await get({}, '/health/ready');
  await writeFile(
    join(state.directory, 'limits-report.json'),
    JSON.stringify(
      {
        exactBytes: limit,
        transferMs: Number(result.transferMs.toFixed(1)),
        readySeconds: Number(((result.readyAt - started) / 1000).toFixed(2)),
        originalHashVerified: true,
        overLimitDeclaration: 413,
        overLimitContentLength: 413,
        overLimitBrandingFile: 413,
        note: '低像素 PNG 的合法私有 ancillary chunk 填充；只验证字节边界与流式交付，不代表高像素或长视频容量。',
      },
      null,
      2,
    ),
  );
  await save('100 MiB 精确字节上限上传/处理/摘要通过，超限声明/传输/品牌文件均 413');
} else if (phase === 'backlog') {
  await login(member, JSON.parse(await readFile(join(state.directory, 'member.json'), 'utf8')));
  const files = await fixtures();
  const compose = (args) =>
    docker([
      'compose',
      '-p',
      state.project,
      '--env-file',
      join(state.directory, 'compose.env'),
      '-f',
      'deploy/compose/compose.yaml',
      '-f',
      join(state.directory, 'override.json'),
      ...args,
    ]);
  compose(['stop', 'worker']);
  let results;
  let started;
  try {
    const current = await batch();
    const entries = await pool(
      Array.from({ length: 6 }, (_, i) => files[i % 4]),
      4,
      (file) => sendItem(current.id, file),
    );
    await delay(1000);
    for (const entry of entries)
      assert.equal(
        (await get(member, `${team}/upload-items/${entry.itemId}`)).uiState,
        'verifying',
      );
    started = performance.now();
    compose(['up', '-d', '--no-build', '--wait', 'worker']);
    results = await pool(entries, 6, (entry) => finished(entry));
    await pool(results, 3, checkArtifacts);
    await writeFile(
      join(state.directory, 'backlog-report.json'),
      JSON.stringify(
        {
          count: 6,
          acceptedWhileWorkerStopped: true,
          readyAfterRestartSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
          failed: 0,
        },
        null,
        2,
      ),
    );
    await save('worker 停止时 6 项上传持久排队，恢复后全部处理且产物摘要正确');
  } finally {
    compose(['up', '-d', '--no-build', '--wait', 'worker']);
  }
} else if (phase === 'capacity') {
  await login(admin, credentials);
  await login(member, JSON.parse(await readFile(join(state.directory, 'member.json'), 'utf8')));
  await request(member, `${management}/settings`, { status: 403 });
  const capabilities = await get(member, `${team}/capabilities`);
  const motion = capabilities.types.find((t) => t.id === 'web_motion');
  assert.equal(motion.acceptUploads, false);
  assert.equal(motion.executePreview, false);
  const files = await fixtures();
  const report = {
    fixtures: files.map(({ name, type, bytes, sha256 }) => ({
      name,
      type,
      bytes: bytes.length,
      sha256,
    })),
    stages: [],
    health: [],
    expectedFailures: [],
  };
  await writeFile(join(state.directory, 'capacity-report.json'), JSON.stringify(report, null, 2));
  let checking = false;
  let healthError;
  const healthTimer = setInterval(async () => {
    if (checking) return;
    checking = true;
    const started = performance.now();
    try {
      await get({}, '/health/ready');
      report.health.push(performance.now() - started);
    } catch (error) {
      healthError = error;
    } finally {
      checking = false;
    }
  }, 1000);
  let lastAsset;
  try {
    for (const [concurrency, count] of [
      [1, 4],
      [4, 12],
      [8, 24],
    ]) {
      const current = await batch();
      const started = performance.now();
      const metricStart = metrics.length;
      const entries = await pool(
        Array.from({ length: count }, (_, i) => files[i % files.length]),
        concurrency,
        (fixture) => sendItem(current.id, fixture),
      );
      const submitted = performance.now();
      const results = await pool(entries, count, (entry) => finished(entry));
      const ended = performance.now();
      const stageMetrics = metrics.slice(metricStart);
      const assets = await pool(results, 4, checkArtifacts);
      assert.equal(new Set(assets.map((asset) => asset.id)).size, count);
      lastAsset = assets[0];
      const stage = {
        concurrency,
        count,
        totalBytes: entries.reduce((sum, e) => sum + e.fixture.bytes.length, 0),
        uploadBurstSeconds: Number(((submitted - started) / 1000).toFixed(2)),
        allReadySeconds: Number(((ended - started) / 1000).toFixed(2)),
        endToEndP50Ms: percentile(
          results.map((e) => e.readyAt - e.started),
          0.5,
        ),
        endToEndP95Ms: percentile(
          results.map((e) => e.readyAt - e.started),
          0.95,
        ),
        transferP95Ms: percentile(
          results.map((e) => e.transferMs),
          0.95,
        ),
        requestP95Ms: percentile(
          stageMetrics.map((m) => m.ms),
          0.95,
        ),
        failed: 0,
      };
      report.stages.push(stage);
      await writeFile(
        join(state.directory, 'capacity-report.json'),
        JSON.stringify(report, null, 2),
      );
      console.info(JSON.stringify({ event: 'capacity.stage.passed', ...stage }));
    }
    const negativeBatch = await batch();
    await itemIn(negativeBatch.id, files[0], { declaredBytes: String(100 * 1024 * 1024 + 1) }, 413);
    report.expectedFailures.push('超过 100 MiB 的声明在创建前返回 413');
    await itemIn(
      negativeBatch.id,
      { ...files[0], name: 'disabled.html', type: 'web_motion', media: 'text/html' },
      {},
      403,
    );
    report.expectedFailures.push('动效上传 403');
    const corrupt = {
      name: 'corrupt.png',
      media: 'image/png',
      type: 'image',
      bytes: Buffer.from('not a png'),
    };
    corrupt.sha256 = hash(corrupt.bytes);
    const rejected = await finished(await sendItem(negativeBatch.id, corrupt), 'failed');
    assert.equal(rejected.item.safeError.code, 'IMAGE_DECODE_FAILED');
    report.expectedFailures.push('损坏图片在核验阶段安全失败');
    const badDigest = await finished(
      await sendItem(negativeBatch.id, { ...files[0], sha256: '0'.repeat(64) }),
      'failed',
    );
    assert.ok(badDigest.item.safeError.code);
    report.expectedFailures.push(`摘要不符安全失败：${badDigest.item.safeError.code}`);
    const interrupted = await itemIn(negativeBatch.id, files[0]);
    const attempt = await post(
      member,
      `${team}/upload-items/${interrupted.id}/attempts`,
      undefined,
      { key: true, status: 201 },
    );
    await new Promise((resolve) => {
      const req = httpsRequest({
        hostname: '127.0.0.1',
        port: state.httpsPort,
        servername: 'shiling.test',
        ca,
        method: 'PUT',
        path: `${team}/upload-attempts/${attempt.attemptId}/content`,
        headers: {
          Host: 'shiling.test',
          Origin: state.origin,
          Cookie: member.cookie,
          'X-CSRF-Token': member.csrfToken,
          'Content-Type': 'application/octet-stream',
          'Content-Length': files[0].bytes.length,
        },
      });
      req.on('error', () => resolve());
      req.write(files[0].bytes.subarray(0, 65536));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 150);
    });
    await finished({ itemId: interrupted.id }, 'failed');
    const retry = await post(
      member,
      `${team}/upload-items/${interrupted.id}/retry`,
      { scope: 'transfer' },
      { key: true, status: 202 },
    );
    await request(member, `${team}/upload-attempts/${retry.attemptId}/content`, {
      method: 'PUT',
      body: files[0].bytes,
      raw: true,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    await post(
      member,
      `${team}/upload-attempts/${retry.attemptId}/complete`,
      {},
      { key: true, status: 202 },
    );
    await checkArtifacts(await finished({ itemId: interrupted.id, fixture: files[0] }));
    report.expectedFailures.push('中断上传进入失败态，重新传输后 ready 且摘要一致');
    // Publication still follows ownership after load: administrators cannot publish a member asset.
    const settings = await get(admin, `${management}/settings`);
    await request(admin, `${management}/settings`, {
      method: 'PATCH',
      revision: settings.revision,
      body: { publicEnabled: true },
    });
    const pub = await get(member, `${team}/assets/${lastAsset.id}/publication`);
    const body = {
      expectedAssetRevision: lastAsset.revision,
      expectedPublicationRevision: pub.revision,
      versionId: lastAsset.currentVersionId,
      publicMetadata: { title: 'HTTPS 并发验收', description: '合成数据', tagIds: [] },
    };
    await post(admin, `${team}/assets/${lastAsset.id}/publish`, body, { key: true, status: 403 });
    await post(member, `${team}/assets/${lastAsset.id}/publish`, body, { key: true, status: 201 });
    const publicAsset = await get({}, `${api}/public/assets/${lastAsset.id}`);
    assert.ok(!('ownerId' in publicAsset));
    const grant = await post({}, `${api}/public/assets/${lastAsset.id}/delivery-grants`, {
      artifactId: publicAsset.artifacts.find((a) => a.role === 'original').id,
      purpose: 'download',
    });
    assert.equal(new URL(grant.url, state.origin).origin, state.origin);
    assert.equal(hash(await get({}, grant.url)), files[0].sha256);
    assert.equal((await get(admin, `${management}/operations`)).preview.executionEnabled, false);
    assert.ok(!healthError, 'Readiness failed during capacity test.');
    report.healthP95Ms = percentile(report.health, 0.95);
    report.healthSamples = report.health.length;
    report.passed = true;
    await save('1/4/8 并发 40 个图片/MP4 处理、摘要与产物、失败恢复、HTTPS 公开权限通过');
  } finally {
    clearInterval(healthTimer);
    while (checking) await delay(50);
    await writeFile(join(state.directory, 'capacity-report.json'), JSON.stringify(report, null, 2));
  }
} else throw new Error('Unknown phase. See tests/deployment/https-capacity.md.');
agent.destroy();
