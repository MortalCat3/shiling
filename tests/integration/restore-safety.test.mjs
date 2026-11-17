import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AppError,
  createDatabase,
  createIdentityService,
  createPublicationService,
  runMigrations,
  runRestoreSafety,
} from '../../packages/backend/dist/index.js';

const databaseUrl =
  process.env['SHILING_TEST_DATABASE_URL'] ??
  'postgresql://shiling_test@127.0.0.1:5432/shiling_test';
const target = new URL(databaseUrl);
const restoreCliPath = fileURLToPath(
  new URL('../../apps/api/dist/restore-safety.js', import.meta.url),
);
if (
  decodeURIComponent(target.pathname.slice(1)) !== 'shiling_test' ||
  target.username !== 'shiling_test'
) {
  throw new Error('灾备集成测试只允许使用 shiling_test 数据库和 shiling_test 角色。');
}

const ids = Object.freeze({
  batch: randomUUID(),
  item: randomUUID(),
  attempt: randomUUID(),
  object: randomUUID(),
  asset: randomUUID(),
  version: randomUUID(),
  artifact: randomUUID(),
  publication: randomUUID(),
  publicationRevision: randomUUID(),
  activeItem: randomUUID(),
  activeAttempt: randomUUID(),
  activeObject: randomUUID(),
  job: randomUUID(),
  processingAttempt: randomUUID(),
  token: randomUUID(),
});

function storageStub() {
  const unavailable = async () => {
    throw new Error('测试不应读取文件存储。');
  };
  return {
    backendKey: 'local',
    namespace: 'restore-test',
    put: unavailable,
    inspect: unavailable,
    open: unavailable,
    withLocalFile: unavailable,
    remove: unavailable,
  };
}

async function runRestoreCli(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [restoreCliPath, ...args], {
      env: { ...process.env, SHILING_DATABASE_URL: databaseUrl },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('灾备安全动作：撤销旧资格、撤回公开并栅栏旧 worker', async (t) => {
  let database = createDatabase({
    connectionString: databaseUrl,
    applicationName: 'shiling-restore-safety-test',
    maxConnections: 3,
  });
  t.after(() => database.close());
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
  assert.deepEqual((await runMigrations(database)).applied, [
    '0001_identity_settings',
    '0002_assets_ingestion_processing_storage',
    '0003_library_publication',
    '0004_system_operations',
  ]);

  const identity = createIdentityService(database, {
    setupToken: 'restore-setup-token-0000000000000000001',
    csrfSecret: 'restore-csrf-secret-0000000000000000001',
    sessionTtlSeconds: 3_600,
    freshAuthSeconds: 600,
    invitationTtlSeconds: 3_600,
    recoveryTtlSeconds: 900,
  });
  const initialized = await identity.initialize(
    {
      setupToken: 'restore-setup-token-0000000000000000001',
      loginName: 'restore-admin',
      displayName: '灾备测试管理员',
      password: 'Strong-restore-password-2026!',
    },
    randomUUID(),
  );
  const login = await identity.login(
    { loginName: 'restore-admin', password: 'Strong-restore-password-2026!' },
    randomUUID(),
  );
  const adminId = initialized.user.id;

  await database.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO shiling.upload_batches(id,owner_id,intake_policy_revision)
      VALUES($1,$2,1)`,
      [ids.batch, adminId],
    );
    await tx.query(
      `INSERT INTO shiling.upload_items
      (id,batch_id,ordinal,client_item_id,creation_request_hash,requested_type,original_filename,
       declared_bytes,declared_media_type,initial_metadata,transport_state,current_attempt_id,expires_at)
      VALUES($1,$2,0,'ready','${'a'.repeat(64)}','image','restore.png',3,'image/png','{}','verified',NULL,now()+interval '1 hour')`,
      [ids.item, ids.batch],
    );
    await tx.query(
      `INSERT INTO shiling.upload_attempts
      (id,item_id,attempt_no,generation,state,transfer_mode,intake_policy,expires_at,received_bytes,verified_at)
      VALUES($1,$2,1,1,'verified','server_stream','{}',now()+interval '1 hour',3,now())`,
      [ids.attempt, ids.item],
    );
    await tx.query('UPDATE shiling.upload_items SET current_attempt_id=$2 WHERE id=$1', [
      ids.item,
      ids.attempt,
    ]);
    await tx.query(
      `INSERT INTO shiling.storage_objects
      (id,upload_attempt_id,backend_key,namespace,object_key,state,integrity_state,bytes,sha256,verified_at)
      VALUES($1,$2,'local','restore-test','ready/source','stored','verified',3,$3,now())`,
      [ids.object, ids.attempt, 'b'.repeat(64)],
    );
    await tx.query(
      `INSERT INTO shiling.assets(id,owner_id,type_key,title,description,lifecycle)
      VALUES($1,$2,'image','灾备测试素材','','pending')`,
      [ids.asset, adminId],
    );
    await tx.query(
      `INSERT INTO shiling.asset_versions
      (id,asset_id,upload_item_id,processing_state,processor_plan,source_sha256,media_metadata,ready_at,created_by)
      VALUES($1,$2,$3,'ready','{}',$4,'{}',now(),$5)`,
      [ids.version, ids.asset, ids.item, 'b'.repeat(64), adminId],
    );
    await tx.query(
      "UPDATE shiling.assets SET lifecycle='active',current_version_id=$2 WHERE id=$1",
      [ids.asset, ids.version],
    );
    await tx.query(
      `INSERT INTO shiling.artifacts
      (id,version_id,role,storage_object_id,media_type,metadata)
      VALUES($1,$2,'original',$3,'image/png','{}')`,
      [ids.artifact, ids.version, ids.object],
    );
    await tx.query(
      `INSERT INTO shiling.publications
      (id,asset_id,state,current_revision_id,updated_by)
      VALUES($1,$2,'active',$3,$4)`,
      [ids.publication, ids.asset, ids.publicationRevision, adminId],
    );
    await tx.query(
      `INSERT INTO shiling.publication_revisions
      (id,publication_id,asset_id,revision_no,action,version_id,title,description,tag_labels,tag_keys,
       download_filename,source_asset_revision,actor_id)
      VALUES($1,$2,$3,1,'publish',$4,'公开灾备素材','','{}','{}','restore.png',1,$5)`,
      [ids.publicationRevision, ids.publication, ids.asset, ids.version, adminId],
    );
    await tx.query(
      `INSERT INTO shiling.publication_revision_artifacts
      (publication_revision_id,version_id,role,artifact_id)
      VALUES($1,$2,'original',$3)`,
      [ids.publicationRevision, ids.version, ids.artifact],
    );
    await tx.query(
      `INSERT INTO shiling.upload_items
      (id,batch_id,ordinal,client_item_id,creation_request_hash,requested_type,original_filename,
       declared_bytes,declared_media_type,initial_metadata,transport_state,expires_at)
      VALUES($1,$2,1,'active','${'c'.repeat(64)}','image','pending.png',3,'image/png','{}','uploading',now()+interval '1 hour')`,
      [ids.activeItem, ids.batch],
    );
    await tx.query(
      `INSERT INTO shiling.upload_attempts
      (id,item_id,attempt_no,generation,state,transfer_mode,intake_policy,expires_at,received_bytes)
      VALUES($1,$2,1,1,'receiving','server_stream','{}',now()+interval '1 hour',1)`,
      [ids.activeAttempt, ids.activeItem],
    );
    await tx.query('UPDATE shiling.upload_items SET current_attempt_id=$2 WHERE id=$1', [
      ids.activeItem,
      ids.activeAttempt,
    ]);
    await tx.query(
      `INSERT INTO shiling.storage_objects
      (id,upload_attempt_id,backend_key,namespace,object_key)
      VALUES($1,$2,'local','restore-test','active/source')`,
      [ids.activeObject, ids.activeAttempt],
    );
    await tx.query(
      `INSERT INTO shiling.processing_jobs
      (id,version_id,execution_generation,step_key,processor_key,processor_version,required,state)
      VALUES($1,$2,1,'restore-test','restore-test','1',false,'running')`,
      [ids.job, ids.version],
    );
    await tx.query(
      `INSERT INTO shiling.processing_attempts
      (id,job_id,attempt_no,fence,state,worker_instance,deadline_at)
      VALUES($1,$2,1,1,'running','old-worker',now()+interval '15 minutes')`,
      [ids.processingAttempt, ids.job],
    );
    await tx.query('UPDATE shiling.processing_jobs SET current_attempt_id=$2 WHERE id=$1', [
      ids.job,
      ids.processingAttempt,
    ]);
    await tx.query(
      `INSERT INTO shiling.auth_tokens
      (id,user_id,purpose,token_hash,issued_by,expires_at)
      VALUES($1,$2,'recovery',$3,$2,now()+interval '15 minutes')`,
      [ids.token, adminId, 'd'.repeat(64)],
    );
    await tx.query(
      `UPDATE shiling.product_settings SET
      values=jsonb_set(jsonb_set(values,'{publicEnabled}','true'::jsonb,true),'{executePreview}','true'::jsonb,true),
      updated_by=$1 WHERE id=1`,
      [adminId],
    );
  });

  const publications = createPublicationService({
    database,
    identity,
    storage: storageStub(),
    deliverySecret: 'restore-delivery-secret-0000000000000001',
  });
  const grant = await publications.createDeliveryGrant(ids.asset, {
    artifactId: ids.artifact,
    purpose: 'download',
  });
  const grantToken = new URL(grant.url, 'http://shiling.invalid').searchParams.get('grant');
  assert.ok(grantToken);

  const blocker = createDatabase({
    connectionString: databaseUrl,
    applicationName: 'shiling-restore-safety-blocker',
    maxConnections: 1,
  });
  await blocker.query('SELECT 1 AS connected');
  try {
    await assert.rejects(
      () =>
        runRestoreSafety(database, {
          mode: 'apply',
          requestId: 'restore-safety-must-refuse-live-clients',
        }),
      /其他 client backend 连接/,
    );
  } finally {
    await blocker.close();
  }

  const dryRun = await runRestoreSafety(database);
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.changed, false);
  assert.equal(dryRun.before.safe, false);
  assert.equal(dryRun.before.counts.activePublications, 1);
  assert.equal((await identity.getSession(login.sessionToken)).user.id, adminId);

  const applied = await runRestoreSafety(database, {
    mode: 'apply',
    requestId: 'restore-safety-integration',
  });
  assert.equal(applied.after.safe, true);
  assert.notEqual(applied.after.runtimeEpoch, applied.before.runtimeEpoch);
  assert.ok(BigInt(applied.after.publicAccessEpoch) > BigInt(applied.before.publicAccessEpoch));
  assert.ok(BigInt(applied.after.previewAccessEpoch) > BigInt(applied.before.previewAccessEpoch));
  assert.deepEqual(applied.after.counts, {
    otherClientConnections: 0,
    sessions: 0,
    authTokens: 0,
    activePublications: 0,
    uploadAttempts: 0,
    uploadItems: 0,
    processingAttempts: 0,
    processingJobs: 0,
    processingVersions: 0,
  });
  await assert.rejects(
    () => identity.getSession(login.sessionToken),
    (error) => error instanceof AppError && error.code === 'AUTH_REQUIRED',
  );
  await assert.rejects(
    () => publications.openContent(ids.asset, ids.artifact, grantToken),
    (error) => error instanceof AppError && error.code === 'PUBLIC_ASSET_NOT_FOUND',
  );

  const state = await database.query(`SELECT
    (SELECT count(*)::int FROM shiling.sessions WHERE user_id='${adminId}' AND revoked_at IS NOT NULL AND revoke_reason='restore_safety') session_revoked,
    (SELECT revoked_at IS NOT NULL FROM shiling.auth_tokens WHERE id='${ids.token}') token_revoked,
    (SELECT state FROM shiling.publications WHERE id='${ids.publication}') publication_state,
    (SELECT actor_id IS NULL FROM shiling.publication_revisions WHERE publication_id='${ids.publication}' ORDER BY revision_no DESC LIMIT 1) system_revision,
    (SELECT reason_code FROM shiling.publication_revisions WHERE publication_id='${ids.publication}' ORDER BY revision_no DESC LIMIT 1) reason,
    (SELECT state FROM shiling.upload_attempts WHERE id='${ids.activeAttempt}') upload_attempt_state,
    (SELECT transport_state FROM shiling.upload_items WHERE id='${ids.activeItem}') upload_item_state,
    (SELECT state FROM shiling.processing_attempts WHERE id='${ids.processingAttempt}') processing_attempt_state,
    (SELECT state FROM shiling.processing_jobs WHERE id='${ids.job}') processing_job_state,
    (SELECT count(*)::int FROM shiling.audit_events WHERE actor_kind='system' AND action='administration.restore_safety_applied') restore_audits`);
  assert.deepEqual(state.rows[0], {
    session_revoked: 1,
    token_revoked: true,
    publication_state: 'withdrawn',
    system_revision: true,
    reason: 'restore_safety',
    upload_attempt_state: 'aborted',
    upload_item_state: 'failed',
    processing_attempt_state: 'abandoned',
    processing_job_state: 'canceled',
    restore_audits: 1,
  });

  const publicationRevisionCount = Number(
    (
      await database.query(
        'SELECT count(*)::text count FROM shiling.publication_revisions WHERE publication_id=$1',
        [ids.publication],
      )
    ).rows[0].count,
  );
  const second = await runRestoreSafety(database, {
    mode: 'apply',
    requestId: 'restore-safety-integration-repeat',
  });
  assert.equal(second.after.safe, true);
  assert.equal(
    Number(
      (
        await database.query(
          'SELECT count(*)::text count FROM shiling.publication_revisions WHERE publication_id=$1',
          [ids.publication],
        )
      ).rows[0].count,
    ),
    publicationRevisionCount,
  );
  assert.equal((await runRestoreSafety(database, { mode: 'verify' })).after.safe, true);

  await database.query(`CREATE FUNCTION shiling.inject_restore_safety_race()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      INSERT INTO shiling.sessions(id,user_id,identity_id,token_hash,auth_epoch,expires_at)
      SELECT gen_random_uuid(),u.id,i.id,repeat('e',64),u.auth_epoch,now()+interval '1 hour'
      FROM shiling.users u JOIN shiling.identities i ON i.user_id=u.id
      WHERE u.id='${adminId}' ORDER BY i.created_at LIMIT 1;
      RETURN NEW;
    END
    $function$;
    CREATE TRIGGER inject_restore_safety_race
    AFTER INSERT ON shiling.audit_events FOR EACH ROW
    WHEN (NEW.action='administration.restore_safety_applied')
    EXECUTE FUNCTION shiling.inject_restore_safety_race()`);
  await database.close();

  let cliResult;
  try {
    cliResult = await runRestoreCli(['--apply']);
  } finally {
    database = createDatabase({
      connectionString: databaseUrl,
      applicationName: 'shiling-restore-safety-test-cleanup',
      maxConnections: 1,
    });
    await database.query(
      'DROP TRIGGER IF EXISTS inject_restore_safety_race ON shiling.audit_events',
    );
    await database.query('DROP FUNCTION IF EXISTS shiling.inject_restore_safety_race()');
  }

  const unsafeState = await database.query(
    `SELECT count(*)::int live_sessions FROM shiling.sessions WHERE revoked_at IS NULL`,
  );
  assert.equal(cliResult.code, 2, cliResult.stderr);
  assert.equal(cliResult.signal, null);
  assert.equal(JSON.parse(cliResult.stdout.trim()).safe, false);
  assert.equal(unsafeState.rows[0].live_sessions, 1);

  const repaired = await runRestoreSafety(database, {
    mode: 'apply',
    requestId: 'restore-safety-after-cli-unsafe-result',
  });
  assert.equal(repaired.after.safe, true);
});
