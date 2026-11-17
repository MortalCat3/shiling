import { randomUUID } from 'node:crypto';
import type { Database, Transaction } from '../../ports/database.js';
import { appendAudit } from './audit.js';

export interface RestoreSafetyCounts {
  readonly otherClientConnections: number;
  readonly sessions: number;
  readonly authTokens: number;
  readonly activePublications: number;
  readonly uploadAttempts: number;
  readonly uploadItems: number;
  readonly processingAttempts: number;
  readonly processingJobs: number;
  readonly processingVersions: number;
}

export interface RestoreSafetySnapshot {
  readonly publicEnabled: boolean;
  readonly previewEnabled: boolean;
  readonly runtimeEpoch: string;
  readonly publicAccessEpoch: string;
  readonly previewAccessEpoch: string;
  readonly counts: RestoreSafetyCounts;
  readonly safe: boolean;
}

export interface RestoreSafetyResult {
  readonly mode: 'dry-run' | 'apply' | 'verify';
  readonly changed: boolean;
  readonly before: RestoreSafetySnapshot;
  readonly after: RestoreSafetySnapshot;
}

interface SnapshotRow {
  public_enabled: boolean;
  preview_enabled: boolean;
  runtime_epoch: string;
  public_access_epoch: string;
  preview_access_epoch: string;
  other_client_connections: string;
  sessions: string;
  auth_tokens: string;
  active_publications: string;
  upload_attempts: string;
  upload_items: string;
  processing_attempts: string;
  processing_jobs: string;
  processing_versions: string;
}

function count(value: string, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error(`灾备安全检查返回了无效的 ${name} 数量。`);
  return result;
}

async function snapshot(transaction: Transaction): Promise<RestoreSafetySnapshot> {
  const row = (
    await transaction.query<SnapshotRow>(`SELECT
      COALESCE((s.values->>'publicEnabled')::boolean,false) public_enabled,
      COALESCE((s.values->>'executePreview')::boolean,false) preview_enabled,
      s.runtime_epoch::text runtime_epoch,
      s.public_access_epoch::text public_access_epoch,
      s.preview_access_epoch::text preview_access_epoch,
      (SELECT count(*)::text FROM pg_catalog.pg_stat_activity
       WHERE datname=pg_catalog.current_database()
         AND backend_type='client backend'
         AND pid<>pg_catalog.pg_backend_pid()) other_client_connections,
      (SELECT count(*)::text FROM shiling.sessions WHERE revoked_at IS NULL) sessions,
      (SELECT count(*)::text FROM shiling.auth_tokens WHERE revoked_at IS NULL AND consumed_at IS NULL) auth_tokens,
      (SELECT count(*)::text FROM shiling.publications WHERE state='active') active_publications,
      (SELECT count(*)::text FROM shiling.upload_attempts WHERE state IN ('issued','receiving','verifying')) upload_attempts,
      (SELECT count(*)::text FROM shiling.upload_items WHERE transport_state IN ('uploading','verifying')) upload_items,
      (SELECT count(*)::text FROM shiling.processing_attempts WHERE state='running') processing_attempts,
      (SELECT count(*)::text FROM shiling.processing_jobs WHERE state IN ('pending','queued','running')) processing_jobs,
      (SELECT count(*)::text FROM shiling.asset_versions WHERE processing_state='processing') processing_versions
    FROM shiling.product_settings s WHERE s.id=1 FOR SHARE`)
  ).rows[0];
  if (!row) throw new Error('拾灵产品设置不存在，拒绝执行灾备安全动作。');
  const counts: RestoreSafetyCounts = {
    otherClientConnections: count(row.other_client_connections, '其他客户端连接'),
    sessions: count(row.sessions, '会话'),
    authTokens: count(row.auth_tokens, '一次性令牌'),
    activePublications: count(row.active_publications, '公开记录'),
    uploadAttempts: count(row.upload_attempts, '上传尝试'),
    uploadItems: count(row.upload_items, '上传项'),
    processingAttempts: count(row.processing_attempts, '处理尝试'),
    processingJobs: count(row.processing_jobs, '处理任务'),
    processingVersions: count(row.processing_versions, '处理中版本'),
  };
  const safe =
    !row.public_enabled &&
    !row.preview_enabled &&
    Object.values(counts).every((value) => value === 0);
  return {
    publicEnabled: row.public_enabled,
    previewEnabled: row.preview_enabled,
    runtimeEpoch: row.runtime_epoch,
    publicAccessEpoch: row.public_access_epoch,
    previewAccessEpoch: row.preview_access_epoch,
    counts,
    safe,
  };
}

interface ActivePublicationRow {
  id: string;
  asset_id: string;
  version_id: string;
  publication_revision: string;
  asset_revision: string;
}

async function withdrawActivePublications(
  transaction: Transaction,
  requestId: string,
): Promise<number> {
  const publications = (
    await transaction.query<ActivePublicationRow>(`SELECT
      p.id,p.asset_id,r.version_id,p.revision publication_revision,a.revision asset_revision
    FROM shiling.publications p
    JOIN shiling.publication_revisions r ON r.id=p.current_revision_id
    JOIN shiling.assets a ON a.id=p.asset_id
    WHERE p.state='active'
    ORDER BY p.id
    FOR UPDATE OF p,a`)
  ).rows;
  for (const publication of publications) {
    const revisionId = randomUUID();
    const revision = String(BigInt(publication.publication_revision) + 1n);
    await transaction.query(
      `INSERT INTO shiling.publication_revisions
      (id,publication_id,asset_id,revision_no,action,version_id,source_asset_revision,actor_id,reason_code)
      VALUES($1,$2,$3,$4,'withdraw',$5,$6,NULL,'restore_safety')`,
      [
        revisionId,
        publication.id,
        publication.asset_id,
        revision,
        publication.version_id,
        publication.asset_revision,
      ],
    );
    await transaction.query(
      "UPDATE shiling.publications SET state='withdrawn',current_revision_id=$2,updated_by=NULL WHERE id=$1",
      [publication.id, revisionId],
    );
    await appendAudit(transaction, {
      actorId: null,
      action: 'publication.withdrawn',
      resourceType: 'asset',
      resourceId: publication.asset_id,
      requestId,
      changes: { reason: 'restore_safety', publicationRevision: revision },
    });
  }
  return publications.length;
}

async function apply(transaction: Transaction, requestId: string): Promise<void> {
  await transaction.query(`UPDATE shiling.product_settings SET
    values=jsonb_set(jsonb_set(values,'{publicEnabled}','false'::jsonb,true),'{executePreview}','false'::jsonb,true),
    public_access_epoch=public_access_epoch+1,
    preview_access_epoch=preview_access_epoch+1,
    runtime_epoch=gen_random_uuid(),
    updated_by=NULL
    WHERE id=1`);
  const sessions = await transaction.query(
    "UPDATE shiling.sessions SET revoked_at=now(),revoke_reason='restore_safety' WHERE revoked_at IS NULL",
  );
  const tokens = await transaction.query(
    'UPDATE shiling.auth_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE revoked_at IS NULL AND consumed_at IS NULL',
  );
  const uploadAttempts = await transaction.query(
    `UPDATE shiling.upload_attempts SET state='aborted',failure_code='RESTORE_EPOCH_REVOKED'
    WHERE state IN ('issued','receiving','verifying')`,
  );
  const uploadItems = await transaction.query(
    `UPDATE shiling.upload_items SET transport_state='failed',failure_code='RESTORE_EPOCH_REVOKED'
    WHERE transport_state IN ('uploading','verifying')`,
  );
  const processingAttempts = await transaction.query(
    `UPDATE shiling.processing_attempts SET state='abandoned',finished_at=now(),error_code='RESTORE_EPOCH_REVOKED'
    WHERE state='running'`,
  );
  const processingJobs = await transaction.query(
    `UPDATE shiling.processing_jobs SET state='canceled',failure_code='RESTORE_EPOCH_REVOKED'
    WHERE state IN ('pending','queued','running')`,
  );
  const processingVersions = await transaction.query(
    `UPDATE shiling.asset_versions SET processing_state='failed',failure_code='RESTORE_EPOCH_REVOKED'
    WHERE processing_state='processing'`,
  );
  const publications = await withdrawActivePublications(transaction, requestId);
  await appendAudit(transaction, {
    actorId: null,
    action: 'administration.restore_safety_applied',
    resourceType: 'settings',
    resourceId: null,
    requestId,
    changes: {
      revokedSessions: sessions.rowCount,
      revokedAuthTokens: tokens.rowCount,
      abortedUploadAttempts: uploadAttempts.rowCount,
      failedUploadItems: uploadItems.rowCount,
      abandonedProcessingAttempts: processingAttempts.rowCount,
      canceledProcessingJobs: processingJobs.rowCount,
      failedProcessingVersions: processingVersions.rowCount,
      withdrawnPublications: publications,
    },
  });
}

export async function runRestoreSafety(
  database: Database,
  options: { mode?: 'dry-run' | 'apply' | 'verify'; requestId?: string } = {},
): Promise<RestoreSafetyResult> {
  const mode = options.mode ?? 'dry-run';
  return database.transaction(async (transaction) => {
    await transaction.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('shiling:restore-safety',0))`,
    );
    const before = await snapshot(transaction);
    if (mode === 'apply' && before.counts.otherClientConnections > 0)
      throw new Error(
        `检测到同一数据库仍有 ${before.counts.otherClientConnections} 个其他 client backend 连接；请先停止 API、worker、preview、迁移和人工数据库会话，再重新执行。`,
      );
    if (mode === 'apply') await apply(transaction, options.requestId ?? `restore-${randomUUID()}`);
    const after = mode === 'apply' ? await snapshot(transaction) : before;
    return { mode, changed: mode === 'apply', before, after };
  });
}
