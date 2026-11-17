import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const password = process.env['SHILING_E2E_PASSWORD'];
if (!password) throw new Error('必须通过 SHILING_E2E_PASSWORD 提供本地管理员密码。');

function configuredBaseUrl() {
  const raw = process.env['SHILING_E2E_BASE_URL'] ?? 'http://127.0.0.1:3000';
  let value;
  try {
    value = new URL(raw);
  } catch {
    throw new Error('SHILING_E2E_BASE_URL 必须是有效的 HTTP(S) URL。');
  }
  if (
    !['http:', 'https:'].includes(value.protocol) ||
    value.username ||
    value.password ||
    (value.pathname !== '/' && value.pathname !== '') ||
    value.search ||
    value.hash
  ) {
    throw new Error('SHILING_E2E_BASE_URL 只能包含 HTTP(S) scheme、主机和可选端口。');
  }
  return value;
}

const baseUrl = configuredBaseUrl();

function mutationOrigin(value) {
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(value.hostname);
  if (loopback && value.port === '3000') {
    const origin = new URL(value);
    origin.port = '5173';
    return origin.origin;
  }
  return value.origin;
}

const appOrigin = mutationOrigin(baseUrl);
let cookie = '';
let csrfToken = '';

function safeTarget(url) {
  const shown = new URL(url);
  if (shown.searchParams.has('grant')) shown.searchParams.set('grant', '[redacted]');
  return `${shown.pathname}${shown.search}`;
}

async function request(target, options = {}) {
  const url = new URL(target, baseUrl);
  const method = (options.method ?? 'GET').toUpperCase();
  const authenticated = options.auth !== false;
  const headers = { Accept: options.accept ?? 'application/json', ...(options.headers ?? {}) };
  if (authenticated && cookie) headers.Cookie = cookie;
  if (!['GET', 'HEAD'].includes(method)) {
    headers.Origin = appOrigin;
    if (authenticated && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  if (options.idempotency) headers['Idempotency-Key'] = randomUUID();
  if (options.revision) headers['If-Match'] = `"${options.revision}"`;

  let body = options.body;
  if (body !== undefined && !options.raw) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const contentType = response.headers.get('content-type') ?? '';
  let data = null;
  if (response.status !== 204) {
    data = contentType.includes('json')
      ? await response.json().catch(() => null)
      : Buffer.from(await response.arrayBuffer());
  }
  if (!response.ok && !options.allowError) {
    const code =
      data && typeof data === 'object' && !Buffer.isBuffer(data) && 'code' in data
        ? data.code
        : 'HTTP_ERROR';
    throw new Error(
      `${method} ${safeTarget(url)} 请求失败：HTTP ${response.status} ${String(code)}`,
    );
  }
  return { response, data };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function neutralPng() {
  const width = 64;
  const height = 48;
  const stride = 1 + width * 3;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      pixels[offset] = 104 + Math.floor((x / (width - 1)) * 72);
      pixels[offset + 1] = 82 + Math.floor((y / (height - 1)) * 68);
      pixels[offset + 2] = 176;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function assertFacetShape(entries, name) {
  assert.ok(Array.isArray(entries), `${name} 分面必须是数组。`);
  for (const entry of entries) {
    assert.equal(typeof entry.label, 'string', `${name} 分面缺少 label。`);
    assert.ok(entry.label.length > 0, `${name} 分面 label 不能为空。`);
    assert.equal(typeof entry.value, 'string', `${name} 分面缺少 value。`);
    assert.ok(entry.value.length > 0, `${name} 分面 value 不能为空。`);
    assert.ok(Number.isInteger(entry.count) && entry.count >= 0, `${name} 分面 count 无效。`);
  }
}

const identityKeys = new Set([
  'owner',
  'ownerid',
  'uploader',
  'uploaderid',
  'member',
  'memberid',
  'actorid',
  'createdby',
  'updatedby',
]);

function assertNoMemberIdentity(value, path = 'publicAsset') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoMemberIdentity(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || value === null || Buffer.isBuffer(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
    assert.ok(!identityKeys.has(normalized), `${path}.${key} 泄露了成员身份字段。`);
    assertNoMemberIdentity(child, `${path}.${key}`);
  }
}

async function findOwnAudit(action, resourceId) {
  let cursor = null;
  for (let page = 0; page < 100; page += 1) {
    const url = new URL('/api/v1/team/admin/audit-events', baseUrl);
    url.searchParams.set('limit', '100');
    url.searchParams.set('action', action);
    if (cursor) url.searchParams.set('cursor', cursor);
    const result = (await request(url)).data;
    assert.ok(result.items.length > 0, `审计动作 ${action} 没有返回记录。`);
    assert.ok(
      result.items.every((entry) => entry.action === action),
      `审计动作 ${action} 的筛选结果混入其他动作。`,
    );
    if (result.items.some((entry) => entry.resourceId === resourceId)) return result.items.length;
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
    cursor = result.pageInfo.nextCursor;
  }
  throw new Error(`审计动作 ${action} 未找到本次创建的资源。`);
}

const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const state = {
  loggedIn: false,
  initialPublicEnabled: null,
  publicSettingChanged: false,
  tag: null,
  uploadItemId: null,
  assetId: null,
};
const summary = {
  health: null,
  upload: null,
  facetType: null,
  facetTag: null,
  publicIdentityLeak: null,
  downloadBytes: null,
  rangeStatus: null,
  staleGrantStatus: null,
  motionCreateStatus: null,
  auditFilteredCount: null,
  publicationCleanup: null,
  assetCleanup: null,
  tagCleanup: null,
  settingsRestored: null,
  logoutStatus: null,
};

async function runRegression() {
  const live = await request('/health/live', { auth: false });
  assert.equal(live.data?.status, 'alive', 'API 存活检查未通过。');
  const ready = await request('/health/ready', { auth: false });
  assert.equal(ready.data?.status, 'ready', 'API 就绪检查未通过。');
  assert.equal(ready.data?.checks?.database, true, '数据库未就绪。');
  assert.equal(ready.data?.checks?.queue, true, '任务队列未就绪。');
  summary.health = 'ready';

  const login = await request('/api/v1/auth/login', {
    method: 'POST',
    auth: false,
    body: { loginName: 'admin', password },
  });
  const setCookie =
    login.response.headers.getSetCookie?.()[0] ?? login.response.headers.get('set-cookie');
  assert.ok(setCookie, '登录响应没有设置会话 Cookie。');
  cookie = setCookie.split(';', 1)[0];
  csrfToken = login.data?.csrfToken;
  assert.equal(typeof csrfToken, 'string', '登录响应没有 CSRF token。');
  assert.ok(csrfToken.length > 10, '登录响应的 CSRF token 无效。');
  state.loggedIn = true;

  const capabilities = (await request('/api/v1/team/capabilities')).data;
  const imageCapability = capabilities.types.find((entry) => entry.id === 'image');
  const motionCapability = capabilities.types.find((entry) => entry.id === 'web_motion');
  assert.equal(imageCapability?.acceptUploads, true, '本地实例没有启用图片上传。');
  assert.equal(motionCapability?.acceptUploads, false, '动效上传必须保持安全关闭。');
  assert.equal(motionCapability?.executePreview, false, '动效执行必须保持安全关闭。');

  let settings = (await request('/api/v1/team/admin/settings')).data;
  state.initialPublicEnabled = settings.publicEnabled;
  if (!settings.publicEnabled) {
    settings = (
      await request('/api/v1/team/admin/settings', {
        method: 'PATCH',
        revision: settings.revision,
        body: { publicEnabled: true },
      })
    ).data;
    assert.equal(settings.publicEnabled, true, '无法临时开启公开入口。');
    state.publicSettingChanged = true;
  }

  const tagName = `E2E回归-${suffix}`;
  state.tag = (
    await request('/api/v1/team/tags', {
      method: 'POST',
      idempotency: true,
      body: { name: tagName, description: '中性合成图片 HTTP 回归标签' },
    })
  ).data;

  const batch = (
    await request('/api/v1/team/upload-batches', {
      method: 'POST',
      idempotency: true,
      body: { clientBatchId: `http-e2e-${suffix}` },
    })
  ).data;

  const image = neutralPng();
  const sha256 = createHash('sha256').update(image).digest('hex');
  const uploadItem = (
    await request(`/api/v1/team/upload-batches/${batch.id}/items`, {
      method: 'POST',
      idempotency: true,
      body: {
        clientItemId: `image-${suffix}`,
        fileName: `neutral-${suffix}.png`,
        declaredBytes: String(image.length),
        declaredMediaType: 'image/png',
        typeHint: 'image',
        expectedSha256: sha256,
        initialMetadata: {
          title: `HTTP 中性图片 ${suffix}`,
          description: '由 Node.js 内存生成的端到端回归样例',
          tagIds: [state.tag.id],
          collectionIds: [],
        },
      },
    })
  ).data;
  state.uploadItemId = uploadItem.id;

  const attempt = (
    await request(`/api/v1/team/upload-items/${uploadItem.id}/attempts`, {
      method: 'POST',
      idempotency: true,
    })
  ).data;
  await request(`/api/v1/team/upload-attempts/${attempt.attemptId}/content`, {
    method: 'PUT',
    raw: true,
    body: image,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(image.length),
    },
  });
  await request(`/api/v1/team/upload-attempts/${attempt.attemptId}/complete`, {
    method: 'POST',
    idempotency: true,
    body: {},
  });

  let completed = null;
  for (let poll = 0; poll < 120; poll += 1) {
    completed = (await request(`/api/v1/team/upload-items/${uploadItem.id}`)).data;
    if (['ready', 'failed', 'canceled', 'expired'].includes(completed.uiState)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(
    completed?.uiState,
    'ready',
    `图片上传未进入 ready：${completed?.safeError?.code ?? completed?.uiState ?? 'timeout'}`,
  );
  assert.ok(completed.assetId, 'ready 上传项没有 assetId。');
  state.assetId = completed.assetId;
  summary.upload = completed.uiState;

  const asset = (await request(`/api/v1/team/assets/${state.assetId}`)).data;
  assert.ok(
    asset.tags.some((entry) => entry.id === state.tag.id),
    '初始标签没有应用到素材。',
  );
  assert.ok(
    asset.artifacts.some((entry) => entry.role === 'original'),
    '图片缺少 original 产物。',
  );
  assert.ok(
    asset.artifacts.some((entry) => entry.role === 'thumbnail'),
    '图片缺少 thumbnail 产物。',
  );

  const facetUrl = new URL('/api/v1/team/assets/facets', baseUrl);
  facetUrl.searchParams.set('state', 'active');
  facetUrl.searchParams.set('owner', 'me');
  facetUrl.searchParams.set('tagId', state.tag.id);
  const facets = (await request(facetUrl)).data;
  assertFacetShape(facets.types, '类型');
  assertFacetShape(facets.tags, '标签');
  const imageFacet = facets.types.find((entry) => entry.value === 'image');
  const tagFacet = facets.tags.find((entry) => entry.value === state.tag.id);
  assert.equal(imageFacet?.label, '图片', '图片分面 label 不正确。');
  assert.ok(imageFacet.count >= 1, '图片分面 count 不正确。');
  assert.equal(tagFacet?.label, tagName, '标签分面 label 不正确。');
  assert.ok(tagFacet.count >= 1, '标签分面 count 不正确。');
  summary.facetType = imageFacet;
  summary.facetTag = tagFacet;

  const motion = await request(`/api/v1/team/upload-batches/${batch.id}/items`, {
    method: 'POST',
    idempotency: true,
    allowError: true,
    body: {
      clientItemId: `motion-${suffix}`,
      fileName: `disabled-${suffix}.html`,
      declaredBytes: '128',
      declaredMediaType: 'text/html',
      typeHint: 'web_motion',
      initialMetadata: {
        title: `禁用动效 ${suffix}`,
        description: '创建前安全拒绝验证',
        tagIds: [],
        collectionIds: [],
      },
    },
  });
  assert.equal(motion.response.status, 403, '禁用动效没有在创建前返回 403。');
  assert.equal(motion.data?.code, 'UPLOAD_TYPE_DISABLED', '禁用动效错误码不正确。');
  summary.motionCreateStatus = motion.response.status;

  const publication = (await request(`/api/v1/team/assets/${state.assetId}/publication`)).data;
  const published = (
    await request(`/api/v1/team/assets/${state.assetId}/publish`, {
      method: 'POST',
      idempotency: true,
      body: {
        expectedAssetRevision: asset.revision,
        expectedPublicationRevision: publication.revision,
        versionId: asset.currentVersionId,
        publicMetadata: {
          title: `公开中性图片 ${suffix}`,
          description: '公开投影与下载端到端回归',
          tagIds: [state.tag.id],
        },
      },
    })
  ).data;
  assert.equal(published.state, 'active', '公开记录没有进入 active。');

  const publicAsset = (await request(`/api/v1/public/assets/${state.assetId}`, { auth: false }))
    .data;
  assertNoMemberIdentity(publicAsset);
  summary.publicIdentityLeak = false;
  const original = publicAsset.artifacts.find((entry) => entry.role === 'original');
  assert.ok(original, '公开详情缺少 original 产物。');
  const grant = (
    await request(`/api/v1/public/assets/${state.assetId}/delivery-grants`, {
      method: 'POST',
      auth: false,
      body: { artifactId: original.id, purpose: 'download' },
    })
  ).data;

  const downloaded = await request(grant.url, {
    auth: false,
    accept: 'application/octet-stream',
  });
  assert.equal(downloaded.data.length, image.length, '游客下载字节长度发生变化。');
  assert.equal(
    createHash('sha256').update(downloaded.data).digest('hex'),
    sha256,
    '游客下载原件摘要发生变化。',
  );
  summary.downloadBytes = downloaded.data.length;

  const ranged = await request(grant.url, {
    auth: false,
    accept: 'application/octet-stream',
    headers: { Range: 'bytes=0-15' },
  });
  assert.equal(ranged.response.status, 206, 'Range 下载没有返回 206。');
  assert.equal(ranged.data.length, 16, 'Range 下载字节长度不正确。');
  assert.equal(
    ranged.response.headers.get('content-range'),
    `bytes 0-15/${image.length}`,
    'Range Content-Range 不正确。',
  );
  summary.rangeStatus = ranged.response.status;

  summary.auditFilteredCount = await findOwnAudit('publication.snapshot_written', state.assetId);

  const withdrawn = (
    await request(`/api/v1/team/assets/${state.assetId}/withdraw`, {
      method: 'POST',
      idempotency: true,
      body: { expectedRevision: published.revision },
    })
  ).data;
  assert.equal(withdrawn.state, 'withdrawn', '公开记录没有撤回。');

  const staleGrant = await request(grant.url, {
    auth: false,
    allowError: true,
    accept: 'application/json',
  });
  assert.equal(staleGrant.response.status, 404, '撤回后旧 grant 仍然可用。');
  summary.staleGrantStatus = staleGrant.response.status;
}

async function cleanup() {
  const errors = [];
  async function attempt(label, work) {
    try {
      await work();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(new Error(`${label}失败：${detail}`));
    }
  }

  if (state.loggedIn && state.uploadItemId && !state.assetId) {
    await attempt('恢复上传项状态', async () => {
      const item = (await request(`/api/v1/team/upload-items/${state.uploadItemId}`)).data;
      state.assetId = item.assetId;
      if (!state.assetId && item.actions?.cancel) {
        await request(`/api/v1/team/upload-items/${state.uploadItemId}/cancel`, {
          method: 'POST',
          idempotency: true,
        });
      }
    });
  }

  if (state.loggedIn && state.assetId) {
    await attempt('撤回测试公开记录', async () => {
      const publication = (await request(`/api/v1/team/assets/${state.assetId}/publication`)).data;
      if (publication.state === 'active') {
        await request(`/api/v1/team/assets/${state.assetId}/withdraw`, {
          method: 'POST',
          idempotency: true,
          body: { expectedRevision: publication.revision },
        });
      }
      summary.publicationCleanup = 'withdrawn';
    });
    await attempt('归档测试素材', async () => {
      let asset = (await request(`/api/v1/team/assets/${state.assetId}`)).data;
      if (asset.lifecycle !== 'archived') {
        asset = (
          await request(`/api/v1/team/assets/${state.assetId}/archive`, {
            method: 'POST',
            idempotency: true,
            body: { expectedRevision: asset.revision },
          })
        ).data;
      }
      assert.equal(asset.lifecycle, 'archived', '测试素材未归档。');
      summary.assetCleanup = asset.lifecycle;
    });
  }

  if (state.loggedIn && state.tag) {
    await attempt('停用测试标签', async () => {
      let tag = state.tag;
      if (tag.state !== 'disabled') {
        tag = (
          await request(`/api/v1/team/tags/${tag.id}/disable`, {
            method: 'POST',
            body: { expectedRevision: tag.revision },
          })
        ).data;
      }
      assert.equal(tag.state, 'disabled', '测试标签未停用。');
      summary.tagCleanup = tag.state;
    });
  }

  if (state.loggedIn && state.publicSettingChanged) {
    await attempt('恢复公开入口设置', async () => {
      let settings = (await request('/api/v1/team/admin/settings')).data;
      if (settings.publicEnabled !== state.initialPublicEnabled) {
        settings = (
          await request('/api/v1/team/admin/settings', {
            method: 'PATCH',
            revision: settings.revision,
            body: { publicEnabled: state.initialPublicEnabled },
          })
        ).data;
      }
      assert.equal(settings.publicEnabled, state.initialPublicEnabled, '公开入口设置没有恢复。');
      summary.settingsRestored = true;
    });
  } else if (state.initialPublicEnabled !== null) {
    summary.settingsRestored = true;
  }

  if (state.loggedIn) {
    await attempt('退出测试会话', async () => {
      const logout = await request('/api/v1/auth/logout', { method: 'POST', body: {} });
      assert.equal(logout.response.status, 204, '空 JSON body 登出没有返回 204。');
      state.loggedIn = false;
      cookie = '';
      csrfToken = '';
      summary.logoutStatus = logout.response.status;
    });
  }
  return errors;
}

let runError = null;
try {
  await runRegression();
} catch (error) {
  runError = error;
}
const cleanupErrors = await cleanup();
const failures = [...(runError ? [runError] : []), ...cleanupErrors];
if (failures.length > 0) {
  const message = failures
    .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
    .join('\n');
  console.error(message);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(summary));
}
