import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Database, Queryable } from '../ports/database.js';
import type { StoragePort } from '../ports/storage.js';
import { runRestoreSafety } from '../modules/administration/restore-safety.js';
import { assertStorageBinding } from './binding.js';

interface Entry {
  id: string;
  backend_key: string;
  namespace: string;
  object_key: string;
  state: string;
  bytes: string | null;
  sha256: string | null;
}
interface Manifest {
  version: 1;
  backendKey: string;
  namespace: string;
  ledgerSha256: string;
  objects: { id: string; key: string; bytes: number; sha256: string }[];
}

async function stopped(database: Queryable): Promise<void> {
  const result = await database.query<{ count: string }>(
    `SELECT count(*)::text count FROM pg_stat_activity WHERE datname=current_database()
     AND backend_type='client backend' AND pid<>pg_backend_pid()`,
  );
  if (result.rows[0]?.count !== '0') throw new Error('请先停止 API、worker 和其他数据库客户端。');
}

async function inventory(database: Queryable): Promise<Entry[]> {
  return (
    await database.query<Entry>(
      `SELECT id,backend_key,namespace,object_key,state,bytes::text bytes,sha256
     FROM shiling.storage_objects WHERE state <> 'deleted' ORDER BY id`,
    )
  ).rows;
}
function ledgerHash(rows: Entry[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
function manifest(rows: Entry[], storage: StoragePort): Manifest {
  if (rows.some((row) => row.state === 'gc_pending'))
    throw new Error('请先完成正在进行的 GC，再停止服务并备份。');
  return {
    version: 1,
    backendKey: storage.backendKey,
    namespace: storage.namespace,
    ledgerSha256: ledgerHash(rows),
    objects: rows
      .filter((row) => row.state === 'stored')
      .map((row) => {
        const bytes = Number(row.bytes);
        if (
          row.bytes === null ||
          !Number.isSafeInteger(bytes) ||
          bytes < 0 ||
          !row.sha256 ||
          !/^[a-f0-9]{64}$/.test(row.sha256)
        )
          throw new Error('存储台账缺少字节数或 SHA-256，拒绝生成不完整备份。');
        return { id: row.id, key: row.object_key, bytes, sha256: row.sha256 };
      }),
  };
}

async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest('hex') };
}
function matching(
  actual: { bytes: number; sha256: string },
  expected: { bytes: number; sha256: string },
): void {
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
    throw new Error('备份对象长度或 SHA-256 不匹配。');
}

/** Offline object half of a paired DB + objects backup. The caller must keep all writers stopped. */
export async function exportStorageBackup(
  database: Database,
  storage: StoragePort,
  directory: string,
): Promise<{ objects: number; bytes: number }> {
  await stopped(database);
  await assertStorageBinding(database, storage);
  const rows = await inventory(database);
  const record = manifest(rows, storage);
  // Exclusive directory prevents mixing an earlier partial backup into a new snapshot.
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, 'objects'), { mode: 0o700 });
  let total = 0;
  for (const entry of record.objects) {
    const source = await storage.open(entry.key);
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > entry.bytes) {
          callback(new Error('备份对象长度超出台账。'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      source.stream,
      meter,
      createWriteStream(join(directory, 'objects', entry.id), { flags: 'wx', mode: 0o600 }),
    );
    matching({ bytes, sha256: hash.digest('hex') }, entry);
    total += bytes;
  }
  await stopped(database);
  if (ledgerHash(await inventory(database)) !== record.ledgerSha256)
    throw new Error('备份期间台账发生变化。');
  // Only a completed backup has a manifest; failed copies are never accepted for restore.
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(record, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return { objects: record.objects.length, bytes: total };
}

/** Restore requires the matching DB dump, a fresh destination and all services stopped. */
export async function restoreStorageBackup(
  database: Database,
  storage: StoragePort,
  directory: string,
): Promise<{ objects: number; bytes: number }> {
  await stopped(database);
  const value: unknown = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (typeof value !== 'object' || value === null) throw new Error('备份清单无效。');
  const source = value as Manifest;
  if (
    source.version !== 1 ||
    typeof source.backendKey !== 'string' ||
    typeof source.namespace !== 'string'
  )
    throw new Error('备份清单版本或存储位置无效。');
  const rows = await inventory(database);
  // Reconstruct the complete expected manifest from the restored DB. Never trust paths/keys from JSON.
  const expected = manifest(rows, {
    ...storage,
    backendKey: source.backendKey,
    namespace: source.namespace,
  });
  if (JSON.stringify(source) !== JSON.stringify(expected))
    throw new Error('数据库快照与对象备份清单不匹配。');
  if (
    rows.some((row) => row.backend_key !== source.backendKey || row.namespace !== source.namespace)
  )
    throw new Error('备份包含混合存储位置。');
  if (storage.backendKey === source.backendKey && storage.namespace === source.namespace)
    throw new Error('恢复必须使用新的存储位置；OSS 请使用新前缀。');
  // Validate every backup before making any writes or changing the DB.
  for (const entry of expected.objects)
    matching(await hashFile(join(directory, 'objects', entry.id)), entry);
  await runRestoreSafety(database, { mode: 'apply' });
  let total = 0;
  for (const entry of expected.objects) {
    const result = await storage.put(
      entry.key,
      createReadStream(join(directory, 'objects', entry.id)),
      { maxBytes: Math.max(1, entry.bytes), expectedBytes: entry.bytes },
    );
    matching(result, entry);
    matching(await storage.inspect(entry.key), entry);
    total += entry.bytes;
  }
  await database.transaction(async (tx) => {
    await tx.query('LOCK TABLE shiling.storage_objects IN EXCLUSIVE MODE');
    await stopped(tx);
    const current = await inventory(tx);
    if (ledgerHash(current) !== expected.ledgerSha256) throw new Error('恢复期间台账发生变化。');
    await tx.query(
      `UPDATE shiling.storage_objects SET backend_key=$1,namespace=$2
      WHERE backend_key=$3 AND namespace=$4`,
      [storage.backendKey, storage.namespace, source.backendKey, source.namespace],
    );
  });
  const safety = await runRestoreSafety(database, { mode: 'verify' });
  if (!safety.after.safe) throw new Error('恢复安全检查未通过，禁止启动服务。');
  await assertStorageBinding(database, storage);
  return { objects: expected.objects.length, bytes: total };
}
