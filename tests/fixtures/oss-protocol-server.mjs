/** Small OSS protocol fixture, not an Alibaba compatibility certification. No production switch. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createOssStorage } from '../../packages/backend/dist/index.js';

const require = createRequire(new URL('../../packages/backend/package.json', import.meta.url));
const OSS = require('ali-oss');
export async function createOssProtocolFixture(directory) {
  const objects = new Map(),
    uploads = new Map();
  const bucket = 'shiling-protocol-test';
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      assert.match(req.headers.authorization, /^OSS4-HMAC-SHA256 /);
      const url = new URL(req.url, 'http://localhost');
      const name = decodeURIComponent(url.pathname).replace(new RegExp(`^/${bucket}/?`), '');
      requests.push({ method: req.method, name, query: [...url.searchParams.keys()] });
      const xml = (value, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/xml' });
        res.end(value);
      };
      const error = (status, code) =>
        xml(
          `<Error><Code>${code}</Code><Message>Protocol fixture failure</Message></Error>`,
          status,
        );
      if (url.searchParams.has('acl'))
        return xml(
          '<AccessControlPolicy><Owner><ID>test</ID><DisplayName>test</DisplayName></Owner><AccessControlList><Grant>private</Grant></AccessControlList></AccessControlPolicy>',
        );
      if (url.searchParams.has('versioning')) return xml('<VersioningConfiguration/>');
      if (req.method === 'POST' && url.searchParams.has('uploads')) {
        const uploadId = randomUUID();
        uploads.set(uploadId, { name, parts: [], headers: req.headers });
        return xml(
          `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${name}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      const id = url.searchParams.get('uploadId');
      if (req.method === 'DELETE' && id) {
        uploads.delete(id);
        res.writeHead(204);
        res.end();
        return;
      }
      const input = Buffer.concat(await Array.fromAsync(req));
      const etag = (bytes) => `"${createHash('md5').update(bytes).digest('hex')}"`;
      if (req.method === 'PUT' && id) {
        const upload = uploads.get(id);
        if (!upload) return error(404, 'NoSuchUpload');
        upload.parts[Number(url.searchParams.get('partNumber')) - 1] = input;
        res.setHeader('etag', etag(input));
        res.end();
        return;
      }
      if ((req.method === 'POST' && id) || req.method === 'PUT') {
        if (objects.has(name) && req.headers['x-oss-forbid-overwrite'] === 'true')
          return error(409, 'FileAlreadyExists');
        const upload = id ? uploads.get(id) : undefined;
        if (id && !upload) return error(404, 'NoSuchUpload');
        const bytes = upload ? Buffer.concat(upload.parts) : input;
        const headers = { ...(upload?.headers ?? {}), ...req.headers };
        assert.equal(headers['x-oss-object-acl'], 'private');
        objects.set(name, {
          bytes,
          headers: {
            etag: etag(bytes),
            'content-length': String(bytes.length),
            ...(headers['x-oss-meta-shiling-deleted'] ? { 'x-oss-meta-shiling-deleted': '1' } : {}),
          },
        });
        res.setHeader('etag', etag(bytes));
        if (id) {
          uploads.delete(id);
          return xml(
            `<CompleteMultipartUploadResult><Location>unused</Location><Bucket>${bucket}</Bucket><Key>${name}</Key><ETag>${etag(bytes)}</ETag></CompleteMultipartUploadResult>`,
          );
        }
        res.end();
        return;
      }
      const object = objects.get(name);
      if (!object) return error(404, 'NoSuchKey');
      if (req.headers['if-match'] && req.headers['if-match'] !== object.headers.etag)
        return error(412, 'PreconditionFailed');
      if (req.method === 'HEAD') {
        res.writeHead(200, object.headers);
        res.end();
        return;
      }
      assert.equal(req.method, 'GET');
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      if (range) {
        const start = Number(range[1]),
          end = Number(range[2]);
        const bytes = object.bytes.subarray(start, end + 1);
        res.writeHead(206, {
          ...object.headers,
          'content-length': String(bytes.length),
          'content-range': `bytes ${start}-${end}/${object.bytes.length}`,
        });
        res.end(bytes);
        return;
      }
      res.writeHead(200, object.headers);
      res.end(object.bytes);
    } catch {
      res.writeHead(500);
      res.end('Protocol fixture assertion failed');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    objects,
    uploads,
    requests,
    async storage(prefix) {
      const client = new OSS({
        region: 'oss-cn-hangzhou',
        bucket,
        endpoint: `http://127.0.0.1:${server.address().port}`,
        sldEnable: true,
        authorizationV4: true,
        accessKeyId: 'protocol-test-id',
        accessKeySecret: 'protocol-test-secret',
        timeout: 5000,
      });
      return createOssStorage({
        client,
        bucket,
        prefix,
        namespace: `protocol-${prefix}`,
        temporaryDirectory: directory,
        maxObjectBytes: 100 * 1024 ** 2,
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
