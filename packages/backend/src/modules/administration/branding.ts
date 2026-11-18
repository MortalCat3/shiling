import { requireStorageLocation } from '../../storage/binding.js';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AppError, mapDatabaseError } from '../../errors.js';
import type { Database, Transaction } from '../../ports/database.js';
import type { StoragePort } from '../../ports/storage.js';
import type { IdentityService } from '../identity/service.js';
import { appendAudit } from './audit.js';

export type BrandingPurpose = 'logo' | 'favicon';

export interface BrandingCandidateInput {
  readonly purpose: BrandingPurpose;
  readonly source: AsyncIterable<Uint8Array>;
  readonly mediaType: 'image/png';
  readonly width: number;
  readonly height: number;
  readonly expectedBytes: number;
}

export interface BrandingDependencies {
  readonly database: Database;
  readonly identity: IdentityService;
  readonly storage: StoragePort;
  readonly candidateRetentionSeconds: number;
}

export interface OpenedBrandingAsset {
  readonly stream: Readable;
  readonly bytes: number;
  readonly mediaType: string;
  readonly sha256: string;
}

const MAX_NORMALIZED_BYTES = 8 * 1024 * 1024;

function validate(input: BrandingCandidateInput): void {
  const maxDimension = input.purpose === 'favicon' ? 512 : 1024;
  if (
    input.mediaType !== 'image/png' ||
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 1 ||
    input.height < 1 ||
    input.width > maxDimension ||
    input.height > maxDimension ||
    !Number.isSafeInteger(input.expectedBytes) ||
    input.expectedBytes < 1 ||
    input.expectedBytes > MAX_NORMALIZED_BYTES
  ) {
    throw new AppError(400, 'INVALID_BRANDING_ASSET', '品牌图片规格无效。');
  }
}

export function createBrandingService({
  database,
  identity,
  storage,
  candidateRetentionSeconds,
}: BrandingDependencies) {
  if (
    !Number.isSafeInteger(candidateRetentionSeconds) ||
    candidateRetentionSeconds < 60 * 60 ||
    candidateRetentionSeconds > 30 * 24 * 60 * 60
  ) {
    throw new Error('Branding candidate retention must be between 1 hour and 30 days.');
  }
  async function transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await database.transaction(work);
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  return {
    async assertCanCreate(token: string): Promise<void> {
      await transaction(async (tx) => {
        await identity.authorize(tx, token, 'system.settings.manage', true);
      });
    },

    async createCandidate(
      token: string,
      input: BrandingCandidateInput,
      requestId: string,
    ): Promise<{ brandingAssetId: string }> {
      validate(input);
      const brandingAssetId = randomUUID();
      const storageObjectId = randomUUID();
      const extension = 'png';
      const objectKey = `branding/${input.purpose}/${brandingAssetId}.${extension}`;

      await transaction(async (tx) => {
        const actor = await identity.authorize(tx, token, 'system.settings.manage', true);
        await tx.query(
          `INSERT INTO shiling.branding_assets
          (id,uploader_id,purpose,state,media_type,width,height,bytes)
          VALUES($1,$2,$3,'receiving',$4,$5,$6,$7)`,
          [
            brandingAssetId,
            actor.id,
            input.purpose,
            input.mediaType,
            input.width,
            input.height,
            input.expectedBytes,
          ],
        );
        await tx.query(
          `INSERT INTO shiling.storage_objects
          (id,branding_asset_id,backend_key,namespace,object_key,state,integrity_state,retain_until)
          VALUES($1,$2,$3,$4,$5,'reserved','pending',now()+($6::int*interval '1 second'))`,
          [
            storageObjectId,
            brandingAssetId,
            storage.backendKey,
            storage.namespace,
            objectKey,
            candidateRetentionSeconds,
          ],
        );
        await tx.query(
          `UPDATE shiling.branding_assets
          SET state='verifying',storage_object_id=$2 WHERE id=$1`,
          [brandingAssetId, storageObjectId],
        );
      });

      try {
        const stored = await storage.put(objectKey, input.source, {
          maxBytes: MAX_NORMALIZED_BYTES,
          expectedBytes: input.expectedBytes,
        });
        await transaction(async (tx) => {
          const actor = await identity.authorize(tx, token, 'system.settings.manage', true);
          const candidate = (
            await tx.query<{ state: string }>(
              'SELECT state FROM shiling.branding_assets WHERE id=$1 FOR UPDATE',
              [brandingAssetId],
            )
          ).rows[0];
          if (!candidate || candidate.state !== 'verifying') {
            throw new AppError(409, 'BRANDING_ASSET_STATE_CHANGED', '品牌图片状态已经变化。');
          }
          const storedObject = await tx.query(
            `UPDATE shiling.storage_objects SET state='stored',integrity_state='verified',
            bytes=$2,sha256=$3,verified_at=now() WHERE id=$1 AND state='reserved' RETURNING id`,
            [storageObjectId, stored.bytes, stored.sha256],
          );
          if (!storedObject.rowCount) {
            throw new AppError(409, 'BRANDING_ASSET_STATE_CHANGED', '品牌图片状态已经变化。');
          }
          await tx.query(
            `UPDATE shiling.branding_assets SET state='verified',media_type=$2,width=$3,height=$4,
            bytes=$5,sha256=$6,failure_code=NULL WHERE id=$1`,
            [
              brandingAssetId,
              input.mediaType,
              input.width,
              input.height,
              stored.bytes,
              stored.sha256,
            ],
          );
          await appendAudit(tx, {
            actorId: actor.id,
            action: 'administration.branding_asset_verified',
            resourceType: 'branding_asset',
            resourceId: brandingAssetId,
            requestId,
            changes: {
              purpose: input.purpose,
              mediaType: input.mediaType,
              width: input.width,
              height: input.height,
              bytes: stored.bytes,
            },
          });
        });
        return { brandingAssetId };
      } catch (error) {
        await database
          .transaction(async (tx) => {
            await tx.query(
              `UPDATE shiling.storage_objects SET
              retain_until=now()
              WHERE id=$1 AND state IN ('reserved','stored')`,
              [storageObjectId],
            );
            const failed = (
              await tx.query<{ uploader_id: string }>(
                `UPDATE shiling.branding_assets SET state='failed',failure_code='BRANDING_UPLOAD_FAILED'
              WHERE id=$1 AND state<>'verified' RETURNING uploader_id`,
                [brandingAssetId],
              )
            ).rows[0];
            if (failed) {
              await appendAudit(tx, {
                actorId: failed.uploader_id,
                action: 'administration.branding_asset_upload_failed',
                resourceType: 'branding_asset',
                resourceId: brandingAssetId,
                requestId,
                outcome: 'failed',
                changes: {
                  purpose: input.purpose,
                  failureCode: 'BRANDING_UPLOAD_FAILED',
                },
              });
            }
          })
          .catch(() => undefined);
        if (error instanceof AppError) throw error;
        throw new AppError(
          503,
          'BRANDING_STORAGE_FAILED',
          '品牌图片暂时无法保存，请稍后重试。',
          true,
        );
      }
    },

    async openActive(purpose: BrandingPurpose): Promise<OpenedBrandingAsset> {
      const row = (
        await database.query<{
          object_key: string;
          backend_key: string;
          namespace: string;
          media_type: string;
          bytes: string;
          sha256: string;
        }>(
          `SELECT so.object_key,so.backend_key,so.namespace,b.media_type,so.bytes::text bytes,so.sha256
          FROM shiling.product_settings ps
          JOIN shiling.branding_assets b ON b.id=CASE WHEN $1::text='logo'
            THEN ps.logo_branding_asset_id ELSE ps.favicon_branding_asset_id END
          JOIN shiling.storage_objects so ON so.id=b.storage_object_id AND so.branding_asset_id=b.id
          WHERE ps.id=1 AND b.purpose=$1::text AND b.state='verified'
          AND so.state='stored' AND so.integrity_state='verified'`,
          [purpose],
        )
      ).rows[0];
      if (!row) throw new AppError(404, 'BRANDING_ASSET_NOT_FOUND', '品牌图片不存在。');
      requireStorageLocation(storage, row);
      const opened = await storage.open(row.object_key);
      if (opened.bytes !== Number(row.bytes)) {
        opened.stream.destroy();
        throw new AppError(409, 'BRANDING_ASSET_UNAVAILABLE', '品牌图片完整性异常。');
      }
      return {
        stream: opened.stream,
        bytes: opened.bytes,
        mediaType: row.media_type,
        sha256: row.sha256,
      };
    },
  };
}

export type BrandingService = ReturnType<typeof createBrandingService>;
