import { Type, type Static } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  AppError,
  type AssetListInput,
  type IdentityService,
  type LibraryService,
} from '@shiling/backend';
import {
  AssetBatchSchema,
  AssetTypeSchema,
  CollectionItemsSchema,
  CollectionSchema,
  CollectionWriteSchema,
  ExpectedRevisionSchema,
  PageQuerySchema,
  RevisionSchema,
  TagCreateSchema,
  TagSchema,
  TeamAssetSchema,
  UuidSchema,
  pageSchema,
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

export interface LibraryRouteServices {
  readonly identity: IdentityService;
  readonly library: LibraryService;
}

const IdParamsSchema = Type.Object({ id: UuidSchema }, { additionalProperties: false });
const AssetParamsSchema = Type.Object({ assetId: UuidSchema }, { additionalProperties: false });
const TagQuerySchema = Type.Object(
  {
    ...PageQuerySchema.properties,
    state: Type.Optional(
      Type.Union([Type.Literal('active'), Type.Literal('disabled'), Type.Literal('all')]),
    ),
  },
  { additionalProperties: false },
);
const CollectionQuerySchema = Type.Object(
  {
    ...PageQuerySchema.properties,
    state: Type.Optional(
      Type.Union([Type.Literal('active'), Type.Literal('archived'), Type.Literal('all')]),
    ),
  },
  { additionalProperties: false },
);
const AssetQuerySchema = Type.Object(
  {
    ...PageQuerySchema.properties,
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
    owner: Type.Optional(Type.Union([Type.Literal('me'), UuidSchema])),
    sort: Type.Optional(
      Type.Union([
        Type.Literal('createdAtDesc'),
        Type.Literal('updatedAtDesc'),
        Type.Literal('titleAsc'),
      ]),
    ),
  },
  { additionalProperties: false },
);
const CollectionAssetQuerySchema = Type.Omit(AssetQuerySchema, ['collectionId']);
const BatchResultSchema = Type.Object(
  {
    overall: Type.Union([
      Type.Literal('succeeded'),
      Type.Literal('partial'),
      Type.Literal('failed'),
    ]),
    items: Type.Array(
      Type.Object(
        {
          assetId: UuidSchema,
          outcome: Type.Union([
            Type.Literal('succeeded'),
            Type.Literal('denied'),
            Type.Literal('conflict'),
            Type.Literal('failed'),
          ]),
          code: Type.String(),
          revision: Type.Union([RevisionSchema, Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const FavoriteResultSchema = Type.Object(
  { assetId: UuidSchema, favorite: Type.Boolean() },
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

export function registerLibraryRoutes(
  instance: FastifyInstance,
  config: ApiConfig,
  services: LibraryRouteServices,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  app.get(
    '/api/v1/team/tags',
    { schema: { querystring: TagQuerySchema, response: { 200: pageSchema(TagSchema) } } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      reply.header('Cache-Control', 'no-store');
      return services.library.listTags(token, request.query);
    },
  );
  app.post(
    '/api/v1/team/tags',
    { schema: { body: TagCreateSchema, response: { 201: TagSchema } } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const tag = await services.library.createTag(token, request.body, {
        requestId: request.id,
        idempotencyKey: requireIdempotencyKey(request),
      });
      setRevision(reply, tag.revision);
      return reply.code(201).header('Cache-Control', 'no-store').send(tag);
    },
  );
  app.patch(
    '/api/v1/team/tags/:id',
    { schema: { params: IdParamsSchema, body: TagCreateSchema, response: { 200: TagSchema } } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const tag = await services.library.updateTag(
        token,
        request.params.id,
        request.body,
        requireExpectedRevision(request),
        request.id,
      );
      setRevision(reply, tag.revision);
      reply.header('Cache-Control', 'no-store');
      return tag;
    },
  );
  for (const [action, state] of [
    ['disable', 'disabled'],
    ['enable', 'active'],
  ] as const) {
    app.post(
      `/api/v1/team/tags/:id/${action}`,
      {
        schema: {
          params: IdParamsSchema,
          body: ExpectedRevisionSchema,
          response: { 200: TagSchema },
        },
      },
      async (request, reply) => {
        const { token } = await requireMutationSession(request, config, services.identity);
        const tag = await services.library.setTagState(
          token,
          request.params.id,
          state,
          request.body.expectedRevision,
          request.id,
        );
        setRevision(reply, tag.revision);
        reply.header('Cache-Control', 'no-store');
        return tag;
      },
    );
  }

  app.get(
    '/api/v1/team/collections',
    {
      schema: {
        querystring: CollectionQuerySchema,
        response: { 200: pageSchema(CollectionSchema) },
      },
    },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      reply.header('Cache-Control', 'no-store');
      return services.library.listCollections(token, request.query);
    },
  );
  app.post(
    '/api/v1/team/collections',
    { schema: { body: CollectionWriteSchema, response: { 201: CollectionSchema } } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const collection = await services.library.createCollection(token, request.body, {
        requestId: request.id,
        idempotencyKey: requireIdempotencyKey(request),
      });
      setRevision(reply, collection.revision);
      return reply.code(201).header('Cache-Control', 'no-store').send(collection);
    },
  );
  app.get(
    '/api/v1/team/collections/:id',
    { schema: { params: IdParamsSchema, response: { 200: CollectionSchema } } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      const collection = await services.library.getCollection(token, request.params.id);
      setRevision(reply, collection.revision);
      reply.header('Cache-Control', 'no-store');
      return collection;
    },
  );
  app.patch(
    '/api/v1/team/collections/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: CollectionWriteSchema,
        response: { 200: CollectionSchema },
      },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const collection = await services.library.updateCollection(
        token,
        request.params.id,
        request.body,
        requireExpectedRevision(request),
        request.id,
      );
      setRevision(reply, collection.revision);
      reply.header('Cache-Control', 'no-store');
      return collection;
    },
  );
  for (const [action, state] of [
    ['archive', 'archived'],
    ['restore', 'active'],
  ] as const) {
    app.post(
      `/api/v1/team/collections/:id/${action}`,
      {
        schema: {
          params: IdParamsSchema,
          body: ExpectedRevisionSchema,
          response: { 200: CollectionSchema },
        },
      },
      async (request, reply) => {
        const { token } = await requireMutationSession(request, config, services.identity);
        const collection = await services.library.setCollectionState(
          token,
          request.params.id,
          state,
          request.body.expectedRevision,
          request.id,
        );
        setRevision(reply, collection.revision);
        reply.header('Cache-Control', 'no-store');
        return collection;
      },
    );
  }
  app.get(
    '/api/v1/team/collections/:id/items',
    {
      schema: {
        params: IdParamsSchema,
        querystring: CollectionAssetQuerySchema,
        response: { 200: pageSchema(TeamAssetSchema) },
      },
    },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      reply.header('Cache-Control', 'no-store');
      return services.library.listCollectionItems(
        token,
        request.params.id,
        assetQuery(request.query),
      );
    },
  );
  // find-my-way 使用双冒号注册字面冒号，外部路径仍为 items:batch。
  app.post(
    '/api/v1/team/collections/:id/items::batch',
    {
      schema: {
        params: IdParamsSchema,
        body: CollectionItemsSchema,
        response: { 200: CollectionSchema },
      },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const collection = await services.library.updateCollectionItems(
        token,
        request.params.id,
        request.body,
        request.id,
      );
      setRevision(reply, collection.revision);
      reply.header('Cache-Control', 'no-store');
      return collection;
    },
  );

  app.get(
    '/api/v1/team/me/favorites',
    { schema: { querystring: AssetQuerySchema, response: { 200: pageSchema(TeamAssetSchema) } } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      reply.header('Cache-Control', 'no-store');
      return services.library.listFavorites(token, assetQuery(request.query));
    },
  );
  for (const [method, favorite] of [
    ['PUT', true],
    ['DELETE', false],
  ] as const) {
    app.route({
      method,
      url: '/api/v1/team/me/favorites/:assetId',
      schema: { params: AssetParamsSchema, response: { 200: FavoriteResultSchema } },
      handler: async (request, reply) => {
        const { token } = await requireMutationSession(request, config, services.identity);
        if (request.body !== undefined)
          throw new AppError(400, 'UNEXPECTED_BODY', '收藏操作不接受请求体。');
        reply.header('Cache-Control', 'no-store');
        return services.library.setFavorite(token, request.params.assetId, favorite, request.id);
      },
    });
  }
  app.post(
    '/api/v1/team/asset-batch-operations',
    { schema: { body: AssetBatchSchema, response: { 200: BatchResultSchema } } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      reply.header('Cache-Control', 'no-store');
      return services.library.batchAssets(token, request.body, {
        requestId: request.id,
        idempotencyKey: requireIdempotencyKey(request),
      });
    },
  );
}
