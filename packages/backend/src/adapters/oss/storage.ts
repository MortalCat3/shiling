import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type OSS from 'ali-oss';
import { AppError } from '../../errors.js';
import type { StoragePort, ContentRange } from '../../ports/storage.js';

// The installed SDK implements getBucketVersioning; DefinitelyTyped omits it.
export type OssClient = Pick<
  OSS,
  | 'getBucketACL'
  | 'initMultipartUpload'
  | 'uploadPart'
  | 'completeMultipartUpload'
  | 'abortMultipartUpload'
  | 'put'
  | 'head'
  | 'getStream'
> & {
  getBucketVersioning(bucket: string): Promise<{ versionStatus?: string }>;
};

const partBytes = 8 * 1024 * 1024;
const privateHeaders = { 'x-oss-object-acl': 'private' };
const immutableHeaders = { ...privateHeaders, 'x-oss-forbid-overwrite': 'true' };
const deletedHeader = 'x-oss-meta-shiling-deleted';

function unavailable(): AppError {
  return new AppError(409, 'STORAGE_OBJECT_UNAVAILABLE', '文件对象不可用。');
}

function sanitized(error: unknown): Error {
  if (error instanceof AppError) return error;
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
  if (status === 404) return unavailable();
  if (status === 409 || status === 412)
    return new AppError(409, 'STORAGE_OBJECT_CONFLICT', '文件对象已存在或已变化。');
  // Never propagate SDK request objects, signed headers, endpoint or credentials.
  return new AppError(503, 'STORAGE_UNAVAILABLE', '对象存储暂时不可用。', true);
}

export async function createOssStorage(options: {
  client: OssClient;
  bucket: string;
  prefix: string;
  namespace: string;
  temporaryDirectory: string;
  maxObjectBytes: number;
}): Promise<StoragePort> {
  const { client } = options;
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/$/.test(options.prefix))
    throw new Error('OSS requires a dedicated non-root prefix.');
  function name(key: string): string {
    if (
      key.length > 512 ||
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(key) ||
      key.split('/').some((p) => p === '.' || p === '..')
    )
      throw new AppError(400, 'STORAGE_KEY_INVALID', '文件对象标识无效。');
    return options.prefix + key;
  }
  async function request<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw sanitized(error);
    }
  }
  async function checkReady(): Promise<boolean> {
    const acl = await request(() => client.getBucketACL(options.bucket));
    const version = await request(() => client.getBucketVersioning(options.bucket));
    if (
      acl.acl !== 'private' ||
      (version.versionStatus !== undefined && version.versionStatus !== '')
    )
      throw new AppError(503, 'STORAGE_BUCKET_UNSAFE', 'OSS Bucket 必须私有且从未开启版本控制。');
    return true;
  }
  await checkReady();
  await mkdir(options.temporaryDirectory, { recursive: true, mode: 0o700 });

  async function open(
    key: string,
    range?: ContentRange,
  ): Promise<{ stream: Readable; bytes: number }> {
    const object = name(key);
    const head = await request(() => client.head(object));
    const headers = head.res.headers as Record<string, unknown>;
    if (headers[deletedHeader] === '1') throw unavailable();
    const bytes = Number(headers['content-length']);
    const etag = headers['etag'];
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > options.maxObjectBytes ||
      typeof etag !== 'string'
    )
      throw unavailable();
    if (
      range &&
      (!Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start ||
        range.end >= bytes)
    )
      throw new AppError(416, 'RANGE_NOT_SATISFIABLE', '文件范围无效。');
    const result = await request(() =>
      client.getStream(object, {
        headers: {
          'If-Match': etag,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        },
      }),
    );
    const responseHeaders = result.res.headers as Record<string, unknown>;
    const source = result.stream as Readable;
    const expected = range ? range.end - range.start + 1 : bytes;
    if (
      result.res.status !== (range ? 206 : 200) ||
      responseHeaders[deletedHeader] === '1' ||
      (range && responseHeaders['content-range'] !== `bytes ${range.start}-${range.end}/${bytes}`)
    ) {
      source.destroy();
      throw unavailable();
    }
    const stream = Readable.from(
      (async function* () {
        let received = 0;
        try {
          for await (const chunk of source) {
            const buffer = chunk as Buffer;
            received += buffer.byteLength;
            if (received > expected) throw unavailable();
            yield buffer;
          }
          if (received !== expected) throw unavailable();
        } catch (error) {
          throw sanitized(error);
        } finally {
          source.destroy();
        }
      })(),
    );
    // Also close a stream cancelled before its async generator has started.
    stream.once('close', () => source.destroy());
    return { stream, bytes };
  }

  return {
    backendKey: 'oss',
    namespace: options.namespace,
    checkReady,
    async put(key, source, limits) {
      const object = name(key);
      if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1)
        throw new Error('Storage maxBytes must be a positive integer.');
      let uploadId: string | undefined;
      let complete = false;
      let bytes = 0;
      const hash = createHash('sha256');
      const parts: { number: number; etag: string }[] = [];
      let buffer = Buffer.allocUnsafe(partBytes);
      let offset = 0;
      async function upload(data: Buffer): Promise<void> {
        uploadId ??= (
          await request(() =>
            client.initMultipartUpload(object, {
              mime: 'application/octet-stream',
              headers: privateHeaders,
            }),
          )
        ).uploadId;
        const id = uploadId;
        const number = parts.length + 1;
        const part = await request(() =>
          client.uploadPart(object, id, number, data, 0, data.length),
        );
        parts.push({ number, etag: part.etag });
      }
      try {
        for await (const chunk of source) {
          bytes += chunk.byteLength;
          if (bytes > Math.min(limits.maxBytes, options.maxObjectBytes))
            throw new AppError(413, 'UPLOAD_TOO_LARGE', '文件超过当前上传大小限制。');
          hash.update(chunk);
          let position = 0;
          while (position < chunk.byteLength) {
            const length = Math.min(partBytes - offset, chunk.byteLength - position);
            buffer.set(chunk.subarray(position, position + length), offset);
            offset += length;
            position += length;
            if (offset === partBytes) {
              await upload(buffer);
              buffer = Buffer.allocUnsafe(partBytes);
              offset = 0;
            }
          }
        }
        if (limits.expectedBytes !== undefined && bytes !== limits.expectedBytes)
          throw new AppError(400, 'UPLOAD_SIZE_MISMATCH', '实际文件长度与声明不一致。');
        if (offset) await upload(buffer.subarray(0, offset));
        const content = { bytes, sha256: hash.digest('hex') };
        let started = false;
        const persist = async () => {
          if (started) throw new Error('Storage commit may persist only once.');
          started = true;
          if (uploadId) {
            const id = uploadId;
            await request(() =>
              client.completeMultipartUpload(object, id, parts, {
                headers: immutableHeaders,
                timeout: 15000,
              }),
            );
          } else {
            await request(() =>
              client.put(object, Buffer.alloc(0), { headers: immutableHeaders, timeout: 15000 }),
            );
          }
          complete = true;
        };
        if (limits.commit) await limits.commit(content, persist);
        else await persist();
        if (!complete) throw new Error('Storage commit returned without persisting the object.');
        return content;
      } finally {
        if (uploadId && !complete) {
          const id = uploadId;
          // Failed aborts are covered by the documented abort-multipart lifecycle rule.
          await request(() => client.abortMultipartUpload(object, id)).catch(() => undefined);
        }
      }
    },
    open,
    async inspect(key) {
      const opened = await open(key);
      const hash = createHash('sha256');
      for await (const chunk of opened.stream) hash.update(chunk as Buffer);
      return { bytes: opened.bytes, sha256: hash.digest('hex') };
    },
    async withLocalFile(key, use) {
      const directory = await mkdtemp(join(options.temporaryDirectory, 'oss-read-'));
      try {
        const file = join(directory, 'object');
        const opened = await open(key);
        await pipeline(opened.stream, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
        return await use(file);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async remove(key) {
      // An atomic zero-byte tombstone at the SAME key makes late immutable completions fail.
      // A separate marker + DeleteObject has a race that can resurrect a GC'd key.
      await request(() =>
        client.put(name(key), Buffer.alloc(0), {
          headers: { ...privateHeaders, [deletedHeader]: '1' },
          timeout: 15000,
        }),
      );
    },
    async sweepTemporaryFiles({ olderThan, limit }) {
      let deleted = 0,
        failed = 0;
      for (const entry of await readdir(options.temporaryDirectory, { withFileTypes: true })) {
        if (deleted + failed >= limit) break;
        if (!entry.isDirectory() || !/^oss-read-[a-zA-Z0-9]+$/.test(entry.name)) continue;
        const directory = join(options.temporaryDirectory, entry.name);
        try {
          const stat = await lstat(directory);
          if (!stat.isDirectory() || stat.mtime >= olderThan) continue;
          await rm(directory, { recursive: true, force: true });
          deleted++;
        } catch {
          failed++;
        }
      }
      return { deleted, failed };
    },
  };
}
