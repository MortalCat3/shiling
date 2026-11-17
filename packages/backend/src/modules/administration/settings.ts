import { AppError, assertRevision, mapDatabaseError } from '../../errors.js';
import type { Database, Queryable, Transaction } from '../../ports/database.js';
import type { MediaTypeKey } from '../../ports/media.js';
import type { IdentityService } from '../identity/service.js';
import { DEFAULT_MAX_BYTES, effectiveTypeMaxBytes } from '../ingestion/policy.js';
import { appendAudit } from './audit.js';

export interface SettingsDependencies {
  database: Database;
  identity: IdentityService;
  uploadMaxBytes?: number;
}
export interface SettingsPatch {
  name?: string;
  brand?: { name: string; description: string; primaryColor: string };
  types?: { id: MediaTypeKey; acceptUploads: boolean; maxBytes: number }[];
  publicEnabled?: boolean;
  executePreview?: boolean;
  logoBrandingAssetId?: string | null;
  faviconBrandingAssetId?: string | null;
}
export interface PublicationImpact {
  eligibleActiveCount: number;
  evaluatedAt: string;
}
export interface ProductSettings {
  revision: string;
  name: string;
  brand: {
    name: string;
    description: string;
    primaryColor: string;
    logoUrl: string | null;
    faviconUrl: string | null;
  };
  types: {
    id: MediaTypeKey;
    name: string;
    acceptUploads: boolean;
    executePreview: boolean;
    extensions: string[];
    maxBytes: number;
  }[];
  publicEnabled: boolean;
  executePreview: boolean;
  logoBrandingAssetId: string | null;
  faviconBrandingAssetId: string | null;
  publicationImpact: PublicationImpact;
}
interface SettingsRow {
  revision: string;
  values: Record<string, unknown> & {
    name?: string;
    brandDescription?: string;
    primaryColor?: string;
    publicEnabled?: boolean;
    executePreview?: boolean;
    types?: Partial<Record<MediaTypeKey, { acceptUploads?: boolean; maxBytes?: number }>>;
  };
  logo_branding_asset_id: string | null;
  favicon_branding_asset_id: string | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPE_DEFINITIONS: ReadonlyArray<{
  id: MediaTypeKey;
  name: string;
  extensions: string[];
}> = [
  { id: 'image', name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
  { id: 'video', name: '视频', extensions: ['mp4'] },
  { id: 'web_motion', name: '动效', extensions: ['html', 'htm', 'zip'] },
];

async function settingsRow(db: Queryable, lock = false): Promise<SettingsRow> {
  const row = (
    await db.query<SettingsRow>(`SELECT revision,values,logo_branding_asset_id,favicon_branding_asset_id
    FROM shiling.product_settings WHERE id=1 ${lock ? 'FOR UPDATE' : 'FOR SHARE'}`)
  ).rows[0];
  if (!row) throw new AppError(503, 'SETTINGS_UNAVAILABLE', '实例设置暂不可用。', true);
  return row;
}
async function publicationImpact(db: Queryable): Promise<PublicationImpact> {
  try {
    const row = (
      await db.query<{
        count: string;
        evaluated_at: Date;
      }>(`SELECT count(*)::text count,clock_timestamp() evaluated_at
      FROM shiling.publications p
      JOIN shiling.publication_revisions r ON r.id=p.current_revision_id AND r.publication_id=p.id
      JOIN shiling.assets a ON a.id=p.asset_id
      JOIN shiling.asset_versions v ON v.id=r.version_id AND v.asset_id=a.id
      WHERE p.state='active' AND r.action<>'withdraw' AND a.lifecycle='active' AND v.processing_state='ready'
      AND EXISTS(SELECT 1 FROM shiling.publication_revision_artifacts ra WHERE ra.publication_revision_id=r.id AND ra.role='original')
      AND NOT EXISTS(SELECT 1 FROM shiling.publication_revision_artifacts ra
        JOIN shiling.artifacts art ON art.id=ra.artifact_id
        JOIN shiling.storage_objects so ON so.id=art.storage_object_id
        WHERE ra.publication_revision_id=r.id AND (so.state<>'stored' OR so.integrity_state<>'verified'))`)
    ).rows[0];
    if (!row || !Number.isSafeInteger(Number(row.count)))
      throw new Error('Invalid publication count');
    return { eligibleActiveCount: Number(row.count), evaluatedAt: row.evaluated_at.toISOString() };
  } catch {
    throw new AppError(
      503,
      'PUBLICATION_IMPACT_UNAVAILABLE',
      '无法核对公开恢复范围，请稍后重试。',
      true,
    );
  }
}
function dto(row: SettingsRow, impact: PublicationImpact, uploadMaxBytes: number): ProductSettings {
  const name = typeof row.values.name === 'string' ? row.values.name : '拾灵';
  return {
    revision: row.revision,
    name,
    brand: {
      name,
      description:
        typeof row.values.brandDescription === 'string'
          ? row.values.brandDescription
          : '收集灵感，让好素材被再次使用。',
      primaryColor:
        typeof row.values.primaryColor === 'string' &&
        /^#[0-9a-fA-F]{6}$/.test(row.values.primaryColor)
          ? row.values.primaryColor.toLowerCase()
          : '#7657c8',
      logoUrl: row.logo_branding_asset_id
        ? `/api/v1/branding/logo?v=${row.logo_branding_asset_id}`
        : null,
      faviconUrl: row.favicon_branding_asset_id
        ? `/api/v1/branding/favicon?v=${row.favicon_branding_asset_id}`
        : null,
    },
    types: TYPE_DEFINITIONS.map((definition) => ({
      ...definition,
      acceptUploads:
        definition.id !== 'web_motion' &&
        row.values.types?.[definition.id]?.acceptUploads !== false,
      executePreview: false,
      maxBytes:
        typeof row.values.types?.[definition.id]?.maxBytes === 'number'
          ? Math.min(
              row.values.types[definition.id]?.maxBytes ?? DEFAULT_MAX_BYTES[definition.id],
              effectiveTypeMaxBytes(definition.id, uploadMaxBytes),
            )
          : effectiveTypeMaxBytes(definition.id, uploadMaxBytes),
    })),
    publicEnabled: row.values.publicEnabled === true,
    executePreview: row.values.executePreview === true,
    logoBrandingAssetId: row.logo_branding_asset_id,
    faviconBrandingAssetId: row.favicon_branding_asset_id,
    publicationImpact: impact,
  };
}
function validatePatch(input: SettingsPatch, uploadMaxBytes: number): SettingsPatch {
  const keys = Object.keys(input);
  const allowed = [
    'name',
    'brand',
    'types',
    'publicEnabled',
    'executePreview',
    'logoBrandingAssetId',
    'faviconBrandingAssetId',
  ];
  if (!keys.length || keys.some((key) => !allowed.includes(key)))
    throw new AppError(400, 'INVALID_SETTINGS', '设置请求为空或包含不支持的字段。');
  const patch = { ...input };
  if (patch.name !== undefined) {
    patch.name = patch.name.normalize('NFKC').trim();
    if (
      !patch.name ||
      [...patch.name].length > 80 ||
      [...patch.name].some((character) => character.charCodeAt(0) < 32)
    )
      throw new AppError(400, 'INVALID_NAME', '实例名称应为 1 至 80 个字符。');
  }
  if (patch.brand !== undefined) {
    const name = patch.brand.name.normalize('NFKC').trim();
    const description = patch.brand.description.normalize('NFC').trim();
    const primaryColor = patch.brand.primaryColor.toLowerCase();
    if (
      !name ||
      [...name].length > 80 ||
      [...name].some((character) => character.charCodeAt(0) < 32) ||
      [...description].length > 500 ||
      !/^#[0-9a-f]{6}$/.test(primaryColor)
    )
      throw new AppError(400, 'INVALID_BRAND', '品牌名称、简介或主色格式无效。');
    patch.brand = { name, description, primaryColor };
  }
  if (patch.name !== undefined && patch.brand !== undefined && patch.name !== patch.brand.name) {
    throw new AppError(400, 'CONFLICTING_BRAND_NAME', '同时提交的平台名称与品牌名称必须一致。');
  }
  if (patch.types !== undefined) {
    const ids = patch.types.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length)
      throw new AppError(400, 'INVALID_TYPE_SETTINGS', '素材类型设置不能重复。');
    for (const entry of patch.types) {
      if (
        !TYPE_DEFINITIONS.some((definition) => definition.id === entry.id) ||
        !Number.isSafeInteger(entry.maxBytes) ||
        entry.maxBytes < 1 ||
        entry.maxBytes > effectiveTypeMaxBytes(entry.id, uploadMaxBytes)
      )
        throw new AppError(400, 'INVALID_TYPE_SETTINGS', '素材类型上限超出处理能力。');
      if (entry.id === 'web_motion' && entry.acceptUploads)
        throw new AppError(
          409,
          'PREVIEW_ISOLATION_NOT_READY',
          '动效隔离尚未通过验收，不能开启新的动效上传。',
        );
    }
  }
  for (const key of ['publicEnabled', 'executePreview'] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean')
      throw new AppError(400, 'INVALID_SETTINGS', '开关必须为布尔值。');
  }
  for (const key of ['logoBrandingAssetId', 'faviconBrandingAssetId'] as const) {
    const id = patch[key];
    if (id !== undefined && id !== null && !UUID.test(id))
      throw new AppError(400, 'INVALID_BRANDING_ASSET', '品牌候选标识无效。');
  }
  return patch;
}
async function checkBranding(
  tx: Transaction,
  id: string | null | undefined,
  purpose: 'logo' | 'favicon',
): Promise<void> {
  if (id === undefined || id === null) return;
  const result = await tx.query(
    `SELECT b.id FROM shiling.branding_assets b JOIN shiling.storage_objects s ON s.id=b.storage_object_id AND s.branding_asset_id=b.id
    WHERE b.id=$1 AND b.purpose=$2 AND b.state='verified' AND s.state='stored' AND s.integrity_state='verified' FOR SHARE OF b,s`,
    [id, purpose],
  );
  if (!result.rowCount)
    throw new AppError(409, 'BRANDING_ASSET_UNAVAILABLE', '品牌文件不存在、尚未核验或用途不匹配。');
}

export function createSettingsService({
  database,
  identity,
  uploadMaxBytes = DEFAULT_MAX_BYTES.video,
}: SettingsDependencies) {
  if (!Number.isSafeInteger(uploadMaxBytes) || uploadMaxBytes < 1)
    throw new Error('Upload maximum must be a positive safe integer.');
  async function transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await database.transaction(work);
    } catch (error) {
      return mapDatabaseError(error);
    }
  }
  return {
    async getSettings(token: string): Promise<ProductSettings> {
      return transaction(async (tx) => {
        await identity.authorize(tx, token, 'system.settings.manage');
        const row = await settingsRow(tx);
        return dto(row, await publicationImpact(tx), uploadMaxBytes);
      });
    },
    async patchSettings(
      token: string,
      input: SettingsPatch,
      expectedRevision: string | undefined,
      requestId: string,
    ): Promise<ProductSettings> {
      const patch = validatePatch(input, uploadMaxBytes);
      return transaction(async (tx) => {
        const actor = await identity.authorize(tx, token, 'system.settings.manage', true);
        const row = await settingsRow(tx, true);
        assertRevision(row.revision, expectedRevision, true);
        if (patch.executePreview === true)
          throw new AppError(
            409,
            'PREVIEW_ISOLATION_NOT_READY',
            '服务器执行隔离尚未通过验收，不能开启动效执行。',
          );
        await checkBranding(tx, patch.logoBrandingAssetId, 'logo');
        await checkBranding(tx, patch.faviconBrandingAssetId, 'favicon');
        // 必须重新计算；摘要失败时事务回滚，不能以零代替并开启公开。
        const impact = await publicationImpact(tx);
        const values = { ...row.values };
        if (patch.name !== undefined) values.name = patch.name;
        if (patch.publicEnabled !== undefined) values.publicEnabled = patch.publicEnabled;
        if (patch.executePreview !== undefined) values.executePreview = patch.executePreview;
        if (patch.brand !== undefined) {
          values.name = patch.brand.name;
          values.brandDescription = patch.brand.description;
          values.primaryColor = patch.brand.primaryColor;
        }
        if (patch.types !== undefined) {
          const next = { ...(row.values.types ?? {}) };
          for (const entry of patch.types)
            next[entry.id] = {
              acceptUploads: entry.acceptUploads,
              maxBytes: entry.maxBytes,
            };
          values.types = next;
        }
        const publicTightened = row.values.publicEnabled === true && patch.publicEnabled === false;
        const previewTightened =
          row.values.executePreview === true && patch.executePreview === false;
        const logo =
          patch.logoBrandingAssetId === undefined
            ? row.logo_branding_asset_id
            : patch.logoBrandingAssetId;
        const favicon =
          patch.faviconBrandingAssetId === undefined
            ? row.favicon_branding_asset_id
            : patch.faviconBrandingAssetId;
        // D01 不修改 publication；关闭递增代次，重开也不使旧 grant 有效。
        await tx.query(
          `UPDATE shiling.product_settings SET values=$1::jsonb,logo_branding_asset_id=$2,favicon_branding_asset_id=$3,
          public_access_epoch=public_access_epoch+CASE WHEN $4 THEN 1 ELSE 0 END,
          preview_access_epoch=preview_access_epoch+CASE WHEN $5 THEN 1 ELSE 0 END,updated_by=$6 WHERE id=1`,
          [JSON.stringify(values), logo, favicon, publicTightened, previewTightened, actor.id],
        );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'administration.settings_updated',
          resourceType: 'settings',
          resourceId: null,
          requestId,
          changes: {
            previousRevision: row.revision,
            changedFields: Object.keys(patch),
            publicAccessRevoked: publicTightened,
            previewAccessRevoked: previewTightened,
            eligibleActiveCount: impact.eligibleActiveCount,
          },
        });
        return dto(await settingsRow(tx), impact, uploadMaxBytes);
      });
    },
    async getOperationsSummary(token: string) {
      return transaction(async (tx) => {
        await identity.authorize(tx, token, 'system.operations.read');
        const settings = await settingsRow(tx);
        const jobs = (
          await tx.query<{ state: string; count: string }>(
            'SELECT state,count(*)::text count FROM shiling.processing_jobs GROUP BY state ORDER BY state',
          )
        ).rows;
        const assets = (
          await tx.query<{ lifecycle: string; count: string }>(
            'SELECT lifecycle,count(*)::text count FROM shiling.assets GROUP BY lifecycle ORDER BY lifecycle',
          )
        ).rows;
        const storage = (
          await tx.query<{
            stored_bytes: string;
            stored_objects: string;
            integrity_issues: string;
            evaluated_at: Date;
          }>(`SELECT
          COALESCE(sum(bytes) FILTER(WHERE state='stored'),0)::text stored_bytes,
          count(*) FILTER(WHERE state='stored')::text stored_objects,
          count(*) FILTER(WHERE state<>'deleted' AND integrity_state IN ('missing','corrupt'))::text integrity_issues,
          clock_timestamp() evaluated_at FROM shiling.storage_objects`)
        ).rows[0];
        if (!storage) throw new AppError(503, 'OPERATIONS_UNAVAILABLE', '运维摘要暂不可用。', true);
        // 仅提供数据库元数据摘要，不推断磁盘剩余容量、S3 健康或实际 worker 存活。
        return {
          evaluatedAt: storage.evaluated_at.toISOString(),
          database: { reachable: true },
          storage: {
            basis: 'databaseMetadata' as const,
            storedBytes: storage.stored_bytes,
            storedObjects: storage.stored_objects,
            integrityIssues: storage.integrity_issues,
          },
          jobs: jobs.map((row) => ({ state: row.state, count: row.count })),
          assets: assets.map((row) => ({ lifecycle: row.lifecycle, count: row.count })),
          publicEnabled: settings.values.publicEnabled === true,
          preview: {
            configured: settings.values.executePreview === true,
            isolationReady: false,
            executionEnabled: false,
          },
        };
      });
    },
  };
}
export type SettingsService = ReturnType<typeof createSettingsService>;
