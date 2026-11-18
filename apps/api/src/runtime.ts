import {
  checkDatabaseReady,
  createAssetService,
  createBrandingService,
  createDatabase,
  createIdentityService,
  createIngestionService,
  createLibraryService,
  createStorage,
  type StoragePort,
  assertStorageBinding,
  createOperationsService,
  createPublicationService,
  createSettingsService,
  createTaskQueue,
  type AssetService,
  type BrandingService,
  type Database,
  type IdentityService,
  type IngestionService,
  type LibraryService,
  type OperationsService,
  type PublicationService,
  type SettingsService,
} from '@shiling/backend';
import { PgBoss } from 'pg-boss';
import type { ApiConfig } from './config.js';

export interface ApiRuntime {
  readonly database: Database;
  readonly identity: IdentityService;
  readonly ingestion: IngestionService;
  readonly assets: AssetService;
  readonly branding: BrandingService;
  readonly publication: PublicationService;
  readonly library: LibraryService;
  readonly settings: SettingsService;
  readonly operations: OperationsService;
  checkReady(): Promise<{ database: boolean; queue: boolean; storage: boolean }>;
  close(): Promise<void>;
}

export async function createApiRuntime(
  config: ApiConfig,
  storageOverride?: StoragePort,
): Promise<ApiRuntime> {
  const database = createDatabase({
    connectionString: config.databaseUrl,
    applicationName: 'shiling-api',
    maxConnections: 12,
  });
  const identity = createIdentityService(database, {
    setupToken: config.setupToken,
    csrfSecret: config.csrfSecret,
    sessionTtlSeconds: config.sessionTtlSeconds,
    freshAuthSeconds: 10 * 60,
    invitationTtlSeconds: 24 * 60 * 60,
    recoveryTtlSeconds: 15 * 60,
  });
  const storage = await (
    storageOverride ? Promise.resolve(storageOverride) : createStorage(config.storage)
  ).catch(async (error: unknown) => {
    await database.close();
    throw error;
  });
  await assertStorageBinding(database, storage).catch(async (error: unknown) => {
    await database.close();
    throw error;
  });
  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    schema: 'pgboss',
    application_name: 'shiling-api-queue',
    max: 6,
    migrate: false,
    createSchema: false,
    schedule: false,
    supervise: false,
    reindex: false,
    registerInstance: true,
    instanceName: 'shiling-api',
    openTelemetry: { enabled: false },
  });
  let queueHealthy = true;
  boss.on('error', (error: unknown) => {
    queueHealthy = false;
    console.error(
      JSON.stringify({
        service: 'api',
        event: 'queue.error',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
  });
  boss.on('warning', () => {
    console.warn(JSON.stringify({ service: 'api', event: 'queue.warning' }));
  });
  try {
    await boss.start({ attempts: 3 });
  } catch (error) {
    await boss.stop({ close: true, graceful: false, timeout: 2_000 }).catch(() => undefined);
    await database.close();
    throw error;
  }
  const queue = createTaskQueue(boss);
  const ingestion = createIngestionService({
    database,
    identity,
    storage,
    queue,
    uploadMaxBytes: config.uploadMaxBytes,
    temporaryObjectRetentionSeconds: config.temporaryObjectRetentionSeconds,
  });
  const assets = createAssetService({
    database,
    identity,
    storage,
    deliverySecret: config.deliverySecret,
    grantTtlSeconds: config.deliveryGrantTtlSeconds,
  });
  const branding = createBrandingService({
    database,
    identity,
    storage,
    candidateRetentionSeconds: config.temporaryObjectRetentionSeconds,
  });
  const publication = createPublicationService({
    database,
    identity,
    storage,
    deliverySecret: config.deliverySecret,
    grantTtlSeconds: config.deliveryGrantTtlSeconds,
  });
  const library = createLibraryService({ database, identity, assets });
  const settings = createSettingsService({
    database,
    identity,
    uploadMaxBytes: config.uploadMaxBytes,
  });
  const operations = createOperationsService({ database, identity, queue });
  return {
    database,
    identity,
    ingestion,
    assets,
    branding,
    publication,
    library,
    settings,
    operations,
    async checkReady() {
      const databaseReady = await checkDatabaseReady(database);
      const queueReady =
        queueHealthy && (await boss.isInstalled()) && (await boss.schemaVersion()) !== null;
      const storageReady = await (storage.checkReady?.() ?? Promise.resolve(true)).catch(
        () => false,
      );
      return { database: databaseReady, queue: queueReady, storage: storageReady };
    },
    async close() {
      await boss.stop({ close: true, graceful: true, timeout: 10_000 }).catch(() => undefined);
      await database.close();
    },
  };
}
