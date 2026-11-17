import { createWorkerRuntime } from './app.js';
import { readWorkerConfig } from './config.js';

async function main(): Promise<void> {
  const runtime = await createWorkerRuntime(readWorkerConfig());
  let stopping = false;
  const stop = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.info(JSON.stringify({ service: 'worker', event: 'worker.stopping', signal }));
    await runtime.close();
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
  await runtime.start();
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      service: 'worker',
      event: 'worker.start_failed',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    }),
  );
  process.exitCode = 1;
});
