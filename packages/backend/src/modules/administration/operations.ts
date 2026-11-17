import { randomUUID } from 'node:crypto';
import type { Database, Transaction } from '../../ports/database.js';
import { TASK_NAMES, type TaskQueue } from '../../ports/tasks.js';
import type { MediaTypeKey } from '../../ports/media.js';
import type { IdentityService, MutationContext } from '../identity/service.js';
import { AppError, mapDatabaseError } from '../../errors.js';
import { appendAudit } from './audit.js';
import { claimIdempotency, completeIdempotency, requestHash } from './idempotency.js';
import { getUpload } from '../ingestion/repository.js';
import { ownerCanUpload } from '../ingestion/policy.js';
import { enqueueProcessing } from '../ingestion/service.js';

export interface OperationsDependencies {
  database: Database;
  identity: IdentityService;
  queue: TaskQueue;
}
export interface OperationsPage {
  cursor?: string;
  limit?: number;
  state?: string;
  action?: string;
}
interface JobRow {
  id: string;
  step_key: string;
  state: string;
  required: boolean;
  attempt_count: number;
  failure_code: string | null;
  created_at: Date;
  cursor_created_at: string;
  updated_at: Date;
  version_id: string;
  execution_generation: string;
  upload_item_id: string;
  asset_id: string;
  type_key: MediaTypeKey;
  processing_state: string;
  lifecycle: string;
  optional_missing: boolean;
}
const jobSelect = `SELECT j.*,to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00' cursor_created_at,v.upload_item_id,v.asset_id,v.processing_state,a.type_key,a.lifecycle,
  NOT EXISTS(SELECT 1 FROM shiling.artifacts f WHERE f.version_id=v.id AND f.role='preview_image') optional_missing
  FROM shiling.processing_jobs j JOIN shiling.asset_versions v ON v.id=j.version_id JOIN shiling.assets a ON a.id=v.asset_id`;
function jobDto(row: JobRow) {
  return {
    id: row.id,
    kind: row.step_key,
    state: row.state,
    required: row.required,
    attemptCount: row.attempt_count,
    assetId: row.asset_id,
    uploadItemId: row.upload_item_id,
    safeError: row.failure_code
      ? {
          code: row.failure_code,
          message: '任务未能完成，可查看素材状态并按允许动作重试。',
          retryable: row.state === 'failed',
        }
      : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    actions: {
      retry:
        (row.processing_state === 'failed' && row.state === 'failed') ||
        (row.processing_state === 'ready' &&
          row.lifecycle === 'active' &&
          row.type_key === 'image' &&
          row.optional_missing &&
          !['queued', 'running'].includes(row.state)),
    },
  };
}
function pagination(input: OperationsPage, scope: string) {
  const limit = input.limit ?? 40;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new AppError(400, 'INVALID_PAGE_LIMIT', '每页数量应为 1 至 100。');
  let afterId: string | null = null;
  let afterCreatedAt: string | null = null;
  if (input.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as {
        id: string;
        scope: string;
        filter: string | null;
        createdAt: string;
        order: string;
      };
      if (
        decoded.scope !== scope ||
        decoded.filter !== (input.state ?? input.action ?? null) ||
        decoded.order !== 'createdAtDesc' ||
        typeof decoded.createdAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00$/.test(decoded.createdAt) ||
        !Number.isFinite(Date.parse(decoded.createdAt)) ||
        new Date(decoded.createdAt).toISOString().slice(0, 19) !==
          decoded.createdAt.slice(0, 19).replace(' ', 'T') ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decoded.id)
      )
        throw new Error('cursor');
      afterId = decoded.id;
      afterCreatedAt = decoded.createdAt;
    } catch {
      throw new AppError(400, 'INVALID_CURSOR', '分页条件已变化，请刷新列表。');
    }
  }
  return {
    limit,
    afterId,
    afterCreatedAt,
    // Preserve PostgreSQL microseconds; Date.toISOString() truncates to milliseconds.
    next: (id: string, createdAt: string) =>
      Buffer.from(
        JSON.stringify({
          id,
          createdAt,
          order: 'createdAtDesc',
          scope,
          filter: input.state ?? input.action ?? null,
        }),
      ).toString('base64url'),
  };
}
export function createOperationsService({ database, identity, queue }: OperationsDependencies) {
  async function transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await database.transaction(work);
    } catch (error) {
      return mapDatabaseError(error);
    }
  }
  return {
    async listJobs(token: string, input: OperationsPage = {}) {
      return transaction(async (tx) => {
        const actor = await identity.authorize(tx, token, 'system.operations.read');
        const page = pagination(input, `jobs:${actor.id}`);
        const rows = (
          await tx.query<JobRow>(
            `${jobSelect} WHERE ($1::text IS NULL OR j.state=$1)
             AND ($2::timestamptz IS NULL OR (j.created_at,j.id)<($2::timestamptz,$3::uuid))
             ORDER BY j.created_at DESC,j.id DESC LIMIT $4`,
            [input.state ?? null, page.afterCreatedAt, page.afterId, page.limit + 1],
          )
        ).rows;
        const selected = rows.slice(0, page.limit);
        const hasMore = rows.length > page.limit;
        const last = selected.at(-1);
        return {
          items: selected.map(jobDto),
          pageInfo: {
            hasMore,
            nextCursor: hasMore && last ? page.next(last.id, last.cursor_created_at) : null,
          },
        };
      });
    },
    async getJob(token: string, jobId: string) {
      return transaction(async (tx) => {
        await identity.authorize(tx, token, 'system.operations.read');
        const row = (await tx.query<JobRow>(`${jobSelect} WHERE j.id=$1`, [jobId])).rows[0];
        if (!row) throw new AppError(404, 'JOB_NOT_FOUND', '任务不存在。');
        const attempts = (
          await tx.query<{
            id: string;
            attempt_no: number;
            state: string;
            started_at: Date;
            finished_at: Date | null;
            error_code: string | null;
          }>(
            'SELECT id,attempt_no,state,started_at,finished_at,error_code FROM shiling.processing_attempts WHERE job_id=$1 ORDER BY attempt_no',
            [jobId],
          )
        ).rows;
        return {
          ...jobDto(row),
          attempts: attempts.map((attempt) => ({
            id: attempt.id,
            attempt: attempt.attempt_no,
            state: attempt.state,
            startedAt: attempt.started_at.toISOString(),
            finishedAt: attempt.finished_at?.toISOString() ?? null,
            errorCode: attempt.error_code,
          })),
        };
      });
    },
    async retryJob(token: string, jobId: string, context: MutationContext) {
      return transaction(async (tx) => {
        const actor = await identity.authorize(tx, token, 'system.jobs.manage');
        const initial = (await tx.query<JobRow>(`${jobSelect} WHERE j.id=$1`, [jobId])).rows[0];
        if (!initial) throw new AppError(404, 'JOB_NOT_FOUND', '任务不存在。');
        const upload = await getUpload(tx, initial.upload_item_id, true);
        const job = (await tx.query<JobRow>(`${jobSelect} WHERE j.id=$1 FOR UPDATE OF j`, [jobId]))
          .rows[0];
        if (!job) throw new AppError(404, 'JOB_NOT_FOUND', '任务不存在。');
        const claim = await claimIdempotency(
          tx,
          actor.id,
          'operations.job.retry',
          context.idempotencyKey,
          requestHash({ jobId }),
        );
        if (claim.replay) return { jobId: String(claim.resourceRefs.jobId) };
        let nextId: string;
        if (
          upload.processing_state === 'failed' &&
          job.state === 'failed' &&
          job.required &&
          job.step_key === 'media.derive'
        ) {
          if (!(await ownerCanUpload(tx, upload.owner_id)))
            throw new AppError(403, 'AUTHORIZATION_REVOKED', '上传者账号或上传权限尚未恢复。');
          if (job.type_key === 'web_motion')
            throw new AppError(
              409,
              'MOTION_EXECUTION_UNAVAILABLE',
              '实例尚未启用完整的动效执行隔离。',
            );
          const generation = String(BigInt(upload.execution_generation ?? '1') + 1n);
          await tx.query(
            "UPDATE shiling.asset_versions SET processing_state='processing',execution_generation=$2,failure_code=NULL WHERE id=$1",
            [job.version_id, generation],
          );
          nextId = await enqueueProcessing(tx, queue, job.version_id, generation, job.type_key);
        } else if (
          upload.processing_state === 'ready' &&
          job.lifecycle === 'active' &&
          job.type_key === 'image' &&
          job.optional_missing
        ) {
          const existing = (
            await tx.query<{ id: string; state: string }>(
              "SELECT id,state FROM shiling.processing_jobs WHERE version_id=$1 AND execution_generation=$2 AND step_key='media.optional.preview_image' FOR UPDATE",
              [job.version_id, upload.execution_generation],
            )
          ).rows[0];
          if (existing && ['queued', 'running'].includes(existing.state))
            throw new AppError(409, 'JOB_ALREADY_RUNNING', '可选预览任务正在执行。');
          nextId = existing?.id ?? randomUUID();
          if (existing)
            await tx.query(
              "UPDATE shiling.processing_jobs SET state='queued',attempt_fence=attempt_fence+1,failure_code=NULL WHERE id=$1",
              [nextId],
            );
          else
            await tx.query(
              "INSERT INTO shiling.processing_jobs(id,version_id,execution_generation,step_key,processor_key,processor_version,required,state) VALUES($1,$2,$3,'media.optional.preview_image','builtin.image','1',false,'queued')",
              [nextId, job.version_id, upload.execution_generation],
            );
          const epoch = (
            await tx.query<{ runtime_epoch: string }>(
              'SELECT runtime_epoch FROM shiling.product_settings WHERE id=1',
            )
          ).rows[0];
          if (!epoch) throw new AppError(503, 'SETTINGS_UNAVAILABLE', '实例设置暂不可用。');
          const queueId = await queue.enqueue(tx, TASK_NAMES.process, {
            jobId: nextId,
            generation: upload.execution_generation,
            runtimeEpoch: epoch.runtime_epoch,
          });
          await tx.query('UPDATE shiling.processing_jobs SET queue_job_id=$2 WHERE id=$1', [
            nextId,
            queueId,
          ]);
        } else throw new AppError(409, 'JOB_RETRY_NOT_ALLOWED', '当前状态没有可重试的注册步骤。');
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'administration.job_retried',
          resourceType: 'processing_job',
          resourceId: nextId,
          requestId: context.requestId,
          changes: { requestedJobId: jobId },
        });
        await completeIdempotency(tx, claim.id, { jobId: nextId });
        return { jobId: nextId };
      });
    },
    async listAuditEvents(token: string, input: Omit<OperationsPage, 'state'> = {}) {
      return transaction(async (tx) => {
        const actor = await identity.authorize(tx, token, 'system.audit.read');
        const action = input.action?.trim() ?? '';
        if (action.length > 200)
          throw new AppError(400, 'INVALID_AUDIT_FILTER', '审计动作筛选内容过长。');
        const page = pagination(input, `audit:${actor.id}`);
        const rows = (
          await tx.query<{
            id: string;
            actor_kind: string;
            actor_id: string | null;
            action: string;
            resource_type: string;
            resource_id: string | null;
            outcome: string;
            request_id: string;
            changes: Record<string, unknown>;
            created_at: Date;
            cursor_created_at: string;
          }>(
            `SELECT id,actor_kind,actor_id,action,resource_type,resource_id,outcome,request_id,changes,created_at,
            to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00' cursor_created_at
            FROM shiling.audit_events WHERE ($1='' OR action=$1)
            AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
            ORDER BY created_at DESC,id DESC LIMIT $4`,
            [action, page.afterCreatedAt, page.afterId, page.limit + 1],
          )
        ).rows;
        const selected = rows.slice(0, page.limit);
        const hasMore = rows.length > page.limit;
        const last = selected.at(-1);
        return {
          items: selected.map((row) => ({
            id: row.id,
            actorKind: row.actor_kind,
            actorId: row.actor_id,
            action: row.action,
            resourceType: row.resource_type,
            resourceId: row.resource_id,
            outcome: row.outcome,
            requestId: row.request_id,
            changes: row.changes,
            createdAt: row.created_at.toISOString(),
          })),
          pageInfo: {
            hasMore,
            nextCursor: hasMore && last ? page.next(last.id, last.cursor_created_at) : null,
          },
        };
      });
    },
  };
}
export type OperationsService = ReturnType<typeof createOperationsService>;
