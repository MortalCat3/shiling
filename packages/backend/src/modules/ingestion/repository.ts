import type { UploadItem, UploadMetadata, PermissionKey } from '@shiling/contracts';
import type { Queryable } from '../../ports/database.js';
import type { MediaTypeKey } from '../../ports/media.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../identity/authorization.js';

export interface UploadRow {
  id: string;
  batch_id: string;
  owner_id: string;
  client_item_id: string;
  original_filename: string;
  declared_bytes: string;
  declared_media_type: string;
  declared_sha256: string | null;
  requested_type: MediaTypeKey | null;
  creation_request_hash: string;
  initial_metadata: { schemaVersion: number; title: string; description: string; tagIds: string[] };
  requested_collection_ids: string[];
  revision: string;
  transport_state: string;
  attempt_generation: string;
  current_attempt_id: string | null;
  expires_at: Date;
  failure_code: string | null;
  organization_warnings: { code: string; message: string }[];
  version_id: string | null;
  asset_id: string | null;
  processing_state: string | null;
  execution_generation: string | null;
  version_failure_code: string | null;
  received_bytes: string | null;
}
export async function getUpload(db: Queryable, id: string, lock = false): Promise<UploadRow> {
  const row = (
    await db.query<UploadRow>(
      `SELECT i.*,b.owner_id,v.id version_id,v.asset_id,v.processing_state,v.execution_generation,v.failure_code version_failure_code,a.received_bytes
    FROM shiling.upload_items i JOIN shiling.upload_batches b ON b.id=i.batch_id
    LEFT JOIN shiling.asset_versions v ON v.upload_item_id=i.id LEFT JOIN shiling.upload_attempts a ON a.id=i.current_attempt_id
    WHERE i.id=$1 ${lock ? 'FOR UPDATE OF i' : ''}`,
      [id],
    )
  ).rows[0];
  if (!row) throw new AppError(404, 'UPLOAD_NOT_FOUND', '上传项不存在。');
  return row;
}
export function authorizeUpload(actor: Actor, row: UploadRow, ownPermission: PermissionKey): void {
  if (actor.permissionKeys.includes('uploads.governAny')) return;
  if (row.owner_id !== actor.id) throw new AppError(404, 'UPLOAD_NOT_FOUND', '上传项不存在。');
  if (!actor.permissionKeys.includes(ownPermission))
    throw new AppError(403, 'FORBIDDEN', '没有执行此上传操作的权限。');
}
export function uploadDto(row: UploadRow, actor: Actor): UploadItem {
  const govern = actor.permissionKeys.includes('uploads.governAny');
  const owner = row.owner_id === actor.id;
  const ready = row.processing_state === 'ready';
  const terminal =
    ['canceled', 'expired'].includes(row.transport_state) || row.processing_state === 'canceled';
  const failed = row.processing_state === 'failed' || row.transport_state === 'failed';
  const failureCode = row.version_failure_code ?? row.failure_code;
  let uiState = row.transport_state === 'pending' ? 'queued' : row.transport_state;
  if (row.processing_state) uiState = row.processing_state;
  else if (row.transport_state === 'verified') uiState = 'queued';
  return {
    id: row.id,
    batchId: row.batch_id,
    clientItemId: row.client_item_id,
    fileName: row.original_filename,
    attemptId: row.current_attempt_id,
    transportState: row.transport_state,
    processingState: row.processing_state,
    uiState,
    assetId: row.asset_id,
    revision: row.revision,
    metadata: {
      title: row.initial_metadata.title,
      description: row.initial_metadata.description,
      tagIds: row.initial_metadata.tagIds,
      collectionIds: row.requested_collection_ids,
    },
    safeError: failureCode
      ? {
          code: failureCode,
          message:
            failureCode === 'AUTHORIZATION_REVOKED'
              ? '上传者账号或上传权限已撤回；恢复后需手动重试。'
              : '当前上传未能完成，可查看详情或按允许动作重试。',
          retryable: failed && !terminal,
        }
      : null,
    organizationWarnings: row.organization_warnings,
    progress: { receivedBytes: row.received_bytes, totalBytes: row.declared_bytes },
    actions: {
      editMetadata:
        !ready &&
        !terminal &&
        (govern || (owner && actor.permissionKeys.includes('uploads.create'))),
      cancel:
        !ready &&
        !terminal &&
        (govern || (owner && actor.permissionKeys.includes('uploads.cancelOwn'))),
      retry:
        failed &&
        !terminal &&
        (govern || (owner && actor.permissionKeys.includes('uploads.retryOwn'))),
    },
  };
}
export function normalizeMetadata(input: UploadMetadata): UploadMetadata {
  const title = input.title.trim();
  if (
    !title ||
    title.length > 200 ||
    input.description.length > 5000 ||
    input.tagIds.length > 20 ||
    input.collectionIds.length > 20
  )
    throw new AppError(400, 'INVALID_METADATA', '标题、说明或整理项数量超出限制。');
  return {
    title,
    description: input.description,
    tagIds: [...new Set(input.tagIds)],
    collectionIds: [...new Set(input.collectionIds)],
  };
}
