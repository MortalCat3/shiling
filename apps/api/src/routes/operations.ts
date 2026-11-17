import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { IdentityService, OperationsService } from '@shiling/backend';
import {
  DateTimeSchema,
  PageQuerySchema,
  SafeErrorSchema,
  UuidSchema,
  pageSchema,
} from '@shiling/contracts';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../config.js';
import { requireIdempotencyKey, requireMutationSession, requireSession } from '../http/security.js';

export interface OperationsRouteServices {
  readonly identity: IdentityService;
  readonly operations: OperationsService;
}

const IdParamsSchema = Type.Object({ id: UuidSchema }, { additionalProperties: false });
const JobStateSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('canceled'),
]);
const JobStateOutputSchema = Type.String({ minLength: 1, maxLength: 80 });
const JobQuerySchema = Type.Object(
  { ...PageQuerySchema.properties, state: Type.Optional(JobStateSchema) },
  { additionalProperties: false },
);
const AuditQuerySchema = Type.Object(
  {
    ...PageQuerySchema.properties,
    action: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);
const JobActionsSchema = Type.Object({ retry: Type.Boolean() }, { additionalProperties: false });
const JobSchema = Type.Object(
  {
    id: UuidSchema,
    kind: Type.String({ minLength: 1, maxLength: 200 }),
    state: JobStateOutputSchema,
    required: Type.Boolean(),
    attemptCount: Type.Integer({ minimum: 0 }),
    assetId: UuidSchema,
    uploadItemId: UuidSchema,
    safeError: Type.Union([SafeErrorSchema, Type.Null()]),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    actions: JobActionsSchema,
  },
  { additionalProperties: false },
);
const AttemptSchema = Type.Object(
  {
    id: UuidSchema,
    attempt: Type.Integer({ minimum: 1 }),
    state: Type.String({ minLength: 1, maxLength: 80 }),
    startedAt: DateTimeSchema,
    finishedAt: Type.Union([DateTimeSchema, Type.Null()]),
    errorCode: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
  },
  { additionalProperties: false },
);
const JobDetailSchema = Type.Object(
  { ...JobSchema.properties, attempts: Type.Array(AttemptSchema) },
  { additionalProperties: false },
);
const RetryResultSchema = Type.Object({ jobId: UuidSchema }, { additionalProperties: false });
const AuditEventSchema = Type.Object(
  {
    id: UuidSchema,
    actorKind: Type.String({ minLength: 1, maxLength: 80 }),
    actorId: Type.Union([UuidSchema, Type.Null()]),
    action: Type.String({ minLength: 1, maxLength: 200 }),
    resourceType: Type.String({ minLength: 1, maxLength: 120 }),
    resourceId: Type.Union([UuidSchema, Type.Null()]),
    outcome: Type.String({ minLength: 1, maxLength: 80 }),
    requestId: Type.String({ minLength: 1, maxLength: 200 }),
    changes: Type.Record(Type.String(), Type.Unknown()),
    createdAt: DateTimeSchema,
  },
  { additionalProperties: false },
);

export function registerOperationsRoutes(
  instance: FastifyInstance,
  config: ApiConfig,
  services: OperationsRouteServices,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  app.get(
    '/api/v1/team/admin/jobs',
    { schema: { querystring: JobQuerySchema, response: { 200: pageSchema(JobSchema) } } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      reply.header('Cache-Control', 'no-store');
      return services.operations.listJobs(token, request.query);
    },
  );

  app.get(
    '/api/v1/team/admin/jobs/:id',
    { schema: { params: IdParamsSchema, response: { 200: JobDetailSchema } } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      reply.header('Cache-Control', 'no-store');
      return services.operations.getJob(token, request.params.id);
    },
  );

  app.post(
    '/api/v1/team/admin/jobs/:id/retry',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: RetryResultSchema },
      },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const result = await services.operations.retryJob(token, request.params.id, {
        requestId: request.id,
        idempotencyKey: requireIdempotencyKey(request),
      });
      return reply.header('Cache-Control', 'no-store').send(result);
    },
  );

  app.get(
    '/api/v1/team/admin/audit-events',
    { schema: { querystring: AuditQuerySchema, response: { 200: pageSchema(AuditEventSchema) } } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      reply.header('Cache-Control', 'no-store');
      return services.operations.listAuditEvents(token, request.query);
    },
  );
}
