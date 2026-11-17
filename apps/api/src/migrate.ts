import { createDatabase, runMigrations, runQueueMigrations } from '@shiling/backend';
import { readMigrationConfig } from './config.js';

async function main(): Promise<void> {
  const config = readMigrationConfig();
  const database = createDatabase({
    connectionString: config.databaseUrl,
    applicationName: 'shiling-migrate',
    maxConnections: 1,
  });
  try {
    const result = await runMigrations(database, {
      ...(config.ownerRole === null ? {} : { ownerRole: config.ownerRole }),
    });
    if (config.ownerRole === null) {
      throw new Error('SHILING_DATABASE_OWNER_ROLE is required for queue migrations.');
    }
    const queueResult = await runQueueMigrations({
      connectionString: config.databaseUrl,
      ownerRole: config.ownerRole,
      runtimeRole: config.runtimeRole,
    });
    console.info(
      JSON.stringify({
        event: 'database.migrated',
        applied: result.applied,
        queueSchemaVersion: queueResult.schemaVersion,
        queues: queueResult.queues,
      }),
    );
  } finally {
    await database.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Database migration failed.');
  process.exitCode = 1;
});
