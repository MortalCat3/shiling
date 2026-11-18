import { runOssWorkflow } from '../fixtures/oss-workflow.mjs';

// Requires a dedicated local shiling_test database and an explicitly authorized OSS prefix.
console.info(JSON.stringify(await runOssWorkflow({ real: true })));
