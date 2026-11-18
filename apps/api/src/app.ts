import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyPluginCallback } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ApiConfig } from './config.js';
import { registerErrorHandling } from './http/errors.js';
import { createProxyTrust } from './http/proxy-trust.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerBrandingRoutes } from './routes/branding.js';
import { registerIdentityRoutes } from './routes/identity.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerOperationsRoutes } from './routes/operations.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerUploadRoutes } from './routes/uploads.js';
import type { ApiRuntime } from './runtime.js';

interface MultipartPluginOptions {
  readonly limits: {
    readonly files: number;
    readonly fields: number;
    readonly fileSize: number;
    readonly fieldNameSize: number;
    readonly fieldSize: number;
  };
}

const require = createRequire(import.meta.url);
const multipart = require('@fastify/multipart') as FastifyPluginCallback<MultipartPluginOptions>;

export function createApi(config: ApiConfig, runtime?: ApiRuntime) {
  const proxy = createProxyTrust(config.trustedProxyHost ?? null);
  const app = Fastify({
    trustProxy: proxy.trust,
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.x-csrf-token',
          'res.headers.set-cookie',
        ],
        censor: '[REDACTED]',
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    exposeHeadRoutes: false,
    bodyLimit: 1024 * 1024,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });

  // Resolve before preHandler rate limiting reads request.ip. This also avoids the
  // API/Caddy startup dependency cycle and follows proxy address changes on recreate.
  app.addHook('onRequest', async () => proxy.refresh());

  void app.register(cookie);
  void app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  void app.register(rateLimit, {
    global: false,
    hook: 'preHandler',
    keyGenerator: (request) => request.ip,
  });
  void app.register(multipart, {
    limits: {
      files: 1,
      fields: 8,
      fileSize: config.uploadMaxBytes,
      fieldNameSize: 100,
      fieldSize: 64 * 1024,
    },
  });

  registerErrorHandling(app);

  app.get('/health/live', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { service: 'api', status: 'alive', scope: 'process' };
  });

  app.get('/health/ready', async (_request, reply) => {
    const checks =
      runtime === undefined
        ? { database: false, queue: false, storage: false }
        : await runtime.checkReady();
    const ready = checks.database && checks.queue && checks.storage;
    reply.header('Cache-Control', 'no-store');
    return reply.code(ready ? 200 : 503).send({
      service: 'api',
      status: ready ? 'ready' : 'not-ready',
      checks,
    });
  });

  if (runtime !== undefined) {
    // Route registration must run after the queued plugins have installed their
    // decorators and onRoute hooks. Otherwise per-route rateLimit config is inert.
    void app.register(async (routes) => {
      registerIdentityRoutes(routes, config, runtime);
      registerUploadRoutes(routes, config, runtime);
      registerAssetRoutes(routes, config, runtime);
      registerBrandingRoutes(routes, config, runtime);
      registerLibraryRoutes(routes, config, runtime);
      registerSettingsRoutes(routes, config, runtime);
      registerOperationsRoutes(routes, config, runtime);
      registerPublicRoutes(routes, runtime);
    });
    app.addHook('onClose', async () => runtime.close());
  }

  return app;
}
