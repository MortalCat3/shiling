import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { AppError, type IdentityService, type IngestionService } from '@shiling/backend';
import {
  PageInfoSchema,
  UploadBatchCreateSchema,
  UploadCompleteSchema,
  UploadItemCreateSchema,
  UploadItemSchema,
  UploadMetadataResponseSchema,
  UploadMetadataSchema,
  UploadRetrySchema,
  UuidSchema,
} from '@shiling/contracts';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../config.js';
import {
  requireExpectedRevision,
  requireIdempotencyKey,
  requireMutationSession,
  requireSession,
  setRevision,
} from '../http/security.js';

export interface UploadRouteServices {
  readonly identity: IdentityService;
  readonly ingestion: IngestionService;
}

const BatchParamsSchema = Type.Object({ batchId: UuidSchema }, { additionalProperties: false });
const ItemParamsSchema = Type.Object({ itemId: UuidSchema }, { additionalProperties: false });
const AttemptParamsSchema = Type.Object({ attemptId: UuidSchema }, { additionalProperties: false });
const BatchQuerySchema = Type.Object(
  {
    scope: Type.Optional(Type.Union([Type.Literal('own'), Type.Literal('all')])),
    cursor: Type.Optional(UuidSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
const BatchCreatedSchema = Type.Object({ id: UuidSchema }, { additionalProperties: false });
const BatchSummarySchema = Type.Object(
  {
    id: UuidSchema,
    createdAt: Type.String({ format: 'date-time' }),
    itemCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const BatchPageSchema = Type.Object(
  { items: Type.Array(BatchSummarySchema), pageInfo: PageInfoSchema },
  { additionalProperties: false },
);
const TransferSchema = Type.Object(
  {
    mode: Type.Literal('server_stream'),
    method: Type.Literal('PUT'),
    url: Type.String(),
    headers: Type.Record(Type.String(), Type.String()),
    expiresAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
const AttemptCreatedSchema = Type.Object(
  { attemptId: UuidSchema, transfer: TransferSchema },
  { additionalProperties: false },
);
const AttemptProgressSchema = Type.Object(
  {
    attemptId: UuidSchema,
    mode: Type.Literal('server_stream'),
    state: Type.String(),
    receivedBytes: Type.Union([Type.String(), Type.Null()]),
    totalBytes: Type.String(),
    resumable: Type.Boolean(),
    current: Type.Boolean(),
    expiresAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
const ReceivedSchema = Type.Object(
  { receivedBytes: Type.String() },
  { additionalProperties: false },
);
const CompleteResultSchema = Type.Object(
  {
    itemId: UuidSchema,
    attemptId: UuidSchema,
    jobId: Type.Union([UuidSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
const PartRequestSchema = Type.Object(
  {
    partNumbers: Type.Array(Type.Integer({ minimum: 1, maximum: 10_000 }), {
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

function contentLength(value: string | undefined, maximum: number): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) {
    throw new AppError(411, 'CONTENT_LENGTH_REQUIRED', '上传文件必须提供有效的 Content-Length。');
  }
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', '上传文件超过当前实例限制。');
  }
  if (bytes > maximum) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', '上传文件超过当前实例限制。');
  }
  return bytes;
}

function asyncBytes(value: unknown): AsyncIterable<Uint8Array> {
  if (
    typeof value !== 'object' ||
    value === null ||
    !(Symbol.asyncIterator in value) ||
    typeof value[Symbol.asyncIterator] !== 'function'
  ) {
    throw new AppError(400, 'UPLOAD_STREAM_REQUIRED', '上传内容流不可用。');
  }
  return value as AsyncIterable<Uint8Array>;
}

export function registerUploadRoutes(
  instance: FastifyInstance,
  config: ApiConfig,
  services: UploadRouteServices,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  if (!app.hasContentTypeParser('application/octet-stream')) {
    app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
      done(null, payload);
    });
  }

  app.post(
    '/api/v1/team/upload-batches',
    { schema: { body: UploadBatchCreateSchema, response: { 201: BatchCreatedSchema } } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const batch = await services.ingestion.createBatch(token, request.body, {
        requestId: request.id,
        idempotencyKey: requireIdempotencyKey(request),
      });
      return reply.code(201).header('Cache-Control', 'no-store').send(batch);
    },
  );

  app.post(
    '/api/v1/team/upload-batches/:batchId/items',
    {
      schema: {
        params: BatchParamsSchema,
        body: UploadItemCreateSchema,
        response: { 201: UploadItemSchema },
      },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      requireIdempotencyKey(request);
      const item = await services.ingestion.createItem(
        token,
        request.params.batchId,
        request.body,
        request.id,
      );
      setRevision(reply, item.revision);
      return (
        reply
          .code(201)
          .header('Cache-Control', 'no-store')
          // UploadItemSchema 的动态联合目前静态推导为 never；运行时 schema 仍负责白名单序列化。
          .send(item as never)
      );
    },
  );

  app.get(
    '/api/v1/team/upload-batches',
    { schema: { querystring: BatchQuerySchema, response: { 200: BatchPageSchema } } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      const { cursor, ...query } = request.query;
      reply.header('Cache-Control', 'no-store');
      return services.ingestion.listBatches(token, {
        ...query,
        ...(cursor === undefined ? {} : { beforeId: cursor }),
      });
    },
  );

  app.get(
    '/api/v1/team/upload-batches/:batchId',
    { schema: { params: BatchParamsSchema } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      reply.header('Cache-Control', 'no-store');
      return services.ingestion.getBatch(token, request.params.batchId);
    },
  );

  app.get(
    '/api/v1/team/upload-items/:itemId',
    { schema: { params: ItemParamsSchema, response: { 200: UploadItemSchema } } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      const item = await services.ingestion.getItem(token, request.params.itemId);
      setRevision(reply, item.revision);
      return reply.header('Cache-Control', 'no-store').send(item as never);
    },
  );

  app.patch(
    '/api/v1/team/upload-items/:itemId/metadata',
    {
      schema: {
        params: ItemParamsSchema,
        body: UploadMetadataSchema,
        response: { 200: UploadMetadataResponseSchema },
      },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const result = await services.ingestion.updateMetadata(
        token,
        request.params.itemId,
        request.body,
        requireExpectedRevision(request),
        request.id,
      );
      setRevision(reply, result.revision);
      return reply.header('Cache-Control', 'no-store').send(result);
    },
  );

  app.post(
    '/api/v1/team/upload-items/:itemId/attempts',
    { schema: { params: ItemParamsSchema, response: { 201: AttemptCreatedSchema } } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const attempt = await services.ingestion.createAttempt(token, request.params.itemId, {
        requestId: request.id,
        idempotencyKey: requireIdempotencyKey(request),
      });
      return reply.code(201).header('Cache-Control', 'no-store').send(attempt);
    },
  );

  app.put(
    '/api/v1/team/upload-attempts/:attemptId/content',
    {
      bodyLimit: config.uploadMaxBytes,
      schema: { params: AttemptParamsSchema, response: { 200: ReceivedSchema } },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      if (
        request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/octet-stream'
      ) {
        throw new AppError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          '上传传输必须使用 application/octet-stream。',
        );
      }
      const length = contentLength(request.headers['content-length'], config.uploadMaxBytes);
      const result = await services.ingestion.receiveContent(
        token,
        request.params.attemptId,
        asyncBytes(request.body),
        length,
        request.id,
      );
      return reply.header('Cache-Control', 'no-store').send(result);
    },
  );

  app.post(
    '/api/v1/team/upload-attempts/:attemptId/parts',
    { schema: { params: AttemptParamsSchema, body: PartRequestSchema } },
    async (request) => {
      await requireMutationSession(request, config, services.identity);
      throw new AppError(
        409,
        'TRANSFER_MODE_UNSUPPORTED',
        '当前 Local 存储模式不提供对象存储分片授权。',
      );
    },
  );

  app.get(
    '/api/v1/team/upload-attempts/:attemptId/progress',
    { schema: { params: AttemptParamsSchema, response: { 200: AttemptProgressSchema } } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      reply.header('Cache-Control', 'no-store');
      return services.ingestion.attemptProgress(token, request.params.attemptId);
    },
  );

  app.post(
    '/api/v1/team/upload-attempts/:attemptId/complete',
    {
      schema: {
        params: AttemptParamsSchema,
        body: UploadCompleteSchema,
        response: { 202: CompleteResultSchema },
      },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      requireIdempotencyKey(request);
      const result = await services.ingestion.completeAttempt(
        token,
        request.params.attemptId,
        request.body,
        request.id,
      );
      return reply.code(202).header('Cache-Control', 'no-store').send(result);
    },
  );

  app.post(
    '/api/v1/team/upload-items/:itemId/retry',
    { schema: { params: ItemParamsSchema, body: UploadRetrySchema } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const result = await services.ingestion.retry(
        token,
        request.params.itemId,
        request.body.scope,
        { requestId: request.id, idempotencyKey: requireIdempotencyKey(request) },
      );
      return reply.code(202).header('Cache-Control', 'no-store').send(result);
    },
  );

  app.post(
    '/api/v1/team/upload-items/:itemId/cancel',
    { schema: { params: ItemParamsSchema, response: { 200: UploadItemSchema } } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const item = await services.ingestion.cancel(token, request.params.itemId, {
        requestId: request.id,
        idempotencyKey: requireIdempotencyKey(request),
      });
      setRevision(reply, item.revision);
      return reply.header('Cache-Control', 'no-store').send(item as never);
    },
  );
}
