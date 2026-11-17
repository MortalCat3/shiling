import { mapDatabaseError } from '../../errors.js';
import type { Database, Transaction } from '../../ports/database.js';
import type { StoragePort } from '../../ports/storage.js';
import { appendAudit } from './audit.js';

export interface StorageCleanupDependencies {
  database: Database;
  storage: StoragePort;
  batchSize?: number;
  staleClaimSeconds?: number;
}

export interface StorageCleanupContext {
  requestId: string;
}

export interface StorageCleanupResult {
  claimed: number;
  deleted: number;
  failed: number;
  fenced: number;
}

export class StorageCleanupRetryError extends Error {
  readonly result: StorageCleanupResult;

  constructor(result: StorageCleanupResult) {
    super('Temporary object removal failed; retry the cleanup job with backoff.');
    this.name = 'StorageCleanupRetryError';
    this.result = result;
  }
}

interface CleanupCandidate {
  id: string;
  object_key: string;
  gc_token: string;
  previous_state: 'reserved' | 'stored' | 'gc_pending';
  verified_at: Date | null;
  branding_asset_id: string | null;
}

function restoredState(candidate: CleanupCandidate): 'reserved' | 'stored' {
  return candidate.previous_state === 'stored' || candidate.verified_at !== null
    ? 'stored'
    : 'reserved';
}

async function isProtectedOrLeased(tx: Transaction, objectId: string): Promise<boolean> {
  const result = (
    await tx.query<{ blocked: boolean }>(
      `SELECT
      EXISTS(SELECT 1 FROM shiling.artifacts a WHERE a.storage_object_id=$1)
      OR EXISTS(SELECT 1 FROM shiling.package_entries p WHERE p.storage_object_id=$1)
      OR EXISTS(
        SELECT 1 FROM shiling.storage_objects so
        JOIN shiling.product_settings s ON
          s.logo_branding_asset_id=so.branding_asset_id
          OR s.favicon_branding_asset_id=so.branding_asset_id
        WHERE so.id=$1
      )
      OR EXISTS(
        SELECT 1 FROM shiling.storage_objects so
        JOIN shiling.upload_attempts u ON u.id=so.upload_attempt_id
        WHERE so.id=$1 AND u.state IN ('issued','receiving','verifying') AND u.expires_at>now()
      )
      OR EXISTS(
        SELECT 1 FROM shiling.storage_objects so
        JOIN shiling.processing_attempts p ON p.id=so.processing_attempt_id
        WHERE so.id=$1 AND p.state='running' AND p.deadline_at>now()
      )
      AS blocked`,
      [objectId],
    )
  ).rows[0];
  return result?.blocked ?? true;
}

export function createStorageCleanupService({
  database,
  storage,
  batchSize = 25,
  staleClaimSeconds = 30 * 60,
}: StorageCleanupDependencies) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 200)
    throw new Error('Storage cleanup batchSize must be between 1 and 200.');
  if (
    !Number.isSafeInteger(staleClaimSeconds) ||
    staleClaimSeconds < 5 * 60 ||
    staleClaimSeconds > 24 * 60 * 60
  )
    throw new Error('Storage cleanup staleClaimSeconds must be between 300 and 86400.');

  async function transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await database.transaction(work);
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async function claim(): Promise<CleanupCandidate[]> {
    return transaction(async (tx) => {
      const candidates = await tx.query<CleanupCandidate>(
        `WITH candidates AS (
          SELECT so.id,so.state AS previous_state,so.verified_at
          FROM shiling.storage_objects so
          WHERE so.backend_key=$1 AND so.namespace=$2
          AND so.retain_until IS NOT NULL AND so.retain_until<=now()
          AND (
            so.state IN ('reserved','stored')
            OR (so.state='gc_pending' AND so.updated_at<=now()-($4::int*interval '1 second'))
          )
          AND NOT EXISTS(SELECT 1 FROM shiling.artifacts a WHERE a.storage_object_id=so.id)
          AND NOT EXISTS(SELECT 1 FROM shiling.package_entries p WHERE p.storage_object_id=so.id)
          AND NOT EXISTS(
            SELECT 1 FROM shiling.product_settings s
            WHERE s.logo_branding_asset_id=so.branding_asset_id
               OR s.favicon_branding_asset_id=so.branding_asset_id
          )
          AND NOT EXISTS(
            SELECT 1 FROM shiling.upload_attempts u
            WHERE u.id=so.upload_attempt_id
              AND u.state IN ('issued','receiving','verifying') AND u.expires_at>now()
          )
          AND NOT EXISTS(
            SELECT 1 FROM shiling.processing_attempts p
            WHERE p.id=so.processing_attempt_id AND p.state='running' AND p.deadline_at>now()
          )
          ORDER BY so.retain_until,so.id
          FOR UPDATE OF so SKIP LOCKED
          LIMIT $3
        )
        UPDATE shiling.storage_objects so
        SET state='gc_pending',gc_token=gen_random_uuid()
        FROM candidates c WHERE so.id=c.id
        RETURNING so.id,so.object_key,so.gc_token,c.previous_state,c.verified_at,so.branding_asset_id`,
        [storage.backendKey, storage.namespace, batchSize, staleClaimSeconds],
      );
      return candidates.rows;
    });
  }

  async function release(candidate: CleanupCandidate): Promise<void> {
    await transaction(async (tx) => {
      await tx.query(
        `UPDATE shiling.storage_objects
         SET state=$3,gc_token=NULL
         WHERE id=$1 AND state='gc_pending' AND gc_token=$2`,
        [candidate.id, candidate.gc_token, restoredState(candidate)],
      );
    });
  }

  async function finalize(
    candidate: CleanupCandidate,
    context: StorageCleanupContext,
  ): Promise<'deleted' | 'fenced'> {
    return transaction(async (tx) => {
      const current = (
        await tx.query<{ state: string; gc_token: string | null }>(
          'SELECT state,gc_token FROM shiling.storage_objects WHERE id=$1 FOR UPDATE',
          [candidate.id],
        )
      ).rows[0];
      if (!current || current.state !== 'gc_pending' || current.gc_token !== candidate.gc_token)
        return 'fenced';
      if (await isProtectedOrLeased(tx, candidate.id)) {
        await tx.query(
          `UPDATE shiling.storage_objects
           SET state=$2,integrity_state='missing',gc_token=NULL
           WHERE id=$1`,
          [candidate.id, restoredState(candidate)],
        );
        return 'fenced';
      }
      await tx.query(
        `UPDATE shiling.storage_objects
         SET state='deleted',deleted_at=now(),gc_token=NULL
         WHERE id=$1`,
        [candidate.id],
      );
      if (candidate.branding_asset_id)
        await tx.query(
          `UPDATE shiling.branding_assets
           SET state='failed',failure_code='UNREFERENCED_OBJECT_RECLAIMED'
           WHERE id=$1 AND state IN ('receiving','verifying','verified')`,
          [candidate.branding_asset_id],
        );
      await appendAudit(tx, {
        actorId: null,
        action: 'administration.storage_object_reclaimed',
        resourceType: 'storage_object',
        resourceId: candidate.id,
        requestId: context.requestId,
        changes: { backendKey: storage.backendKey, namespace: storage.namespace },
      });
      return 'deleted';
    });
  }

  return {
    async runOnce(context: StorageCleanupContext): Promise<StorageCleanupResult> {
      const candidates = await claim();
      const result: StorageCleanupResult = {
        claimed: candidates.length,
        deleted: 0,
        failed: 0,
        fenced: 0,
      };
      for (const candidate of candidates) {
        try {
          await storage.remove(candidate.object_key);
        } catch {
          result.failed += 1;
          await release(candidate);
          continue;
        }
        const final = await finalize(candidate, context);
        if (final === 'deleted') result.deleted += 1;
        else result.fenced += 1;
      }
      return result;
    },
    async runUntilDrained(
      context: StorageCleanupContext,
      maxBatches = 10,
    ): Promise<StorageCleanupResult> {
      if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 100)
        throw new Error('Storage cleanup maxBatches must be between 1 and 100.');
      const totals: StorageCleanupResult = { claimed: 0, deleted: 0, failed: 0, fenced: 0 };
      for (let index = 0; index < maxBatches; index += 1) {
        const result = await this.runOnce(context);
        totals.claimed += result.claimed;
        totals.deleted += result.deleted;
        totals.failed += result.failed;
        totals.fenced += result.fenced;
        // runOnce has already released failed claims. Stop immediately so pg-boss, rather than
        // this hot loop, owns retry delay and backoff.
        if (result.failed > 0) throw new StorageCleanupRetryError(totals);
        if (result.claimed < batchSize) break;
      }
      return totals;
    },
  };
}

export type StorageCleanupService = ReturnType<typeof createStorageCleanupService>;
