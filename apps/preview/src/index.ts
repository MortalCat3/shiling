import { createPreview } from './app.js';
import { readPreviewConfig } from './config.js';

async function main(): Promise<void> {
  const config = readPreviewConfig();
  const app = createPreview(config);
  let shutdownPromise: Promise<void> | undefined;

  function shutdown(reason: string): Promise<void> {
    if (shutdownPromise !== undefined) return shutdownPromise;
    app.log.info({ reason }, 'Closing preview foundation');
    const deadline = setTimeout(() => {
      app.log.error('Preview shutdown exceeded 10 seconds');
      process.exit(1);
    }, 10_000);
    deadline.unref();
    shutdownPromise = app
      .close()
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'Preview shutdown failed');
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
    app.log.info('Preview foundation is alive; media serving and execution are not enabled');
  } catch (error: unknown) {
    if (shutdownPromise === undefined) {
      app.log.error({ err: error }, 'Preview startup failed');
      process.exitCode = 1;
    }
    await shutdown('startup-ended');
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Preview configuration failed.');
  process.exitCode = 1;
});
