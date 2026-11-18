/** Run only against an explicitly prepared local fixture. All resources are synthetic. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const { Blob, FormData } = globalThis;

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (['docker-acceptance', 'local-acceptance'].includes(config.fixtureKind)) {
  const target = new URL(config.baseUrl);
  assert.equal(target.protocol, 'http:');
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.origin, config.baseUrl);
  assert.equal(config.origin, config.baseUrl);
} else {
  assert.equal(config.baseUrl, 'http://127.0.0.1:3000');
}
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const sharp = require('sharp');
const report = [];
const anonymous = {};
const admin = {};
const member = {};
const api = '/api/v1';
const team = `${api}/team`;
const management = `${team}/admin`;
const password = config.password;
const memberPassword = `Member-${randomUUID()}`;
const nextPassword = `Changed-${randomUUID()}`;
const recoveredPassword = `Recovered-${randomUUID()}`;
const loginTimes = [];

async function request(actor, path, options = {}) {
  const method = options.method ?? 'GET';
  const headers = { ...(actor.cookie ? { Cookie: actor.cookie } : {}), ...options.headers };
  if (!['GET', 'HEAD'].includes(method)) {
    headers.Origin = config.origin;
    if (actor.csrfToken) headers['X-CSRF-Token'] = actor.csrfToken;
  }
  if (options.revision) headers['If-Match'] = `"${options.revision}"`;
  if (options.key) headers['Idempotency-Key'] = options.key === true ? randomUUID() : options.key;
  let body = options.body;
  if (body !== undefined && !options.raw) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const url = new URL(path, config.baseUrl);
  assert.ok([config.baseUrl, config.origin].includes(url.origin), 'No external requests allowed.');
  const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15000) });
  const data =
    response.status === 204
      ? null
      : response.headers.get('content-type')?.includes('json')
        ? await response.json()
        : Buffer.from(await response.arrayBuffer());
  const expected = options.status ?? 200;
  assert.equal(
    response.status,
    expected,
    `${method} ${url.pathname}: expected ${expected}, got ${response.status} ${data?.code ?? ''}`,
  );
  if (options.code) assert.equal(data?.code, options.code);
  return { data, response };
}
const get = async (actor, path) => (await request(actor, path)).data;
const post = async (actor, path, body, options = {}) =>
  (await request(actor, path, { method: 'POST', body, ...options })).data;
const patch = async (actor, path, body, revision, options = {}) =>
  (await request(actor, path, { method: 'PATCH', body, revision, ...options })).data;
async function login(actor, loginName, value) {
  while (loginTimes.length && Date.now() - loginTimes[0] > 61000) loginTimes.shift();
  if (loginTimes.length >= 9) await delay(61000 - (Date.now() - loginTimes[0]));
  loginTimes.push(Date.now());
  const result = await request(anonymous, `${api}/auth/login`, {
    method: 'POST',
    body: { loginName, password: value },
  });
  actor.cookie = result.response.headers.getSetCookie()[0].split(';')[0];
  actor.csrfToken = result.data.csrfToken;
  actor.session = result.data;
  assert.match(result.response.headers.getSetCookie()[0], /HttpOnly/);
}
async function check(name, operation) {
  await operation();
  report.push(name);
  await writeFile(
    join(config.directory, 'report.json'),
    JSON.stringify({ passed: report }, null, 2),
  );
  console.info(`PASS ${name}`);
}
function noIdentity(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      !/^(owner(Id)?|uploader(Id)?|member(Id)?|actorId|createdBy|updatedBy)$/i.test(key),
      `Public identity field: ${key}`,
    );
    noIdentity(child);
  }
}
let roles,
  memberRole,
  viewerRole,
  invite,
  settings,
  collection,
  tag,
  asset,
  video,
  published,
  download;
const imageBytes = await sharp({
  create: { width: 800, height: 600, channels: 3, background: '#244bc5' },
})
  .png()
  .toBuffer();
await writeFile(join(config.directory, 'synthetic-brand.png'), imageBytes);

await check('初始化、重复初始化保护与会话 Cookie', async () => {
  assert.equal((await get(anonymous, `${api}/bootstrap`)).initialized, false);
  const body = {
    setupToken: config.setupToken,
    loginName: 'admin',
    displayName: '验收管理员',
    password,
  };
  await post(anonymous, `${api}/setup/initialize`, body, { status: 201 });
  await post(anonymous, `${api}/setup/initialize`, body, {
    status: 409,
    code: 'ALREADY_INITIALIZED',
  });
  await login(admin, 'admin', password);
  await request(anonymous, `${management}/settings`, { status: 401 });
  settings = await get(admin, `${management}/settings`);
  await request({ cookie: admin.cookie }, `${management}/settings`, {
    method: 'PATCH',
    revision: settings.revision,
    body: { name: '不应保存' },
    status: 403,
  });
});
await check('角色依赖、不可委派系统能力、系统角色与最后管理员保护', async () => {
  roles = (await get(admin, `${management}/roles`)).items;
  memberRole = roles.find((role) => role.key === 'member');
  assert.ok(memberRole);
  await post(
    admin,
    `${management}/roles`,
    { name: '缺少依赖', permissionKeys: ['assets.download'] },
    { key: true, status: 400, code: 'ROLE_DEPENDENCY_MISSING' },
  );
  await post(
    admin,
    `${management}/roles`,
    { name: '越权', permissionKeys: ['system.members.manage'] },
    { key: true, status: 400 },
  );
  viewerRole = await post(
    admin,
    `${management}/roles`,
    { name: '验收只读成员', permissionKeys: ['assets.read', 'tags.read', 'collections.read'] },
    { key: true, status: 201 },
  );
  const systemRole = roles.find((role) => role.id === admin.session.role.id);
  await patch(
    admin,
    `${management}/roles/${systemRole.id}`,
    { name: '无效修改', permissionKeys: [] },
    systemRole.revision,
    { status: 403, code: 'SYSTEM_ROLE_IMMUTABLE' },
  );
  await post(
    admin,
    `${management}/members/${admin.session.user.id}/disable`,
    { expectedRevision: admin.session.user.revision },
    { status: 409, code: 'LAST_ADMIN_REQUIRED' },
  );
});
await check('邀请幂等、重发使旧令牌失效、预留账号与接受后不可复用', async () => {
  const key = randomUUID();
  const body = { loginName: 'e2e.creator', roleId: memberRole.id };
  invite = await post(admin, `${management}/invitations`, body, { key, status: 201 });
  const replay = await post(admin, `${management}/invitations`, body, { key });
  assert.equal(replay.token, null);
  assert.equal(replay.invitation.id, invite.invitation.id);
  const oldToken = invite.token;
  invite = await post(
    admin,
    `${management}/invitations/${invite.invitation.id}/reissue`,
    { expectedRevision: invite.invitation.revision },
    { key: true },
  );
  await post(anonymous, `${api}/auth/invitations/inspect`, { token: oldToken }, { status: 410 });
  await post(anonymous, `${api}/auth/invitations/inspect`, { token: invite.token });
  const accept = {
    token: invite.token,
    loginName: 'e2e.creator',
    displayName: '验收创作者',
    password: memberPassword,
  };
  await post(
    anonymous,
    `${api}/auth/invitations/accept`,
    { ...accept, loginName: 'wrong.creator' },
    { status: 409 },
  );
  await post(anonymous, `${api}/auth/invitations/accept`, accept, { status: 201 });
  await post(anonymous, `${api}/auth/invitations/accept`, accept, { status: 410 });
  await login(member, 'e2e.creator', memberPassword);
  const revoke = await post(
    admin,
    `${management}/invitations`,
    { roleId: memberRole.id },
    { key: true, status: 201 },
  );
  await post(admin, `${management}/invitations/${revoke.invitation.id}/revoke`, {
    expectedRevision: revoke.invitation.revision,
  });
  await post(
    anonymous,
    `${api}/auth/invitations/inspect`,
    { token: revoke.token },
    { status: 410 },
  );
});
await check('普通成员直接调用管理与标签治理接口被拒绝', async () => {
  for (const path of ['members', 'roles', 'settings', 'jobs', 'audit-events', 'operations'])
    await request(member, `${management}/${path}`, { status: 403 });
  await post(member, `${team}/tags`, { name: '越权标签' }, { key: true, status: 403 });
  const form = new FormData();
  form.set('purpose', 'logo');
  form.set('file', new Blob([imageBytes], { type: 'image/png' }), 'synthetic.png');
  await post(member, `${management}/branding-assets`, form, { raw: true, status: 403 });
});
await check('品牌 PNG/JPEG/WebP 真实上传、应用、匿名读取和恶意输入拒绝', async () => {
  const candidates = {};
  for (const format of ['png', 'jpeg', 'webp']) {
    const bytes = await sharp(imageBytes).toFormat(format).toBuffer();
    const form = new FormData();
    form.set('purpose', format === 'webp' ? 'favicon' : 'logo');
    form.set('file', new Blob([bytes], { type: `image/${format}` }), `synthetic.${format}`);
    candidates[format] = await post(admin, `${management}/branding-assets`, form, {
      raw: true,
      status: 201,
    });
  }
  settings = await patch(
    admin,
    `${management}/settings`,
    {
      brand: {
        name: '拾灵验收空间',
        description: '真实 API 合成数据验收',
        primaryColor: '#244bc5',
      },
      logoBrandingAssetId: candidates.png.brandingAssetId,
      faviconBrandingAssetId: candidates.webp.brandingAssetId,
    },
    settings.revision,
  );
  const bootstrap = await get(anonymous, `${api}/bootstrap`);
  assert.ok(bootstrap.brand.logoUrl && bootstrap.brand.faviconUrl);
  for (const purpose of ['logo', 'favicon']) {
    const response = await request(anonymous, `${api}/branding/${purpose}`);
    assert.equal(response.response.headers.get('content-type'), 'image/png');
    assert.equal(response.response.headers.get('cache-control'), 'no-store');
    const meta = await sharp(response.data).metadata();
    assert.ok(meta.width <= (purpose === 'logo' ? 1024 : 512));
  }
  for (const [type, bytes, status] of [
    ['image/svg+xml', Buffer.from('<svg><script>alert(1)</script></svg>'), 415],
    ['image/png', Buffer.from('not-a-png'), 415],
    ['image/png', Buffer.alloc(2 * 1024 * 1024 + 1), 413],
  ]) {
    const form = new FormData();
    form.set('purpose', 'logo');
    form.set('file', new Blob([bytes], { type }), 'invalid.png');
    await post(admin, `${management}/branding-assets`, form, { raw: true, status });
  }
  await patch(
    admin,
    `${management}/settings`,
    { logoBrandingAssetId: candidates.webp.brandingAssetId },
    settings.revision,
    { status: 409 },
  );
  await patch(admin, `${management}/settings`, { name: '冲突写入' }, '1', { status: 412 });
});
async function upload(bytes, name, type, mediaType) {
  const batch = await post(
    member,
    `${team}/upload-batches`,
    { clientBatchId: randomUUID() },
    { key: true, status: 201 },
  );
  const item = await post(
    member,
    `${team}/upload-batches/${batch.id}/items`,
    {
      clientItemId: randomUUID(),
      fileName: name,
      declaredBytes: String(bytes.length),
      declaredMediaType: mediaType,
      typeHint: type,
      expectedSha256: createHash('sha256').update(bytes).digest('hex'),
      initialMetadata: {
        title: name,
        description: '真实 API 与 worker 合成素材',
        tagIds: [tag.id],
        collectionIds: [],
      },
    },
    { key: true, status: 201 },
  );
  const attempt = await post(member, `${team}/upload-items/${item.id}/attempts`, undefined, {
    key: true,
    status: 201,
  });
  await request(member, `${team}/upload-attempts/${attempt.attemptId}/content`, {
    method: 'PUT',
    body: bytes,
    raw: true,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  await post(
    member,
    `${team}/upload-attempts/${attempt.attemptId}/complete`,
    {},
    { key: true, status: 202 },
  );
  let completed;
  for (let n = 0; n < 120; n++) {
    completed = await get(member, `${team}/upload-items/${item.id}`);
    if (['ready', 'failed', 'canceled', 'expired'].includes(completed.uiState)) break;
    await delay(500);
  }
  assert.equal(
    completed.uiState,
    'ready',
    `Worker ${type}: ${completed.safeError?.code ?? completed.uiState}`,
  );
  return get(member, `${team}/assets/${completed.assetId}`);
}
await check('真实队列与 worker 完成图片、MP4 处理和原文件读取', async () => {
  tag = await post(
    admin,
    `${team}/tags`,
    { name: '端到端验收', description: '合成素材' },
    { key: true, status: 201 },
  );
  asset = await upload(imageBytes, '蓝色画布.png', 'image', 'image/png');
  assert.ok(asset.artifacts.some((a) => a.role === 'thumbnail'));
  const videoPath = join(config.directory, 'synthetic.mp4');
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x244bc5:s=320x240:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      videoPath,
    ],
    { stdio: 'ignore' },
  );
  video = await upload(await readFile(videoPath), '蓝色视频.mp4', 'video', 'video/mp4');
  const original = asset.artifacts.find((a) => a.role === 'original');
  const grant = await post(member, `${team}/assets/${asset.id}/delivery-grants`, {
    artifactId: original.id,
    purpose: 'download',
  });
  const bytes = await get(member, grant.url);
  assert.deepEqual(bytes, imageBytes);
});
await check('集合创建、批量加入移除、收藏、标签与编辑冲突', async () => {
  collection = await post(
    member,
    `${team}/collections`,
    { name: '验收项目素材', description: '真实整理流程' },
    { key: true, status: 201 },
  );
  collection = await post(
    member,
    `${team}/collections/${collection.id}/items:batch`,
    { expectedRevision: collection.revision, action: 'add', assetIds: [asset.id, video.id] },
    { key: true },
  );
  assert.equal((await get(member, `${team}/collections/${collection.id}/items`)).items.length, 2);
  await request(member, `${team}/me/favorites/${asset.id}`, { method: 'PUT' });
  assert.ok((await get(member, `${team}/me/favorites`)).items.some((a) => a.id === asset.id));
  await request(member, `${team}/me/favorites/${asset.id}`, { method: 'DELETE' });
  const revision = asset.revision;
  asset = await patch(
    member,
    `${team}/assets/${asset.id}`,
    { title: '蓝色画布 · 团队版' },
    revision,
  );
  await patch(member, `${team}/assets/${asset.id}`, { title: '旧版冲突' }, revision, {
    status: 412,
  });
  collection = await post(
    member,
    `${team}/collections/${collection.id}/items:batch`,
    { expectedRevision: collection.revision, action: 'remove', assetIds: [video.id] },
    { key: true },
  );
  assert.equal((await get(member, `${team}/collections/${collection.id}/items`)).items.length, 1);
});
async function publish(actor, current, title, options = {}) {
  const publication = await get(member, `${team}/assets/${current.id}/publication`);
  return post(
    actor,
    `${team}/assets/${current.id}/publish`,
    {
      expectedAssetRevision: current.revision,
      expectedPublicationRevision: publication.revision,
      versionId: current.currentVersionId,
      publicMetadata: { title, description: '可公开的合成素材', tagIds: [tag.id] },
    },
    { key: true, status: publication.state === 'none' ? 201 : 200, ...options },
  );
}
await check('仅所有者可公开、公开快照独立、游客下载与 Range', async () => {
  settings = await patch(
    admin,
    `${management}/settings`,
    { publicEnabled: true },
    settings.revision,
  );
  await publish(admin, asset, '他人代公开', { status: 403 });
  published = await publish(member, asset, '蓝色画布 · 公开版');
  const publicAsset = await get(anonymous, `${api}/public/assets/${asset.id}`);
  noIdentity(publicAsset);
  noIdentity(await get(anonymous, `${api}/public/assets`));
  asset = await get(member, `${team}/assets/${asset.id}`);
  asset = await patch(
    member,
    `${team}/assets/${asset.id}`,
    { title: '蓝色画布 · 内部修改' },
    asset.revision,
  );
  assert.equal(
    (await get(anonymous, `${api}/public/assets/${asset.id}`)).title,
    '蓝色画布 · 公开版',
  );
  download = await post(anonymous, `${api}/public/assets/${asset.id}/delivery-grants`, {
    artifactId: publicAsset.artifacts.find((a) => a.role === 'original').id,
    purpose: 'download',
  });
  assert.deepEqual(await get(anonymous, download.url), imageBytes);
  const range = await request(anonymous, download.url, {
    headers: { Range: 'bytes=0-15' },
    status: 206,
  });
  assert.equal(range.data.length, 16);
  published = await publish(member, asset, '蓝色画布 · 公开更新');
  assert.equal(
    (await get(anonymous, `${api}/public/assets/${asset.id}`)).title,
    '蓝色画布 · 公开更新',
  );
  await request(anonymous, download.url, { status: 404 });
});
await check('关闭重开仅恢复有效快照、旧 grant 失效、撤回归档后不复活', async () => {
  const publicAsset = await get(anonymous, `${api}/public/assets/${asset.id}`);
  download = await post(anonymous, `${api}/public/assets/${asset.id}/delivery-grants`, {
    artifactId: publicAsset.artifacts.find((a) => a.role === 'original').id,
    purpose: 'download',
  });
  settings = await patch(
    admin,
    `${management}/settings`,
    { publicEnabled: false },
    settings.revision,
  );
  await request(anonymous, `${api}/public/assets/${asset.id}`, { status: 404 });
  settings = await patch(
    admin,
    `${management}/settings`,
    { publicEnabled: true },
    settings.revision,
  );
  await get(anonymous, `${api}/public/assets/${asset.id}`);
  await request(anonymous, download.url, { status: 404 });
  published = await get(member, `${team}/assets/${asset.id}/publication`);
  await post(
    admin,
    `${team}/assets/${asset.id}/withdraw`,
    { expectedRevision: published.revision },
    { key: true },
  );
  await request(anonymous, `${api}/public/assets/${asset.id}`, { status: 404 });
  asset = await get(member, `${team}/assets/${asset.id}`);
  await publish(admin, asset, '他人重新公开', { status: 403 });
  await publish(member, asset, '蓝色画布 · 恢复公开');
  asset = await get(member, `${team}/assets/${asset.id}`);
  asset = await post(
    member,
    `${team}/assets/${asset.id}/archive`,
    { expectedRevision: asset.revision },
    { key: true },
  );
  await request(anonymous, `${api}/public/assets/${asset.id}`, { status: 404 });
  asset = await post(
    member,
    `${team}/assets/${asset.id}/restore`,
    { expectedRevision: asset.revision },
    { key: true },
  );
  settings = await patch(
    admin,
    `${management}/settings`,
    { publicEnabled: false },
    settings.revision,
  );
  settings = await patch(
    admin,
    `${management}/settings`,
    { publicEnabled: true },
    settings.revision,
  );
  await request(anonymous, `${api}/public/assets/${asset.id}`, { status: 404 });
  await publish(member, asset, '蓝色画布 · 公开验收');
});
await check('角色降权立即生效、停用成员撤销会话、恢复不复活旧会话', async () => {
  let user = (await get(admin, `${management}/members`)).items.find(
    (u) => u.id === member.session.user.id,
  );
  user = await post(admin, `${management}/members/${user.id}/change-role`, {
    roleId: viewerRole.id,
    expectedRevision: user.revision,
  });
  await request(member, `${api}/auth/session`, { status: 401 });
  await login(member, 'e2e.creator', memberPassword);
  await post(
    member,
    `${team}/upload-batches`,
    { clientBatchId: randomUUID() },
    { key: true, status: 403 },
  );
  await post(
    admin,
    `${management}/roles/${viewerRole.id}/retire`,
    { expectedRevision: viewerRole.revision },
    { status: 409 },
  );
  user = await post(admin, `${management}/members/${user.id}/change-role`, {
    roleId: memberRole.id,
    expectedRevision: user.revision,
  });
  user = await post(admin, `${management}/members/${user.id}/disable`, {
    expectedRevision: user.revision,
  });
  await request(member, `${api}/auth/session`, { status: 401 });
  await post(admin, `${management}/members/${user.id}/enable`, { expectedRevision: user.revision });
  await request(member, `${api}/auth/session`, { status: 401 });
  await login(member, 'e2e.creator', memberPassword);
});
await check('密码修改、恢复令牌一次性与全部退出撤销旧会话', async () => {
  const second = {};
  await login(second, 'e2e.creator', memberPassword);
  await patch(
    member,
    `${api}/auth/change-password`,
    { currentPassword: memberPassword, newPassword: nextPassword },
    undefined,
    { status: 204 },
  );
  await request(second, `${api}/auth/session`, { status: 401 });
  await request(member, `${api}/auth/session`, { status: 401 });
  await login(member, 'e2e.creator', nextPassword);
  const key = randomUUID();
  const recovery = await post(
    admin,
    `${management}/members/${member.session.user.id}/recovery-tokens`,
    {},
    { key, status: 201 },
  );
  assert.equal(
    (
      await post(
        admin,
        `${management}/members/${member.session.user.id}/recovery-tokens`,
        {},
        { key },
      )
    ).token,
    null,
  );
  const inspected = await post(anonymous, `${api}/auth/recovery/inspect`, {
    token: recovery.token,
  });
  assert.deepEqual(Object.keys(inspected), ['expiresAt']);
  await post(
    anonymous,
    `${api}/auth/recovery/complete`,
    { token: recovery.token, newPassword: recoveredPassword },
    { status: 204 },
  );
  await request(member, `${api}/auth/session`, { status: 401 });
  await post(
    anonymous,
    `${api}/auth/recovery/complete`,
    { token: recovery.token, newPassword: nextPassword },
    { status: 410 },
  );
  await login(member, 'e2e.creator', recoveredPassword);
  await post(member, `${api}/auth/logout-all`, {}, { status: 204 });
  await request(member, `${api}/auth/session`, { status: 401 });
});
await check('真实处理任务、执行记录、审计筛选与运行状态', async () => {
  const jobs = await get(admin, `${management}/jobs?state=succeeded`);
  assert.ok(jobs.items.length >= 2);
  const job = await get(admin, `${management}/jobs/${jobs.items[0].id}`);
  assert.ok(job.attempts.length && !job.actions.retry);
  const audit = await get(admin, `${management}/audit-events?action=publication.snapshot_written`);
  assert.ok(
    audit.items.length && audit.items.every((e) => e.action === 'publication.snapshot_written'),
  );
  for (const path of [
    `${management}/jobs?state=succeeded`,
    `${management}/audit-events?action=publication.snapshot_written`,
  ]) {
    const seen = [];
    let cursor = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await get(
        admin,
        `${path}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      seen.push(...page.items);
      cursor = page.pageInfo.nextCursor;
      if (!page.pageInfo.hasMore) break;
      assert.ok(cursor);
    }
    assert.ok(seen.length >= 2);
    assert.equal(new Set(seen.map((item) => item.id)).size, seen.length);
    assert.deepEqual(
      seen.map((item) => item.createdAt),
      seen
        .map((item) => item.createdAt)
        .sort()
        .reverse(),
    );
  }
  const operations = await get(admin, `${management}/operations`);
  assert.equal(operations.database.reachable, true);
  assert.equal(operations.preview.executionEnabled, false);
});
await writeFile(
  join(config.directory, 'browser-fixture.json'),
  JSON.stringify({
    admin: { loginName: 'admin', password },
    member: { loginName: 'e2e.creator', password: recoveredPassword },
    assetId: asset.id,
    videoId: video.id,
    collectionId: collection.id,
    brandingPath: join(config.directory, 'synthetic-brand.png'),
  }),
  { mode: 0o600 },
);
console.info(JSON.stringify({ passed: report.length, browserFixtureReady: true }));
