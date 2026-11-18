import { readFile } from 'node:fs/promises';
import OSS from 'ali-oss';
import { createLocalStorage } from '../adapters/local/storage.js';
import { createOssStorage, type OssClient } from '../adapters/oss/storage.js';
import type { StoragePort } from '../ports/storage.js';
import type { StorageConfig } from './config.js';

async function credentials(
  file: string,
): Promise<{ accessKeyId: string; accessKeySecret: string; stsToken?: string }> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof value !== 'object' || value === null) throw new Error();
    const record = value as Record<string, unknown>;
    for (const key of ['accessKeyId', 'accessKeySecret'])
      if (typeof record[key] !== 'string' || !record[key].trim()) throw new Error();
    if (
      record['stsToken'] !== undefined &&
      (typeof record['stsToken'] !== 'string' || !record['stsToken'].trim())
    )
      throw new Error();
    return {
      accessKeyId: record['accessKeyId'] as string,
      accessKeySecret: record['accessKeySecret'] as string,
      ...(typeof record['stsToken'] === 'string' ? { stsToken: record['stsToken'] } : {}),
    };
  } catch {
    throw new Error('OSS credentials file is missing or invalid.');
  }
}

export async function createStorage(config: StorageConfig): Promise<StoragePort> {
  if (config.driver === 'local') return createLocalStorage(config);
  const auth = await credentials(config.credentialsFile);
  const client = new OSS({
    ...auth,
    region: config.region,
    bucket: config.bucket,
    endpoint: config.endpoint,
    secure: true,
    authorizationV4: true,
    timeout: 30000,
    // Operators may atomically replace the file to rotate STS credentials without a restart.
    ...(auth.stsToken
      ? {
          refreshSTSToken: async () => {
            const next = await credentials(config.credentialsFile);
            if (!next.stsToken) throw new Error('OSS STS rotation requires stsToken.');
            return { ...next, stsToken: next.stsToken };
          },
          refreshSTSTokenInterval: 60000,
        }
      : {}),
  }) as OSS & OssClient;
  return createOssStorage({ ...config, client });
}
