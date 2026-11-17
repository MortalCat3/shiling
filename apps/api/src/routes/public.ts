import { Type, type Static } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { AppError, type PublicationService, type PublicListInput } from '@shiling/backend';
import {
  AssetTypeSchema,
  DeliveryGrantSchema,
  DeliveryRequestSchema,
  PublicAssetSchema,
  UuidSchema,
  pageSchema,
} from '@shiling/contracts';
import type { FastifyInstance } from 'fastify';
import { sendOpenedContent } from './assets.js';

export interface PublicRouteServices {
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
const PublicQuerySchema = Type.Object(
  {
    q: Type.Optional(Type.String({ maxLength: 200 })),
    typeId: Type.Optional(
      Type.Union([
        AssetTypeSchema,
        Type.Array(AssetTypeSchema, { minItems: 1, maxItems: 3, uniqueItems: true }),
      ]),
    ),
    tag: Type.Optional(
      Type.Union([
        Type.String({ minLength: 1, maxLength: 40 }),
        Type.Array(Type.String({ minLength: 1, maxLength: 40 }), {
          minItems: 1,
          maxItems: 20,
          uniqueItems: true,
        }),
      ]),
    ),
    sort: Type.Optional(Type.Union([Type.Literal('publishedAtDesc'), Type.Literal('titleAsc')])),
    cursor: Type.Optional(Type.String({ maxLength: 2_048 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
const PublicFacetsSchema = Type.Object(
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
        { label: Type.String(), value: Type.String(), count: Type.Integer({ minimum: 0 }) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

function publicQuery(query: Static<typeof PublicQuerySchema>): PublicListInput {
  const { typeId, tag, ...rest } = query;
  return {
    ...rest,
    ...(typeId === undefined ? {} : { typeId: Array.isArray(typeId) ? typeId : [typeId] }),
    ...(tag === undefined ? {} : { tag: Array.isArray(tag) ? tag : [tag] }),
  };
}

export function registerPublicRoutes(
  instance: FastifyInstance,
  services: PublicRouteServices,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  app.get(
    '/api/v1/public/assets',
    {
      schema: {
        querystring: PublicQuerySchema,
        response: { 200: pageSchema(PublicAssetSchema) },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return services.publication.list(publicQuery(request.query));
    },
  );

  app.get(
    '/api/v1/public/assets/facets',
    { schema: { querystring: PublicQuerySchema, response: { 200: PublicFacetsSchema } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return services.publication.facets(publicQuery(request.query));
    },
  );

  app.get(
    '/api/v1/public/assets/:assetId',
    { schema: { params: AssetParamsSchema, response: { 200: PublicAssetSchema } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return services.publication.get(request.params.assetId);
    },
  );

  app.post(
    '/api/v1/public/assets/:assetId/delivery-grants',
    {
      schema: {
        params: AssetParamsSchema,
        body: DeliveryRequestSchema,
        response: { 200: DeliveryGrantSchema },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return services.publication.createDeliveryGrant(request.params.assetId, request.body);
    },
  );

  app.get(
    '/api/v1/public/assets/:assetId/content/:artifactId',
    {
      schema: { params: ContentParamsSchema, querystring: GrantQuerySchema },
      config: { rateLimit: { max: 180, timeWindow: '1 minute' } },
    },
    async (request, reply) =>
      sendOpenedContent(reply, request.headers.range, (range) =>
        services.publication.openContent(
          request.params.assetId,
          request.params.artifactId,
          request.query.grant,
          range,
        ),
      ),
  );

  app.post(
    '/api/v1/public/assets/:assetId/motion-preview-grants',
    {
      schema: { params: AssetParamsSchema },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request) => {
      await services.publication.get(request.params.assetId);
      throw new AppError(
        409,
        'MOTION_EXECUTION_UNAVAILABLE',
        '当前部署尚未具备动效执行所需的独立来源与服务器隔离。',
      );
    },
  );
}
