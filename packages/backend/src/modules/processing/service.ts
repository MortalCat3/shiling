import { requireStorageLocation } from '../../storage/binding.js';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { Database, Transaction } from '../../ports/database.js';
import type { StoragePort } from '../../ports/storage.js';
import type {
  MediaProcessor,
  MediaTypeKey,
  MediaInspection,
  MediaArtifactOutput,
} from '../../ports/media.js';
import type { TaskQueue } from '../../ports/tasks.js';
import { AppError } from '../../errors.js';
import { appendAudit } from '../administration/audit.js';
import { getUpload, type UploadRow } from '../ingestion/repository.js';
import { DEFAULT_MAX_BYTES, ownerCanUpload, type IntakePolicy } from '../ingestion/policy.js';
import { enqueueProcessing } from '../ingestion/service.js';

export interface VerificationTask {
  uploadAttemptId: string;
  generation: string;
  runtimeEpoch: string;
}
export interface ProcessingTask {
  jobId: string;
  generation: string;
  runtimeEpoch: string;
}
export interface WorkerContext {
  requestId: string;
  workerInstance: string;
}
export interface ProcessingDependencies {
  database: Database;
  storage: StoragePort;
  queue: TaskQueue;
  media: MediaProcessor;
  temporaryDirectory?: string;
  temporaryObjectRetentionSeconds?: number;
}
interface VerificationAttempt {
  id: string;
  item_id: string;
  generation: string;
  state: string;
  verification_fence: string;
  verification_deadline_at: Date | null;
  expires_at: Date;
  intake_policy: IntakePolicy;
}
interface ObjectRow {
  id: string;
  object_key: string;
  backend_key: string;
  namespace: string;
  state: string;
  bytes: string | null;
  sha256: string | null;
}
const requiredRoles: Readonly<Record<MediaTypeKey, readonly string[]>> = {
  image: ['original', 'thumbnail'],
  video: ['original', 'poster', 'playback_video'],
  web_motion: ['original', 'motion_manifest', 'poster'],
};

async function epochMatches(tx: Transaction, epoch: string): Promise<boolean> {
  return (
    (
      await tx.query('SELECT id FROM shiling.product_settings WHERE id=1 AND runtime_epoch=$1', [
        epoch,
      ])
    ).rowCount > 0
  );
}
function failureCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'safeMessage' in error &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)
  )
    return error.code;
  return 'PROCESSING_FAILED';
}
async function safeOutput(directory: string, artifact: MediaArtifactOutput): Promise<void> {
  const path = await realpath(artifact.filePath);
  const rel = relative(directory, path);
  if (
    !rel ||
    rel.startsWith('..') ||
    isAbsolute(rel) ||
    (await lstat(artifact.filePath)).isSymbolicLink()
  )
    throw new AppError(422, 'PROCESSOR_OUTPUT_UNSAFE', '媒体处理输出路径无效。');
  if (
    ![
      'thumbnail',
      'preview_image',
      'poster',
      'playback_video',
      'motion_manifest',
      'loop_video',
    ].includes(artifact.role)
  )
    throw new AppError(422, 'PROCESSOR_OUTPUT_UNSAFE', '媒体处理输出角色无效。');
  if (
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes < 1 ||
    artifact.bytes > 1024 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)
  )
    throw new AppError(422, 'PROCESSOR_OUTPUT_UNSAFE', '媒体处理输出大小或摘要无效。');
}
async function applyOrganization(
  tx: Transaction,
  row: UploadRow,
  assetId: string,
): Promise<{ code: string; message: string }[]> {
  const permissions = (
    await tx.query<{ permission_key: string }>(
      'SELECT rp.permission_key FROM shiling.users u JOIN shiling.role_permissions rp ON rp.role_id=u.role_id WHERE u.id=$1',
      [row.owner_id],
    )
  ).rows.map((permission) => permission.permission_key);
  const warnings: { code: string; message: string }[] = [];
  let tagSkipped = false;
  let collectionSkipped = false;
  for (const tagId of [...row.initial_metadata.tagIds].sort()) {
    const tag = (
      await tx.query<{ state: string }>('SELECT state FROM shiling.tags WHERE id=$1 FOR SHARE', [
        tagId,
      ])
    ).rows[0];
    if (
      tag?.state !== 'active' ||
      !permissions.includes('assets.editOwn') ||
      !permissions.includes('tags.read')
    ) {
      tagSkipped = true;
      continue;
    }
    await tx.query(
      'INSERT INTO shiling.asset_tags(asset_id,tag_id,assigned_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [assetId, tagId, row.owner_id],
    );
  }
  for (const collectionId of [...row.requested_collection_ids].sort()) {
    const collection = (
      await tx.query<{ owner_id: string; archived_at: Date | null }>(
        'SELECT owner_id,archived_at FROM shiling.collections WHERE id=$1 FOR UPDATE',
        [collectionId],
      )
    ).rows[0];
    if (
      !collection ||
      collection.archived_at ||
      !permissions.includes('assets.read') ||
      !permissions.includes('collections.read') ||
      !(
        permissions.includes('collections.governAny') ||
        (collection.owner_id === row.owner_id && permissions.includes('collections.manageOwn'))
      )
    ) {
      collectionSkipped = true;
      continue;
    }
    const inserted = await tx.query(
      'INSERT INTO shiling.collection_items(collection_id,asset_id,added_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [collectionId, assetId, row.owner_id],
    );
    if (inserted.rowCount)
      await tx.query('UPDATE shiling.collections SET updated_at=now() WHERE id=$1', [collectionId]);
  }
  if (tagSkipped)
    warnings.push({
      code: 'TAG_ASSIGNMENT_SKIPPED',
      message: '部分标签已停用或当前无权关联，可在素材详情中重新整理。',
    });
  if (collectionSkipped)
    warnings.push({
      code: 'COLLECTION_ASSIGNMENT_SKIPPED',
      message: '部分集合已归档或当前无权维护，可在素材详情中重新整理。',
    });
  return warnings;
}

export function createProcessingService({
  database,
  storage,
  queue,
  media,
  temporaryDirectory = tmpdir(),
  temporaryObjectRetentionSeconds = 24 * 60 * 60,
}: ProcessingDependencies) {
  if (
    !Number.isSafeInteger(temporaryObjectRetentionSeconds) ||
    temporaryObjectRetentionSeconds < 60 * 60 ||
    temporaryObjectRetentionSeconds > 30 * 24 * 60 * 60
  )
    throw new Error('Temporary object retention must be between 1 hour and 30 days.');
  async function verificationRow(tx: Transaction, task: VerificationTask) {
    const initial = (
      await tx.query<{ item_id: string }>(
        'SELECT item_id FROM shiling.upload_attempts WHERE id=$1',
        [task.uploadAttemptId],
      )
    ).rows[0];
    if (!initial) return null;
    const item = await getUpload(tx, initial.item_id, true);
    const attempt = (
      await tx.query<VerificationAttempt>(
        'SELECT * FROM shiling.upload_attempts WHERE id=$1 FOR UPDATE',
        [task.uploadAttemptId],
      )
    ).rows[0];
    if (
      !attempt ||
      !(await epochMatches(tx, task.runtimeEpoch)) ||
      item.current_attempt_id !== attempt.id ||
      item.attempt_generation !== task.generation ||
      attempt.generation !== task.generation ||
      item.transport_state !== 'verifying' ||
      attempt.state !== 'verifying'
    )
      return null;
    return { item, attempt };
  }
  async function failVerification(task: VerificationTask, fence: string, code: string) {
    await database.transaction(async (tx) => {
      const current = await verificationRow(tx, task);
      if (!current || current.attempt.verification_fence !== fence) return;
      await tx.query(
        "UPDATE shiling.upload_attempts SET state='failed',failure_code=$2 WHERE id=$1",
        [task.uploadAttemptId, code],
      );
      await tx.query(
        "UPDATE shiling.upload_items SET transport_state='failed',failure_code=$2 WHERE id=$1",
        [current.item.id, code],
      );
    });
  }
  async function createVerifiedVersion(
    tx: Transaction,
    row: UploadRow,
    attemptId: string,
    object: ObjectRow,
    inspection: MediaInspection,
    context: WorkerContext,
  ) {
    const assetId = randomUUID();
    const versionId = randomUUID();
    const artifactId = randomUUID();
    const storageState = (
      await tx.query<{ state: string; gc_token: string | null }>(
        'SELECT state,gc_token FROM shiling.storage_objects WHERE id=$1 FOR UPDATE',
        [object.id],
      )
    ).rows[0];
    if (
      !storageState ||
      !['reserved', 'stored'].includes(storageState.state) ||
      storageState.gc_token !== null
    )
      throw new AppError(409, 'STORAGE_OBJECT_UNAVAILABLE', '已验证原件暂不可用。');
    await tx.query(
      "UPDATE shiling.storage_objects SET state='stored',integrity_state='verified',bytes=$2,sha256=$3,verified_at=now() WHERE id=$1",
      [object.id, inspection.bytes, inspection.sha256],
    );
    await tx.query(
      "UPDATE shiling.upload_attempts SET state='verified',verified_at=now(),failure_code=NULL WHERE id=$1",
      [attemptId],
    );
    await tx.query(
      "UPDATE shiling.upload_items SET transport_state='verified',failure_code=NULL WHERE id=$1",
      [row.id],
    );
    await tx.query(
      "INSERT INTO shiling.assets(id,owner_id,type_key,title,description,lifecycle) VALUES($1,$2,$3,$4,$5,'pending')",
      [
        assetId,
        row.owner_id,
        inspection.type,
        row.initial_metadata.title,
        row.initial_metadata.description,
      ],
    );
    await tx.query(
      "INSERT INTO shiling.asset_versions(id,asset_id,upload_item_id,processing_state,processor_plan,source_sha256,media_metadata,created_by) VALUES($1,$2,$3,'processing',$4,$5,$6,$7)",
      [
        versionId,
        assetId,
        row.id,
        JSON.stringify({ schemaVersion: 1, requiredRoles: requiredRoles[inspection.type] }),
        inspection.sha256,
        JSON.stringify(inspection.metadata),
        row.owner_id,
      ],
    );
    await tx.query(
      "INSERT INTO shiling.artifacts(id,version_id,role,storage_object_id,media_type,metadata) VALUES($1,$2,'original',$3,$4,$5)",
      [artifactId, versionId, object.id, inspection.mediaType, JSON.stringify(inspection.metadata)],
    );
    await enqueueProcessing(tx, queue, versionId, '1', inspection.type);
    await appendAudit(tx, {
      actorId: null,
      action: 'processing.input_verified',
      resourceType: 'upload_item',
      resourceId: row.id,
      requestId: context.requestId,
    });
  }
  return {
    async verifyUpload(task: VerificationTask, context: WorkerContext): Promise<void> {
      const claim = await database.transaction(async (tx) => {
        const current = await verificationRow(tx, task);
        if (!current) return null;
        if (
          current.attempt.verification_deadline_at &&
          current.attempt.verification_deadline_at.getTime() > Date.now()
        )
          return null;
        if (!(await ownerCanUpload(tx, current.item.owner_id))) {
          await tx.query(
            "UPDATE shiling.upload_attempts SET state='failed',failure_code='AUTHORIZATION_REVOKED' WHERE id=$1",
            [task.uploadAttemptId],
          );
          await tx.query(
            "UPDATE shiling.upload_items SET transport_state='failed',failure_code='AUTHORIZATION_REVOKED' WHERE id=$1",
            [current.item.id],
          );
          return null;
        }
        const object = (
          await tx.query<ObjectRow>(
            'SELECT id,object_key,backend_key,namespace,state,bytes,sha256 FROM shiling.storage_objects WHERE upload_attempt_id=$1',
            [task.uploadAttemptId],
          )
        ).rows[0];
        if (!object || object.state !== 'stored')
          throw new AppError(409, 'STORAGE_OBJECT_UNAVAILABLE', '上传原件不可用。');
        const fence = String(BigInt(current.attempt.verification_fence) + 1n);
        await tx.query(
          "UPDATE shiling.upload_attempts SET verification_fence=$2,verification_deadline_at=now()+interval '15 minutes' WHERE id=$1",
          [task.uploadAttemptId, fence],
        );
        return { ...current, object, fence };
      });
      if (!claim) return;
      try {
        requireStorageLocation(storage, claim.object);
        const inspection = await storage.withLocalFile(claim.object.object_key, (inputPath) =>
          media.verify({ inputPath, originalFilename: claim.item.original_filename }),
        );
        if (
          inspection.bytes !== Number(claim.item.declared_bytes) ||
          inspection.bytes !== Number(claim.object.bytes) ||
          inspection.sha256 !== claim.object.sha256 ||
          (claim.item.declared_sha256 && inspection.sha256 !== claim.item.declared_sha256)
        )
          throw new AppError(422, 'UPLOAD_CONTENT_MISMATCH', '文件长度或摘要与上传信息不一致。');
        if (
          inspection.type !== claim.item.requested_type ||
          !claim.attempt.intake_policy.acceptTypes.includes(inspection.type) ||
          inspection.bytes > claim.attempt.intake_policy.maxBytes[inspection.type] ||
          inspection.bytes > DEFAULT_MAX_BYTES[inspection.type]
        )
          throw new AppError(422, 'MEDIA_POLICY_REJECTED', '真实媒体类型或大小不符合接收规则。');
        await database.transaction(async (tx) => {
          const current = await verificationRow(tx, task);
          if (
            !current ||
            current.attempt.verification_fence !== claim.fence ||
            !current.attempt.verification_deadline_at ||
            current.attempt.verification_deadline_at.getTime() <= Date.now()
          )
            return;
          if (!(await ownerCanUpload(tx, current.item.owner_id))) {
            await tx.query(
              "UPDATE shiling.upload_attempts SET state='failed',failure_code='AUTHORIZATION_REVOKED' WHERE id=$1",
              [task.uploadAttemptId],
            );
            await tx.query(
              "UPDATE shiling.upload_items SET transport_state='failed',failure_code='AUTHORIZATION_REVOKED' WHERE id=$1",
              [current.item.id],
            );
            return;
          }
          await createVerifiedVersion(
            tx,
            current.item,
            task.uploadAttemptId,
            claim.object,
            inspection,
            context,
          );
        });
      } catch (error) {
        await failVerification(task, claim.fence, failureCode(error));
      }
    },
    async processJob(task: ProcessingTask, context: WorkerContext): Promise<void> {
      const claim = await database.transaction(async (tx) => {
        const initial = (
          await tx.query<{ upload_item_id: string }>(
            'SELECT v.upload_item_id FROM shiling.processing_jobs j JOIN shiling.asset_versions v ON v.id=j.version_id WHERE j.id=$1',
            [task.jobId],
          )
        ).rows[0];
        if (!initial) return null;
        const row = await getUpload(tx, initial.upload_item_id, true);
        const job = (
          await tx.query<{
            id: string;
            version_id: string;
            execution_generation: string;
            state: string;
            required: boolean;
            step_key: string;
            attempt_fence: string;
            attempt_count: number;
            current_attempt_id: string | null;
            deadline_at: Date | null;
          }>(
            'SELECT j.*,a.deadline_at FROM shiling.processing_jobs j LEFT JOIN shiling.processing_attempts a ON a.id=j.current_attempt_id WHERE j.id=$1 FOR UPDATE OF j',
            [task.jobId],
          )
        ).rows[0];
        const optional =
          job?.required === false &&
          job.step_key === 'media.optional.preview_image' &&
          row.processing_state === 'ready';
        if (
          !job ||
          !(await epochMatches(tx, task.runtimeEpoch)) ||
          (row.processing_state !== 'processing' && !optional) ||
          row.execution_generation !== task.generation ||
          job.execution_generation !== task.generation ||
          !['queued', 'running'].includes(job.state)
        )
          return null;
        if (job.state === 'running' && job.deadline_at && job.deadline_at.getTime() > Date.now())
          return null;
        const original = (
          await tx.query<{
            id: string;
            object_key: string;
            backend_key: string;
            namespace: string;
            type_key: MediaTypeKey;
          }>(
            `SELECT o.id,o.object_key,o.backend_key,o.namespace,a.type_key FROM shiling.artifacts f JOIN shiling.storage_objects o ON o.id=f.storage_object_id
          JOIN shiling.assets a ON a.id=$2 WHERE f.version_id=$1 AND f.role='original' AND o.state='stored' AND o.integrity_state='verified'`,
            [row.version_id, row.asset_id],
          )
        ).rows[0];
        if (!original)
          throw new AppError(409, 'STORAGE_OBJECT_UNAVAILABLE', '已验证原件暂不可用。');
        const attemptId = randomUUID();
        const fence = String(BigInt(job.attempt_fence) + 1n);
        if (job.current_attempt_id)
          await tx.query(
            "UPDATE shiling.processing_attempts SET state='abandoned',finished_at=now() WHERE id=$1 AND state='running'",
            [job.current_attempt_id],
          );
        await tx.query(
          "INSERT INTO shiling.processing_attempts(id,job_id,attempt_no,fence,state,worker_instance,deadline_at) VALUES($1,$2,$3,$4,'running',$5,now()+interval '15 minutes')",
          [attemptId, job.id, job.attempt_count + 1, fence, context.workerInstance],
        );
        await tx.query(
          "UPDATE shiling.processing_jobs SET state='running',current_attempt_id=$2,attempt_fence=$3,attempt_count=attempt_count+1 WHERE id=$1",
          [job.id, attemptId, fence],
        );
        return { row, original, attemptId, fence, jobId: job.id, optional };
      });
      if (!claim) return;
      let outputDirectory: string | undefined;
      async function current(tx: Transaction) {
        const row = await getUpload(tx, claim!.row.id, true);
        const job = (
          await tx.query<{ state: string; attempt_fence: string; current_attempt_id: string }>(
            'SELECT state,attempt_fence,current_attempt_id FROM shiling.processing_jobs WHERE id=$1 FOR UPDATE',
            [task.jobId],
          )
        ).rows[0];
        if (
          !job ||
          !(await epochMatches(tx, task.runtimeEpoch)) ||
          row.processing_state !== (claim!.optional ? 'ready' : 'processing') ||
          row.execution_generation !== task.generation ||
          job.state !== 'running' ||
          job.attempt_fence !== claim!.fence ||
          job.current_attempt_id !== claim!.attemptId
        )
          return null;
        return row;
      }
      try {
        if (claim.original.type_key === 'web_motion')
          throw new AppError(
            409,
            'MOTION_EXECUTION_UNAVAILABLE',
            '实例尚未启用完整的动效执行隔离，动效原件保持待处理。',
          );
        outputDirectory = await mkdtemp(join(temporaryDirectory, 'shiling-media-'));
        const directory = await realpath(outputDirectory);
        requireStorageLocation(storage, claim.original);
        const result = await storage.withLocalFile(claim.original.object_key, (inputPath) =>
          media.process({
            inputPath,
            outputDirectory: directory,
            originalFilename: claim.row.original_filename,
          }),
        );
        const outputs = claim.optional
          ? result.artifacts.filter((artifact) => artifact.role === 'preview_image')
          : result.artifacts;
        const roles = outputs.map((artifact) => artifact.role);
        const expectedRoles = claim.optional
          ? ['preview_image']
          : requiredRoles[claim.original.type_key];
        if (
          new Set(roles).size !== roles.length ||
          expectedRoles.some(
            (role) => role !== 'original' && !roles.includes(role as MediaArtifactOutput['role']),
          )
        )
          throw new AppError(422, 'PROCESSOR_REQUIRED_OUTPUT_MISSING', '目标媒体产物未完整生成。');
        const produced: { artifact: MediaArtifactOutput; objectId: string }[] = [];
        for (const artifact of outputs) {
          await safeOutput(directory, artifact);
          const objectId = randomUUID();
          const objectKey = `derived/${claim.attemptId}/${artifact.role}`;
          const registered = await database.transaction(async (tx) => {
            if (!(await current(tx))) return false;
            await tx.query(
              `INSERT INTO shiling.storage_objects
               (id,processing_attempt_id,backend_key,namespace,object_key,retain_until)
               VALUES($1,$2,$3,$4,$5,now()+($6::int*interval '1 second'))`,
              [
                objectId,
                claim.attemptId,
                storage.backendKey,
                storage.namespace,
                objectKey,
                temporaryObjectRetentionSeconds,
              ],
            );
            return true;
          });
          if (!registered) return;
          const stored = await storage.put(objectKey, createReadStream(artifact.filePath), {
            maxBytes: artifact.bytes,
            expectedBytes: artifact.bytes,
          });
          if (stored.sha256 !== artifact.sha256)
            throw new AppError(422, 'PROCESSOR_OUTPUT_CHANGED', '媒体产物在提交前发生变化。');
          await database.transaction(async (tx) => {
            const updated = await tx.query(
              `UPDATE shiling.storage_objects
               SET state='stored',integrity_state='verified',bytes=$2,sha256=$3,verified_at=now()
               WHERE id=$1 AND state='reserved' AND gc_token IS NULL RETURNING id`,
              [objectId, stored.bytes, stored.sha256],
            );
            if (!updated.rowCount)
              throw new AppError(409, 'STORAGE_OBJECT_UNAVAILABLE', '处理产物正在回收或不可用。');
          });
          produced.push({ artifact, objectId });
        }
        await database.transaction(async (tx) => {
          const row = await current(tx);
          if (!row) return;
          if (claim.optional) {
            if (
              !(
                await tx.query(
                  "SELECT id FROM shiling.assets WHERE id=$1 AND lifecycle='active' AND current_version_id=$2 FOR SHARE",
                  [row.asset_id, row.version_id],
                )
              ).rowCount
            )
              throw new AppError(409, 'ASSET_ARCHIVED', '素材当前不能追加可选产物。');
          } else if (!(await ownerCanUpload(tx, row.owner_id)))
            throw new AppError(403, 'AUTHORIZATION_REVOKED', '上传者账号或上传权限已撤回。');
          const deadline = (
            await tx.query<{ deadline_at: Date }>(
              'SELECT deadline_at FROM shiling.processing_attempts WHERE id=$1',
              [claim.attemptId],
            )
          ).rows[0];
          if (!deadline || deadline.deadline_at.getTime() <= Date.now())
            throw new AppError(409, 'PROCESSING_DEADLINE_EXCEEDED', '媒体处理超过允许时限。');
          for (const { artifact, objectId } of produced) {
            if (
              claim.optional &&
              (
                await tx.query('SELECT id FROM shiling.artifacts WHERE version_id=$1 AND role=$2', [
                  row.version_id,
                  artifact.role,
                ])
              ).rowCount
            )
              continue;
            const storedObject = (
              await tx.query<{ state: string; gc_token: string | null }>(
                'SELECT state,gc_token FROM shiling.storage_objects WHERE id=$1 FOR UPDATE',
                [objectId],
              )
            ).rows[0];
            if (!storedObject || storedObject.state !== 'stored' || storedObject.gc_token !== null)
              throw new AppError(409, 'STORAGE_OBJECT_UNAVAILABLE', '处理产物暂不可用。');
            await tx.query(
              'INSERT INTO shiling.artifacts(id,version_id,role,storage_object_id,produced_by_attempt_id,media_type,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',
              [
                randomUUID(),
                row.version_id,
                artifact.role,
                objectId,
                claim.attemptId,
                artifact.mediaType,
                JSON.stringify(artifact.metadata),
              ],
            );
          }
          if (!claim.optional) {
            const warnings = await applyOrganization(tx, row, row.asset_id!);
            await tx.query(
              "UPDATE shiling.asset_versions SET processing_state='ready',ready_at=now(),failure_code=NULL,media_metadata=$2 WHERE id=$1",
              [row.version_id, JSON.stringify(result.metadata)],
            );
            await tx.query(
              "UPDATE shiling.assets SET title=$2,description=$3,lifecycle='active',current_version_id=$4 WHERE id=$1",
              [
                row.asset_id,
                row.initial_metadata.title,
                row.initial_metadata.description,
                row.version_id,
              ],
            );
            await tx.query('UPDATE shiling.upload_items SET organization_warnings=$2 WHERE id=$1', [
              row.id,
              JSON.stringify(warnings),
            ]);
          }
          await tx.query(
            "UPDATE shiling.processing_attempts SET state='succeeded',finished_at=now(),output_manifest=$2 WHERE id=$1",
            [
              claim.attemptId,
              JSON.stringify({ objectIds: produced.map((entry) => entry.objectId) }),
            ],
          );
          await tx.query(
            "UPDATE shiling.processing_jobs SET state='succeeded',failure_code=NULL WHERE id=$1",
            [task.jobId],
          );
          await appendAudit(tx, {
            actorId: null,
            action: claim.optional
              ? 'processing.optional_artifact_added'
              : 'processing.asset_ready',
            resourceType: 'asset',
            resourceId: row.asset_id,
            requestId: context.requestId,
          });
        });
      } catch (error) {
        await database.transaction(async (tx) => {
          const row = await current(tx);
          if (!row) return;
          const code = failureCode(error);
          await tx.query(
            "UPDATE shiling.processing_attempts SET state='failed',finished_at=now(),error_code=$2 WHERE id=$1",
            [claim.attemptId, code],
          );
          await tx.query(
            "UPDATE shiling.processing_jobs SET state='failed',failure_code=$2 WHERE id=$1",
            [task.jobId, code],
          );
          if (!claim.optional)
            await tx.query(
              "UPDATE shiling.asset_versions SET processing_state='failed',failure_code=$2 WHERE id=$1",
              [row.version_id, code],
            );
        });
      } finally {
        if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
      }
    },
  };
}
export type ProcessingService = ReturnType<typeof createProcessingService>;
