import type { TeamAsset } from '@shiling/contracts';
import type { Queryable } from '../../ports/database.js';
import type { MediaTypeKey } from '../../ports/media.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../identity/authorization.js';

export interface AssetRow {
  id: string;
  owner_id: string;
  display_name: string;
  type_key: MediaTypeKey;
  title: string;
  description: string;
  lifecycle: 'pending' | 'active' | 'archived';
  current_version_id: string | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
  processing_state: string | null;
  media_metadata: Record<string, unknown>;
  processor_plan: { requiredRoles?: string[] };
}
export interface ArtifactRow {
  id: string;
  role: string;
  storage_object_id: string;
  media_type: string;
  metadata: Record<string, unknown>;
  bytes: string;
  object_key: string;
  state: string;
  integrity_state: string;
}
export function numericMetadata(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
export async function assetById(db: Queryable, id: string, lock = false): Promise<AssetRow> {
  const row = (
    await db.query<AssetRow>(
      `SELECT a.*,u.display_name,v.processing_state,v.media_metadata,v.processor_plan FROM shiling.assets a
    JOIN shiling.users u ON u.id=a.owner_id LEFT JOIN shiling.asset_versions v ON v.id=a.current_version_id
    WHERE a.id=$1 ${lock ? 'FOR UPDATE OF a' : ''}`,
      [id],
    )
  ).rows[0];
  if (!row) throw new AppError(404, 'ASSET_NOT_FOUND', '素材不存在或当前不可访问。');
  return row;
}
export function requireVisibleAsset(actor: Actor, row: AssetRow): void {
  if (!actor.permissionKeys.includes('assets.read'))
    throw new AppError(403, 'FORBIDDEN', '没有查看素材的权限。');
  if (
    row.lifecycle === 'pending' ||
    row.processing_state !== 'ready' ||
    (row.lifecycle === 'archived' &&
      row.owner_id !== actor.id &&
      !actor.permissionKeys.includes('assets.governAny'))
  )
    throw new AppError(404, 'ASSET_NOT_FOUND', '素材不存在或当前不可访问。');
}
export async function artifactRows(db: Queryable, versionId: string): Promise<ArtifactRow[]> {
  return (
    await db.query<ArtifactRow>(
      `SELECT f.id,f.role,f.storage_object_id,f.media_type,f.metadata,o.bytes,o.object_key,o.state,o.integrity_state
    FROM shiling.artifacts f JOIN shiling.storage_objects o ON o.id=f.storage_object_id WHERE f.version_id=$1 ORDER BY f.role,f.id`,
      [versionId],
    )
  ).rows;
}
export async function requireReadyArtifacts(db: Queryable, row: AssetRow): Promise<ArtifactRow[]> {
  if (row.processing_state !== 'ready' || !row.current_version_id)
    throw new AppError(409, 'ASSET_NOT_READY', '素材尚未就绪。');
  const artifacts = await artifactRows(db, row.current_version_id);
  const required = row.processor_plan.requiredRoles ?? ['original'];
  for (const role of required) {
    const found = artifacts.find(
      (artifact) =>
        artifact.role === role &&
        artifact.state === 'stored' &&
        artifact.integrity_state === 'verified',
    );
    if (!found)
      throw new AppError(409, 'ASSET_INTEGRITY_FAILED', '必要素材文件不可用，请联系管理员。');
  }
  return artifacts;
}
export async function assetDto(db: Queryable, row: AssetRow, actor: Actor): Promise<TeamAsset> {
  const tags = (
    await db.query<{ id: string; name: string; state: 'active' | 'disabled' }>(
      'SELECT t.id,t.name,t.state FROM shiling.asset_tags at JOIN shiling.tags t ON t.id=at.tag_id WHERE at.asset_id=$1 ORDER BY t.name,t.id',
      [row.id],
    )
  ).rows;
  const publication = (
    await db.query<{ state: 'active' | 'withdrawn' }>(
      'SELECT state FROM shiling.publications WHERE asset_id=$1',
      [row.id],
    )
  ).rows[0];
  const favorite =
    (
      await db.query('SELECT asset_id FROM shiling.favorites WHERE user_id=$1 AND asset_id=$2', [
        actor.id,
        row.id,
      ])
    ).rowCount > 0;
  const artifacts = row.current_version_id ? await artifactRows(db, row.current_version_id) : [];
  const owner = row.owner_id === actor.id;
  const govern = actor.permissionKeys.includes('assets.governAny');
  const active = row.lifecycle === 'active';
  return {
    id: row.id,
    typeId: row.type_key,
    title: row.title,
    description: row.description,
    owner: { id: row.owner_id, displayName: row.display_name },
    lifecycle: row.lifecycle,
    currentVersionId: row.current_version_id,
    revision: row.revision,
    tags,
    favorite,
    publicationState: publication?.state ?? 'none',
    artifacts: artifacts
      .filter(
        (artifact) =>
          artifact.state === 'stored' &&
          artifact.integrity_state === 'verified' &&
          (active || ['thumbnail', 'preview_image', 'poster'].includes(artifact.role)),
      )
      .map((artifact) => ({
        id: artifact.id,
        role: artifact.role,
        mediaType: artifact.media_type,
        bytes: artifact.bytes,
        width: numericMetadata(artifact.metadata, 'width'),
        height: numericMetadata(artifact.metadata, 'height'),
      })),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    actions: {
      edit: active && (govern || (owner && actor.permissionKeys.includes('assets.editOwn'))),
      archive: active && (govern || (owner && actor.permissionKeys.includes('assets.archiveOwn'))),
      restore: !active && (govern || (owner && actor.permissionKeys.includes('assets.archiveOwn'))),
      download: active && actor.permissionKeys.includes('assets.download'),
      favorite: active && actor.permissionKeys.includes('favorites.manageOwn'),
      publish: active && owner && actor.permissionKeys.includes('publications.publishOwn'),
      withdraw:
        publication?.state === 'active' &&
        (actor.permissionKeys.includes('publications.withdrawAny') ||
          (owner && actor.permissionKeys.includes('publications.withdrawOwn'))),
    },
  };
}
