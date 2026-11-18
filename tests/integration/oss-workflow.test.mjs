import test from 'node:test';
import { runOssWorkflow } from '../fixtures/oss-workflow.mjs';

test(
  'OSS protocol: official SDK + API/worker + DB/object backup and restored authorization',
  { timeout: 240000 },
  async () => {
    console.info(JSON.stringify(await runOssWorkflow()));
  },
);
