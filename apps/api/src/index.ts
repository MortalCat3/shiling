import { createApi } from './app.js';
import { readApiConfig } from './config.js';
import { createApiRuntime } from './runtime.js';

async function main(): Promise<void> {
  const config = readApiConfig();
  const runtime = await createApiRuntime(config);
  const app = createApi(config, runtime);
  let shutdownPromise: Promise<void> | undefined;

  function shutdown(reason: string): Promise<void> {
    if (shutdownPromise !== undefined) return shutdownPromise;
    app.log.info({ reason }, 'Closing API service');
    const deadline = setTimeout(() => {
      app.log.error('API shutdown exceeded 10 seconds');
      process.exit(1);
    }, 10_000);
    deadline.unref();
    shutdownPromise = app
      .close()
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'API shutdown failed');
        process.exitCode = 1;
      })
      .finally(() => {
        clearTimeout(deadline);
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
      });
    return shutdownPromise;
  }

  const onInterrupt = () => {
    void shutdown('SIGINT');
  };
  const onTerminate = () => {
    void shutdown('SIGTERM');
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info('API service is listening');
  } catch (error: unknown) {
    if (shutdownPromise === undefined) {
      app.log.error({ err: error }, 'API startup failed');
      process.exitCode = 1;
    }
    await shutdown('startup-ended');
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'API configuration failed.');
  process.exitCode = 1;
});
