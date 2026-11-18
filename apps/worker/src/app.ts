import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import {
  TASK_NAMES,
  createStorageCleanupService,
  createDatabase,
  createStorage,
  type StoragePort,
  assertStorageBinding,
  createProcessingService,
  createTaskQueue,
  type MediaArtifactOutput,
  type MediaProcessor,
  type CleanupTask,
  type ProcessingTask,
  type VerificationTask,
} from '@shiling/backend';
import {
  inspectMedia,
  processMedia,
  type ArtifactRole,
  type MediaInspection as ProcessorInspection,
} from '@shiling/media';
import { PgBoss } from 'pg-boss';
import type { WorkerConfig } from './config.js';

export interface WorkerRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
}

const roleMap: Readonly<Record<ArtifactRole, MediaArtifactOutput['role']>> = Object.freeze({
  thumbnail: 'thumbnail',
  preview: 'preview_image',
  poster: 'poster',
  playback: 'playback_video',
  manifest: 'motion_manifest',
});

function inspectionMetadata(inspection: ProcessorInspection): Record<string, unknown> {
  return { ...inspection.metadata };
}

function createMediaProcessor(): MediaProcessor {
  return {
    async verify(input) {
      const inspection = await inspectMedia(input);
      return {
        type: inspection.type,
        mediaType: inspection.mediaType,
        bytes: inspection.bytes,
        sha256: inspection.sha256,
        metadata: inspectionMetadata(inspection),
      };
    },
    async process(input) {
      const result = await processMedia(input);
      return {
        metadata: { ...result.metadata },
        artifacts: result.artifacts.map((artifact) => ({
          role: roleMap[artifact.role],
          filePath: artifact.filePath,
          mediaType: artifact.contentType,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          metadata: {
            schemaVersion: 1,
            width: artifact.width,
            height: artifact.height,
            durationMs: artifact.durationMs,
          },
        })),
      };
    },
  };
}

export async function createWorkerRuntime(
  config: WorkerConfig,
  storageOverride?: StoragePort,
): Promise<WorkerRuntime> {
  await mkdir(config.temporaryDirectory, { recursive: true, mode: 0o700 });
  const workerInstance = randomUUID();
  const database = createDatabase({
    connectionString: config.databaseUrl,
    applicationName: 'shiling-worker-domain',
    maxConnections: Math.max(4, config.verificationConcurrency + config.processingConcurrency + 2),
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
    application_name: 'shiling-worker-queue',
    max: Math.max(4, config.verificationConcurrency + config.processingConcurrency + 2),
    migrate: false,
    createSchema: false,
    schedule: false,
    supervise: true,
    reindex: false,
    registerInstance: true,
    instanceName: `shiling-worker-${workerInstance.slice(0, 8)}`,
    openTelemetry: { enabled: false },
  });
  boss.on('error', (error: unknown) => {
    console.error(
      JSON.stringify({
        service: 'worker',
        event: 'queue.error',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
  });
  boss.on('warning', () => {
    console.warn(JSON.stringify({ service: 'worker', event: 'queue.warning' }));
  });
  const processing = createProcessingService({
    database,
    storage,
    queue: createTaskQueue(boss),
    media: createMediaProcessor(),
    temporaryDirectory: config.temporaryDirectory,
    temporaryObjectRetentionSeconds: config.temporaryObjectRetentionSeconds,
  });
  const cleanup = createStorageCleanupService({
    database,
    storage,
    batchSize: config.cleanupBatchSize,
  });
  let started = false;
  let closed = false;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;

  async function submitCleanup(reason: CleanupTask['reason']): Promise<void> {
    if (closed) return;
    try {
      await boss.send(
        TASK_NAMES.cleanup,
        { reason },
        {
          singletonKey: 'storage-cleanup',
          singletonSeconds: config.cleanupIntervalSeconds,
          retryLimit: 3,
          retryDelay: 30,
          retryBackoff: true,
          expireInSeconds: 15 * 60,
        },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          service: 'worker',
          event: 'cleanup.enqueue_failed',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    }
  }

  return {
    async start() {
      if (started) return;
      await boss.start({ attempts: 3 });
      await boss.work<VerificationTask>(
        TASK_NAMES.verify,
        {
          batchSize: 1,
          localConcurrency: config.verificationConcurrency,
          pollingIntervalSeconds: 1,
        },
        async (jobs) => {
          for (const job of jobs) {
            await processing.verifyUpload(job.data, {
              requestId: randomUUID(),
              workerInstance,
            });
          }
        },
      );
      await boss.work<ProcessingTask>(
        TASK_NAMES.process,
        {
          batchSize: 1,
          localConcurrency: config.processingConcurrency,
          pollingIntervalSeconds: 1,
        },
        async (jobs) => {
          for (const job of jobs) {
            await processing.processJob(job.data, {
              requestId: randomUUID(),
              workerInstance,
            });
          }
        },
      );
      await boss.work<CleanupTask>(
        TASK_NAMES.cleanup,
        { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 },
        async (jobs) => {
          for (const job of jobs) {
            try {
              const temporary = storage.sweepTemporaryFiles
                ? await storage.sweepTemporaryFiles({
                    olderThan: new Date(
                      Date.now() - config.temporaryObjectRetentionSeconds * 1_000,
                    ),
                    limit: Math.min(config.cleanupBatchSize * 10, 10_000),
                  })
                : { deleted: 0, failed: 0 };
              if (temporary.failed > 0)
                throw new Error('Temporary storage sweep failed; retry with queue backoff.');
              const totals = await cleanup.runUntilDrained({ requestId: randomUUID() }, 10);
              console.info(
                JSON.stringify({
                  service: 'worker',
                  event: 'cleanup.completed',
                  reason: job.data.reason,
                  temporaryFilesDeleted: temporary.deleted,
                  ...totals,
                }),
              );
            } catch (error) {
              console.warn(
                JSON.stringify({
                  service: 'worker',
                  event: 'cleanup.retry_requested',
                  reason: job.data.reason,
                  errorType: error instanceof Error ? error.name : 'UnknownError',
                }),
              );
              throw error;
            }
          }
        },
      );
      await submitCleanup('startup');
      cleanupTimer = setInterval(
        () => void submitCleanup('periodic'),
        config.cleanupIntervalSeconds * 1_000,
      );
      cleanupTimer.unref();
      started = true;
      console.info(
        JSON.stringify({
          service: 'worker',
          event: 'worker.ready',
          queues: [TASK_NAMES.verify, TASK_NAMES.process, TASK_NAMES.cleanup],
        }),
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      if (cleanupTimer) clearInterval(cleanupTimer);
      await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
      await database.close();
      console.info(JSON.stringify({ service: 'worker', event: 'worker.stopped' }));
    },
  };
}
