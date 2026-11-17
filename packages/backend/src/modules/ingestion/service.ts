import { randomUUID } from 'node:crypto';
import type { UploadMetadata } from '@shiling/contracts';
import type { Database, Transaction } from '../../ports/database.js';
import type { StoragePort } from '../../ports/storage.js';
import { TASK_NAMES, type TaskQueue } from '../../ports/tasks.js';
import type { MediaTypeKey } from '../../ports/media.js';
import { AppError, assertRevision, mapDatabaseError } from '../../errors.js';
import type { IdentityService, MutationContext } from '../identity/service.js';
import type { Actor } from '../identity/authorization.js';
import { appendAudit } from '../administration/audit.js';
import {
  claimIdempotency,
  completeIdempotency,
  requestHash,
} from '../administration/idempotency.js';
import {
  currentIntakePolicy,
  DEFAULT_MAX_BYTES,
  ensureIntake,
  inferRequestedType,
  ownerCanUpload,
  type IntakePolicy,
} from './policy.js';
import {
  authorizeUpload,
  getUpload,
  normalizeMetadata,
  uploadDto,
  type UploadRow,
} from './repository.js';

export interface UploadItemInput {
  clientItemId: string;
  fileName: string;
  declaredBytes: string;
  declaredMediaType: string;
  typeHint?: MediaTypeKey;
  expectedSha256?: string;
  initialMetadata: UploadMetadata;
}
export interface IngestionDependencies {
  database: Database;
  identity: IdentityService;
  storage: StoragePort;
  queue: TaskQueue;
  uploadMaxBytes?: number;
  temporaryObjectRetentionSeconds?: number;
}
interface AttemptRow {
  id: string;
  item_id: string;
  state: string;
  generation: string;
  expires_at: Date;
  intake_policy: IntakePolicy;
  completion_request_hash: string | null;
  verification_queue_job_id: string | null;
}
async function attemptFor(tx: Transaction, attemptId: string): Promise<AttemptRow> {
  const row = (
    await tx.query<AttemptRow>('SELECT * FROM shiling.upload_attempts WHERE id=$1', [attemptId])
  ).rows[0];
  if (!row) throw new AppError(404, 'UPLOAD_NOT_FOUND', '上传尝试不存在。');
  return row;
}
async function lockedAttempt(tx: Transaction, attemptId: string) {
  const initial = await attemptFor(tx, attemptId);
  const row = await getUpload(tx, initial.item_id, true);
  return { row, attempt: await attemptFor(tx, attemptId) };
}
function ensureCurrent(row: UploadRow, attempt: AttemptRow): void {
  if (
    row.current_attempt_id !== attempt.id ||
    row.attempt_generation !== attempt.generation ||
    ['canceled', 'expired'].includes(row.transport_state)
  )
    throw new AppError(409, 'UPLOAD_ATTEMPT_STALE', '该上传尝试已失效，请刷新状态。');
}
async function runtimeEpoch(tx: Transaction): Promise<string> {
  const row = (
    await tx.query<{ runtime_epoch: string }>(
      'SELECT runtime_epoch FROM shiling.product_settings WHERE id=1',
    )
  ).rows[0];
  if (!row) throw new AppError(503, 'SETTINGS_UNAVAILABLE', '实例设置暂不可用。', true);
  return row.runtime_epoch;
}
export async function enqueueProcessing(
  tx: Transaction,
  queue: TaskQueue,
  versionId: string,
  generation: string,
  type: MediaTypeKey,
): Promise<string> {
  const jobId = randomUUID();
  await tx.query(
    "INSERT INTO shiling.processing_jobs(id,version_id,execution_generation,step_key,processor_key,processor_version,required,state) VALUES($1,$2,$3,'media.derive',$4,'1',true,'queued')",
    [jobId, versionId, generation, `builtin.${type}`],
  );
  const queueId = await queue.enqueue(tx, TASK_NAMES.process, {
    jobId,
    generation,
    runtimeEpoch: await runtimeEpoch(tx),
  });
  await tx.query('UPDATE shiling.processing_jobs SET queue_job_id=$2 WHERE id=$1', [
    jobId,
    queueId,
  ]);
  return jobId;
}

export function createIngestionService({
  database,
  identity,
  storage,
  queue,
  uploadMaxBytes = DEFAULT_MAX_BYTES.video,
  temporaryObjectRetentionSeconds = 24 * 60 * 60,
}: IngestionDependencies) {
  if (!Number.isSafeInteger(uploadMaxBytes) || uploadMaxBytes < 1)
    throw new Error('Upload maximum must be a positive safe integer.');
  if (
    !Number.isSafeInteger(temporaryObjectRetentionSeconds) ||
    temporaryObjectRetentionSeconds < 60 * 60 ||
    temporaryObjectRetentionSeconds > 30 * 24 * 60 * 60
  )
    throw new Error('Temporary object retention must be between 1 hour and 30 days.');
  async function write<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await database.transaction(work);
    } catch (error) {
      return mapDatabaseError(error);
    }
  }
  async function createAttemptIn(tx: Transaction, actor: Actor, row: UploadRow, requestId: string) {
    authorizeUpload(
      actor,
      row,
      row.transport_state === 'failed' ? 'uploads.retryOwn' : 'uploads.create',
    );
    if (!['pending', 'failed'].includes(row.transport_state) || row.version_id)
      throw new AppError(409, 'UPLOAD_ATTEMPT_NOT_ALLOWED', '当前状态不能创建传输尝试。');
    if (row.expires_at.getTime() <= Date.now())
      throw new AppError(410, 'UPLOAD_EXPIRED', '上传项已过期，请重新选择文件。');
    if (!(await ownerCanUpload(tx, row.owner_id)))
      throw new AppError(403, 'AUTHORIZATION_REVOKED', '上传者账号或上传权限已撤回。');
    const policy = await currentIntakePolicy(tx, uploadMaxBytes);
    const type = row.requested_type ?? inferRequestedType(row.original_filename);
    ensureIntake(policy, type, Number(row.declared_bytes));
    const attemptId = randomUUID();
    const storageId = randomUUID();
    const generation = String(BigInt(row.attempt_generation) + 1n);
    const attemptNo =
      Number(
        (
          await tx.query<{ maximum: number }>(
            'SELECT coalesce(max(attempt_no),0) maximum FROM shiling.upload_attempts WHERE item_id=$1',
            [row.id],
          )
        ).rows[0]?.maximum ?? 0,
      ) + 1;
    const expiresAt = new Date(Math.min(row.expires_at.getTime(), Date.now() + 3600_000));
    const retainUntil = new Date(expiresAt.getTime() + temporaryObjectRetentionSeconds * 1_000);
    await tx.query(
      "INSERT INTO shiling.upload_attempts(id,item_id,attempt_no,generation,state,transfer_mode,intake_policy,expires_at) VALUES($1,$2,$3,$4,'issued','server_stream',$5,$6)",
      [attemptId, row.id, attemptNo, generation, JSON.stringify(policy), expiresAt],
    );
    await tx.query(
      'INSERT INTO shiling.storage_objects(id,upload_attempt_id,backend_key,namespace,object_key,retain_until) VALUES($1,$2,$3,$4,$5,$6)',
      [
        storageId,
        attemptId,
        storage.backendKey,
        storage.namespace,
        `uploads/${attemptId}/source`,
        retainUntil,
      ],
    );
    await tx.query(
      "UPDATE shiling.upload_items SET current_attempt_id=$2,attempt_generation=$3,transport_state='uploading',failure_code=NULL WHERE id=$1",
      [row.id, attemptId, generation],
    );
    await appendAudit(tx, {
      actorId: actor.id,
      action: 'ingestion.attempt_created',
      resourceType: 'upload_item',
      resourceId: row.id,
      requestId,
    });
    return {
      attemptId,
      transfer: {
        mode: 'server_stream' as const,
        method: 'PUT' as const,
        url: `/api/v1/team/upload-attempts/${attemptId}/content`,
        headers: { 'Content-Length': row.declared_bytes },
        expiresAt: expiresAt.toISOString(),
      },
    };
  }
  return {
    async createBatch(token: string, input: { clientBatchId?: string }, context: MutationContext) {
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token, 'uploads.create');
        const claim = await claimIdempotency(
          tx,
          actor.id,
          'uploads.batch.create',
          context.idempotencyKey,
          requestHash(input),
        );
        if (claim.replay) return { id: String(claim.resourceRefs.batchId) };
        const policy = await currentIntakePolicy(tx, uploadMaxBytes);
        const batchId = randomUUID();
        await tx.query(
          'INSERT INTO shiling.upload_batches(id,owner_id,client_batch_key,intake_policy_revision) VALUES($1,$2,$3,$4)',
          [batchId, actor.id, input.clientBatchId ?? null, policy.settingsRevision],
        );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'ingestion.batch_created',
          resourceType: 'upload_batch',
          resourceId: batchId,
          requestId: context.requestId,
        });
        await completeIdempotency(tx, claim.id, { batchId });
        return { id: batchId };
      });
    },
    async createItem(token: string, batchId: string, input: UploadItemInput, requestId: string) {
      const metadata = normalizeMetadata(input.initialMetadata);
      const fileName = input.fileName.trim();
      if (
        !fileName ||
        fileName.length > 255 ||
        [...fileName].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new AppError(400, 'INVALID_FILENAME', '文件名无效。');
      if (
        !input.clientItemId ||
        input.clientItemId.length > 128 ||
        !/^[1-9][0-9]*$/.test(input.declaredBytes)
      )
        throw new AppError(400, 'INVALID_UPLOAD', '上传项标识或文件长度无效。');
      const type = inferRequestedType(fileName);
      if (input.typeHint && input.typeHint !== type)
        throw new AppError(400, 'MEDIA_TYPE_MISMATCH', '文件扩展名与选择类型不一致。');
      const hash = requestHash({ ...input, fileName, initialMetadata: metadata });
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token, 'uploads.create');
        const batch = (
          await tx.query<{ owner_id: string }>(
            'SELECT owner_id FROM shiling.upload_batches WHERE id=$1 FOR UPDATE',
            [batchId],
          )
        ).rows[0];
        if (!batch || batch.owner_id !== actor.id)
          throw new AppError(404, 'UPLOAD_BATCH_NOT_FOUND', '上传批次不存在。');
        const existing = (
          await tx.query<{ id: string; creation_request_hash: string }>(
            'SELECT id,creation_request_hash FROM shiling.upload_items WHERE batch_id=$1 AND client_item_id=$2',
            [batchId, input.clientItemId],
          )
        ).rows[0];
        if (existing) {
          if (existing.creation_request_hash !== hash)
            throw new AppError(409, 'CLIENT_ITEM_ID_REUSED', '同一上传项标识不能用于不同文件。');
          return uploadDto(await getUpload(tx, existing.id), actor);
        }
        const policy = await currentIntakePolicy(tx, uploadMaxBytes);
        ensureIntake(policy, type, Number(input.declaredBytes));
        const count = Number(
          (
            await tx.query<{ count: string }>(
              'SELECT count(*) FROM shiling.upload_items WHERE batch_id=$1',
              [batchId],
            )
          ).rows[0]?.count ?? 0,
        );
        if (count >= 100) throw new AppError(400, 'BATCH_ITEM_LIMIT', '每批最多接收 100 个文件。');
        const itemId = randomUUID();
        await tx.query(
          `INSERT INTO shiling.upload_items(id,batch_id,ordinal,client_item_id,creation_request_hash,requested_type,original_filename,declared_bytes,declared_media_type,declared_sha256,initial_metadata,requested_collection_ids,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+interval '24 hours')`,
          [
            itemId,
            batchId,
            count,
            input.clientItemId,
            hash,
            type,
            fileName,
            input.declaredBytes,
            input.declaredMediaType,
            input.expectedSha256 ?? null,
            JSON.stringify({
              schemaVersion: 1,
              title: metadata.title,
              description: metadata.description,
              tagIds: metadata.tagIds,
            }),
            metadata.collectionIds,
          ],
        );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'ingestion.item_created',
          resourceType: 'upload_item',
          resourceId: itemId,
          requestId,
        });
        return uploadDto(await getUpload(tx, itemId), actor);
      });
    },
    async getItem(token: string, itemId: string) {
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token);
        const row = await getUpload(tx, itemId);
        authorizeUpload(actor, row, 'uploads.readOwn');
        return uploadDto(row, actor);
      });
    },
    async getBatch(token: string, batchId: string) {
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token);
        const batch = (
          await tx.query<{ id: string; owner_id: string; created_at: Date }>(
            'SELECT id,owner_id,created_at FROM shiling.upload_batches WHERE id=$1',
            [batchId],
          )
        ).rows[0];
        if (
          !batch ||
          (batch.owner_id !== actor.id && !actor.permissionKeys.includes('uploads.governAny'))
        )
          throw new AppError(404, 'UPLOAD_BATCH_NOT_FOUND', '上传批次不存在。');
        if (
          !actor.permissionKeys.includes('uploads.governAny') &&
          !actor.permissionKeys.includes('uploads.readOwn')
        )
          throw new AppError(403, 'FORBIDDEN', '没有查看上传工作区的权限。');
        const ids = await tx.query<{ id: string }>(
          'SELECT id FROM shiling.upload_items WHERE batch_id=$1 ORDER BY ordinal',
          [batchId],
        );
        const items = [];
        for (const item of ids.rows) items.push(uploadDto(await getUpload(tx, item.id), actor));
        return {
          id: batch.id,
          createdAt: batch.created_at.toISOString(),
          items,
          counts: items.reduce<Record<string, number>>((counts, item) => {
            counts[item.uiState] = (counts[item.uiState] ?? 0) + 1;
            return counts;
          }, {}),
        };
      });
    },
    async listBatches(
      token: string,
      input: { scope?: 'own' | 'all'; beforeId?: string; limit?: number } = {},
    ) {
      return write(async (tx) => {
        const actor = await identity.authorize(
          tx,
          token,
          input.scope === 'all' ? 'uploads.governAny' : 'uploads.readOwn',
        );
        const limit = input.limit ?? 40;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new AppError(400, 'INVALID_PAGE_LIMIT', '每页数量应为 1 至 100。');
        const rows = (
          await tx.query<{ id: string; created_at: Date; item_count: string }>(
            `SELECT b.id,b.created_at,(SELECT count(*) FROM shiling.upload_items i WHERE i.batch_id=b.id) item_count FROM shiling.upload_batches b
          WHERE ($1::uuid IS NULL OR b.owner_id=$1) AND ($2::uuid IS NULL OR b.id<$2) ORDER BY b.id DESC LIMIT $3`,
            [input.scope === 'all' ? null : actor.id, input.beforeId ?? null, limit + 1],
          )
        ).rows;
        const hasMore = rows.length > limit;
        const items = rows.slice(0, limit).map((row) => ({
          id: row.id,
          createdAt: row.created_at.toISOString(),
          itemCount: Number(row.item_count),
        }));
        return {
          items,
          pageInfo: { hasMore, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null },
        };
      });
    },
    async updateMetadata(
      token: string,
      itemId: string,
      input: UploadMetadata,
      expectedRevision: string,
      requestId: string,
    ) {
      const metadata = normalizeMetadata(input);
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token);
        const row = await getUpload(tx, itemId, true);
        authorizeUpload(actor, row, 'uploads.create');
        assertRevision(row.revision, expectedRevision, true);
        if (
          row.processing_state === 'ready' ||
          row.processing_state === 'canceled' ||
          ['canceled', 'expired'].includes(row.transport_state)
        )
          throw new AppError(409, 'UPLOAD_METADATA_LOCKED', '当前上传状态不允许修改整理信息。');
        await tx.query(
          'UPDATE shiling.upload_items SET initial_metadata=$2,requested_collection_ids=$3 WHERE id=$1',
          [
            itemId,
            JSON.stringify({
              schemaVersion: 1,
              title: metadata.title,
              description: metadata.description,
              tagIds: metadata.tagIds,
            }),
            metadata.collectionIds,
          ],
        );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'ingestion.metadata_updated',
          resourceType: 'upload_item',
          resourceId: itemId,
          requestId,
        });
        const updated = await getUpload(tx, itemId);
        return { itemId, revision: updated.revision, metadata };
      });
    },
    async createAttempt(token: string, itemId: string, context: MutationContext) {
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token);
        const row = await getUpload(tx, itemId, true);
        authorizeUpload(
          actor,
          row,
          row.transport_state === 'failed' ? 'uploads.retryOwn' : 'uploads.create',
        );
        const claim = await claimIdempotency(
          tx,
          actor.id,
          'uploads.attempt.create',
          context.idempotencyKey,
          requestHash({ itemId }),
        );
        if (claim.replay) {
          const attempt = await attemptFor(tx, String(claim.resourceRefs.attemptId));
          ensureCurrent(row, attempt);
          if (
            attempt.expires_at.getTime() <= Date.now() ||
            !['issued', 'receiving'].includes(attempt.state)
          )
            throw new AppError(409, 'UPLOAD_ATTEMPT_STALE', '上传授权已失效，请刷新任务状态。');
          return {
            attemptId: attempt.id,
            transfer: {
              mode: 'server_stream' as const,
              method: 'PUT' as const,
              url: `/api/v1/team/upload-attempts/${attempt.id}/content`,
              headers: { 'Content-Length': row.declared_bytes },
              expiresAt: attempt.expires_at.toISOString(),
            },
          };
        }
        const result = await createAttemptIn(tx, actor, row, context.requestId);
        await completeIdempotency(tx, claim.id, { attemptId: result.attemptId });
        return result;
      });
    },
    async receiveContent(
      token: string,
      attemptId: string,
      source: AsyncIterable<Uint8Array>,
      contentLength: number,
      requestId: string,
    ) {
      const claim = await write(async (tx) => {
        const actor = await identity.authorize(tx, token);
        const { attempt, row } = await lockedAttempt(tx, attemptId);
        authorizeUpload(actor, row, 'uploads.create');
        ensureCurrent(row, attempt);
        if (attempt.state !== 'issued' || attempt.expires_at.getTime() <= Date.now())
          throw new AppError(409, 'UPLOAD_ATTEMPT_STALE', '传输已开始或授权过期，请刷新任务状态。');
        if (contentLength !== Number(row.declared_bytes))
          throw new AppError(400, 'UPLOAD_SIZE_MISMATCH', 'Content-Length 与声明文件长度不一致。');
        const object = (
          await tx.query<{ id: string; object_key: string }>(
            'SELECT id,object_key FROM shiling.storage_objects WHERE upload_attempt_id=$1',
            [attemptId],
          )
        ).rows[0];
        if (!object) throw new AppError(409, 'STORAGE_OBJECT_UNAVAILABLE', '上传对象未登记。');
        await tx.query("UPDATE shiling.upload_attempts SET state='receiving' WHERE id=$1", [
          attemptId,
        ]);
        return {
          actorId: actor.id,
          itemId: row.id,
          object,
          maxBytes:
            attempt.intake_policy.maxBytes[
              row.requested_type ?? inferRequestedType(row.original_filename)
            ],
          generation: row.attempt_generation,
        };
      });
      try {
        const stored = await storage.put(claim.object.object_key, source, {
          maxBytes: claim.maxBytes,
          expectedBytes: contentLength,
          commit: async (content, persist) =>
            write(async (tx) => {
              const row = await getUpload(tx, claim.itemId, true);
              const attempt = await attemptFor(tx, attemptId);
              ensureCurrent(row, attempt);
              if (attempt.state !== 'receiving' || attempt.expires_at.getTime() <= Date.now())
                throw new AppError(
                  409,
                  'UPLOAD_ATTEMPT_STALE',
                  '上传授权已失效，接收结果不会入库。',
                );
              const object = (
                await tx.query<{ state: string; gc_token: string | null }>(
                  'SELECT state,gc_token FROM shiling.storage_objects WHERE id=$1 FOR UPDATE',
                  [claim.object.id],
                )
              ).rows[0];
              if (!object || object.state !== 'reserved' || object.gc_token !== null)
                throw new AppError(409, 'STORAGE_OBJECT_UNAVAILABLE', '上传对象正在回收或不可用。');
              // The final link is an atomic local operation and runs while the storage ledger row
              // is locked, so cleanup cannot claim the object between file commit and DB commit.
              await persist();
              const updated = await tx.query(
                `UPDATE shiling.storage_objects SET state='stored',bytes=$2,sha256=$3
                 WHERE id=$1 AND state='reserved' AND gc_token IS NULL RETURNING id`,
                [claim.object.id, content.bytes, content.sha256],
              );
              if (!updated.rowCount)
                throw new AppError(409, 'STORAGE_OBJECT_UNAVAILABLE', '上传对象正在回收或不可用。');
              await tx.query('UPDATE shiling.upload_attempts SET received_bytes=$2 WHERE id=$1', [
                attemptId,
                content.bytes,
              ]);
              await appendAudit(tx, {
                actorId: claim.actorId,
                action: 'ingestion.content_received',
                resourceType: 'upload_item',
                resourceId: row.id,
                requestId,
              });
            }),
        });
        return { receivedBytes: String(stored.bytes) };
      } catch (error) {
        await write(async (tx) => {
          const row = await getUpload(tx, claim.itemId, true);
          if (
            row.current_attempt_id !== attemptId ||
            row.attempt_generation !== claim.generation ||
            row.transport_state !== 'uploading'
          )
            return;
          const code = error instanceof AppError ? error.code : 'UPLOAD_STREAM_FAILED';
          await tx.query(
            "UPDATE shiling.upload_attempts SET state='failed',failure_code=$2 WHERE id=$1 AND state='receiving'",
            [attemptId, code],
          );
          await tx.query(
            "UPDATE shiling.upload_items SET transport_state='failed',failure_code=$2 WHERE id=$1",
            [row.id, code],
          );
        });
        throw error;
      }
    },
    async attemptProgress(token: string, attemptId: string) {
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token);
        const attempt = await attemptFor(tx, attemptId);
        const row = await getUpload(tx, attempt.item_id);
        authorizeUpload(actor, row, 'uploads.readOwn');
        const received = (
          await tx.query<{ received_bytes: string | null }>(
            'SELECT received_bytes FROM shiling.upload_attempts WHERE id=$1',
            [attemptId],
          )
        ).rows[0];
        return {
          attemptId,
          mode: 'server_stream' as const,
          state: attempt.state,
          receivedBytes: received?.received_bytes ?? null,
          totalBytes: row.declared_bytes,
          resumable: false,
          current: row.current_attempt_id === attemptId,
          expiresAt: attempt.expires_at.toISOString(),
        };
      });
    },
    async completeAttempt(
      token: string,
      attemptId: string,
      manifest: { parts?: { partNumber: number; etag: string }[] },
      requestId: string,
    ) {
      if (manifest.parts?.length)
        throw new AppError(400, 'TRANSFER_MODE_UNSUPPORTED', '当前 Local 上传不接受云端分片清单。');
      const manifestHash = requestHash({});
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token);
        const { attempt, row } = await lockedAttempt(tx, attemptId);
        authorizeUpload(actor, row, 'uploads.create');
        ensureCurrent(row, attempt);
        if (attempt.completion_request_hash) {
          if (attempt.completion_request_hash !== manifestHash)
            throw new AppError(409, 'COMPLETION_MANIFEST_CHANGED', '完成清单已固定，不能改写。');
          return { itemId: row.id, attemptId, jobId: attempt.verification_queue_job_id };
        }
        if (attempt.state !== 'receiving' || attempt.expires_at.getTime() <= Date.now())
          throw new AppError(409, 'UPLOAD_NOT_RECEIVED', '上传内容尚未接收完成或授权已失效。');
        const object = (
          await tx.query<{ state: string }>(
            'SELECT state FROM shiling.storage_objects WHERE upload_attempt_id=$1',
            [attemptId],
          )
        ).rows[0];
        if (object?.state !== 'stored')
          throw new AppError(409, 'UPLOAD_NOT_RECEIVED', '上传内容尚未接收完成。');
        const jobId = await queue.enqueue(tx, TASK_NAMES.verify, {
          uploadAttemptId: attemptId,
          generation: attempt.generation,
          runtimeEpoch: await runtimeEpoch(tx),
        });
        await tx.query(
          "UPDATE shiling.upload_attempts SET state='verifying',completion_manifest='{}',completion_request_hash=$2,verification_queue_job_id=$3 WHERE id=$1",
          [attemptId, manifestHash, jobId],
        );
        await tx.query("UPDATE shiling.upload_items SET transport_state='verifying' WHERE id=$1", [
          row.id,
        ]);
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'ingestion.verification_queued',
          resourceType: 'upload_item',
          resourceId: row.id,
          requestId,
        });
        return { itemId: row.id, attemptId, jobId };
      });
    },
    async cancel(token: string, itemId: string, context: MutationContext) {
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token);
        const row = await getUpload(tx, itemId, true);
        authorizeUpload(actor, row, 'uploads.cancelOwn');
        const claim = await claimIdempotency(
          tx,
          actor.id,
          'uploads.cancel',
          context.idempotencyKey,
          requestHash({ itemId }),
        );
        if (claim.replay) return uploadDto(row, actor);
        if (row.processing_state === 'ready')
          throw new AppError(409, 'UPLOAD_ALREADY_READY', '素材已就绪，请使用归档操作。');
        if (
          row.processing_state === 'canceled' ||
          ['canceled', 'expired'].includes(row.transport_state)
        ) {
          await completeIdempotency(tx, claim.id, { itemId });
          return uploadDto(row, actor);
        }
        if (row.version_id) {
          await tx.query(
            "UPDATE shiling.asset_versions SET processing_state='canceled',execution_generation=execution_generation+1 WHERE id=$1",
            [row.version_id],
          );
          await tx.query(
            "UPDATE shiling.processing_jobs SET state='canceled',attempt_fence=attempt_fence+1 WHERE version_id=$1 AND state IN ('pending','queued','running')",
            [row.version_id],
          );
          await tx.query(
            "UPDATE shiling.processing_attempts a SET state='canceled',finished_at=now() FROM shiling.processing_jobs j WHERE a.job_id=j.id AND j.version_id=$1 AND a.state='running'",
            [row.version_id],
          );
        } else if (!['canceled', 'expired'].includes(row.transport_state)) {
          await tx.query(
            "UPDATE shiling.upload_items SET transport_state='canceled',attempt_generation=attempt_generation+1 WHERE id=$1",
            [itemId],
          );
          if (row.current_attempt_id)
            await tx.query(
              "UPDATE shiling.upload_attempts SET state='aborted',verification_fence=verification_fence+1 WHERE id=$1 AND state IN ('issued','receiving','verifying','failed')",
              [row.current_attempt_id],
            );
        }
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'ingestion.canceled',
          resourceType: 'upload_item',
          resourceId: itemId,
          requestId: context.requestId,
        });
        await completeIdempotency(tx, claim.id, { itemId });
        return uploadDto(await getUpload(tx, itemId), actor);
      });
    },
    async retry(
      token: string,
      itemId: string,
      scope: 'transfer' | 'processing',
      context: MutationContext,
    ) {
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token);
        const row = await getUpload(tx, itemId, true);
        authorizeUpload(actor, row, 'uploads.retryOwn');
        const claim = await claimIdempotency(
          tx,
          actor.id,
          'uploads.retry',
          context.idempotencyKey,
          requestHash({ itemId, scope }),
        );
        if (claim.replay)
          return {
            item: uploadDto(row, actor),
            jobId: typeof claim.resourceRefs.jobId === 'string' ? claim.resourceRefs.jobId : null,
          };
        if (row.processing_state === 'ready')
          throw new AppError(409, 'UPLOAD_ALREADY_READY', '素材已经就绪，无需重试。');
        if (scope === 'transfer') {
          if (row.transport_state !== 'failed' || row.version_id)
            throw new AppError(409, 'RETRY_NOT_ALLOWED', '当前状态不能重试传输。');
          const attempt = await createAttemptIn(tx, actor, row, context.requestId);
          await completeIdempotency(tx, claim.id, { itemId, attemptId: attempt.attemptId });
          return { item: uploadDto(await getUpload(tx, itemId), actor), jobId: null, ...attempt };
        }
        if (
          row.transport_state !== 'verified' ||
          row.processing_state !== 'failed' ||
          !row.version_id
        )
          throw new AppError(409, 'RETRY_NOT_ALLOWED', '当前状态不能重试处理。');
        if (!(await ownerCanUpload(tx, row.owner_id)))
          throw new AppError(403, 'AUTHORIZATION_REVOKED', '上传者账号或上传权限尚未恢复。');
        const generation = String(BigInt(row.execution_generation ?? '1') + 1n);
        await tx.query(
          "UPDATE shiling.asset_versions SET processing_state='processing',execution_generation=$2,failure_code=NULL WHERE id=$1",
          [row.version_id, generation],
        );
        const jobId = await enqueueProcessing(
          tx,
          queue,
          row.version_id,
          generation,
          row.requested_type ?? inferRequestedType(row.original_filename),
        );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'ingestion.processing_retried',
          resourceType: 'upload_item',
          resourceId: itemId,
          requestId: context.requestId,
        });
        await completeIdempotency(tx, claim.id, { itemId, jobId });
        return { item: uploadDto(await getUpload(tx, itemId), actor), jobId };
      });
    },
  };
}
export type IngestionService = ReturnType<typeof createIngestionService>;
