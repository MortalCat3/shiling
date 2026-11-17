import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { IdentityService, SettingsService } from '@shiling/backend';
import {
  DateTimeSchema,
  DecimalSchema,
  ProductSettingsPatchSchema,
  ProductSettingsSchema,
} from '@shiling/contracts';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../config.js';
import {
  requireExpectedRevision,
  requireMutationSession,
  requireSession,
  setRevision,
} from '../http/security.js';

export interface SettingsRouteServices {
  readonly identity: IdentityService;
  readonly settings: SettingsService;
}

const OperationsSummarySchema = Type.Object(
  {
    evaluatedAt: DateTimeSchema,
    database: Type.Object({ reachable: Type.Boolean() }, { additionalProperties: false }),
    storage: Type.Object(
      {
        basis: Type.Literal('databaseMetadata'),
        storedBytes: DecimalSchema,
        storedObjects: DecimalSchema,
        integrityIssues: DecimalSchema,
      },
      { additionalProperties: false },
    ),
    jobs: Type.Array(
      Type.Object({ state: Type.String(), count: DecimalSchema }, { additionalProperties: false }),
    ),
    assets: Type.Array(
      Type.Object(
        { lifecycle: Type.String(), count: DecimalSchema },
        { additionalProperties: false },
      ),
    ),
    publicEnabled: Type.Boolean(),
    preview: Type.Object(
      {
        configured: Type.Boolean(),
        isolationReady: Type.Boolean(),
        executionEnabled: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export function registerSettingsRoutes(
  instance: FastifyInstance,
  config: ApiConfig,
  services: SettingsRouteServices,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  app.get(
    '/api/v1/team/admin/settings',
    { schema: { response: { 200: ProductSettingsSchema } } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      const settings = await services.settings.getSettings(token);
      setRevision(reply, settings.revision);
      reply.header('Cache-Control', 'no-store');
      return settings;
    },
  );
  app.patch(
    '/api/v1/team/admin/settings',
    { schema: { body: ProductSettingsPatchSchema, response: { 200: ProductSettingsSchema } } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      const settings = await services.settings.patchSettings(
        token,
        request.body,
        requireExpectedRevision(request),
        request.id,
      );
      setRevision(reply, settings.revision);
      reply.header('Cache-Control', 'no-store');
      return settings;
    },
  );
  app.get(
    '/api/v1/team/admin/operations',
    { schema: { response: { 200: OperationsSummarySchema } } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, services.identity);
      reply.header('Cache-Control', 'no-store');
      return services.settings.getOperationsSummary(token);
    },
  );
}
