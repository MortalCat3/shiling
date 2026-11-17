import type { MediaTypeKey } from '../../ports/media.js';
import type { Queryable } from '../../ports/database.js';
import { AppError } from '../../errors.js';

export interface IntakePolicy {
  schemaVersion: 1;
  settingsRevision: string;
  acceptTypes: MediaTypeKey[];
  maxBytes: Record<MediaTypeKey, number>;
}
export const DEFAULT_MAX_BYTES: Readonly<Record<MediaTypeKey, number>> = {
  image: 100 * 1024 * 1024,
  video: 500 * 1024 * 1024,
  web_motion: 100 * 1024 * 1024,
};

export function effectiveTypeMaxBytes(type: MediaTypeKey, transportMaxBytes: number): number {
  if (!Number.isSafeInteger(transportMaxBytes) || transportMaxBytes < 1) {
    throw new Error('Transport upload maximum must be a positive safe integer.');
  }
  return Math.min(DEFAULT_MAX_BYTES[type], transportMaxBytes);
}

export async function currentIntakePolicy(
  db: Queryable,
  transportMaxBytes = DEFAULT_MAX_BYTES.video,
): Promise<IntakePolicy> {
  const row = (
    await db.query<{
      revision: string;
      values: {
        types?: Partial<Record<MediaTypeKey, { acceptUploads?: boolean; maxBytes?: number }>>;
      };
    }>('SELECT revision,values FROM shiling.product_settings WHERE id=1')
  ).rows[0];
  if (!row) throw new AppError(503, 'SETTINGS_UNAVAILABLE', '实例设置暂不可用。', true);
  const types = ['image', 'video', 'web_motion'] as const;
  // 交互动效必须等独立来源、服务器隔离与真实 poster 验收通过后再开放。
  const acceptTypes = types.filter(
    (type) => type !== 'web_motion' && row.values.types?.[type]?.acceptUploads !== false,
  );
  const maxBytes: Record<MediaTypeKey, number> = {
    image: effectiveTypeMaxBytes('image', transportMaxBytes),
    video: effectiveTypeMaxBytes('video', transportMaxBytes),
    web_motion: effectiveTypeMaxBytes('web_motion', transportMaxBytes),
  };
  for (const type of types) {
    const configured = row.values.types?.[type]?.maxBytes;
    if (configured !== undefined && Number.isSafeInteger(configured) && configured > 0)
      maxBytes[type] = Math.min(configured, maxBytes[type]);
  }
  return { schemaVersion: 1, settingsRevision: row.revision, acceptTypes, maxBytes };
}
export function inferRequestedType(fileName: string): MediaTypeKey {
  if (/\.(jpg|jpeg|png|webp|gif)$/i.test(fileName)) return 'image';
  if (/\.mp4$/i.test(fileName)) return 'video';
  if (/\.(html|htm|zip)$/i.test(fileName)) return 'web_motion';
  throw new AppError(400, 'MEDIA_TYPE_UNSUPPORTED', '当前实例不支持这种文件类型。');
}
export function ensureIntake(policy: IntakePolicy, type: MediaTypeKey, bytes: number): void {
  if (!policy.acceptTypes.includes(type))
    throw new AppError(403, 'UPLOAD_TYPE_DISABLED', '该类型当前不接收新的上传。');
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > policy.maxBytes[type])
    throw new AppError(413, 'UPLOAD_TOO_LARGE', '文件大小超过当前类型限制。');
}
export async function ownerCanUpload(db: Queryable, userId: string): Promise<boolean> {
  const owner = (
    await db.query<{ role_id: string }>(
      `SELECT u.role_id FROM shiling.users u JOIN shiling.roles r ON r.id=u.role_id
    WHERE u.id=$1 AND u.status='active' AND r.archived_at IS NULL FOR SHARE OF u,r`,
      [userId],
    )
  ).rows[0];
  if (!owner) return false;
  return (
    (
      await db.query(
        "SELECT role_id FROM shiling.role_permissions WHERE role_id=$1 AND permission_key='uploads.create'",
        [owner.role_id],
      )
    ).rowCount > 0
  );
}
