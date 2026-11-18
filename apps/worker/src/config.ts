import { readStorageConfig, type StorageConfig } from '@shiling/backend';
import { isAbsolute, resolve } from 'node:path';

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly storage: StorageConfig;
  readonly temporaryDirectory: string;
  readonly verificationConcurrency: number;
  readonly processingConcurrency: number;
  readonly temporaryObjectRetentionSeconds: number;
  readonly cleanupIntervalSeconds: number;
  readonly cleanupBatchSize: number;
}

function configuredPath(env: NodeJS.ProcessEnv, value: string): string {
  if (isAbsolute(value)) return value;
  const base = env['INIT_CWD'] ?? process.cwd();
  if (!isAbsolute(base)) throw new Error('INIT_CWD must be an absolute path when configured.');
  return resolve(base, value);
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (
    !/^[1-9][0-9]*$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function dedicatedDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = env['SHILING_DATABASE_URL'];
  if (value === undefined) throw new Error('SHILING_DATABASE_URL must be configured.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SHILING_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !/^shiling(?:_[a-z0-9_]+)?$/.test(databaseName) ||
    !url.username
  ) {
    throw new Error('SHILING_DATABASE_URL must select a dedicated shiling database and role.');
  }
  return value;
}

export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const rawTemporaryDirectory = env['SHILING_MEDIA_TEMP_ROOT'] ?? './data/tmp';
  return Object.freeze({
    databaseUrl: dedicatedDatabaseUrl(env),
    storage: readStorageConfig(env),
    temporaryDirectory: configuredPath(env, rawTemporaryDirectory),
    verificationConcurrency: positiveInteger(env, 'SHILING_VERIFY_CONCURRENCY', 2, 1, 32),
    processingConcurrency: positiveInteger(env, 'SHILING_PROCESS_CONCURRENCY', 2, 1, 16),
    temporaryObjectRetentionSeconds:
      positiveInteger(env, 'SHILING_TEMP_OBJECT_RETENTION_HOURS', 24, 1, 24 * 30) * 3_600,
    cleanupIntervalSeconds: positiveInteger(
      env,
      'SHILING_CLEANUP_INTERVAL_SECONDS',
      15 * 60,
      60,
      24 * 60 * 60,
    ),
    cleanupBatchSize: positiveInteger(env, 'SHILING_CLEANUP_BATCH_SIZE', 25, 1, 200),
  });
}
