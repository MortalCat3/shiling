import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, rmdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { StoragePort } from '../../ports/storage.js';
import { AppError } from '../../errors.js';

export async function createLocalStorage(options: {
  rootDirectory: string;
  namespace?: string;
}): Promise<StoragePort> {
  if (!isAbsolute(options.rootDirectory))
    throw new Error('Local storage rootDirectory must be absolute.');
  const configured = resolve(options.rootDirectory);
  await mkdir(configured, { recursive: true, mode: 0o700 });
  if ((await lstat(configured)).isSymbolicLink())
    throw new Error('Local storage root must not be a symbolic link.');
  const root = await realpath(configured);
  async function internalDirectory(name: string): Promise<string> {
    const path = join(root, name);
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
    });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Local storage internal path ${name} must be a directory.`);
    return path;
  }
  const locksRoot = await internalDirectory('.shiling-locks');
  const tombstonesRoot = await internalDirectory('.shiling-tombstones');
  function fingerprint(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }
  async function withKeyLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const lockPath = join(locksRoot, fingerprint(key));
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')
        throw new AppError(409, 'STORAGE_OBJECT_BUSY', '文件对象正在提交或回收。', true);
      throw error;
    }
    try {
      return await work();
    } finally {
      await rmdir(lockPath).catch(() => undefined);
    }
  }
  async function tombstoned(key: string): Promise<boolean> {
    try {
      await lstat(join(tombstonesRoot, fingerprint(key)));
      return true;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return false;
      throw error;
    }
  }
  async function createTombstone(key: string): Promise<void> {
    const path = join(tombstonesRoot, fingerprint(key));
    let handle;
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.sync();
    } catch (error) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  async function pathFor(key: string, createParents = false): Promise<string> {
    if (
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(key) ||
      key.split('/').some((part) => part === '.' || part === '..') ||
      key.length > 512
    )
      throw new AppError(400, 'INVALID_OBJECT_KEY', '文件对象标识无效。');
    const path = resolve(root, key);
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new AppError(400, 'INVALID_OBJECT_KEY', '文件对象标识无效。');
    let current = root;
    for (const part of key.split('/').slice(0, -1)) {
      current = join(current, part);
      if (createParents)
        await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
          if (!(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'EEXIST'
          ))
            throw error;
        });
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new AppError(409, 'STORAGE_PATH_UNSAFE', '文件存储路径不可用。');
    }
    return path;
  }
  async function readHandle(key: string) {
    const path = await pathFor(key);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        throw new AppError(409, 'STORAGE_OBJECT_UNAVAILABLE', '文件对象不可用。');
      }
      throw error;
    }
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      throw new AppError(409, 'STORAGE_OBJECT_UNAVAILABLE', '文件对象不可用。');
    }
    return { handle, bytes: stat.size, path };
  }
  return {
    backendKey: 'local',
    namespace: options.namespace ?? 'default',
    async put(key, source, limits) {
      if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1)
        throw new Error('Storage maxBytes must be a positive integer.');
      const target = await pathFor(key, true);
      const temporary = join(dirname(target), `.part-${randomUUID()}`);
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const digest = createHash('sha256');
      let bytes = 0;
      try {
        for await (const chunk of source) {
          bytes += chunk.byteLength;
          if (bytes > limits.maxBytes)
            throw new AppError(413, 'UPLOAD_TOO_LARGE', '文件超过当前上传大小限制。');
          digest.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const result = await handle.write(chunk, offset, chunk.byteLength - offset);
            if (result.bytesWritten === 0) throw new Error('Storage write did not make progress.');
            offset += result.bytesWritten;
          }
        }
        if (limits.expectedBytes !== undefined && bytes !== limits.expectedBytes)
          throw new AppError(400, 'UPLOAD_SIZE_MISMATCH', '实际文件长度与声明不一致。');
        await handle.sync();
        await handle.close();
        const content = { bytes, sha256: digest.digest('hex') };
        let persistStarted = false;
        let persisted = false;
        const persist = async () => {
          if (persistStarted) throw new Error('Storage commit may persist only once.');
          persistStarted = true;
          await withKeyLock(key, async () => {
            if (await tombstoned(key))
              throw new AppError(409, 'STORAGE_OBJECT_DELETED', '文件对象已进入回收终态。');
            // link is atomic and fails if the immutable final key already exists.
            await link(temporary, target);
            persisted = true;
          });
        };
        if (limits.commit) await limits.commit(content, persist);
        else await persist();
        if (!persisted) throw new Error('Storage commit returned without persisting the object.');
        return content;
      } finally {
        await handle.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
      }
    },
    async inspect(key) {
      const { handle } = await readHandle(key);
      const digest = createHash('sha256');
      let bytes = 0;
      try {
        for await (const chunk of handle.createReadStream()) {
          const buffer = chunk as Buffer;
          bytes += buffer.length;
          digest.update(buffer);
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      return { bytes, sha256: digest.digest('hex') };
    },
    async open(key, range) {
      const { handle, bytes } = await readHandle(key);
      if (
        range &&
        (!Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(range.end) ||
          range.start < 0 ||
          range.end < range.start ||
          range.end >= bytes)
      ) {
        await handle.close();
        throw new AppError(416, 'RANGE_NOT_SATISFIABLE', '文件范围无效。');
      }
      return {
        stream: handle.createReadStream(range ? { start: range.start, end: range.end } : {}),
        bytes,
      };
    },
    async withLocalFile(key, use) {
      const { handle, path } = await readHandle(key);
      try {
        return await use(path);
      } finally {
        await handle.close();
      }
    },
    async remove(key) {
      // A reserved ledger row may never have reached put(), so its parent path need not exist.
      // Recreate only the validated server-owned directory chain before writing the tombstone.
      const path = await pathFor(key, true);
      await withKeyLock(key, async () => {
        // The tombstone is durable and checked by every future commit, so a deleted key cannot
        // be recreated by a writer that finishes after the cleanup claim.
        await createTombstone(key);
        try {
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new AppError(409, 'STORAGE_PATH_UNSAFE', '文件存储路径不可用。');
          await unlink(path);
        } catch (error) {
          if (!(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
          ))
            throw error;
        }
      });
    },
    async sweepTemporaryFiles({ olderThan, limit }) {
      if (Number.isNaN(olderThan.getTime())) throw new Error('Temporary file cutoff is invalid.');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
        throw new Error('Temporary file sweep limit must be between 1 and 10000.');
      const cutoff = olderThan.getTime();
      const result = { deleted: 0, failed: 0 };
      const partName =
        /^\.part-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      async function removeCandidate(path: string, directory = false): Promise<void> {
        if (result.deleted >= limit) return;
        try {
          const stat = await lstat(path);
          if (stat.isSymbolicLink() || stat.mtimeMs > cutoff) return;
          if (directory) {
            if (!stat.isDirectory()) return;
            await rmdir(path);
          } else {
            if (!stat.isFile()) return;
            await unlink(path);
          }
          result.deleted += 1;
        } catch (error) {
          if (!(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
          ))
            result.failed += 1;
        }
      }
      async function walk(directory: string): Promise<void> {
        if (result.deleted >= limit) return;
        let entries;
        try {
          entries = await opendir(directory);
        } catch {
          result.failed += 1;
          return;
        }
        for await (const entry of entries) {
          if (result.deleted >= limit) break;
          if (
            directory === root &&
            (entry.name === '.shiling-locks' || entry.name === '.shiling-tombstones')
          )
            continue;
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile() && partName.test(entry.name)) await removeCandidate(path);
        }
      }
      await walk(root);
      if (result.deleted < limit) {
        let locks;
        try {
          locks = await opendir(locksRoot);
          for await (const entry of locks) {
            if (result.deleted >= limit) break;
            if (/^[a-f0-9]{64}$/.test(entry.name))
              await removeCandidate(join(locksRoot, entry.name), true);
          }
        } catch {
          result.failed += 1;
        }
      }
      return result;
    },
  };
}
