import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createApi } from '../apps/api/dist/app.js';
import { createPreview } from '../apps/preview/dist/app.js';

const api = createApi({
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  databaseUrl: 'postgresql://smoke@127.0.0.1:5432/smoke',
  migrationDatabaseUrl: null,
  migrationOwnerRole: null,
  storage: {
    driver: 'local',
    rootDirectory: fileURLToPath(new URL('../data/smoke', import.meta.url)),
    namespace: 'primary',
  },
  appOrigin: 'http://127.0.0.1:5173',
  publicOrigin: 'http://127.0.0.1:5173',
  previewOrigin: 'http://preview.localhost:3001',
  cookieSecure: false,
  setupToken: 'smoke-setup-token-00000000000000001',
  csrfSecret: 'smoke-csrf-secret-00000000000000001',
  deliverySecret: 'smoke-delivery-secret-000000000000001',
  deliveryGrantTtlSeconds: 120,
  sessionTtlSeconds: 3_600,
  uploadMaxBytes: 1024 * 1024,
});

try {
  const live = await api.inject({ method: 'GET', url: '/health/live' });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), {
    service: 'api',
    status: 'alive',
    scope: 'process',
  });

  const ready = await api.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(ready.json(), {
    service: 'api',
    status: 'not-ready',
    checks: { database: false, queue: false, storage: false },
  });
  assert.equal((await api.inject({ method: 'GET', url: '/__missing__' })).statusCode, 404);
} finally {
  await api.close();
}

const preview = createPreview({
  host: '127.0.0.1',
  port: 3001,
  logLevel: 'silent',
});

try {
  const live = await preview.inject({ method: 'GET', url: '/health/live' });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), {
    service: 'preview',
    status: 'alive',
    scope: 'process',
    businessReady: false,
    executionEnabled: false,
  });
  for (const url of ['/health/ready', '/__missing__', '/index.html']) {
    const response = await preview.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'PREVIEW_EXECUTION_DISABLED');
  }
} finally {
  await preview.close();
}

console.log('冒烟检查通过：API 未注入运行时不会误报就绪，动效预览执行保持关闭。');
