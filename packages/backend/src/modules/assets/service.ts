import type { Database, Transaction } from '../../ports/database.js';
import type { StoragePort, ContentRange } from '../../ports/storage.js';
import type { IdentityService, MutationContext } from '../identity/service.js';
import type { MediaTypeKey } from '../../ports/media.js';
import { AppError, assertRevision, mapDatabaseError } from '../../errors.js';
import { appendAudit } from '../administration/audit.js';
import {
  claimIdempotency,
  completeIdempotency,
  requestHash,
} from '../administration/idempotency.js';
import { withdrawPublication } from '../publication/repository.js';
import {
  assetById,
  assetDto,
  requireVisibleAsset,
  requireReadyArtifacts,
  artifactRows,
} from './repository.js';
import {
  allowArtifactPurpose,
  createDeliverySigner,
  safeDownloadName,
  type DeliveryPurpose,
} from './delivery.js';

export interface AssetServiceDependencies {
  database: Database;
  identity: IdentityService;
  storage: StoragePort;
  deliverySecret: string;
  grantTtlSeconds?: number;
}
export interface AssetListInput {
  q?: string;
  typeId?: MediaTypeKey[];
  tagId?: string[];
  collectionId?: string;
  favorite?: boolean;
  owner?: string;
  state?: 'active' | 'archived';
  sort?: 'createdAtDesc' | 'updatedAtDesc' | 'titleAsc';
  cursor?: string;
  limit?: number;
}
export interface AssetEditInput {
  title?: string;
  description?: string;
  tagIds?: string[];
}
async function replaceTags(
  tx: Transaction,
  assetId: string,
  actorId: string,
  tagIds: string[],
): Promise<void> {
  const existing = (
    await tx.query<{ tag_id: string }>('SELECT tag_id FROM shiling.asset_tags WHERE asset_id=$1', [
      assetId,
    ])
  ).rows.map((tag) => tag.tag_id);
  for (const tagId of [...new Set(tagIds)].sort()) {
    const tag = (
      await tx.query<{ state: string }>('SELECT state FROM shiling.tags WHERE id=$1 FOR SHARE', [
        tagId,
      ])
    ).rows[0];
    if (!tag || (tag.state !== 'active' && !existing.includes(tagId)))
      throw new AppError(409, 'TAG_UNAVAILABLE', '标签已停用或不存在，请刷新选择。');
    await tx.query(
      'INSERT INTO shiling.asset_tags(asset_id,tag_id,assigned_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [assetId, tagId, actorId],
    );
  }
  await tx.query(
    'DELETE FROM shiling.asset_tags WHERE asset_id=$1 AND NOT(tag_id=ANY($2::uuid[]))',
    [assetId, tagIds],
  );
}
export function createAssetService({
  database,
  identity,
  storage,
  deliverySecret,
  grantTtlSeconds = 120,
}: AssetServiceDependencies) {
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
  async function archiveAction(
    token: string,
    assetId: string,
    expectedRevision: string,
    context: MutationContext,
    restore: boolean,
  ) {
    return write(async (tx) => {
      const actor = await identity.authorize(tx, token, 'assets.read');
      const row = await assetById(tx, assetId, true);
      requireVisibleAsset(actor, row);
      if (
        !actor.permissionKeys.includes('assets.governAny') &&
        !(row.owner_id === actor.id && actor.permissionKeys.includes('assets.archiveOwn'))
      )
        throw new AppError(403, 'FORBIDDEN', '没有归档或恢复该素材的权限。');
      const claim = await claimIdempotency(
        tx,
        actor.id,
        restore ? 'assets.restore' : 'assets.archive',
        context.idempotencyKey,
        requestHash({ assetId, expectedRevision }),
      );
      if (claim.replay) return assetDto(tx, row, actor);
      assertRevision(row.revision, expectedRevision);
      if (row.lifecycle !== (restore ? 'archived' : 'active'))
        throw new AppError(409, 'ASSET_STATE_CONFLICT', '素材状态已经变化，请刷新。');
      if (restore) {
        await requireReadyArtifacts(tx, row);
        await tx.query(
          "UPDATE shiling.assets SET lifecycle='active',archived_at=NULL,archived_by=NULL WHERE id=$1",
          [assetId],
        );
      } else {
        await withdrawPublication(tx, row, actor.id, context.requestId, 'asset_archived');
        await tx.query(
          "UPDATE shiling.assets SET lifecycle='archived',archived_at=now(),archived_by=$2 WHERE id=$1",
          [assetId, actor.id],
        );
      }
      await appendAudit(tx, {
        actorId: actor.id,
        action: restore ? 'assets.restored' : 'assets.archived',
        resourceType: 'asset',
        resourceId: assetId,
        requestId: context.requestId,
      });
      await completeIdempotency(tx, claim.id, { assetId });
      return assetDto(tx, await assetById(tx, assetId), actor);
    });
  }
  return {
    async get(token: string, assetId: string) {
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token, 'assets.read');
        const row = await assetById(tx, assetId);
        requireVisibleAsset(actor, row);
        return assetDto(tx, row, actor);
      });
    },
    async list(token: string, input: AssetListInput = {}) {
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token, 'assets.read');
        const limit = input.limit ?? 40;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new AppError(400, 'INVALID_PAGE_LIMIT', '每页数量应为 1 至 100。');
        const q = input.q?.trim().replace(/\s+/g, ' ') ?? '';
        if (q.length > 200) throw new AppError(400, 'INVALID_QUERY', '搜索内容过长。');
        if ((input.typeId?.length ?? 0) > 3 || (input.tagId?.length ?? 0) > 20)
          throw new AppError(400, 'INVALID_QUERY', '筛选项数量超出限制。');
        if (input.favorite && !actor.permissionKeys.includes('favorites.manageOwn'))
          throw new AppError(403, 'FORBIDDEN', '没有查看收藏的权限。');
        if (input.collectionId) {
          if (!actor.permissionKeys.includes('collections.read'))
            throw new AppError(403, 'FORBIDDEN', '没有查看集合的权限。');
          const collection = (
            await tx.query<{ owner_id: string; archived_at: Date | null }>(
              'SELECT owner_id,archived_at FROM shiling.collections WHERE id=$1',
              [input.collectionId],
            )
          ).rows[0];
          if (
            !collection ||
            (collection.archived_at &&
              collection.owner_id !== actor.id &&
              !actor.permissionKeys.includes('collections.governAny'))
          )
            throw new AppError(404, 'COLLECTION_NOT_FOUND', '集合不存在。');
        }
        const state = input.state ?? 'active';
        const sort = input.sort ?? 'createdAtDesc';
        const column =
          sort === 'titleAsc'
            ? 'a.title'
            : sort === 'updatedAtDesc'
              ? 'a.updated_at'
              : 'a.created_at';
        const direction = sort === 'titleAsc' ? 'ASC' : 'DESC';
        const comparison = sort === 'titleAsc' ? '>' : '<';
        const scope = requestHash({
          ...input,
          cursor: null,
          limit: null,
          actor: actor.id,
          authzVersion: actor.session.authzVersion,
        });
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
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id) ||
              value.value.length > 200 ||
              (sort !== 'titleAsc' && !Number.isFinite(Date.parse(value.value)))
            )
              throw new Error('cursor');
            cursor = value;
          } catch {
            throw new AppError(400, 'INVALID_CURSOR', '分页条件已变化，请刷新列表。');
          }
        }
        const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
        const values: unknown[] = [
          state,
          actor.id,
          actor.permissionKeys.includes('assets.governAny'),
          input.typeId?.length ? input.typeId : null,
          input.tagId?.length ? input.tagId : null,
          input.collectionId ?? null,
          input.favorite ?? false,
          input.owner === 'me' ? actor.id : (input.owner ?? null),
          q,
          pattern,
          cursor?.value ?? null,
          cursor?.id ?? null,
          limit + 1,
        ];
        const rows = (
          await tx.query<{ id: string; cursor_value: string }>(
            `SELECT a.id,${column}::text cursor_value FROM shiling.assets a JOIN shiling.asset_versions v ON v.id=a.current_version_id
          WHERE a.lifecycle=$1 AND v.processing_state='ready' AND ($1='active' OR a.owner_id=$2 OR $3)
          AND ($4::text[] IS NULL OR a.type_key=ANY($4))
          AND ($5::uuid[] IS NULL OR NOT EXISTS(SELECT unnest($5::uuid[]) EXCEPT SELECT tag_id FROM shiling.asset_tags WHERE asset_id=a.id))
          AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM shiling.collection_items ci WHERE ci.asset_id=a.id AND ci.collection_id=$6))
          AND (NOT $7::boolean OR EXISTS(SELECT 1 FROM shiling.favorites f WHERE f.asset_id=a.id AND f.user_id=$2))
          AND ($8::uuid IS NULL OR a.owner_id=$8)
          AND ($9='' OR lower(a.title || ' ' || a.description) LIKE lower($10) ESCAPE '\\' OR EXISTS(SELECT 1 FROM shiling.asset_tags at JOIN shiling.tags t ON t.id=at.tag_id WHERE at.asset_id=a.id AND lower(t.name) LIKE lower($10) ESCAPE '\\'))
          AND ($11::text IS NULL OR (${column},a.id) ${comparison} ($11::${sort === 'titleAsc' ? 'text' : 'timestamptz'},$12::uuid))
          ORDER BY ${column} ${direction},a.id ${direction} LIMIT $13`,
            values,
          )
        ).rows;
        const hasMore = rows.length > limit;
        const selected = rows.slice(0, limit);
        const items = [];
        for (const row of selected)
          items.push(await assetDto(tx, await assetById(tx, row.id), actor));
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
    async edit(
      token: string,
      assetId: string,
      input: AssetEditInput,
      expectedRevision: string,
      requestId: string,
    ) {
      if (
        (input.title !== undefined && (!input.title.trim() || input.title.trim().length > 200)) ||
        (input.description !== undefined && input.description.length > 5000) ||
        (input.tagIds?.length ?? 0) > 20
      )
        throw new AppError(400, 'INVALID_METADATA', '素材信息超出限制。');
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token, 'assets.read');
        const row = await assetById(tx, assetId, true);
        requireVisibleAsset(actor, row);
        assertRevision(row.revision, expectedRevision, true);
        if (row.lifecycle !== 'active')
          throw new AppError(409, 'ASSET_ARCHIVED', '请恢复素材后再编辑。');
        if (
          !actor.permissionKeys.includes('assets.governAny') &&
          !(row.owner_id === actor.id && actor.permissionKeys.includes('assets.editOwn'))
        )
          throw new AppError(403, 'FORBIDDEN', '没有编辑该素材的权限。');
        if (input.tagIds) await replaceTags(tx, assetId, actor.id, input.tagIds);
        await tx.query('UPDATE shiling.assets SET title=$2,description=$3 WHERE id=$1', [
          assetId,
          input.title?.trim() ?? row.title,
          input.description ?? row.description,
        ]);
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'assets.metadata_updated',
          resourceType: 'asset',
          resourceId: assetId,
          requestId,
        });
        return assetDto(tx, await assetById(tx, assetId), actor);
      });
    },
    async changeTags(
      token: string,
      assetId: string,
      action: 'addTags' | 'removeTags',
      tagIds: string[],
      expectedRevision: string,
      context: MutationContext,
    ) {
      if (tagIds.length > 20) throw new AppError(400, 'TAG_LIMIT', '每项素材最多关联 20 个标签。');
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token, 'assets.read');
        const row = await assetById(tx, assetId, true);
        requireVisibleAsset(actor, row);
        if (row.lifecycle !== 'active')
          throw new AppError(409, 'ASSET_ARCHIVED', '请恢复素材后再编辑。');
        if (
          !actor.permissionKeys.includes('assets.governAny') &&
          !(row.owner_id === actor.id && actor.permissionKeys.includes('assets.editOwn'))
        )
          throw new AppError(403, 'FORBIDDEN', '没有编辑该素材的权限。');
        const claim = await claimIdempotency(
          tx,
          actor.id,
          'assets.change_tags',
          context.idempotencyKey,
          requestHash({ assetId, action, tagIds: [...new Set(tagIds)].sort(), expectedRevision }),
        );
        if (claim.replay) return assetDto(tx, row, actor);
        assertRevision(row.revision, expectedRevision);
        const previous = (
          await tx.query<{ tag_id: string }>(
            'SELECT tag_id FROM shiling.asset_tags WHERE asset_id=$1 ORDER BY tag_id',
            [assetId],
          )
        ).rows.map((tag) => tag.tag_id);
        const tags = new Set(previous);
        for (const tagId of tagIds) {
          if (action === 'addTags') tags.add(tagId);
          else tags.delete(tagId);
        }
        if (tags.size > 20) throw new AppError(400, 'TAG_LIMIT', '每项素材最多关联 20 个标签。');
        const next = [...tags].sort();
        if (JSON.stringify(previous) !== JSON.stringify(next)) {
          await replaceTags(tx, assetId, actor.id, next);
          await tx.query('UPDATE shiling.assets SET updated_at=now() WHERE id=$1', [assetId]);
          await appendAudit(tx, {
            actorId: actor.id,
            action: 'assets.tags_changed',
            resourceType: 'asset',
            resourceId: assetId,
            requestId: context.requestId,
          });
        }
        await completeIdempotency(tx, claim.id, { assetId });
        return assetDto(tx, await assetById(tx, assetId), actor);
      });
    },
    async facets(token: string, input: AssetListInput = {}) {
      return write(async (tx) => {
        const actor = await identity.authorize(tx, token, 'assets.read');
        const q = input.q?.trim().replace(/\s+/g, ' ') ?? '';
        if (q.length > 200 || (input.typeId?.length ?? 0) > 3 || (input.tagId?.length ?? 0) > 20)
          throw new AppError(400, 'INVALID_QUERY', '搜索或筛选内容超出限制。');
        if (input.favorite && !actor.permissionKeys.includes('favorites.manageOwn'))
          throw new AppError(403, 'FORBIDDEN', '没有查看收藏的权限。');
        if (input.collectionId) {
          if (!actor.permissionKeys.includes('collections.read'))
            throw new AppError(403, 'FORBIDDEN', '没有查看集合的权限。');
          const collection = (
            await tx.query<{ owner_id: string; archived_at: Date | null }>(
              'SELECT owner_id,archived_at FROM shiling.collections WHERE id=$1',
              [input.collectionId],
            )
          ).rows[0];
          if (
            !collection ||
            (collection.archived_at &&
              collection.owner_id !== actor.id &&
              !actor.permissionKeys.includes('collections.governAny'))
          )
            throw new AppError(404, 'COLLECTION_NOT_FOUND', '集合不存在。');
        }
        const values: unknown[] = [
          input.state ?? 'active',
          actor.id,
          actor.permissionKeys.includes('assets.governAny'),
          input.typeId?.length ? input.typeId : null,
          input.tagId?.length ? input.tagId : null,
          input.collectionId ?? null,
          input.favorite ?? false,
          input.owner === 'me' ? actor.id : (input.owner ?? null),
          q,
          `%${q.replace(/[\\%_]/g, '\\$&')}%`,
        ];
        const selection = `SELECT a.id,a.type_key FROM shiling.assets a JOIN shiling.asset_versions v ON v.id=a.current_version_id WHERE a.lifecycle=$1 AND v.processing_state='ready' AND ($1='active' OR a.owner_id=$2 OR $3)
          AND ($4::text[] IS NULL OR a.type_key=ANY($4)) AND ($5::uuid[] IS NULL OR NOT EXISTS(SELECT unnest($5::uuid[]) EXCEPT SELECT tag_id FROM shiling.asset_tags WHERE asset_id=a.id))
          AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM shiling.collection_items ci WHERE ci.asset_id=a.id AND ci.collection_id=$6))
          AND (NOT $7::boolean OR EXISTS(SELECT 1 FROM shiling.favorites f WHERE f.asset_id=a.id AND f.user_id=$2)) AND ($8::uuid IS NULL OR a.owner_id=$8)
          AND ($9='' OR lower(a.title || ' ' || a.description) LIKE lower($10) ESCAPE '\\' OR EXISTS(SELECT 1 FROM shiling.asset_tags at JOIN shiling.tags t ON t.id=at.tag_id WHERE at.asset_id=a.id AND lower(t.name) LIKE lower($10) ESCAPE '\\'))`;
        const types = (
          await tx.query<{ value: MediaTypeKey; count: string }>(
            `WITH visible AS (${selection}) SELECT type_key value,count(*) count FROM visible GROUP BY type_key ORDER BY type_key`,
            values,
          )
        ).rows;
        const tags = (
          await tx.query<{ id: string; name: string; state: string; count: string }>(
            `WITH visible AS (${selection}) SELECT t.id,t.name,t.state,count(*) count FROM visible a JOIN shiling.asset_tags at ON at.asset_id=a.id JOIN shiling.tags t ON t.id=at.tag_id GROUP BY t.id,t.name,t.state ORDER BY t.name,t.id`,
            values,
          )
        ).rows;
        return {
          types: types.map((entry) => ({ value: entry.value, count: Number(entry.count) })),
          tags: tags.map((entry) => ({
            id: entry.id,
            name: entry.name,
            state: entry.state,
            count: Number(entry.count),
          })),
        };
      });
    },
    archive: (token: string, assetId: string, expectedRevision: string, context: MutationContext) =>
      archiveAction(token, assetId, expectedRevision, context, false),
    restore: (token: string, assetId: string, expectedRevision: string, context: MutationContext) =>
      archiveAction(token, assetId, expectedRevision, context, true),
    async createDeliveryGrant(
      token: string,
      assetId: string,
      input: { artifactId: string; purpose: DeliveryPurpose },
    ) {
      return write(async (tx) => {
        const actor = await identity.authorize(
          tx,
          token,
          input.purpose === 'download' ? 'assets.download' : 'assets.read',
        );
        const row = await assetById(tx, assetId);
        requireVisibleAsset(actor, row);
        const artifact = (await artifactRows(tx, row.current_version_id!)).find(
          (entry) => entry.id === input.artifactId,
        );
        if (!artifact) throw new AppError(404, 'CONTENT_UNAVAILABLE', '文件当前不可访问。');
        allowArtifactPurpose(artifact, input.purpose, row.lifecycle === 'archived');
        const epoch = (
          await tx.query<{ runtime_epoch: string }>(
            'SELECT runtime_epoch FROM shiling.product_settings WHERE id=1',
          )
        ).rows[0];
        if (!epoch) throw new AppError(503, 'SETTINGS_UNAVAILABLE', '实例设置暂不可用。');
        const expiresAt = Date.now() + grantTtlSeconds * 1000;
        const grant = signer.sign({
          scope: 'team',
          assetId,
          versionId: row.current_version_id!,
          artifactId: artifact.id,
          purpose: input.purpose,
          expiresAt,
          runtimeEpoch: epoch.runtime_epoch,
          sessionId: actor.sessionId,
          authzVersion: actor.session.authzVersion,
        });
        return {
          url: `/api/v1/team/assets/${assetId}/content/${artifact.id}?grant=${encodeURIComponent(grant)}`,
          method: 'GET' as const,
          expiresAt: new Date(expiresAt).toISOString(),
          contentType: artifact.media_type,
          downloadName: safeDownloadName(row.title, artifact.media_type),
          rangeSupported: true,
        };
      });
    },
    async openContent(
      token: string,
      assetId: string,
      artifactId: string,
      grant: string,
      range?: ContentRange,
    ) {
      const claims = signer.verify(grant);
      if (claims.scope !== 'team' || claims.assetId !== assetId || claims.artifactId !== artifactId)
        throw new AppError(404, 'CONTENT_UNAVAILABLE', '文件访问授权已失效。');
      const content = await write(async (tx) => {
        const actor = await identity.authorize(
          tx,
          token,
          claims.purpose === 'download' ? 'assets.download' : 'assets.read',
        );
        const row = await assetById(tx, assetId);
        requireVisibleAsset(actor, row);
        const epoch = (
          await tx.query<{ runtime_epoch: string }>(
            'SELECT runtime_epoch FROM shiling.product_settings WHERE id=1',
          )
        ).rows[0];
        if (
          claims.sessionId !== actor.sessionId ||
          claims.authzVersion !== actor.session.authzVersion ||
          claims.versionId !== row.current_version_id ||
          claims.runtimeEpoch !== epoch?.runtime_epoch
        )
          throw new AppError(404, 'CONTENT_UNAVAILABLE', '文件访问授权已失效。');
        const artifact = (await artifactRows(tx, claims.versionId)).find(
          (entry) => entry.id === artifactId,
        );
        if (!artifact) throw new AppError(404, 'CONTENT_UNAVAILABLE', '文件当前不可访问。');
        allowArtifactPurpose(artifact, claims.purpose, row.lifecycle === 'archived');
        return { artifact, downloadName: safeDownloadName(row.title, artifact.media_type) };
      });
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
export type AssetService = ReturnType<typeof createAssetService>;
