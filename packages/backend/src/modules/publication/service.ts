import { requireStorageLocation } from '../../storage/binding.js';
import { randomUUID } from 'node:crypto';
import type { PublicAsset } from '@shiling/contracts';
import type { Database, Queryable, Transaction } from '../../ports/database.js';
import type { StoragePort, ContentRange } from '../../ports/storage.js';
import type { MediaTypeKey } from '../../ports/media.js';
import type { IdentityService, MutationContext } from '../identity/service.js';
import { AppError, assertRevision, mapDatabaseError } from '../../errors.js';
import { appendAudit } from '../administration/audit.js';
import {
  claimIdempotency,
  completeIdempotency,
  requestHash,
} from '../administration/idempotency.js';
import {
  assetById,
  numericMetadata,
  requireVisibleAsset,
  requireReadyArtifacts,
  type ArtifactRow,
} from '../assets/repository.js';
import {
  createDeliverySigner,
  allowArtifactPurpose,
  safeDownloadName,
  type DeliveryPurpose,
} from '../assets/delivery.js';
import { currentPublication, withdrawPublication } from './repository.js';

export interface PublicationDependencies {
  database: Database;
  identity: IdentityService;
  storage: StoragePort;
  deliverySecret: string;
  grantTtlSeconds?: number;
}
export interface PublishInput {
  expectedAssetRevision: string;
  expectedPublicationRevision: string;
  versionId: string;
  publicMetadata: { title: string; description: string; tagIds: string[] };
}
export interface PublicListInput {
  q?: string;
  typeId?: MediaTypeKey[];
  tag?: string[];
  sort?: 'publishedAtDesc' | 'titleAsc';
  cursor?: string;
  limit?: number;
}
interface PublicRow {
  asset_id: string;
  type_key: MediaTypeKey;
  publication_revision: string;
  snapshot_id: string;
  version_id: string;
  title: string;
  description: string;
  tag_labels: string[];
  download_filename: string;
  published_at: Date;
  media_metadata: Record<string, unknown>;
  runtime_epoch: string;
  public_access_epoch: string;
}
const publicFrom = `FROM shiling.publications p JOIN shiling.publication_revisions r ON r.id=p.current_revision_id
  JOIN shiling.assets a ON a.id=p.asset_id JOIN shiling.asset_versions v ON v.id=r.version_id AND v.asset_id=a.id
  JOIN shiling.product_settings s ON s.id=1`;
const publicWhere = `p.state='active' AND r.action<>'withdraw' AND a.lifecycle='active' AND v.processing_state='ready' AND s.values->>'publicEnabled'='true'
  AND EXISTS(SELECT 1 FROM shiling.publication_revision_artifacts ra JOIN shiling.artifacts f ON f.id=ra.artifact_id WHERE ra.publication_revision_id=r.id AND f.role='original')
  AND NOT EXISTS(SELECT 1 FROM shiling.publication_revision_artifacts ra JOIN shiling.artifacts f ON f.id=ra.artifact_id JOIN shiling.storage_objects o ON o.id=f.storage_object_id
    WHERE ra.publication_revision_id=r.id AND (o.state<>'stored' OR o.integrity_state<>'verified'))`;
const publicSelect = `SELECT a.id asset_id,a.type_key,p.revision publication_revision,r.id snapshot_id,r.version_id,r.title,r.description,r.tag_labels,r.download_filename,
  r.created_at published_at,v.media_metadata,s.runtime_epoch,s.public_access_epoch ${publicFrom}`;
async function publicById(db: Queryable, id: string, lock = false): Promise<PublicRow> {
  const row = (
    await db.query<PublicRow>(
      `${publicSelect} WHERE a.id=$1 AND ${publicWhere} ${lock ? 'FOR SHARE OF p,a,v,s' : ''}`,
      [id],
    )
  ).rows[0];
  if (!row) throw new AppError(404, 'PUBLIC_ASSET_NOT_FOUND', '公开素材不存在或当前不可访问。');
  return row;
}
async function publicArtifacts(db: Queryable, snapshotId: string): Promise<ArtifactRow[]> {
  return (
    await db.query<ArtifactRow>(
      `SELECT f.id,f.role,f.storage_object_id,f.media_type,f.metadata,o.bytes,o.object_key,o.backend_key,o.namespace,o.state,o.integrity_state
    FROM shiling.publication_revision_artifacts ra JOIN shiling.artifacts f ON f.id=ra.artifact_id JOIN shiling.storage_objects o ON o.id=f.storage_object_id
    WHERE ra.publication_revision_id=$1 ORDER BY f.role,f.id`,
      [snapshotId],
    )
  ).rows;
}
async function publicDto(db: Queryable, row: PublicRow): Promise<PublicAsset> {
  const artifacts = await publicArtifacts(db, row.snapshot_id);
  const original = artifacts.find((artifact) => artifact.role === 'original');
  return {
    id: row.asset_id,
    typeId: row.type_key,
    title: row.title,
    description: row.description,
    publicTags: row.tag_labels,
    publicationRevision: row.publication_revision,
    publishedAt: row.published_at.toISOString(),
    format: original?.media_type ?? '',
    width: numericMetadata(row.media_metadata, 'width'),
    height: numericMetadata(row.media_metadata, 'height'),
    duration: numericMetadata(row.media_metadata, 'durationMs'),
    artifacts: artifacts
      .filter(
        (artifact) =>
          ['original', 'thumbnail', 'preview_image', 'poster', 'playback_video'].includes(
            artifact.role,
          ) &&
          artifact.state === 'stored' &&
          artifact.integrity_state === 'verified',
      )
      .map((artifact) => ({
        id: artifact.id,
        role: artifact.role,
        mediaType: artifact.media_type,
        bytes: artifact.bytes,
        width: numericMetadata(artifact.metadata, 'width'),
        height: numericMetadata(artifact.metadata, 'height'),
      })),
  };
}
function publicFilters(input: PublicListInput) {
  const q = input.q?.trim().replace(/\s+/g, ' ') ?? '';
  if (q.length > 200 || (input.tag?.length ?? 0) > 20 || (input.typeId?.length ?? 0) > 3)
    throw new AppError(400, 'INVALID_QUERY', '搜索或筛选内容超出限制。');
  const tags = input.tag?.map((tag) => tag.normalize('NFC').trim().toLowerCase());
  return {
    values: [
      input.typeId?.length ? input.typeId : null,
      tags?.length ? tags : null,
      q,
      `%${q.replace(/[\\%_]/g, '\\$&')}%`,
    ] as unknown[],
    sql: `AND ($1::text[] IS NULL OR a.type_key=ANY($1)) AND ($2::text[] IS NULL OR r.tag_keys @> $2::text[])
    AND ($3='' OR lower(r.title || ' ' || r.description) LIKE lower($4) ESCAPE '\\' OR EXISTS(SELECT 1 FROM unnest(r.tag_labels) label WHERE lower(label) LIKE lower($4) ESCAPE '\\'))`,
  };
}
export function createPublicationService({
  database,
  identity,
  storage,
  deliverySecret,
  grantTtlSeconds = 120,
}: PublicationDependencies) {
  const signer = createDeliverySigner(deliverySecret);
  if (!Number.isSafeInteger(grantTtlSeconds) || grantTtlSeconds < 1 || grantTtlSeconds > 600)
    throw new Error('Delivery grant TTL must be between 1 and 600 seconds.');
  async function write<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await database.transaction(work);
    } catch (error) {
      return mapDatabaseError(error);
    }
  }
  async function ensurePublicEnabled(db: Queryable): Promise<void> {
    if (
      !(
        await db.query(
          "SELECT id FROM shiling.product_settings WHERE id=1 AND values->>'publicEnabled'='true' FOR SHARE",
        )
      ).rowCount
    )
      throw new AppError(404, 'PUBLIC_UNAVAILABLE', '公开入口当前不可访问。');
  }
  return {
    async getState(token: string, assetId: string) {
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token, 'assets.read');
        const asset = await assetById(tx, assetId);
        requireVisibleAsset(actor, asset);
        if (
          asset.owner_id !== actor.id &&
          !actor.permissionKeys.includes('assets.governAny') &&
          !actor.permissionKeys.includes('publications.withdrawAny')
        )
          throw new AppError(403, 'FORBIDDEN', '没有管理该公开记录的权限。');
        const publication = await currentPublication(tx, assetId);
        if (!publication)
          return { state: 'none' as const, revision: '0', snapshot: null, sourceChanged: false };
        const snapshot = (
          await tx.query<{
            title: string | null;
            description: string | null;
            tag_labels: string[] | null;
            source_asset_revision: string;
            version_id: string;
            created_at: Date;
          }>(
            'SELECT title,description,tag_labels,source_asset_revision,version_id,created_at FROM shiling.publication_revisions WHERE id=$1',
            [publication.current_revision_id],
          )
        ).rows[0];
        return {
          state: publication.state,
          revision: publication.revision,
          snapshot:
            snapshot && publication.state === 'active'
              ? {
                  title: snapshot.title,
                  description: snapshot.description,
                  publicTags: snapshot.tag_labels,
                  versionId: snapshot.version_id,
                  publishedAt: snapshot.created_at.toISOString(),
                }
              : null,
          sourceChanged: snapshot ? snapshot.source_asset_revision !== asset.revision : false,
        };
      });
    },
    async publish(token: string, assetId: string, input: PublishInput, context: MutationContext) {
      const title = input.publicMetadata.title.trim();
      if (
        !title ||
        title.length > 200 ||
        input.publicMetadata.description.length > 5000 ||
        input.publicMetadata.tagIds.length > 20
      )
        throw new AppError(400, 'INVALID_PUBLIC_METADATA', '公开信息超出限制。');
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token, 'publications.publishOwn');
        const asset = await assetById(tx, assetId, true);
        requireVisibleAsset(actor, asset);
        if (asset.owner_id !== actor.id)
          throw new AppError(
            403,
            'PUBLICATION_OWNER_REQUIRED',
            '只能公开本人素材，任何角色都不能代发。',
          );
        const claim = await claimIdempotency(
          tx,
          actor.id,
          'publication.publish',
          context.idempotencyKey,
          requestHash({ assetId, input }),
        );
        const existing = await currentPublication(tx, assetId);
        if (claim.replay)
          return {
            state: existing?.state ?? 'none',
            revision: existing?.revision ?? '0',
            created: false,
          };
        assertRevision(asset.revision, input.expectedAssetRevision);
        if (input.expectedPublicationRevision === undefined)
          throw new AppError(428, 'PRECONDITION_REQUIRED', '请提供当前公开修订号。');
        if (input.expectedPublicationRevision !== (existing?.revision ?? '0'))
          throw new AppError(409, 'REVISION_CONFLICT', '公开内容已变化，请刷新后重试。');
        if (asset.lifecycle !== 'active' || asset.current_version_id !== input.versionId)
          throw new AppError(409, 'ASSET_NOT_READY', '当前素材或版本不能公开。');
        await ensurePublicEnabled(tx);
        const artifacts = await requireReadyArtifacts(tx, asset);
        const original = artifacts.find((artifact) => artifact.role === 'original');
        if (!original) throw new AppError(409, 'ASSET_INTEGRITY_FAILED', '原始文件不可用。');
        const tagIds = [...new Set(input.publicMetadata.tagIds)].sort();
        const labels: string[] = [];
        for (const tagId of tagIds) {
          const tag = (
            await tx.query<{ name: string }>(
              'SELECT t.name FROM shiling.tags t JOIN shiling.asset_tags at ON at.tag_id=t.id WHERE at.asset_id=$1 AND t.id=$2 FOR SHARE OF t',
              [assetId, tagId],
            )
          ).rows[0];
          if (!tag)
            throw new AppError(409, 'PUBLIC_TAG_NOT_ATTACHED', '公开标签必须来自素材现有标签。');
          labels.push(tag.name);
        }
        const publicationId = existing?.id ?? randomUUID();
        const revisionId = randomUUID();
        const revision = String(BigInt(existing?.revision ?? '0') + 1n);
        if (!existing)
          await tx.query(
            "INSERT INTO shiling.publications(id,asset_id,state,current_revision_id,updated_by) VALUES($1,$2,'active',$3,$4)",
            [publicationId, assetId, revisionId, actor.id],
          );
        await tx.query(
          'INSERT INTO shiling.publication_revisions(id,publication_id,asset_id,revision_no,action,version_id,title,description,tag_labels,tag_keys,download_filename,source_asset_revision,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
          [
            revisionId,
            publicationId,
            assetId,
            revision,
            existing?.state === 'active' ? 'update' : 'publish',
            input.versionId,
            title,
            input.publicMetadata.description,
            labels,
            labels.map((label) => label.normalize('NFC').trim().toLowerCase()),
            safeDownloadName(title, original.media_type),
            asset.revision,
            actor.id,
          ],
        );
        for (const artifact of artifacts.filter(
          (entry) => entry.state === 'stored' && entry.integrity_state === 'verified',
        ))
          await tx.query(
            'INSERT INTO shiling.publication_revision_artifacts(publication_revision_id,version_id,role,artifact_id) VALUES($1,$2,$3,$4)',
            [revisionId, input.versionId, artifact.role, artifact.id],
          );
        if (existing)
          await tx.query(
            "UPDATE shiling.publications SET state='active',current_revision_id=$2,updated_by=$3 WHERE id=$1",
            [publicationId, revisionId, actor.id],
          );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'publication.snapshot_written',
          resourceType: 'asset',
          resourceId: assetId,
          requestId: context.requestId,
          changes: { publicationRevision: revision },
        });
        await completeIdempotency(tx, claim.id, { assetId, publicationId, revisionId });
        return { state: 'active' as const, revision, created: !existing };
      });
    },
    async withdraw(
      token: string,
      assetId: string,
      expectedRevision: string,
      context: MutationContext,
    ) {
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token, 'assets.read');
        const asset = await assetById(tx, assetId, true);
        requireVisibleAsset(actor, asset);
        if (!(
          actor.permissionKeys.includes('publications.withdrawAny') ||
          (asset.owner_id === actor.id && actor.permissionKeys.includes('publications.withdrawOwn'))
        ))
          throw new AppError(403, 'FORBIDDEN', '没有撤回该公开记录的权限。');
        const claim = await claimIdempotency(
          tx,
          actor.id,
          'publication.withdraw',
          context.idempotencyKey,
          requestHash({ assetId, expectedRevision }),
        );
        const publication = await currentPublication(tx, assetId);
        if (!publication) throw new AppError(409, 'PUBLICATION_NOT_FOUND', '素材从未公开。');
        if (claim.replay) return { state: publication.state, revision: publication.revision };
        assertRevision(publication.revision, expectedRevision);
        const result = await withdrawPublication(
          tx,
          asset,
          actor.id,
          context.requestId,
          asset.owner_id === actor.id ? 'owner_withdraw' : 'governance_withdraw',
        );
        await completeIdempotency(tx, claim.id, { assetId });
        return {
          state: result?.state ?? 'withdrawn',
          revision: result?.revision ?? publication.revision,
        };
      });
    },
    async get(assetId: string) {
      return write(async (tx) => publicDto(tx, await publicById(tx, assetId)));
    },
    async list(input: PublicListInput = {}) {
      return write(async (tx) => {
        await ensurePublicEnabled(tx);
        const limit = input.limit ?? 40;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new AppError(400, 'INVALID_PAGE_LIMIT', '每页数量应为 1 至 100。');
        const filters = publicFilters(input);
        const sort = input.sort ?? 'publishedAtDesc';
        const column = sort === 'titleAsc' ? 'r.title' : 'r.created_at';
        const comparison = sort === 'titleAsc' ? '>' : '<';
        const direction = sort === 'titleAsc' ? 'ASC' : 'DESC';
        const scope = requestHash({ ...input, cursor: null, limit: null });
        let cursor: { value: string; id: string } | null = null;
        if (input.cursor) {
          try {
            const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as {
              scope: string;
              value: string;
              id: string;
            };
            if (
              value.scope !== scope ||
              typeof value.value !== 'string' ||
              value.value.length > 200 ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id) ||
              (sort !== 'titleAsc' && !Number.isFinite(Date.parse(value.value)))
            )
              throw new Error('cursor');
            cursor = value;
          } catch {
            throw new AppError(400, 'INVALID_CURSOR', '分页条件已变化，请刷新列表。');
          }
        }
        const rows = (
          await tx.query<{ id: string; cursor_value: string }>(
            `SELECT a.id,${column}::text cursor_value ${publicFrom} WHERE ${publicWhere} ${filters.sql}
          AND ($5::text IS NULL OR (${column},a.id) ${comparison} ($5::${sort === 'titleAsc' ? 'text' : 'timestamptz'},$6::uuid)) ORDER BY ${column} ${direction},a.id ${direction} LIMIT $7`,
            [...filters.values, cursor?.value ?? null, cursor?.id ?? null, limit + 1],
          )
        ).rows;
        const hasMore = rows.length > limit;
        const selected = rows.slice(0, limit);
        const items = [];
        for (const row of selected) items.push(await publicDto(tx, await publicById(tx, row.id)));
        const last = selected.at(-1);
        return {
          items,
          pageInfo: {
            hasMore,
            nextCursor:
              hasMore && last
                ? Buffer.from(
                    JSON.stringify({ scope, value: last.cursor_value, id: last.id }),
                  ).toString('base64url')
                : null,
          },
        };
      });
    },
    async facets(input: PublicListInput = {}) {
      return write(async (tx) => {
        await ensurePublicEnabled(tx);
        const filters = publicFilters(input);
        const types = (
          await tx.query<{ value: MediaTypeKey; count: string }>(
            `SELECT a.type_key value,count(*) count ${publicFrom} WHERE ${publicWhere} ${filters.sql} GROUP BY a.type_key ORDER BY a.type_key`,
            filters.values,
          )
        ).rows;
        const tags = (
          await tx.query<{ value: string; count: string }>(
            `SELECT label value,count(DISTINCT a.id) count ${publicFrom} CROSS JOIN LATERAL unnest(r.tag_labels) label WHERE ${publicWhere} ${filters.sql} GROUP BY label ORDER BY label`,
            filters.values,
          )
        ).rows;
        return {
          types: types.map((entry) => ({
            label: ({ image: '图片', video: '视频', web_motion: '动效' } as const)[entry.value],
            value: entry.value,
            count: Number(entry.count),
          })),
          tags: tags.map((entry) => ({
            label: entry.value,
            value: entry.value,
            count: Number(entry.count),
          })),
        };
      });
    },
    async createDeliveryGrant(
      assetId: string,
      input: { artifactId: string; purpose: DeliveryPurpose },
    ) {
      return write(async (tx) => {
        const row = await publicById(tx, assetId, true);
        const artifact = (await publicArtifacts(tx, row.snapshot_id)).find(
          (entry) => entry.id === input.artifactId,
        );
        if (!artifact) throw new AppError(404, 'CONTENT_UNAVAILABLE', '文件当前不可访问。');
        allowArtifactPurpose(artifact, input.purpose);
        const expiresAt = Date.now() + grantTtlSeconds * 1000;
        const grant = signer.sign({
          scope: 'public',
          assetId,
          versionId: row.version_id,
          artifactId: artifact.id,
          purpose: input.purpose,
          expiresAt,
          runtimeEpoch: row.runtime_epoch,
          publicationRevision: row.publication_revision,
          accessEpoch: row.public_access_epoch,
        });
        return {
          url: `/api/v1/public/assets/${assetId}/content/${artifact.id}?grant=${encodeURIComponent(grant)}`,
          method: 'GET' as const,
          expiresAt: new Date(expiresAt).toISOString(),
          contentType: artifact.media_type,
          downloadName:
            input.purpose === 'download'
              ? row.download_filename
              : safeDownloadName(row.title, artifact.media_type),
          rangeSupported: true,
        };
      });
    },
    async openContent(assetId: string, artifactId: string, grant: string, range?: ContentRange) {
      const claims = signer.verify(grant);
      if (
        claims.scope !== 'public' ||
        claims.assetId !== assetId ||
        claims.artifactId !== artifactId
      )
        throw new AppError(404, 'CONTENT_UNAVAILABLE', '文件访问授权已失效。');
      const content = await write(async (tx) => {
        const row = await publicById(tx, assetId, true);
        if (
          claims.versionId !== row.version_id ||
          claims.publicationRevision !== row.publication_revision ||
          claims.accessEpoch !== row.public_access_epoch ||
          claims.runtimeEpoch !== row.runtime_epoch
        )
          throw new AppError(404, 'CONTENT_UNAVAILABLE', '文件访问授权已失效。');
        const artifact = (await publicArtifacts(tx, row.snapshot_id)).find(
          (entry) => entry.id === artifactId,
        );
        if (!artifact) throw new AppError(404, 'CONTENT_UNAVAILABLE', '文件当前不可访问。');
        allowArtifactPurpose(artifact, claims.purpose);
        return {
          artifact,
          downloadName:
            claims.purpose === 'download'
              ? row.download_filename
              : safeDownloadName(row.title, artifact.media_type),
        };
      });
      requireStorageLocation(storage, content.artifact);
      const opened = await storage.open(content.artifact.object_key, range);
      return {
        ...opened,
        contentType: content.artifact.media_type,
        downloadName: content.downloadName,
        attachment: claims.purpose === 'download',
      };
    },
  };
}
export type PublicationService = ReturnType<typeof createPublicationService>;
