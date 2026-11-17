import { Type, type Static } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  AppError,
  type AssetListInput,
  type AssetService,
  type ContentRange,
  type IdentityService,
  type PublicationService,
} from '@shiling/backend';
import {
  AssetEditSchema,
  AssetTypeSchema,
  DeliveryGrantSchema,
  DeliveryRequestSchema,
  ExpectedRevisionSchema,
  PublishRequestSchema,
  RevisionSchema,
  TeamAssetSchema,
  UuidSchema,
  pageSchema,
} from '@shiling/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import type { ApiConfig } from '../config.js';
import {
  requireExpectedRevision,
  requireIdempotencyKey,
  requireMutationSession,
  requireSession,
  setRevision,
} from '../http/security.js';

export interface AssetRouteServices {
  readonly identity: IdentityService;
  readonly assets: AssetService;
  readonly publication: PublicationService;
}

const AssetParamsSchema = Type.Object({ assetId: UuidSchema }, { additionalProperties: false });
const ContentParamsSchema = Type.Object(
  { assetId: UuidSchema, artifactId: UuidSchema },
  { additionalProperties: false },
);
const GrantQuerySchema = Type.Object(
  { grant: Type.String({ minLength: 1, maxLength: 8_192 }) },
  { additionalProperties: false },
);
const AssetQuerySchema = Type.Object(
  {
    q: Type.Optional(Type.String({ maxLength: 200 })),
    typeId: Type.Optional(
      Type.Union([
        AssetTypeSchema,
        Type.Array(AssetTypeSchema, { minItems: 1, maxItems: 3, uniqueItems: true }),
      ]),
    ),
    tagId: Type.Optional(
      Type.Union([
        UuidSchema,
        Type.Array(UuidSchema, { minItems: 1, maxItems: 20, uniqueItems: true }),
      ]),
    ),
    collectionId: Type.Optional(UuidSchema),
    favorite: Type.Optional(Type.Boolean()),
    owner: Type.Optional(Type.Union([Type.Literal('me'), UuidSchema])),
    state: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('archived')])),
    sort: Type.Optional(
      Type.Union([
        Type.Literal('createdAtDesc'),
        Type.Literal('updatedAtDesc'),
        Type.Literal('titleAsc'),
      ]),
    ),
    cursor: Type.Optional(Type.String({ maxLength: 2_048 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
const FacetsSchema = Type.Object(
  {
    types: Type.Array(
      Type.Object(
        {
          label: Type.String(),
          value: AssetTypeSchema,
          count: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
    tags: Type.Array(
      Type.Object(
        {
          label: Type.String(),
          value: UuidSchema,
          count: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const PublicationStateSchema = Type.Object(
  {
    state: Type.Union([Type.Literal('none'), Type.Literal('active'), Type.Literal('withdrawn')]),
    revision: Type.String({ pattern: '^(0|[1-9][0-9]*)$' }),
    snapshot: Type.Union([
      Type.Object(
        {
          title: Type.Union([Type.String(), Type.Null()]),
          description: Type.Union([Type.String(), Type.Null()]),
          publicTags: Type.Union([Type.Array(Type.String()), Type.Null()]),
          versionId: UuidSchema,
          publishedAt: Type.String({ format: 'date-time' }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    sourceChanged: Type.Boolean(),
  },
  { additionalProperties: false },
);
const PublishResultSchema = Type.Object(
  {
    state: Type.Union([Type.Literal('none'), Type.Literal('active'), Type.Literal('withdrawn')]),
    revision: RevisionSchema,
    created: Type.Boolean(),
  },
  { additionalProperties: false },
);
const WithdrawResultSchema = Type.Object(
  {
    state: Type.Union([Type.Literal('active'), Type.Literal('withdrawn')]),
    revision: RevisionSchema,
  },
  { additionalProperties: false },
);

function assetQuery(query: Static<typeof AssetQuerySchema>): AssetListInput {
  const { typeId, tagId, ...rest } = query;
  return {
    ...rest,
    ...(typeId === undefined ? {} : { typeId: Array.isArray(typeId) ? typeId : [typeId] }),
    ...(tagId === undefined ? {} : { tagId: Array.isArray(tagId) ? tagId : [tagId] }),
  };
}

interface OpenedContent {
  readonly stream: Readable;
  readonly bytes: number;
  readonly contentType: string;
  readonly downloadName: string;
  readonly attachment: boolean;
}

function requestedRange(header: string, bytes: number): ContentRange {
  if (!/^bytes=/.test(header) || header.includes(',')) {
    throw new AppError(416, 'RANGE_NOT_SATISFIABLE', '仅支持单个字节范围。');
  }
  const value = header.slice('bytes='.length).trim();
  const match = /^(\d*)-(\d*)$/.exec(value);
  if (!match || (match[1] === '' && match[2] === '')) {
    throw new AppError(416, 'RANGE_NOT_SATISFIABLE', '文件范围无效。');
  }
  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      throw new AppError(416, 'RANGE_NOT_SATISFIABLE', '文件范围无效。');
    }
    start = Math.max(0, bytes - suffix);
    end = bytes - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? bytes - 1 : Number(match[2]);
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= bytes ||
    end < start
  ) {
    throw new AppError(416, 'RANGE_NOT_SATISFIABLE', '文件范围无效。');
  }
  return { start, end: Math.min(end, bytes - 1) };
}

function contentDisposition(name: string, attachment: boolean, contentType: string): string {
  const forceAttachment =
    attachment ||
    ['text/html', 'application/xhtml+xml', 'image/svg+xml'].includes(
      contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '',
    );
  const cleaned =
    name
      .replace(/[\r\n]/g, '')
      .trim()
      .slice(0, 240) || 'download';
  const fallback = cleaned
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(cleaned).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${forceAttachment ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function sendOpenedContent(
  reply: FastifyReply,
  rangeHeader: string | undefined,
  open: (range?: ContentRange) => Promise<OpenedContent>,
): Promise<FastifyReply> {
  let content = await open();
  let range: ContentRange | undefined;
  if (rangeHeader !== undefined) {
    try {
      range = requestedRange(rangeHeader, content.bytes);
    } catch (error) {
      content.stream.destroy();
      reply.header('Content-Range', `bytes */${content.bytes}`);
      throw error;
    }
    content.stream.destroy();
    content = await open(range);
  }
  const length = range === undefined ? content.bytes : range.end - range.start + 1;
  reply
    .code(range === undefined ? 200 : 206)
    .header('Cache-Control', 'no-store')
    .header('Accept-Ranges', 'bytes')
    .header('Content-Length', String(length))
    .header('Content-Type', content.contentType)
    .header('X-Content-Type-Options', 'nosniff')
    .header(
      'Content-Disposition',
      contentDisposition(content.downloadName, content.attachment, content.contentType),
    );
  if (range !== undefined) {
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${content.bytes}`);
  }
  return reply.send(content.stream);
}

export function registerAssetRoutes(
  instance: FastifyInstance,
  config: ApiConfig,
  services: AssetRouteServices,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  app.get(
    '/api/v1/team/assets',
    {
      schema: {
        querystring: AssetQuerySchema,
        response: { 200: pageSchema(TeamAssetSchema) },
      },
    },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      reply.header('Cache-Control', 'no-store');
      return services.assets.list(token, assetQuery(request.query));
    },
  );

  app.get(
    '/api/v1/team/assets/facets',
    { schema: { querystring: AssetQuerySchema, response: { 200: FacetsSchema } } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      reply.header('Cache-Control', 'no-store');
      const facets = await services.assets.facets(token, assetQuery(request.query));
      const labels = { image: '图片', video: '视频', web_motion: '动效' } as const;
      return {
        types: facets.types.map((entry) => ({
          label: labels[entry.value],
          value: entry.value,
          count: entry.count,
        })),
        tags: facets.tags.map((entry) => ({
          label: entry.name,
          value: entry.id,
          count: entry.count,
        })),
      };
    },
  );

  app.get(
    '/api/v1/team/assets/:assetId',
    { schema: { params: AssetParamsSchema, response: { 200: TeamAssetSchema } } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      const asset = await services.assets.get(token, request.params.assetId);
      setRevision(reply, asset.revision);
      return reply.header('Cache-Control', 'no-store').send(asset);
    },
  );

  app.patch(
    '/api/v1/team/assets/:assetId',
    {
      schema: {
        params: AssetParamsSchema,
        body: AssetEditSchema,
        response: { 200: TeamAssetSchema },
      },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const asset = await services.assets.edit(
        token,
        request.params.assetId,
        request.body,
        requireExpectedRevision(request),
        request.id,
      );
      setRevision(reply, asset.revision);
      return reply.header('Cache-Control', 'no-store').send(asset);
    },
  );

  for (const action of ['archive', 'restore'] as const) {
    app.post(
      `/api/v1/team/assets/:assetId/${action}`,
      {
        schema: {
          params: AssetParamsSchema,
          body: ExpectedRevisionSchema,
          response: { 200: TeamAssetSchema },
        },
      },
      async (request, reply) => {
        const { token } = await requireMutationSession(request, config, services.identity);
        const asset = await services.assets[action](
          token,
          request.params.assetId,
          request.body.expectedRevision,
          { requestId: request.id, idempotencyKey: requireIdempotencyKey(request) },
        );
        setRevision(reply, asset.revision);
        return reply.header('Cache-Control', 'no-store').send(asset);
      },
    );
  }

  app.post(
    '/api/v1/team/assets/:assetId/delivery-grants',
    {
      schema: {
        params: AssetParamsSchema,
        body: DeliveryRequestSchema,
        response: { 200: DeliveryGrantSchema },
      },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      reply.header('Cache-Control', 'no-store');
      return services.assets.createDeliveryGrant(token, request.params.assetId, request.body);
    },
  );

  app.get(
    '/api/v1/team/assets/:assetId/content/:artifactId',
    { schema: { params: ContentParamsSchema, querystring: GrantQuerySchema } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      return sendOpenedContent(reply, request.headers.range, (range) =>
        services.assets.openContent(
          token,
          request.params.assetId,
          request.params.artifactId,
          request.query.grant,
          range,
        ),
      );
    },
  );

  app.get(
    '/api/v1/team/assets/:assetId/publication',
    { schema: { params: AssetParamsSchema, response: { 200: PublicationStateSchema } } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      const publication = await services.publication.getState(token, request.params.assetId);
      reply.header('ETag', `"${publication.revision}"`).header('Cache-Control', 'no-store');
      return publication;
    },
  );

  app.post(
    '/api/v1/team/assets/:assetId/publish',
    {
      schema: {
        params: AssetParamsSchema,
        body: PublishRequestSchema,
        response: { 200: PublishResultSchema, 201: PublishResultSchema },
      },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const result = await services.publication.publish(
        token,
        request.params.assetId,
        request.body,
        { requestId: request.id, idempotencyKey: requireIdempotencyKey(request) },
      );
      setRevision(reply, result.revision);
      return reply
        .code(result.created ? 201 : 200)
        .header('Cache-Control', 'no-store')
        .send(result as unknown as Static<typeof PublishResultSchema>);
    },
  );

  app.post(
    '/api/v1/team/assets/:assetId/withdraw',
    {
      schema: {
        params: AssetParamsSchema,
        body: ExpectedRevisionSchema,
        response: { 200: WithdrawResultSchema },
      },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const result = await services.publication.withdraw(
        token,
        request.params.assetId,
        request.body.expectedRevision,
        { requestId: request.id, idempotencyKey: requireIdempotencyKey(request) },
      );
      setRevision(reply, result.revision);
      return reply
        .header('Cache-Control', 'no-store')
        .send(result as unknown as Static<typeof WithdrawResultSchema>);
    },
  );

  app.post(
    '/api/v1/team/assets/:assetId/motion-preview-grants',
    { schema: { params: AssetParamsSchema } },
    async (request) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      await services.assets.get(token, request.params.assetId);
      throw new AppError(
        409,
        'MOTION_EXECUTION_UNAVAILABLE',
        '当前部署尚未具备动效执行所需的独立来源与服务器隔离。',
      );
    },
  );
}
