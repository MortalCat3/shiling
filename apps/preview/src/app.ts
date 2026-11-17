import Fastify, { LogController } from 'fastify';
import type { PreviewConfig } from './config.js';

export function createPreview(config: PreviewConfig) {
  const app = Fastify({
    logger: { level: config.logLevel },
    logController: new LogController({ disableRequestLogging: true }),
    exposeHeadRoutes: false,
    bodyLimit: 1024,
  });

  // This listener does not load, serve, or execute uploaded content.
  app.get('/health/live', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      service: 'preview',
      status: 'alive',
      scope: 'process',
      businessReady: false,
      executionEnabled: false,
    };
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({
      code: 'PREVIEW_EXECUTION_DISABLED',
      message: 'Media serving and preview execution are not enabled.',
    });
  });

  return app;
}
