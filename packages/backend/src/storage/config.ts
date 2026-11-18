import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

export type StorageConfig =
  | { driver: 'local'; rootDirectory: string; namespace: string }
  | {
      driver: 'oss';
      region: string;
      bucket: string;
      endpoint: string;
      prefix: string;
      namespace: string;
      credentialsFile: string;
      temporaryDirectory: string;
      maxObjectBytes: number;
    };

function path(env: NodeJS.ProcessEnv, value: string): string {
  const base = env['INIT_CWD'] ?? process.cwd();
  if (!isAbsolute(base)) throw new Error('INIT_CWD must be absolute.');
  return resolve(base, value);
}

export function readStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const driver = env['SHILING_STORAGE_DRIVER'] ?? 'local';
  if (driver === 'local')
    return {
      driver,
      rootDirectory: path(env, env['SHILING_LOCAL_STORAGE_ROOT'] ?? './data/storage'),
      namespace: 'primary',
    };
  if (driver !== 'oss') throw new Error('SHILING_STORAGE_DRIVER must be local or oss.');
  const region = env['SHILING_OSS_REGION'] ?? '';
  const bucket = env['SHILING_OSS_BUCKET'] ?? '';
  const prefix = env['SHILING_OSS_PREFIX'] ?? '';
  const credentialsFile = env['SHILING_OSS_CREDENTIALS_FILE'];
  if (!/^oss-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region))
    throw new Error('SHILING_OSS_REGION must be an OSS region, such as oss-cn-hangzhou.');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
    throw new Error('SHILING_OSS_BUCKET must be a valid dedicated bucket name.');
  if (prefix.length > 160 || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/$/.test(prefix))
    throw new Error('SHILING_OSS_PREFIX must be a non-root prefix ending with /.');
  const endpoint = env['SHILING_OSS_ENDPOINT'] ?? `https://${region}.aliyuncs.com`;
  if (
    ![`https://${region}.aliyuncs.com`, `https://${region}-internal.aliyuncs.com`].includes(
      endpoint,
    )
  )
    throw new Error('SHILING_OSS_ENDPOINT must be the regional HTTPS OSS endpoint.');
  if (!credentialsFile) throw new Error('SHILING_OSS_CREDENTIALS_FILE must be configured.');
  const maxObjectBytes = Number(env['SHILING_OSS_MAX_OBJECT_BYTES'] ?? 2 * 1024 ** 3);
  if (
    !Number.isSafeInteger(maxObjectBytes) ||
    maxObjectBytes < 1024 ||
    maxObjectBytes > 10 * 1024 ** 3
  )
    throw new Error('SHILING_OSS_MAX_OBJECT_BYTES must be between 1024 and 10737418240.');
  // Network endpoint changes (public/internal) do not change the storage location.
  const namespace = `oss-${createHash('sha256').update(`${region}\n${bucket}\n${prefix}`).digest('hex')}`;
  return {
    driver,
    region,
    bucket,
    endpoint,
    prefix,
    namespace,
    credentialsFile: path(env, credentialsFile),
    temporaryDirectory: path(env, env['SHILING_OSS_TEMP_ROOT'] ?? './data/oss-tmp'),
    maxObjectBytes,
  };
}
