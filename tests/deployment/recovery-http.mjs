/** Business assertions for the isolated Docker acceptance runner. Credentials stay in private temp files. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [phase, statePath] = process.argv.slice(2);
const state = JSON.parse(await readFile(statePath, 'utf8'));
assert.match(state.source, /^shiling-acceptance-[a-f0-9]{10}$/);
const fixture = JSON.parse(await readFile(join(state.directory, 'browser-fixture.json'), 'utf8'));
const restored = ['after-restore', 'republish', 'availability'].includes(phase);
const base = `http://127.0.0.1:${restored ? state.restoredPort : state.sourcePort}`;
const api = '/api/v1';
const team = `${api}/team`;
const management = `${team}/admin`;
const admin = {};
const member = {};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function request(actor, path, options = {}) {
  const originalUrl = new URL(path, base);
  assert.ok([base, `http://127.0.0.1:${state.sourcePort}`].includes(originalUrl.origin));
  const url = new URL(`${originalUrl.pathname}${originalUrl.search}`, base);
  const method = options.method ?? 'GET';
  const headers = { ...(actor.cookie ? { Cookie: actor.cookie } : {}), ...options.headers };
  if (!['GET', 'HEAD'].includes(method)) {
    headers.Origin = base;
    if (actor.csrfToken) headers['X-CSRF-Token'] = actor.csrfToken;
  }
  if (options.revision) headers['If-Match'] = `"${options.revision}"`;
  if (options.key) headers['Idempotency-Key'] = randomUUID();
  let body = options.body;
  if (body !== undefined && !options.raw) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15000) });
  const data =
    response.status === 204
      ? null
      : response.headers.get('content-type')?.includes('json')
        ? await response.json()
        : Buffer.from(await response.arrayBuffer());
  assert.equal(
    response.status,
    options.status ?? 200,
    `${method} ${url.pathname}: ${response.status} ${data?.code ?? ''}`,
  );
  return { data, response };
}
const get = async (actor, path, options) => (await request(actor, path, options)).data;
const post = async (actor, path, body, options = {}) =>
  (await request(actor, path, { method: 'POST', body, ...options })).data;
const patch = async (actor, path, body, revision) =>
  (await request(actor, path, { method: 'PATCH', body, revision })).data;
async function login(actor, credentials) {
  const result = await request({}, `${api}/auth/login`, { method: 'POST', body: credentials });
  actor.cookie = result.response.headers.getSetCookie()[0].split(';')[0];
  actor.csrfToken = result.data.csrfToken;
  actor.session = result.data;
}
async function pass(name) {
  if (!state.passed.includes(name)) state.passed.push(name);
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.info(`PASS ${name}`);
}
async function fingerprint() {
  const assets = [];
  for (const id of [fixture.assetId, fixture.videoId]) {
    const asset = await get(member, `${team}/assets/${id}`);
    const artifacts = [];
    for (const artifact of asset.artifacts) {
      const grant = await post(member, `${team}/assets/${id}/delivery-grants`, {
        artifactId: artifact.id,
        purpose:
          artifact.role === 'original'
            ? 'download'
            : artifact.role === 'playback_video'
              ? 'playback'
              : 'preview',
      });
      artifacts.push({
        id: artifact.id,
        role: artifact.role,
        sha256: hash(await get(member, grant.url)),
      });
    }
    assets.push({ id, title: asset.title, currentVersionId: asset.currentVersionId, artifacts });
  }
  const collection = await get(member, `${team}/collections/${fixture.collectionId}`);
  const items = await get(member, `${team}/collections/${fixture.collectionId}/items`);
  return {
    assets,
    collection: {
      id: collection.id,
      name: collection.name,
      assetIds: items.items.map((item) => item.id),
    },
    logo: hash(await get({}, `${api}/branding/logo`)),
    favicon: hash(await get({}, `${api}/branding/favicon`)),
    brand: (await get({}, `${api}/bootstrap`)).brand,
  };
}
async function upload(waitForReady) {
  const bytes = await readFile(join(state.directory, 'synthetic-brand.png'));
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
      fileName: '恢复验收.png',
      declaredBytes: String(bytes.length),
      declaredMediaType: 'image/png',
      typeHint: 'image',
      expectedSha256: hash(bytes),
      initialMetadata: {
        title: '恢复验收',
        description: '合成样例',
        tagIds: [],
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
  let result;
  for (let i = 0; i < (waitForReady ? 120 : 1); i++) {
    result = await get(member, `${team}/upload-items/${item.id}`);
    if (['ready', 'failed'].includes(result.uiState)) break;
    if (waitForReady) await delay(500);
  }
  assert.equal(result.uiState, waitForReady ? 'ready' : 'verifying');
  return { itemId: item.id, attemptId: attempt.attemptId, assetId: result.assetId };
}
await login(admin, fixture.admin);
await login(member, fixture.member);
if (phase === 'baseline') {
  state.fingerprint = await fingerprint();
  await pass('持久化前素材、图片/视频全部产物、品牌与集合摘要采样');
} else if (phase === 'persistence') {
  assert.deepEqual(await fingerprint(), state.fingerprint);
  await get({}, `${api}/public/assets/${fixture.assetId}`);
  await upload(true);
  await pass('重建容器后数据库内容、品牌和全部媒体摘要一致，新任务仍可完成');
} else if (phase === 'checkpoint') {
  assert.deepEqual(await fingerprint(), state.fingerprint);
  const invitation = await post(
    admin,
    `${management}/invitations`,
    { loginName: `restore.${randomUUID().slice(0, 8)}`, roleId: member.session.role.id },
    { key: true, status: 201 },
  );
  const recovery = await post(
    admin,
    `${management}/members/${member.session.user.id}/recovery-tokens`,
    {},
    { key: true, status: 201 },
  );
  const publicAsset = await get({}, `${api}/public/assets/${fixture.assetId}`);
  const grant = await post({}, `${api}/public/assets/${fixture.assetId}/delivery-grants`, {
    artifactId: publicAsset.artifacts.find((a) => a.role === 'original').id,
    purpose: 'download',
  });
  await get({}, grant.url);
  const pending = await upload(false);
  await writeFile(
    join(state.directory, 'recovery-probes.json'),
    JSON.stringify({
      oldAdmin: admin,
      oldMember: member,
      invitation: invitation.token,
      recovery: recovery.token,
      grant,
      pending,
      capturedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  await pass('恢复前凭据、公开 grant 与待处理任务采样');
} else if (phase === 'post-backup') {
  const asset = await get(member, `${team}/assets/${fixture.assetId}`);
  await patch(member, `${team}/assets/${asset.id}`, { title: '备份点之后的修改' }, asset.revision);
  assert.equal((await get(member, `${team}/assets/${asset.id}`)).title, '备份点之后的修改');
  await pass('原实例备份点后写入标记，恢复副本必须回到备份点');
} else if (phase === 'after-restore') {
  const probes = JSON.parse(await readFile(join(state.directory, 'recovery-probes.json'), 'utf8'));
  assert.ok(
    Date.parse(probes.grant.expiresAt) > Date.now(),
    'Old grant must still be unexpired for a meaningful revocation assertion.',
  );
  await request(probes.oldAdmin, `${api}/auth/session`, { status: 401 });
  await request(probes.oldMember, `${api}/auth/session`, { status: 401 });
  await post({}, `${api}/auth/invitations/inspect`, { token: probes.invitation }, { status: 410 });
  await post({}, `${api}/auth/recovery/inspect`, { token: probes.recovery }, { status: 410 });
  await request({}, probes.grant.url, { status: 404 });
  await request({}, `${api}/public/assets/${fixture.assetId}`, { status: 404 });
  const settings = await get(admin, `${management}/settings`);
  assert.equal(settings.publicEnabled, false);
  assert.equal(
    (await get(member, `${team}/assets/${fixture.assetId}/publication`)).state,
    'withdrawn',
  );
  const pending = await get(member, `${team}/upload-items/${probes.pending.itemId}`);
  assert.equal(pending.uiState, 'failed');
  assert.equal(pending.safeError.code, 'RESTORE_EPOCH_REVOKED');
  assert.deepEqual(await fingerprint(), state.fingerprint);
  await upload(true);
  assert.equal((await get(admin, `${management}/operations`)).preview.executionEnabled, false);
  await pass('旧会话/邀请/恢复令牌/未到期 grant 失效，旧任务撤销，公开撤回且数据回到备份点');
  await pass('恢复后全部图片/视频产物与品牌摘要一致，新 worker 可完成新上传');
} else if (phase === 'availability') {
  await get({}, `${api}/public/assets/${fixture.assetId}`);
  assert.equal(hash(await get({}, `${api}/branding/logo`)), state.fingerprint.logo);
  await upload(true);
  assert.equal((await get(admin, `${management}/operations`)).preview.executionEnabled, false);
  await pass('只重启 PostgreSQL 后 API 重新连接、旧素材可读、新上传可由 worker 处理');
} else if (phase === 'republish') {
  const settings = await get(admin, `${management}/settings`);
  await patch(admin, `${management}/settings`, { publicEnabled: true }, settings.revision);
  await request({}, `${api}/public/assets/${fixture.assetId}`, { status: 404 });
  const asset = await get(member, `${team}/assets/${fixture.assetId}`);
  const publication = await get(member, `${team}/assets/${fixture.assetId}/publication`);
  const body = {
    expectedAssetRevision: asset.revision,
    expectedPublicationRevision: publication.revision,
    versionId: asset.currentVersionId,
    publicMetadata: { title: '恢复后由所有者重新公开', description: '合成样例', tagIds: [] },
  };
  await post(admin, `${team}/assets/${asset.id}/publish`, body, { key: true, status: 403 });
  await post(member, `${team}/assets/${asset.id}/publish`, body, { key: true });
  const publicAsset = await get({}, `${api}/public/assets/${asset.id}`);
  assert.equal(publicAsset.title, body.publicMetadata.title);
  const grant = await post({}, `${api}/public/assets/${asset.id}/delivery-grants`, {
    artifactId: publicAsset.artifacts.find((a) => a.role === 'original').id,
    purpose: 'download',
  });
  assert.equal(
    hash(await get({}, grant.url)),
    state.fingerprint.assets[0].artifacts.find((a) => a.role === 'original').sha256,
  );
  const probes = JSON.parse(await readFile(join(state.directory, 'recovery-probes.json'), 'utf8'));
  await request({}, probes.grant.url, { status: 404 });
  await pass('轮换密钥后重新认证、公开重开不复活快照、管理员不得代发布、所有者重新公开与游客下载');
} else throw new Error('Unknown recovery HTTP phase.');
