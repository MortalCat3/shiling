import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  AppError,
  StorageCleanupRetryError,
  TASK_NAMES,
  createAssetService,
  createBrandingService,
  createDatabase,
  createIdentityService,
  createIngestionService,
  createLibraryService,
  createLocalStorage,
  createOperationsService,
  createProcessingService,
  createPublicationService,
  createSettingsService,
  createStorageCleanupService,
  hashToken,
  runMigrations,
} from '../../packages/backend/dist/index.js';
import { inspectMedia, processMedia } from '../../packages/media/dist/index.js';
import { createApi } from '../../apps/api/dist/app.js';

const databaseUrl =
  process.env['SHILING_TEST_DATABASE_URL'] ??
  'postgresql://shiling_test@127.0.0.1:5432/shiling_test';
const target = new URL(databaseUrl);
if (
  decodeURIComponent(target.pathname.slice(1)) !== 'shiling_test' ||
  target.username !== 'shiling_test'
) {
  throw new Error('集成测试只允许使用 shiling_test 数据库和 shiling_test 角色。');
}

const roleMap = Object.freeze({
  thumbnail: 'thumbnail',
  preview: 'preview_image',
  poster: 'poster',
  playback: 'playback_video',
  manifest: 'motion_manifest',
});

function mediaProcessor() {
  return {
    async verify(input) {
      const inspection = await inspectMedia(input);
      return {
        type: inspection.type,
        mediaType: inspection.mediaType,
        bytes: inspection.bytes,
        sha256: inspection.sha256,
        metadata: { ...inspection.metadata },
      };
    },
    async process(input) {
      const result = await processMedia(input);
      return {
        metadata: { ...result.metadata },
        artifacts: result.artifacts.map((artifact) => ({
          role: roleMap[artifact.role],
          filePath: artifact.filePath,
          mediaType: artifact.contentType,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          metadata: {
            schemaVersion: 1,
            width: artifact.width,
            height: artifact.height,
            durationMs: artifact.durationMs,
          },
        })),
      };
    },
  };
}

function mutation(prefix) {
  return { requestId: randomUUID(), idempotencyKey: `${prefix}-${randomUUID()}` };
}

async function appError(action, status, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('首期后端：身份、图片上传、整理、公开与撤回真实 PostgreSQL 闭环', async (t) => {
  const database = createDatabase({
    connectionString: databaseUrl,
    applicationName: 'shiling-integration-test',
    maxConnections: 6,
  });
  const targetState = await database.query(
    `SELECT current_database() AS database,current_user AS role,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`,
  );
  assert.deepEqual(targetState.rows[0], {
    database: 'shiling_test',
    role: 'shiling_test',
    superuser: false,
  });

  await database.query('DROP SCHEMA IF EXISTS shiling CASCADE');
  await database.query('CREATE SCHEMA shiling AUTHORIZATION shiling_test');
  const migrations = await runMigrations(database);
  assert.deepEqual(migrations.applied, [
    '0001_identity_settings',
    '0002_assets_ingestion_processing_storage',
    '0003_library_publication',
    '0004_system_operations',
  ]);
  assert.deepEqual((await runMigrations(database)).applied, []);

  const fixtureRoot = await mkdtemp(join(tmpdir(), 'shiling-integration-'));
  t.after(async () => {
    await database.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  const storage = await createLocalStorage({
    rootDirectory: join(fixtureRoot, 'objects'),
    namespace: 'integration',
  });
  const queued = [];
  const queue = {
    async enqueue(_transaction, name, data) {
      const id = randomUUID();
      queued.push({ id, name, data });
      return id;
    },
  };
  const uploadMaxBytes = 100 * 1024 * 1024;
  const identity = createIdentityService(database, {
    setupToken: 'integration-setup-token-0000000000000001',
    csrfSecret: 'integration-csrf-secret-0000000000000001',
    sessionTtlSeconds: 3_600,
    freshAuthSeconds: 600,
    invitationTtlSeconds: 3_600,
    recoveryTtlSeconds: 900,
  });
  const ingestion = createIngestionService({
    database,
    identity,
    storage,
    queue,
    uploadMaxBytes,
  });
  const processing = createProcessingService({
    database,
    storage,
    queue,
    media: mediaProcessor(),
    temporaryDirectory: fixtureRoot,
  });
  const assets = createAssetService({
    database,
    identity,
    storage,
    deliverySecret: 'integration-delivery-secret-000000000000001',
  });
  const branding = createBrandingService({
    database,
    identity,
    storage,
    candidateRetentionSeconds: 24 * 60 * 60,
  });
  const library = createLibraryService({ database, identity, assets });
  const publications = createPublicationService({
    database,
    identity,
    storage,
    deliverySecret: 'integration-delivery-secret-000000000000001',
  });
  const settings = createSettingsService({ database, identity, uploadMaxBytes });
  const cleanup = createStorageCleanupService({ database, storage, batchSize: 10 });

  await t.test('初始化、登录、邀请与权限', async () => {
    const bootstrap = await identity.bootstrap();
    assert.equal(bootstrap.initialized, false);
    assert.deepEqual(bootstrap.brand, {
      name: '拾灵',
      description: '收集灵感，让好素材被再次使用。',
      primaryColor: '#7657c8',
      logoUrl: null,
      faviconUrl: null,
    });
    const initialized = await identity.initialize(
      {
        setupToken: 'integration-setup-token-0000000000000001',
        loginName: 'admin',
        displayName: '测试管理员',
        password: 'Strong-integration-password-2026!',
      },
      randomUUID(),
    );
    assert.equal(initialized.initialized, true);
    await appError(
      () =>
        identity.initialize(
          {
            setupToken: 'integration-setup-token-0000000000000001',
            loginName: 'another',
            displayName: '另一个管理员',
            password: 'Strong-integration-password-2026!',
          },
          randomUUID(),
        ),
      409,
      'ALREADY_INITIALIZED',
    );
    await appError(
      () => identity.login({ loginName: 'admin', password: 'wrong-password' }, randomUUID()),
      401,
      'INVALID_CREDENTIALS',
    );
  });

  const adminLogin = await identity.login(
    { loginName: 'admin', password: 'Strong-integration-password-2026!' },
    randomUUID(),
  );
  const adminToken = adminLogin.sessionToken;
  assert.ok(adminLogin.session.permissionKeys.includes('system.settings.manage'));

  await t.test('运行上传硬上限与 fresh-auth 错误合同', async () => {
    const runtimeSettings = await settings.getSettings(adminToken);
    assert.equal(
      runtimeSettings.types.find((type) => type.id === 'video')?.maxBytes,
      uploadMaxBytes,
    );
    await appError(
      () =>
        settings.patchSettings(
          adminToken,
          { types: [{ id: 'video', acceptUploads: true, maxBytes: uploadMaxBytes + 1 }] },
          runtimeSettings.revision,
          randomUUID(),
        ),
      400,
      'INVALID_TYPE_SETTINGS',
    );
    await appError(
      () =>
        settings.patchSettings(
          adminToken,
          {
            name: '名称一',
            brand: { name: '名称二', description: '', primaryColor: '#7657c8' },
          },
          runtimeSettings.revision,
          randomUUID(),
        ),
      400,
      'CONFLICTING_BRAND_NAME',
    );
    const limitBatch = await ingestion.createBatch(
      adminToken,
      { clientBatchId: `limit-${randomUUID()}` },
      mutation('limit-batch'),
    );
    await appError(
      () =>
        ingestion.createItem(
          adminToken,
          limitBatch.id,
          {
            clientItemId: 'limit-video',
            fileName: 'over-limit.mp4',
            declaredBytes: String(uploadMaxBytes + 1),
            declaredMediaType: 'video/mp4',
            typeHint: 'video',
            initialMetadata: {
              title: '超出运行上限的视频',
              description: '',
              tagIds: [],
              collectionIds: [],
            },
          },
          randomUUID(),
        ),
      413,
      'UPLOAD_TOO_LARGE',
    );
    await database.query(
      "UPDATE shiling.sessions SET reauthenticated_at=now()-interval '11 minutes' WHERE user_id=$1",
      [adminLogin.session.user.id],
    );
    await appError(() => identity.logoutAll(adminToken, randomUUID()), 403, 'FRESH_AUTH_REQUIRED');
    await identity.reauthenticate(adminToken, 'Strong-integration-password-2026!', randomUUID());
  });

  const memberRole = (await database.query("SELECT id FROM shiling.roles WHERE key='member'"))
    .rows[0];
  assert.ok(memberRole?.id);
  const invitation = await identity.createInvitation(
    adminToken,
    { roleId: memberRole.id, loginName: 'member01' },
    mutation('invite'),
  );
  assert.ok(invitation.token);
  const accepted = await identity.acceptInvitation(
    {
      token: invitation.token,
      loginName: 'member01',
      displayName: '测试成员',
      password: 'Strong-member-password-2026!',
    },
    randomUUID(),
  );
  assert.equal(accepted.user.status, 'active');
  const invitationList = await identity.listInvitations(adminToken, { state: 'accepted' });
  assert.equal(invitationList.items.length, 1);
  assert.equal('token' in invitationList.items[0], false);
  const memberToken = (
    await identity.login(
      { loginName: 'member01', password: 'Strong-member-password-2026!' },
      randomUUID(),
    )
  ).sessionToken;

  const tag = await library.createTag(
    adminToken,
    { name: '插画', description: '集成测试标签' },
    mutation('tag'),
  );
  await appError(
    () =>
      library.createTag(memberToken, { name: '无权标签', description: '' }, mutation('denied-tag')),
    403,
    'FORBIDDEN',
  );
  const collection = await library.createCollection(
    adminToken,
    { name: '发布候选', description: '集成测试集合' },
    mutation('collection'),
  );

  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  await appError(() => branding.assertCanCreate(memberToken), 403, 'FORBIDDEN');
  const failedBrandingRequestId = randomUUID();
  const failingBranding = createBrandingService({
    database,
    identity,
    storage: {
      ...storage,
      async put() {
        throw new Error('injected branding storage failure');
      },
    },
    candidateRetentionSeconds: 24 * 60 * 60,
  });
  await appError(
    () =>
      failingBranding.createCandidate(
        adminToken,
        {
          purpose: 'favicon',
          source: Readable.from([tinyPng]),
          mediaType: 'image/png',
          width: 1,
          height: 1,
          expectedBytes: tinyPng.length,
        },
        failedBrandingRequestId,
      ),
    503,
    'BRANDING_STORAGE_FAILED',
  );
  const failedBrandingAudit = (
    await database.query(
      `SELECT resource_id,outcome,changes FROM shiling.audit_events
       WHERE request_id=$1 AND action='administration.branding_asset_upload_failed'`,
      [failedBrandingRequestId],
    )
  ).rows[0];
  assert.equal(failedBrandingAudit?.outcome, 'failed');
  assert.equal(failedBrandingAudit?.changes?.failureCode, 'BRANDING_UPLOAD_FAILED');
  assert.ok(failedBrandingAudit?.resource_id);
  await database.query(
    `UPDATE shiling.storage_objects SET retain_until=now()+interval '1 day'
     WHERE branding_asset_id=$1`,
    [failedBrandingAudit.resource_id],
  );
  const brandingCandidate = await branding.createCandidate(
    adminToken,
    {
      purpose: 'logo',
      source: Readable.from([tinyPng]),
      mediaType: 'image/png',
      width: 1,
      height: 1,
      expectedBytes: tinyPng.length,
    },
    randomUUID(),
  );
  await appError(() => branding.openActive('logo'), 404, 'BRANDING_ASSET_NOT_FOUND');
  const brandingSettings = await settings.getSettings(adminToken);
  await settings.patchSettings(
    adminToken,
    { logoBrandingAssetId: brandingCandidate.brandingAssetId },
    brandingSettings.revision,
    randomUUID(),
  );
  const openedBranding = await branding.openActive('logo');
  assert.deepEqual(await readAll(openedBranding.stream), tinyPng);
  assert.equal(openedBranding.mediaType, 'image/png');
  assert.match(
    (await identity.bootstrap()).brand.logoUrl ?? '',
    new RegExp(`^/api/v1/branding/logo\\?v=${brandingCandidate.brandingAssetId}$`),
  );
  const faviconCandidate = await branding.createCandidate(
    adminToken,
    {
      purpose: 'favicon',
      source: Readable.from([tinyPng]),
      mediaType: 'image/png',
      width: 1,
      height: 1,
      expectedBytes: tinyPng.length,
    },
    randomUUID(),
  );
  const beforeFavicon = await settings.getSettings(adminToken);
  const withFavicon = await settings.patchSettings(
    adminToken,
    { faviconBrandingAssetId: faviconCandidate.brandingAssetId },
    beforeFavicon.revision,
    randomUUID(),
  );
  assert.match(
    withFavicon.brand.faviconUrl ?? '',
    new RegExp(`^/api/v1/branding/favicon\\?v=${faviconCandidate.brandingAssetId}$`),
  );
  const withoutFavicon = await settings.patchSettings(
    adminToken,
    { faviconBrandingAssetId: null },
    withFavicon.revision,
    randomUUID(),
  );
  assert.equal(withoutFavicon.brand.faviconUrl, null);

  await t.test('身份与品牌 HTTP 合同', async (httpTest) => {
    const appOrigin = 'http://app.localhost';
    const app = createApi(
      {
        host: '127.0.0.1',
        port: 3000,
        logLevel: 'silent',
        databaseUrl,
        migrationDatabaseUrl: null,
        migrationOwnerRole: null,
        storage: {
          driver: 'local',
          rootDirectory: join(fixtureRoot, 'objects'),
          namespace: 'primary',
        },
        appOrigin,
        publicOrigin: appOrigin,
        previewOrigin: 'http://preview.localhost',
        cookieSecure: false,
        setupToken: 'integration-setup-token-0000000000000001',
        csrfSecret: 'integration-csrf-secret-0000000000000001',
        deliverySecret: 'integration-delivery-secret-000000000000001',
        deliveryGrantTtlSeconds: 120,
        sessionTtlSeconds: 3_600,
        uploadMaxBytes,
        temporaryObjectRetentionSeconds: 24 * 60 * 60,
      },
      {
        database,
        identity,
        ingestion,
        assets,
        branding,
        publication: publications,
        library,
        settings,
        operations: {},
        async checkReady() {
          return { database: true, queue: true, storage: true };
        },
        async close() {},
      },
    );
    httpTest.after(async () => app.close());

    const bootstrapResponse = await app.inject({ method: 'GET', url: '/api/v1/bootstrap' });
    assert.equal(bootstrapResponse.statusCode, 200);
    assert.deepEqual(bootstrapResponse.json().brand, {
      name: '拾灵',
      description: '收集灵感，让好素材被再次使用。',
      primaryColor: '#7657c8',
      logoUrl: `/api/v1/branding/logo?v=${brandingCandidate.brandingAssetId}`,
      faviconUrl: null,
    });

    const expiredLogin = await identity.login(
      { loginName: 'admin', password: 'Strong-integration-password-2026!' },
      randomUUID(),
    );
    await database.query(
      "UPDATE shiling.sessions SET expires_at=created_at+interval '1 millisecond' WHERE token_hash=$1",
      [hashToken(expiredLogin.sessionToken)],
    );
    const expiredHeaders = {
      origin: appOrigin,
      cookie: `shiling_session=${expiredLogin.sessionToken}`,
      'content-type': 'application/json',
    };
    const rejectedLogout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      remoteAddress: '198.51.100.41',
      headers: { ...expiredHeaders, 'x-csrf-token': 'invalid-csrf-token' },
      payload: {},
    });
    assert.equal(rejectedLogout.statusCode, 403);
    assert.equal(rejectedLogout.json().code, 'CSRF_REJECTED');
    const expiredLogout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      remoteAddress: '198.51.100.41',
      headers: { ...expiredHeaders, 'x-csrf-token': expiredLogin.session.csrfToken },
      payload: {},
    });
    assert.equal(expiredLogout.statusCode, 204);
    assert.match(String(expiredLogout.headers['set-cookie']), /shiling_session=;/);
    assert.ok(
      (
        await database.query('SELECT revoked_at FROM shiling.sessions WHERE token_hash=$1', [
          hashToken(expiredLogin.sessionToken),
        ])
      ).rows[0]?.revoked_at,
    );

    const rateLogin = await identity.login(
      { loginName: 'admin', password: 'Strong-integration-password-2026!' },
      randomUUID(),
    );
    for (let index = 0; index < 6; index += 1) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/auth/change-password',
        remoteAddress: '198.51.100.42',
        headers: {
          origin: appOrigin,
          cookie: `shiling_session=${rateLogin.sessionToken}`,
          'x-csrf-token': rateLogin.session.csrfToken,
          'content-type': 'application/json',
        },
        payload: {
          currentPassword: 'definitely-not-the-current-password',
          newPassword: 'Another-strong-password-2026!',
        },
      });
      assert.equal(response.headers['x-ratelimit-limit'], '5');
      assert.equal(response.statusCode, index < 5 ? 403 : 429);
      assert.equal(response.json().code, index < 5 ? 'INVALID_CREDENTIALS' : 'RATE_LIMITED');
    }

    const boundary = `shiling-branding-${randomUUID()}`;
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nlogo\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      tinyPng,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const invalidMime = await app.inject({
      method: 'POST',
      url: '/api/v1/team/admin/branding-assets',
      remoteAddress: '198.51.100.43',
      headers: {
        origin: appOrigin,
        cookie: `shiling_session=${adminToken}`,
        'x-csrf-token': (await identity.getSession(adminToken)).csrfToken,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipart,
    });
    assert.equal(invalidMime.statusCode, 415);
    assert.equal(invalidMime.json().code, 'UNSUPPORTED_BRANDING_IMAGE');

    const recoveryKey = `recovery-${randomUUID()}`;
    const recoveryResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/team/admin/members/${accepted.user.id}/recovery-tokens`,
      remoteAddress: '198.51.100.44',
      headers: {
        origin: appOrigin,
        cookie: `shiling_session=${adminToken}`,
        'x-csrf-token': (await identity.getSession(adminToken)).csrfToken,
        'idempotency-key': recoveryKey,
        'content-type': 'application/json',
      },
      payload: {},
    });
    assert.equal(recoveryResponse.statusCode, 201);
    const recovery = recoveryResponse.json();
    assert.equal(recovery.replayed, false);
    assert.equal(typeof recovery.token, 'string');
    assert.match(recovery.expiresAt, /Z$/);
    const inspectRecovery = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/inspect',
      remoteAddress: '198.51.100.45',
      headers: { 'content-type': 'application/json' },
      payload: { token: recovery.token },
    });
    assert.equal(inspectRecovery.statusCode, 200);
    assert.deepEqual(inspectRecovery.json(), { expiresAt: recovery.expiresAt });
    const recoveryReplay = await app.inject({
      method: 'POST',
      url: `/api/v1/team/admin/members/${accepted.user.id}/recovery-tokens`,
      remoteAddress: '198.51.100.44',
      headers: {
        origin: appOrigin,
        cookie: `shiling_session=${adminToken}`,
        'x-csrf-token': (await identity.getSession(adminToken)).csrfToken,
        'idempotency-key': recoveryKey,
        'content-type': 'application/json',
      },
      payload: {},
    });
    assert.equal(recoveryReplay.statusCode, 200);
    assert.deepEqual(recoveryReplay.json(), {
      token: null,
      expiresAt: recovery.expiresAt,
      replayed: true,
    });
  });

  const batch = await ingestion.createBatch(
    adminToken,
    { clientBatchId: `integration-${randomUUID()}` },
    mutation('batch'),
  );
  const item = await ingestion.createItem(
    adminToken,
    batch.id,
    {
      clientItemId: '1',
      fileName: 'neutral-fixture.png',
      declaredBytes: String(tinyPng.length),
      declaredMediaType: 'image/png',
      typeHint: 'image',
      initialMetadata: {
        title: '中性测试图片',
        description: '仅用于自动化集成验证',
        tagIds: [tag.id],
        collectionIds: [collection.id],
      },
    },
    randomUUID(),
  );
  const attempt = await ingestion.createAttempt(adminToken, item.id, mutation('attempt'));
  const received = await ingestion.receiveContent(
    adminToken,
    attempt.attemptId,
    Readable.from([tinyPng]),
    tinyPng.length,
    randomUUID(),
  );
  assert.equal(received.receivedBytes, String(tinyPng.length));
  const completion = await ingestion.completeAttempt(
    adminToken,
    attempt.attemptId,
    {},
    randomUUID(),
  );
  assert.ok(completion.jobId);
  const verifyMessage = queued.find((message) => message.name === TASK_NAMES.verify);
  assert.ok(verifyMessage);
  await processing.verifyUpload(verifyMessage.data, {
    requestId: randomUUID(),
    workerInstance: 'integration-worker',
  });
  const processingMessage = queued.find((message) => message.name === TASK_NAMES.process);
  assert.ok(processingMessage);
  await processing.processJob(processingMessage.data, {
    requestId: randomUUID(),
    workerInstance: 'integration-worker',
  });

  const readyItem = await ingestion.getItem(adminToken, item.id);
  assert.equal(readyItem.uiState, 'ready');
  assert.ok(readyItem.assetId);
  assert.deepEqual(readyItem.organizationWarnings, []);
  const asset = await assets.get(adminToken, readyItem.assetId);
  assert.equal(asset.lifecycle, 'active');
  assert.equal(asset.typeId, 'image');
  assert.equal(asset.tags[0]?.id, tag.id);
  assert.ok(asset.currentVersionId);
  assert.ok(asset.artifacts.some((artifact) => artifact.role === 'original'));
  assert.ok(asset.artifacts.some((artifact) => artifact.role === 'thumbnail'));

  const collectionItems = await library.listCollectionItems(adminToken, collection.id);
  assert.equal(collectionItems.items.length, 1);
  await library.setFavorite(adminToken, asset.id, true, randomUUID());
  assert.equal((await library.listFavorites(adminToken)).items[0]?.id, asset.id);

  const currentSettings = await settings.getSettings(adminToken);
  const enabledSettings = await settings.patchSettings(
    adminToken,
    { publicEnabled: true },
    currentSettings.revision,
    randomUUID(),
  );
  assert.equal(enabledSettings.publicEnabled, true);
  const publicationState = await publications.getState(adminToken, asset.id);
  const published = await publications.publish(
    adminToken,
    asset.id,
    {
      expectedAssetRevision: asset.revision,
      expectedPublicationRevision: publicationState.revision,
      versionId: asset.currentVersionId,
      publicMetadata: {
        title: '公开测试图片',
        description: '不展示成员身份',
        tagIds: [tag.id],
      },
    },
    mutation('publish'),
  );
  assert.equal(published.state, 'active');
  const publicAsset = await publications.get(asset.id);
  assert.equal(publicAsset.title, '公开测试图片');
  assert.equal('owner' in publicAsset, false);
  assert.equal((await publications.list()).items.length, 1);
  const original = publicAsset.artifacts.find((artifact) => artifact.role === 'original');
  assert.ok(original);
  const delivery = await publications.createDeliveryGrant(asset.id, {
    artifactId: original.id,
    purpose: 'download',
  });
  const grant = new URL(delivery.url, 'http://shiling.invalid').searchParams.get('grant');
  assert.ok(grant);
  const opened = await publications.openContent(asset.id, original.id, grant);
  assert.deepEqual(await readAll(opened.stream), tinyPng);

  const withdrawn = await publications.withdraw(
    adminToken,
    asset.id,
    published.revision,
    mutation('withdraw'),
  );
  assert.equal(withdrawn.state, 'withdrawn');
  assert.equal((await publications.list()).items.length, 0);
  await appError(
    () => publications.openContent(asset.id, original.id, grant),
    404,
    'PUBLIC_ASSET_NOT_FOUND',
  );

  await t.test('管理记录按时间倒序翻页，同微秒和相邻微秒不重不漏', async () => {
    const operations = createOperationsService({ database, identity, queue });
    const ids = [1, 2, 3, 4].map((n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`);
    const expected = [ids[1], ids[0], ids[3], ids[2]];
    for (let n = 0; n < ids.length; n++) {
      const time = `2099-01-01 00:00:00.00000${n < 2 ? 2 : 1}+00`;
      await database.query(
        `INSERT INTO shiling.audit_events(id,actor_kind,action,resource_type,outcome,request_id,created_at)
        VALUES($1,'system','test.pagination','test','success','pagination-test',$2)`,
        [ids[n], time],
      );
      await database.query(
        `INSERT INTO shiling.processing_jobs(id,version_id,execution_generation,step_key,processor_key,processor_version,required,state,created_at)
        VALUES($1,$2,1,$3,'test','1',true,'succeeded',$4)`,
        [ids[n], asset.currentVersionId, `test.pagination.${n}`, time],
      );
    }
    for (const [list, filter, changed] of [
      [operations.listAuditEvents, { action: 'test.pagination' }, { action: 'identity.login' }],
      [operations.listJobs, { state: 'succeeded' }, { state: 'failed' }],
    ]) {
      const found = [];
      let cursor;
      for (let n = 0; n < 4; n++) {
        const page = await list(adminToken, { ...filter, limit: 1, ...(cursor ? { cursor } : {}) });
        found.push(page.items[0].id);
        if (n === 0) {
          await appError(
            () => list(adminToken, { ...changed, cursor: page.pageInfo.nextCursor }),
            400,
            'INVALID_CURSOR',
          );
          const invalid = JSON.parse(Buffer.from(page.pageInfo.nextCursor, 'base64url').toString());
          invalid.createdAt = '2099-02-30 00:00:00.000001+00';
          await appError(
            () =>
              list(adminToken, {
                ...filter,
                cursor: Buffer.from(JSON.stringify(invalid)).toString('base64url'),
              }),
            400,
            'INVALID_CURSOR',
          );
        }
        cursor = page.pageInfo.nextCursor;
      }
      assert.deepEqual(found, expected);
      assert.equal(new Set(found).size, 4);
    }
  });

  await t.test('临时对象安全回收、归档保护与并发引用栅栏', async () => {
    const archived = await assets.archive(
      adminToken,
      asset.id,
      (await assets.get(adminToken, asset.id)).revision,
      mutation('archive-before-cleanup'),
    );
    assert.equal(archived.lifecycle, 'archived');

    const protectedObjects = await database.query(
      `SELECT so.id,so.object_key
       FROM shiling.storage_objects so
       JOIN shiling.artifacts a ON a.storage_object_id=so.id
       WHERE a.id=$1
       UNION ALL
       SELECT so.id,so.object_key
       FROM shiling.storage_objects so
       JOIN shiling.product_settings ps ON ps.logo_branding_asset_id=so.branding_asset_id
       WHERE ps.id=1`,
      [original.id],
    );
    assert.equal(protectedObjects.rows.length, 2);
    await database.query(
      `UPDATE shiling.storage_objects SET retain_until=now()-interval '1 minute'
       WHERE id=ANY($1::uuid[])`,
      [protectedObjects.rows.map((row) => row.id)],
    );
    assert.deepEqual(await cleanup.runOnce({ requestId: randomUUID() }), {
      claimed: 0,
      deleted: 0,
      failed: 0,
      fenced: 0,
    });
    for (const protectedObject of protectedObjects.rows) {
      assert.equal((await storage.inspect(protectedObject.object_key)).bytes > 0, true);
    }

    const stalePartDirectory = join(fixtureRoot, 'objects', 'stale-part-test');
    await mkdir(stalePartDirectory, { recursive: true });
    const stalePart = join(stalePartDirectory, `.part-${randomUUID()}`);
    const recentPart = join(stalePartDirectory, `.part-${randomUUID()}`);
    await writeFile(stalePart, Buffer.from('stale'));
    await writeFile(recentPart, Buffer.from('recent'));
    const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    await utimes(stalePart, oldTimestamp, oldTimestamp);
    assert.ok(storage.sweepTemporaryFiles);
    assert.deepEqual(
      await storage.sweepTemporaryFiles({
        olderThan: new Date(Date.now() - 60 * 60 * 1_000),
        limit: 10,
      }),
      { deleted: 1, failed: 0 },
    );
    await assert.rejects(
      () => access(stalePart),
      (error) => error?.code === 'ENOENT',
    );
    await access(recentPart);

    const slowBatch = await ingestion.createBatch(
      adminToken,
      { clientBatchId: `slow-cleanup-${randomUUID()}` },
      mutation('slow-cleanup-batch'),
    );
    const slowItem = await ingestion.createItem(
      adminToken,
      slowBatch.id,
      {
        clientItemId: 'slow-1',
        fileName: 'slow-cleanup.png',
        declaredBytes: String(tinyPng.length),
        declaredMediaType: 'image/png',
        typeHint: 'image',
        initialMetadata: {
          title: '慢上传回收栅栏',
          description: '验证 GC 后迟到写入不能复活对象',
          tagIds: [],
          collectionIds: [],
        },
      },
      randomUUID(),
    );
    const slowAttempt = await ingestion.createAttempt(
      adminToken,
      slowItem.id,
      mutation('slow-cleanup-attempt'),
    );
    let signalSlowWriteStarted;
    let releaseSlowWrite;
    const slowWriteStarted = new Promise((resolve) => {
      signalSlowWriteStarted = resolve;
    });
    const slowWriteGate = new Promise((resolve) => {
      releaseSlowWrite = resolve;
    });
    async function* slowSource() {
      yield tinyPng.subarray(0, 1);
      signalSlowWriteStarted();
      await slowWriteGate;
      yield tinyPng.subarray(1);
    }
    const slowReceive = ingestion
      .receiveContent(adminToken, slowAttempt.attemptId, slowSource(), tinyPng.length, randomUUID())
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    await slowWriteStarted;
    const slowObject = (
      await database.query(
        'SELECT id,object_key FROM shiling.storage_objects WHERE upload_attempt_id=$1',
        [slowAttempt.attemptId],
      )
    ).rows[0];
    assert.ok(slowObject);
    await database.query(
      `UPDATE shiling.upload_attempts SET expires_at=now()-interval '1 minute' WHERE id=$1`,
      [slowAttempt.attemptId],
    );
    await database.query(
      `UPDATE shiling.storage_objects SET retain_until=now()-interval '1 minute' WHERE id=$1`,
      [slowObject.id],
    );
    assert.deepEqual(await cleanup.runOnce({ requestId: randomUUID() }), {
      claimed: 1,
      deleted: 1,
      failed: 0,
      fenced: 0,
    });
    releaseSlowWrite();
    const slowOutcome = await slowReceive;
    assert.ok(slowOutcome.error instanceof AppError);
    assert.equal(slowOutcome.error.code, 'UPLOAD_ATTEMPT_STALE');
    await appError(() => storage.inspect(slowObject.object_key), 409, 'STORAGE_OBJECT_UNAVAILABLE');
    await appError(
      () =>
        storage.put(slowObject.object_key, Readable.from([tinyPng]), {
          maxBytes: tinyPng.length,
          expectedBytes: tinyPng.length,
        }),
      409,
      'STORAGE_OBJECT_DELETED',
    );

    const expiredBrandingAssetId = randomUUID();
    const expiredBrandingObjectId = randomUUID();
    const adminId = (
      await database.query(
        "SELECT id FROM shiling.users WHERE status='active' ORDER BY created_at LIMIT 1",
      )
    ).rows[0]?.id;
    assert.ok(adminId);
    await database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO shiling.branding_assets(id,uploader_id,purpose,state)
         VALUES($1,$2,'favicon','verifying')`,
        [expiredBrandingAssetId, adminId],
      );
      await tx.query(
        `INSERT INTO shiling.storage_objects
         (id,branding_asset_id,backend_key,namespace,object_key,retain_until)
         VALUES($1,$2,$3,$4,$5,now()-interval '1 minute')`,
        [
          expiredBrandingObjectId,
          expiredBrandingAssetId,
          storage.backendKey,
          storage.namespace,
          `branding/favicon/${expiredBrandingAssetId}.png`,
        ],
      );
      await tx.query(`UPDATE shiling.branding_assets SET storage_object_id=$2 WHERE id=$1`, [
        expiredBrandingAssetId,
        expiredBrandingObjectId,
      ]);
    });
    assert.equal((await cleanup.runOnce({ requestId: randomUUID() })).deleted, 1);
    assert.deepEqual(
      (
        await database.query(
          `SELECT b.state,b.failure_code,so.state object_state
           FROM shiling.branding_assets b
           JOIN shiling.storage_objects so ON so.id=b.storage_object_id
           WHERE b.id=$1`,
          [expiredBrandingAssetId],
        )
      ).rows[0],
      {
        state: 'failed',
        failure_code: 'UNREFERENCED_OBJECT_RECLAIMED',
        object_state: 'deleted',
      },
    );

    const processingFenceBatch = await ingestion.createBatch(
      adminToken,
      { clientBatchId: `processing-fence-${randomUUID()}` },
      mutation('processing-fence-batch'),
    );
    const processingFenceItem = await ingestion.createItem(
      adminToken,
      processingFenceBatch.id,
      {
        clientItemId: 'processing-fence-1',
        fileName: 'processing-fence.png',
        declaredBytes: String(tinyPng.length),
        declaredMediaType: 'image/png',
        typeHint: 'image',
        initialMetadata: {
          title: '处理产物回收栅栏',
          description: '',
          tagIds: [],
          collectionIds: [],
        },
      },
      randomUUID(),
    );
    const processingFenceAttempt = await ingestion.createAttempt(
      adminToken,
      processingFenceItem.id,
      mutation('processing-fence-attempt'),
    );
    await ingestion.receiveContent(
      adminToken,
      processingFenceAttempt.attemptId,
      Readable.from([tinyPng]),
      tinyPng.length,
      randomUUID(),
    );
    const queueOffset = queued.length;
    await ingestion.completeAttempt(adminToken, processingFenceAttempt.attemptId, {}, randomUUID());
    const fencedVerifyMessage = queued
      .slice(queueOffset)
      .find((message) => message.name === TASK_NAMES.verify);
    assert.ok(fencedVerifyMessage);
    await processing.verifyUpload(fencedVerifyMessage.data, {
      requestId: randomUUID(),
      workerInstance: 'integration-worker',
    });
    const fencedProcessMessage = queued
      .slice(queueOffset)
      .find((message) => message.name === TASK_NAMES.process);
    assert.ok(fencedProcessMessage);
    let fencedDerivedObjectId;
    const fencedStorage = {
      ...storage,
      async put(key, source, limits) {
        const stored = await storage.put(key, source, limits);
        if (key.startsWith('derived/')) {
          const fenced = await database.query(
            `UPDATE shiling.storage_objects
             SET state='gc_pending',gc_token=gen_random_uuid()
             WHERE object_key=$1 AND state='reserved' RETURNING id`,
            [key],
          );
          fencedDerivedObjectId = fenced.rows[0]?.id;
        }
        return stored;
      },
    };
    const fencedProcessing = createProcessingService({
      database,
      storage: fencedStorage,
      queue,
      media: mediaProcessor(),
      temporaryDirectory: fixtureRoot,
    });
    await fencedProcessing.processJob(fencedProcessMessage.data, {
      requestId: randomUUID(),
      workerInstance: 'integration-worker-fenced',
    });
    assert.ok(fencedDerivedObjectId);
    assert.deepEqual(
      (
        await database.query(
          `SELECT so.state,so.gc_token IS NOT NULL has_gc_token,pj.state job_state,av.processing_state
           FROM shiling.storage_objects so
           JOIN shiling.processing_attempts pa ON pa.id=so.processing_attempt_id
           JOIN shiling.processing_jobs pj ON pj.id=pa.job_id
           JOIN shiling.asset_versions av ON av.id=pj.version_id
           WHERE so.id=$1`,
          [fencedDerivedObjectId],
        )
      ).rows[0],
      {
        state: 'gc_pending',
        has_gc_token: true,
        job_state: 'failed',
        processing_state: 'failed',
      },
    );

    const processingAttempt = (
      await database.query(
        `SELECT pa.id FROM shiling.processing_attempts pa
         JOIN shiling.processing_jobs pj ON pj.id=pa.job_id
         WHERE pj.version_id=$1 ORDER BY pa.created_at DESC LIMIT 1`,
        [asset.currentVersionId],
      )
    ).rows[0];
    assert.ok(processingAttempt?.id);

    async function createExpiredOrphan(suffix) {
      const id = randomUUID();
      const objectKey = `cleanup-test/${suffix}-${id}`;
      const content = Buffer.from(`cleanup-${suffix}`);
      const stored = await storage.put(objectKey, Readable.from([content]), {
        maxBytes: content.length,
        expectedBytes: content.length,
      });
      await database.query(
        `INSERT INTO shiling.storage_objects
         (id,processing_attempt_id,backend_key,namespace,object_key,state,integrity_state,
          bytes,sha256,verified_at,retain_until)
         VALUES($1,$2,$3,$4,$5,'stored','verified',$6,$7,now(),now()-interval '1 minute')`,
        [
          id,
          processingAttempt.id,
          storage.backendKey,
          storage.namespace,
          objectKey,
          stored.bytes,
          stored.sha256,
        ],
      );
      return { id, objectKey };
    }

    const orphan = await createExpiredOrphan('unreferenced');
    assert.deepEqual(await cleanup.runOnce({ requestId: randomUUID() }), {
      claimed: 1,
      deleted: 1,
      failed: 0,
      fenced: 0,
    });
    await appError(() => storage.inspect(orphan.objectKey), 409, 'STORAGE_OBJECT_UNAVAILABLE');

    const retryable = await createExpiredOrphan('retryable');
    let failedRemoveCalls = 0;
    const failingCleanup = createStorageCleanupService({
      database,
      storage: {
        ...storage,
        remove: async () => {
          failedRemoveCalls += 1;
          throw new Error('injected failure');
        },
      },
      batchSize: 10,
    });
    await assert.rejects(
      () => failingCleanup.runUntilDrained({ requestId: randomUUID() }, 10),
      (error) => {
        assert.ok(error instanceof StorageCleanupRetryError);
        assert.deepEqual(error.result, { claimed: 1, deleted: 0, failed: 1, fenced: 0 });
        return true;
      },
    );
    assert.equal(failedRemoveCalls, 1);
    assert.deepEqual(
      (
        await database.query('SELECT state,gc_token FROM shiling.storage_objects WHERE id=$1', [
          retryable.id,
        ])
      ).rows[0],
      { state: 'stored', gc_token: null },
    );
    assert.equal((await storage.inspect(retryable.objectKey)).bytes > 0, true);
    assert.equal((await cleanup.runOnce({ requestId: randomUUID() })).deleted, 1);

    const competingBrand = await branding.createCandidate(
      adminToken,
      {
        purpose: 'logo',
        source: Readable.from([tinyPng]),
        mediaType: 'image/png',
        width: 1,
        height: 1,
        expectedBytes: tinyPng.length,
      },
      randomUUID(),
    );
    await database.query(
      `UPDATE shiling.storage_objects SET retain_until=now()-interval '1 minute'
       WHERE branding_asset_id=$1`,
      [competingBrand.brandingAssetId],
    );
    let signalRemoveStarted;
    let allowRemove;
    const removeStarted = new Promise((resolve) => {
      signalRemoveStarted = resolve;
    });
    const removeGate = new Promise((resolve) => {
      allowRemove = resolve;
    });
    const gatedCleanup = createStorageCleanupService({
      database,
      storage: {
        ...storage,
        async remove(key) {
          signalRemoveStarted();
          await removeGate;
          await storage.remove(key);
        },
      },
      batchSize: 10,
    });
    const cleanupPromise = gatedCleanup.runOnce({ requestId: randomUUID() });
    await removeStarted;
    const settingsBeforeRace = await settings.getSettings(adminToken);
    await appError(
      () =>
        settings.patchSettings(
          adminToken,
          { logoBrandingAssetId: competingBrand.brandingAssetId },
          settingsBeforeRace.revision,
          randomUUID(),
        ),
      409,
      'BRANDING_ASSET_UNAVAILABLE',
    );
    allowRemove();
    assert.deepEqual(await cleanupPromise, {
      claimed: 1,
      deleted: 1,
      failed: 0,
      fenced: 0,
    });
  });
});
