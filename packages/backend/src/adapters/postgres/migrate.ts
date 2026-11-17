import { createHash } from 'node:crypto';
import type { Database } from '../../ports/database.js';
import { identitySettingsSql } from './migrations/0001-identity-settings.js';
import { assetsIngestionSql } from './migrations/0002-assets-ingestion-processing-storage.js';
import { libraryPublicationSql } from './migrations/0003-library-publication.js';
import { systemOperationsSql } from './migrations/0004-system-operations.js';

export const MIGRATIONS = [
  { id: '0001_identity_settings', sql: identitySettingsSql },
  { id: '0002_assets_ingestion_processing_storage', sql: assetsIngestionSql },
  { id: '0003_library_publication', sql: libraryPublicationSql },
  { id: '0004_system_operations', sql: systemOperationsSql },
] as const;

/** Explicit CLI operation only. Creating an API/worker never runs migrations. */
export async function runMigrations(
  database: Database,
  options: { ownerRole?: string } = {},
): Promise<{ applied: string[] }> {
  if (options.ownerRole !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(options.ownerRole))
    throw new Error('数据库 ownerRole 必须是有效的小写 PostgreSQL 角色标识。');
  return database.transaction(async (transaction) => {
    if (options.ownerRole) await transaction.query(`SET LOCAL ROLE "${options.ownerRole}"`);
    await transaction.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('shiling:schema-migrations',0))`,
    );
    await transaction.query(`CREATE SCHEMA IF NOT EXISTS shiling`);
    await transaction.query(
      `CREATE TABLE IF NOT EXISTS shiling.schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const existing = await transaction.query<{ id: string; checksum: string }>(
      `SELECT id,checksum FROM shiling.schema_migrations ORDER BY id`,
    );
    if (existing.rows.some((row) => !MIGRATIONS.some((migration) => migration.id === row.id)))
      throw new Error('数据库含当前程序不认识的迁移版本，拒绝降级写入。');
    const applied: string[] = [];
    for (const migration of MIGRATIONS) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const prior = existing.rows.find((row) => row.id === migration.id);
      if (prior) {
        if (prior.checksum !== checksum)
          throw new Error(`迁移 ${migration.id} 的校验和发生变化，请新增迁移而非修改历史。`);
        continue;
      }
      if (existing.rows.some((row) => row.id > migration.id))
        throw new Error('数据库迁移顺序不完整。');
      await transaction.query(migration.sql);
      await transaction.query(`INSERT INTO shiling.schema_migrations(id,checksum) VALUES($1,$2)`, [
        migration.id,
        checksum,
      ]);
      applied.push(migration.id);
    }
    return { applied };
  });
}

export async function checkDatabaseReady(database: Database): Promise<boolean> {
  try {
    const result = await database.query<{ id: string; checksum: string }>(
      'SELECT id,checksum FROM shiling.schema_migrations ORDER BY id',
    );
    return (
      result.rows.length === MIGRATIONS.length &&
      MIGRATIONS.every((migration, index) => {
        const existing = result.rows[index];
        return (
          existing?.id === migration.id &&
          existing.checksum === createHash('sha256').update(migration.sql).digest('hex')
        );
      })
    );
  } catch {
    return false;
  }
}
