import { randomUUID } from 'node:crypto';
import type { PermissionKey } from '@shiling/contracts';
import { AppError, assertRevision, mapDatabaseError } from '../../errors.js';
import type { Database, Queryable, Transaction } from '../../ports/database.js';
import { appendAudit } from '../administration/audit.js';
import type { Actor } from '../identity/authorization.js';
import type { IdentityService, MutationContext } from '../identity/service.js';
import {
  claimIdempotency,
  completeIdempotency,
  requestHash,
} from '../administration/idempotency.js';
import type { AssetListInput, AssetService } from '../assets/service.js';

export interface LibraryDependencies {
  database: Database;
  identity: IdentityService;
  assets: AssetService;
}
export interface LibraryPageQuery {
  cursor?: string;
  limit?: number;
}
export interface TagInput {
  name: string;
  description?: string;
}
export interface CollectionInput {
  name: string;
  description: string;
}
export interface Tag {
  id: string;
  name: string;
  description: string;
  state: 'active' | 'disabled';
  revision: string;
}
export interface Collection {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  state: 'active' | 'archived';
  revision: string;
  visibleItemCount: number;
  actions: Record<string, boolean>;
}
export interface AssetBatchInput {
  action: 'archive' | 'restore' | 'addTags' | 'removeTags';
  items: { assetId: string; expectedRevision: string }[];
  tagIds?: string[];
}
interface TagRow extends Tag {
  normalized_name: string;
}
interface CollectionRow {
  id: string;
  title: string;
  description: string;
  owner_id: string;
  revision: string;
  archived_at: Date | null;
  created_at: Date;
  visible_count?: string;
}
interface Cursor {
  id: string;
  value: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function permission(actor: Actor, key: PermissionKey): void {
  if (!actor.permissionKeys.includes(key))
    throw new AppError(403, 'FORBIDDEN', '没有执行此操作的权限。');
}
function validId(id: string): void {
  if (!UUID.test(id)) throw new AppError(400, 'INVALID_ID', '资源标识无效。');
}
function text(value: string, maximum: number, required: boolean): string {
  const normalized = required ? value.normalize('NFKC').trim() : value;
  const unsafeControl = [...normalized].some(
    (character) => character.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(character),
  );
  if ((required && !normalized) || [...normalized].length > maximum || unsafeControl) {
    throw new AppError(400, 'INVALID_METADATA', '名称或说明不符合长度和字符要求。');
  }
  return normalized;
}
function page(query: LibraryPageQuery, timestamp = false) {
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new AppError(400, 'INVALID_PAGE', '分页数量应为 1 至 100。');
  let cursor: Cursor | undefined;
  if (query.cursor !== undefined) {
    try {
      if (query.cursor.length > 2048) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (
        typeof value !== 'object' ||
        value === null ||
        !('id' in value) ||
        !('value' in value) ||
        typeof value.id !== 'string' ||
        typeof value.value !== 'string' ||
        !UUID.test(value.id)
      )
        throw new Error();
      if (
        value.value.length > 200 ||
        [...value.value].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error();
      if (
        timestamp &&
        (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.value) ||
          !Number.isFinite(Date.parse(value.value)) ||
          new Date(value.value).toISOString().slice(0, 19) !== value.value.slice(0, 19))
      )
        throw new Error();
      cursor = { id: value.id, value: value.value };
    } catch {
      throw new AppError(400, 'INVALID_CURSOR', '分页游标无效，请从第一页重新读取。');
    }
  }
  return { limit, cursor };
}
function pageInfo(hasMore: boolean, last: Cursor | undefined) {
  return {
    hasMore,
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify(last)).toString('base64url') : null,
  };
}
function tagDto(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    state: row.state,
    revision: row.revision,
  };
}
function manageCollection(actor: Actor, row: CollectionRow): boolean {
  return (
    actor.permissionKeys.includes('collections.governAny') ||
    (actor.id === row.owner_id && actor.permissionKeys.includes('collections.manageOwn'))
  );
}
async function tagById(db: Queryable, id: string, lock = false): Promise<TagRow> {
  validId(id);
  const row = (
    await db.query<TagRow>(
      `SELECT id,name,description,state,revision,normalized_name FROM shiling.tags WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    )
  ).rows[0];
  if (!row) throw new AppError(404, 'TAG_NOT_FOUND', '标签不存在。');
  return row;
}
async function collectionById(
  db: Queryable,
  actor: Actor,
  id: string,
  lock = false,
): Promise<CollectionRow> {
  validId(id);
  const row = (
    await db.query<CollectionRow>(
      `SELECT id,title,description,owner_id,revision,archived_at,created_at FROM shiling.collections WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    )
  ).rows[0];
  if (
    !row ||
    (row.archived_at &&
      row.owner_id !== actor.id &&
      !actor.permissionKeys.includes('collections.governAny'))
  )
    throw new AppError(404, 'COLLECTION_NOT_FOUND', '集合不存在或不可访问。');
  return row;
}
async function collectionDto(db: Queryable, actor: Actor, row: CollectionRow): Promise<Collection> {
  const count =
    row.visible_count ??
    (
      await db.query<{ count: string }>(
        `SELECT count(*) FROM shiling.collection_items ci
    JOIN shiling.assets a ON a.id=ci.asset_id JOIN shiling.asset_versions v ON v.id=a.current_version_id AND v.asset_id=a.id
    WHERE ci.collection_id=$1 AND a.lifecycle='active' AND v.processing_state='ready'`,
        [row.id],
      )
    ).rows[0]?.count ??
    '0';
  const manage = manageCollection(actor, row);
  return {
    id: row.id,
    name: row.title,
    description: row.description,
    ownerId: row.owner_id,
    state: row.archived_at ? 'archived' : 'active',
    revision: row.revision,
    visibleItemCount: Number(count),
    actions: {
      edit: manage && !row.archived_at,
      manageItems: manage && !row.archived_at,
      archive: manage && !row.archived_at,
      restore: manage && !!row.archived_at,
    },
  };
}
function checkIds(ids: readonly string[], maximum: number, allowEmpty = false): void {
  if ((!allowEmpty && ids.length === 0) || ids.length > maximum || new Set(ids).size !== ids.length)
    throw new AppError(400, 'INVALID_BATCH', '批次数量不正确或存在重复标识。');
  for (const id of ids) validId(id);
}

export function createLibraryService({ database, identity, assets }: LibraryDependencies) {
  async function transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await database.transaction(work);
    } catch (error) {
      return mapDatabaseError(error);
    }
  }
  async function collectionActor(tx: Transaction, token: string, create = false): Promise<Actor> {
    const actor = await identity.authorize(
      tx,
      token,
      create ? 'collections.create' : 'collections.read',
    );
    permission(actor, 'assets.read');
    return actor;
  }
  async function mutableCollection(
    tx: Transaction,
    token: string,
    id: string,
    expectedRevision: string | undefined,
    patch: boolean,
    requireActive = true,
  ) {
    const actor = await collectionActor(tx, token);
    const row = await collectionById(tx, actor, id, true);
    if (!manageCollection(actor, row))
      throw new AppError(403, 'FORBIDDEN', '只能维护本人或获治理授权的集合。');
    assertRevision(row.revision, expectedRevision, patch);
    if (requireActive && row.archived_at)
      throw new AppError(409, 'COLLECTION_ARCHIVED', '请先恢复集合后再修改。');
    return { actor, row };
  }
  return {
    async listTags(
      token: string,
      query: LibraryPageQuery & { state?: 'active' | 'disabled' | 'all' } = {},
    ) {
      const { cursor, limit } = page(query);
      const state = query.state ?? 'active';
      if (!['active', 'disabled', 'all'].includes(state))
        throw new AppError(400, 'INVALID_STATE', '标签状态无效。');
      return transaction(async (tx) => {
        await identity.authorize(tx, token, 'tags.read');
        const rows = (
          await tx.query<TagRow>(
            `SELECT id,name,description,state,revision,normalized_name FROM shiling.tags
          WHERE ($1='all' OR state=$1) AND ($2::text IS NULL OR (normalized_name,id)>($2,$3::uuid))
          ORDER BY normalized_name,id LIMIT $4`,
            [state, cursor?.value ?? null, cursor?.id ?? null, limit + 1],
          )
        ).rows;
        const selected = rows.slice(0, limit);
        const last = selected.at(-1);
        return {
          items: selected.map(tagDto),
          pageInfo: pageInfo(
            rows.length > limit,
            last && { id: last.id, value: last.normalized_name },
          ),
        };
      });
    },
    async createTag(token: string, input: TagInput, context: MutationContext): Promise<Tag> {
      const name = text(input.name, 40, true);
      const description = text(input.description ?? '', 5000, false);
      return transaction(async (tx) => {
        const actor = await identity.authorize(tx, token, 'tags.manage');
        const claim = await claimIdempotency(
          tx,
          actor.id,
          'tags.create',
          context.idempotencyKey,
          requestHash({ name, description }),
        );
        if (claim.replay) return tagDto(await tagById(tx, String(claim.resourceRefs.tagId)));
        const id = randomUUID();
        await tx.query(
          'INSERT INTO shiling.tags(id,name,description,normalized_name,created_by) VALUES($1,$2,$3,$4,$5)',
          [id, name, description, name.toLowerCase(), actor.id],
        );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'library.tag_created',
          resourceType: 'tag',
          resourceId: id,
          requestId: context.requestId,
        });
        await completeIdempotency(tx, claim.id, { tagId: id });
        return tagDto(await tagById(tx, id));
      });
    },
    async updateTag(
      token: string,
      id: string,
      input: TagInput,
      expectedRevision: string | undefined,
      requestId: string,
    ): Promise<Tag> {
      const name = text(input.name, 40, true);
      const description =
        input.description === undefined ? undefined : text(input.description, 5000, false);
      return transaction(async (tx) => {
        const actor = await identity.authorize(tx, token, 'tags.manage');
        const row = await tagById(tx, id, true);
        assertRevision(row.revision, expectedRevision, true);
        await tx.query(
          'UPDATE shiling.tags SET name=$2,description=$3,normalized_name=$4 WHERE id=$1',
          [id, name, description ?? row.description, name.toLowerCase()],
        );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'library.tag_updated',
          resourceType: 'tag',
          resourceId: id,
          requestId,
          changes: { previousRevision: row.revision },
        });
        return tagDto(await tagById(tx, id));
      });
    },
    async setTagState(
      token: string,
      id: string,
      state: 'active' | 'disabled',
      expectedRevision: string | undefined,
      requestId: string,
    ): Promise<Tag> {
      if (!['active', 'disabled'].includes(state))
        throw new AppError(400, 'INVALID_STATE', '标签状态无效。');
      return transaction(async (tx) => {
        const actor = await identity.authorize(tx, token, 'tags.manage');
        const row = await tagById(tx, id, true);
        assertRevision(row.revision, expectedRevision);
        if (row.state === state) return tagDto(row);
        await tx.query('UPDATE shiling.tags SET state=$2 WHERE id=$1', [id, state]);
        await appendAudit(tx, {
          actorId: actor.id,
          action: state === 'active' ? 'library.tag_enabled' : 'library.tag_disabled',
          resourceType: 'tag',
          resourceId: id,
          requestId,
          changes: { previousRevision: row.revision },
        });
        return tagDto(await tagById(tx, id));
      });
    },
    async listCollections(
      token: string,
      query: LibraryPageQuery & { state?: 'active' | 'archived' | 'all' } = {},
    ) {
      const { cursor, limit } = page(query, true);
      const state = query.state ?? 'active';
      if (!['active', 'archived', 'all'].includes(state))
        throw new AppError(400, 'INVALID_STATE', '集合状态无效。');
      return transaction(async (tx) => {
        const actor = await collectionActor(tx, token);
        const rows = (
          await tx.query<CollectionRow & { cursor_value: string }>(
            `SELECT c.id,c.title,c.description,c.owner_id,c.revision,c.archived_at,c.created_at,
          to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_value,
          (SELECT count(*)::text FROM shiling.collection_items ci JOIN shiling.assets a ON a.id=ci.asset_id
            JOIN shiling.asset_versions v ON v.id=a.current_version_id AND v.asset_id=a.id
            WHERE ci.collection_id=c.id AND a.lifecycle='active' AND v.processing_state='ready') visible_count FROM shiling.collections c
          WHERE ($1='all' OR ($1='active' AND archived_at IS NULL) OR ($1='archived' AND archived_at IS NOT NULL))
          AND (archived_at IS NULL OR $2::boolean OR owner_id=$3)
          AND ($4::timestamptz IS NULL OR (created_at,id)<($4,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT $6`,
            [
              state,
              actor.permissionKeys.includes('collections.governAny'),
              actor.id,
              cursor?.value ?? null,
              cursor?.id ?? null,
              limit + 1,
            ],
          )
        ).rows;
        const selected = rows.slice(0, limit);
        const last = selected.at(-1);
        const items: Collection[] = [];
        for (const row of selected) items.push(await collectionDto(tx, actor, row));
        return {
          items,
          pageInfo: pageInfo(
            rows.length > limit,
            last && { id: last.id, value: last.cursor_value },
          ),
        };
      });
    },
    async getCollection(token: string, id: string): Promise<Collection> {
      return transaction(async (tx) => {
        const actor = await collectionActor(tx, token);
        return collectionDto(tx, actor, await collectionById(tx, actor, id));
      });
    },
    async createCollection(
      token: string,
      input: CollectionInput,
      context: MutationContext,
    ): Promise<Collection> {
      const name = text(input.name, 200, true);
      const description = text(input.description, 5000, false);
      return transaction(async (tx) => {
        const actor = await collectionActor(tx, token, true);
        const claim = await claimIdempotency(
          tx,
          actor.id,
          'collections.create',
          context.idempotencyKey,
          requestHash({ name, description }),
        );
        if (claim.replay)
          return collectionDto(
            tx,
            actor,
            await collectionById(tx, actor, String(claim.resourceRefs.collectionId)),
          );
        const id = randomUUID();
        await tx.query(
          'INSERT INTO shiling.collections(id,title,description,owner_id) VALUES($1,$2,$3,$4)',
          [id, name, description, actor.id],
        );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'library.collection_created',
          resourceType: 'collection',
          resourceId: id,
          requestId: context.requestId,
        });
        await completeIdempotency(tx, claim.id, { collectionId: id });
        return collectionDto(tx, actor, await collectionById(tx, actor, id));
      });
    },
    async updateCollection(
      token: string,
      id: string,
      input: CollectionInput,
      expectedRevision: string | undefined,
      requestId: string,
    ): Promise<Collection> {
      const name = text(input.name, 200, true);
      const description = text(input.description, 5000, false);
      return transaction(async (tx) => {
        const { actor, row } = await mutableCollection(tx, token, id, expectedRevision, true);
        await tx.query('UPDATE shiling.collections SET title=$2,description=$3 WHERE id=$1', [
          id,
          name,
          description,
        ]);
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'library.collection_updated',
          resourceType: 'collection',
          resourceId: id,
          requestId,
          changes: { previousRevision: row.revision },
        });
        return collectionDto(tx, actor, await collectionById(tx, actor, id));
      });
    },
    async setCollectionState(
      token: string,
      id: string,
      state: 'active' | 'archived',
      expectedRevision: string | undefined,
      requestId: string,
    ): Promise<Collection> {
      if (!['active', 'archived'].includes(state))
        throw new AppError(400, 'INVALID_STATE', '集合状态无效。');
      return transaction(async (tx) => {
        const { actor, row } = await mutableCollection(
          tx,
          token,
          id,
          expectedRevision,
          false,
          false,
        );
        if ((row.archived_at !== null) === (state === 'archived'))
          return collectionDto(tx, actor, row);
        await tx.query(
          `UPDATE shiling.collections SET archived_at=CASE WHEN $2 THEN now() ELSE NULL END,archived_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END WHERE id=$1`,
          [id, state === 'archived', actor.id],
        );
        await appendAudit(tx, {
          actorId: actor.id,
          action:
            state === 'archived' ? 'library.collection_archived' : 'library.collection_restored',
          resourceType: 'collection',
          resourceId: id,
          requestId,
          changes: { previousRevision: row.revision },
        });
        return collectionDto(tx, actor, await collectionById(tx, actor, id));
      });
    },
    async updateCollectionItems(
      token: string,
      id: string,
      input: { action: 'add' | 'remove'; assetIds: string[]; expectedRevision: string },
      requestId: string,
    ): Promise<Collection> {
      checkIds(input.assetIds, 100);
      if (!['add', 'remove'].includes(input.action))
        throw new AppError(400, 'INVALID_ACTION', '集合条目操作无效。');
      return transaction(async (tx) => {
        const { actor, row } = await mutableCollection(
          tx,
          token,
          id,
          input.expectedRevision,
          false,
        );
        const ids = [...input.assetIds].sort();
        if (input.action === 'add') {
          const visible = await tx.query(
            `SELECT a.id FROM shiling.assets a JOIN shiling.asset_versions v ON v.id=a.current_version_id AND v.asset_id=a.id
            WHERE a.id=ANY($1::uuid[]) AND a.lifecycle='active' AND v.processing_state='ready' ORDER BY a.id FOR SHARE OF a,v`,
            [ids],
          );
          if (visible.rowCount !== ids.length)
            throw new AppError(404, 'RESOURCE_NOT_FOUND', '部分素材不存在或当前不可加入集合。');
        }
        const changed =
          input.action === 'add'
            ? await tx.query(
                'INSERT INTO shiling.collection_items(collection_id,asset_id,added_by) SELECT $1,asset_id,$3 FROM unnest($2::uuid[]) AS asset_id ON CONFLICT DO NOTHING',
                [id, ids, actor.id],
              )
            : await tx.query(
                'DELETE FROM shiling.collection_items WHERE collection_id=$1 AND asset_id=ANY($2::uuid[])',
                [id, ids],
              );
        if (changed.rowCount) {
          await tx.query('UPDATE shiling.collections SET updated_at=now() WHERE id=$1', [id]);
          await appendAudit(tx, {
            actorId: actor.id,
            action: `library.collection_items_${input.action}`,
            resourceType: 'collection',
            resourceId: id,
            requestId,
            changes: { previousRevision: row.revision, changedCount: changed.rowCount },
          });
        }
        return collectionDto(tx, actor, await collectionById(tx, actor, id));
      });
    },
    async listCollectionItems(
      token: string,
      id: string,
      query: Omit<AssetListInput, 'collectionId' | 'state'> = {},
    ) {
      await transaction(async (tx) => {
        const actor = await collectionActor(tx, token);
        await collectionById(tx, actor, id);
      });
      return assets.list(token, { ...query, collectionId: id, state: 'active' });
    },
    async setFavorite(
      token: string,
      assetId: string,
      favorite: boolean,
      requestId: string,
    ): Promise<{ assetId: string; favorite: boolean }> {
      validId(assetId);
      return transaction(async (tx) => {
        const actor = await identity.authorize(tx, token, 'favorites.manageOwn');
        permission(actor, 'assets.read');
        if (favorite) {
          const visible = await tx.query(
            `SELECT a.id FROM shiling.assets a JOIN shiling.asset_versions v ON v.id=a.current_version_id AND v.asset_id=a.id
            WHERE a.id=$1 AND a.lifecycle='active' AND v.processing_state='ready' FOR SHARE OF a,v`,
            [assetId],
          );
          if (!visible.rowCount)
            throw new AppError(404, 'RESOURCE_NOT_FOUND', '素材不存在或当前不可收藏。');
        }
        const result = favorite
          ? await tx.query(
              'INSERT INTO shiling.favorites(user_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
              [actor.id, assetId],
            )
          : await tx.query('DELETE FROM shiling.favorites WHERE user_id=$1 AND asset_id=$2', [
              actor.id,
              assetId,
            ]);
        if (result.rowCount)
          await appendAudit(tx, {
            actorId: actor.id,
            action: favorite ? 'library.favorite_added' : 'library.favorite_removed',
            resourceType: 'asset',
            resourceId: assetId,
            requestId,
          });
        return { assetId, favorite };
      });
    },
    async listFavorites(token: string, query: Omit<AssetListInput, 'favorite' | 'state'> = {}) {
      return assets.list(token, { ...query, favorite: true, state: 'active' });
    },
    async batchAssets(token: string, input: AssetBatchInput, context: MutationContext) {
      if (context.idempotencyKey.length < 8 || context.idempotencyKey.length > 128)
        throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', '请提供有效的幂等键。');
      checkIds(
        input.items.map((item) => item.assetId),
        100,
      );
      if (!['archive', 'restore', 'addTags', 'removeTags'].includes(input.action))
        throw new AppError(400, 'INVALID_ACTION', '批量操作无效。');
      for (const item of input.items)
        if (!/^[1-9][0-9]*$/.test(item.expectedRevision))
          throw new AppError(400, 'INVALID_REVISION', '请为每项素材提供有效修订号。');
      if (input.action === 'addTags' || input.action === 'removeTags')
        checkIds(input.tagIds ?? [], 20);
      else if (input.tagIds !== undefined)
        throw new AppError(400, 'INVALID_BATCH', '归档和恢复不能同时修改标签。');
      await transaction((tx) => identity.authorize(tx, token, 'assets.read'));
      const items: {
        assetId: string;
        outcome: 'succeeded' | 'denied' | 'conflict' | 'failed';
        code: string;
        revision: string | null;
      }[] = [];
      for (const item of input.items) {
        try {
          let revision: string;
          const itemContext = {
            requestId: context.requestId,
            idempotencyKey: requestHash({
              parent: context.idempotencyKey,
              action: input.action,
              assetId: item.assetId,
            }),
          };
          if (input.action === 'archive')
            revision = (
              await assets.archive(token, item.assetId, item.expectedRevision, itemContext)
            ).revision;
          else if (input.action === 'restore')
            revision = (
              await assets.restore(token, item.assetId, item.expectedRevision, itemContext)
            ).revision;
          else {
            revision = (
              await assets.changeTags(
                token,
                item.assetId,
                input.action,
                input.tagIds ?? [],
                item.expectedRevision,
                itemContext,
              )
            ).revision;
          }
          items.push({ assetId: item.assetId, outcome: 'succeeded', code: 'OK', revision });
        } catch (error) {
          const known =
            error instanceof AppError
              ? error
              : new AppError(500, 'INTERNAL_ERROR', '操作暂时无法完成。');
          items.push({
            assetId: item.assetId,
            outcome:
              known.status === 403 || known.status === 404
                ? 'denied'
                : [409, 412, 428].includes(known.status)
                  ? 'conflict'
                  : 'failed',
            code: known.status === 412 ? 'REVISION_CONFLICT' : known.code,
            revision: null,
          });
        }
      }
      const succeeded = items.filter((item) => item.outcome === 'succeeded').length;
      return {
        overall:
          succeeded === items.length
            ? ('succeeded' as const)
            : succeeded === 0
              ? ('failed' as const)
              : ('partial' as const),
        items,
      };
    },
  };
}
export type LibraryService = ReturnType<typeof createLibraryService>;
