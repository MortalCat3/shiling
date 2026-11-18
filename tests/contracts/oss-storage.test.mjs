import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  createOssStorage,
  readStorageConfig,
  assertStorageBinding,
} from '../../packages/backend/dist/index.js';

const digest = (data) => createHash('sha256').update(data).digest('hex');
function fakeOss() {
  const objects = new Map();
  const uploads = new Map();
  let next = 0;
  return {
    objects,
    uploads,
    acl: 'private',
    versionStatus: undefined,
    completed: 0,
    aborted: 0,
    async getBucketACL() {
      return { acl: this.acl };
    },
    async getBucketVersioning() {
      return { versionStatus: this.versionStatus };
    },
    async initMultipartUpload(key) {
      const uploadId = String(++next);
      uploads.set(uploadId, { key, parts: [] });
      return { uploadId };
    },
    async uploadPart(key, id, number, data, start, end) {
      assert.equal(key, uploads.get(id).key);
      uploads.get(id).parts[number - 1] = Buffer.from(data.subarray(start, end));
      return { etag: digest(data) };
    },
    async completeMultipartUpload(key, id, parts, options) {
      assert.equal(options.headers['x-oss-forbid-overwrite'], 'true');
      assert.equal(options.headers['x-oss-object-acl'], 'private');
      assert.equal(parts.length, uploads.get(id).parts.length);
      await this.put(key, Buffer.concat(uploads.get(id).parts), options);
      uploads.delete(id);
      this.completed++;
    },
    async abortMultipartUpload(_key, id) {
      uploads.delete(id);
      this.aborted++;
    },
    async put(key, data, options) {
      if (options.headers['x-oss-forbid-overwrite'] === 'true' && objects.has(key))
        throw { status: 409 };
      const bytes = Buffer.from(data);
      objects.set(key, {
        bytes,
        headers: {
          ...options.headers,
          etag: digest(bytes),
          'content-length': String(bytes.length),
        },
      });
    },
    async head(key) {
      if (!objects.has(key)) throw { status: 404 };
      return { res: { headers: objects.get(key).headers } };
    },
    async getStream(key, { headers }) {
      const row = objects.get(key);
      if (headers['If-Match'] !== row.headers.etag) throw { status: 412 };
      const range = headers.Range?.match(/^bytes=(\d+)-(\d+)$/);
      const start = Number(range?.[1]),
        end = Number(range?.[2]);
      return {
        stream: Readable.from([range ? row.bytes.subarray(start, end + 1) : row.bytes]),
        res: {
          status: range ? 206 : 200,
          headers: {
            ...row.headers,
            ...(range ? { 'content-range': `bytes ${start}-${end}/${row.bytes.length}` } : {}),
          },
        },
      };
    },
  };
}

test('OSS immutable streaming contract, GC fences, bounded reads and failure cleanup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shiling-oss-contract-'));
  const client = fakeOss();
  const options = {
    client,
    bucket: 'example-bucket',
    prefix: 'test/',
    namespace: 'test',
    temporaryDirectory: directory,
    maxObjectBytes: 32 * 1024 ** 2,
  };
  const storage = await createOssStorage(options);
  try {
    await t.test('multipart boundary, hash and final commit fence', async () => {
      const bytes = Buffer.alloc(9 * 1024 ** 2 + 13, 37);
      const result = await storage.put(
        'objects/one',
        Readable.from([bytes.subarray(0, 123), bytes.subarray(123)]),
        {
          maxBytes: bytes.length,
          expectedBytes: bytes.length,
          commit: async (content, persist) => {
            assert.deepEqual(content, { bytes: bytes.length, sha256: digest(bytes) });
            assert.equal(client.objects.has('test/objects/one'), false);
            assert.equal(client.uploads.size, 1);
            await persist();
          },
        },
      );
      assert.deepEqual(await storage.inspect('objects/one'), result);
      const range = await storage.open('objects/one', { start: 10, end: 16 });
      assert.equal(range.bytes, bytes.length);
      assert.deepEqual(Buffer.concat(await Array.fromAsync(range.stream)), bytes.subarray(10, 17));
      await assert.rejects(
        storage.put('objects/one', Readable.from([Buffer.from('overwrite')]), { maxBytes: 100 }),
        { code: 'STORAGE_OBJECT_CONFLICT' },
      );
      assert.equal((await storage.inspect('objects/one')).sha256, result.sha256);
      await storage.withLocalFile('objects/one', async (path) =>
        assert.deepEqual(await readFile(path), bytes),
      );
      assert.deepEqual(await readdir(directory), []);
      await assert.rejects(
        storage.withLocalFile('objects/one', async () => {
          throw new Error('media failure');
        }),
        /media failure/,
      );
      assert.deepEqual(await readdir(directory), []);
    });
    await t.test(
      'oversize, wrong size, interrupted source and rejected commit leave no final object',
      async () => {
        const data = Buffer.alloc(9 * 1024 ** 2);
        await assert.rejects(storage.put('limit', Readable.from([data]), { maxBytes: 1 }), {
          code: 'UPLOAD_TOO_LARGE',
        });
        await assert.rejects(
          storage.put('size', Readable.from([data]), {
            maxBytes: data.length,
            expectedBytes: data.length + 1,
          }),
          { code: 'UPLOAD_SIZE_MISMATCH' },
        );
        await assert.rejects(
          storage.put('fence', Readable.from([data]), {
            maxBytes: data.length,
            commit: async () => {
              throw new Error('stale fence');
            },
          }),
          /stale fence/,
        );
        await assert.rejects(
          storage.put('no-commit', Readable.from([data]), {
            maxBytes: data.length,
            commit: async () => {},
          }),
          /without persisting/,
        );
        const broken = (async function* () {
          yield data;
          throw new Error('disconnected');
        })();
        await assert.rejects(
          storage.put('broken', broken, { maxBytes: 2 * data.length }),
          /disconnected/,
        );
        assert.equal(client.uploads.size, 0);
        for (const key of ['limit', 'size', 'fence', 'broken', 'no-commit'])
          assert.equal(client.objects.has(`test/${key}`), false);
      },
    );
    await t.test(
      'GC before completion prevents resurrection; repeated GC is harmless',
      async () => {
        await assert.rejects(
          storage.put('dead', Readable.from([Buffer.from('late')]), {
            maxBytes: 10,
            commit: async (_content, persist) => {
              await storage.remove('dead');
              await persist();
            },
          }),
          { code: 'STORAGE_OBJECT_CONFLICT' },
        );
        await storage.remove('dead');
        await assert.rejects(storage.inspect('dead'), { code: 'STORAGE_OBJECT_UNAVAILABLE' });
        await assert.rejects(storage.put('dead', Readable.from([]), { maxBytes: 10 }), {
          code: 'STORAGE_OBJECT_CONFLICT',
        });
        await storage.remove('objects/one');
        assert.equal(client.objects.get('test/objects/one').bytes.length, 0);
      },
    );
    await t.test(
      'truncated/failed downloads and ignored ranges fail closed; cancellation closes provider stream',
      async () => {
        await storage.put('stream', Readable.from([Buffer.from('abcdef')]), { maxBytes: 6 });
        const get = client.getStream.bind(client);
        client.getStream = async (...args) => {
          const result = await get(...args);
          result.stream = Readable.from([Buffer.from('abc')]);
          return result;
        };
        await assert.rejects(storage.inspect('stream'), { code: 'STORAGE_OBJECT_UNAVAILABLE' });
        client.getStream = async (...args) => {
          const result = await get(...args);
          result.stream = Readable.from(
            (async function* () {
              yield Buffer.from('a');
              throw new Error('signed-provider-secret');
            })(),
          );
          return result;
        };
        await assert.rejects(
          storage.inspect('stream'),
          (error) =>
            error.code === 'STORAGE_UNAVAILABLE' &&
            !error.message.includes('signed-provider-secret'),
        );
        let source;
        client.getStream = async (...args) => {
          const result = await get(...args);
          source = result.stream;
          result.res.status = 200;
          return result;
        };
        await assert.rejects(storage.open('stream', { start: 0, end: 1 }), {
          code: 'STORAGE_OBJECT_UNAVAILABLE',
        });
        assert.equal(source.destroyed, true);
        const opened = await storage.open('stream');
        opened.stream.destroy();
        await new Promise((resolve) => opened.stream.once('close', resolve));
        assert.equal(source.destroyed, true);
        client.getStream = get;
        const upload = client.uploadPart.bind(client);
        client.uploadPart = async () => {
          throw new Error('signed-provider-secret');
        };
        await assert.rejects(
          storage.put('failed-part', Readable.from([Buffer.from('abc')]), { maxBytes: 3 }),
          { code: 'STORAGE_UNAVAILABLE' },
        );
        assert.equal(client.uploads.size, 0);
        client.uploadPart = upload;
      },
    );
    await t.test('reject unsafe bucket, bad keys/ranges and sanitize provider errors', async () => {
      for (const version of ['Enabled', 'Suspended']) {
        client.versionStatus = version;
        await assert.rejects(createOssStorage(options), { code: 'STORAGE_BUCKET_UNSAFE' });
      }
      client.versionStatus = undefined;
      client.acl = 'public-read';
      await assert.rejects(createOssStorage(options), { code: 'STORAGE_BUCKET_UNSAFE' });
      client.acl = 'private';
      for (const key of ['../escape', '/absolute', 'a/../../b'])
        await assert.rejects(storage.open(key), { code: 'STORAGE_KEY_INVALID' });
      await storage.put('small', Readable.from([Buffer.from('abc')]), { maxBytes: 3 });
      await assert.rejects(storage.open('small', { start: 0, end: 3 }), { status: 416 });
      client.head = async () => {
        throw new Error('signed-secret-endpoint');
      };
      await assert.rejects(
        storage.open('small'),
        (error) =>
          error.code === 'STORAGE_UNAVAILABLE' && !JSON.stringify(error).includes('signed-secret'),
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Local remains default; OSS configuration is explicit and location bound', async () => {
  assert.equal(readStorageConfig({}).driver, 'local');
  const env = {
    SHILING_STORAGE_DRIVER: 'oss',
    SHILING_OSS_REGION: 'oss-cn-hangzhou',
    SHILING_OSS_BUCKET: 'example-bucket',
    SHILING_OSS_PREFIX: 'team/test/',
    SHILING_OSS_CREDENTIALS_FILE: './secrets.local/oss.json',
  };
  const config = readStorageConfig(env);
  assert.equal(
    config.namespace,
    readStorageConfig({
      ...env,
      SHILING_OSS_ENDPOINT: 'https://oss-cn-hangzhou-internal.aliyuncs.com',
    }).namespace,
  );
  assert.notEqual(
    config.namespace,
    readStorageConfig({ ...env, SHILING_OSS_PREFIX: 'team/restore/' }).namespace,
  );
  for (const patch of [
    { SHILING_OSS_PREFIX: '' },
    { SHILING_OSS_PREFIX: '../' },
    { SHILING_OSS_ENDPOINT: 'http://127.0.0.1' },
    { SHILING_STORAGE_DRIVER: 's3' },
  ])
    assert.throws(() => readStorageConfig({ ...env, ...patch }));
  await assert.rejects(
    assertStorageBinding(
      { query: async () => ({ rows: [{}] }) },
      { backendKey: 'oss', namespace: config.namespace },
    ),
    { code: 'STORAGE_LOCATION_MISMATCH' },
  );
});
