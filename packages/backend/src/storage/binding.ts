import { AppError } from '../errors.js';
import type { Queryable } from '../ports/database.js';
import type { StoragePort } from '../ports/storage.js';

export interface StorageLocation {
  backend_key: string;
  namespace: string;
}
export function requireStorageLocation(storage: StoragePort, location: StorageLocation): void {
  if (storage.backendKey !== location.backend_key || storage.namespace !== location.namespace)
    throw new AppError(503, 'STORAGE_LOCATION_MISMATCH', '存储位置与数据库记录不一致。');
}

export async function assertStorageBinding(
  database: Queryable,
  storage: StoragePort,
): Promise<void> {
  const mismatch = await database.query(
    `SELECT 1 FROM shiling.storage_objects WHERE state <> 'deleted'
     AND (backend_key <> $1 OR namespace <> $2) LIMIT 1`,
    [storage.backendKey, storage.namespace],
  );
  if (mismatch.rows.length)
    throw new AppError(
      503,
      'STORAGE_LOCATION_MISMATCH',
      '存储位置与数据库记录不一致；请执行完整迁移或恢复。',
    );
}
