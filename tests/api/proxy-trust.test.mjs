import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createProxyTrust } from '../../apps/api/dist/http/proxy-trust.js';
import { readApiConfig } from '../../apps/api/dist/config.js';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const Fastify = require('fastify');
test('仅信任已解析代理的直接一跳；直连伪造与更远转发链不能决定客户端地址', async () => {
  const proxy = createProxyTrust('web', async () => ['172.20.0.8']);
  const app = Fastify({ trustProxy: proxy.trust });
  app.addHook('onRequest', async () => proxy.refresh());
  app.get('/', (req) => ({ ip: req.ip, protocol: req.protocol }));
  try {
    const trusted = await app.inject({
      url: '/',
      remoteAddress: '172.20.0.8',
      headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.8', 'x-forwarded-proto': 'https' },
    });
    assert.deepEqual(trusted.json(), { ip: '203.0.113.8', protocol: 'https' });
    const direct = await app.inject({
      url: '/',
      remoteAddress: '172.20.0.9',
      headers: { 'x-forwarded-for': '198.51.100.99', 'x-forwarded-proto': 'https' },
    });
    assert.deepEqual(direct.json(), { ip: '172.20.0.9', protocol: 'http' });
    assert.equal(proxy.trust('::ffff:172.20.0.8', 0), true);
    assert.equal(proxy.trust('172.20.0.8', 1), false);
  } finally {
    await app.close();
  }
});
test('DNS 地址轮换、并发解析合并、失败清除旧信任及默认不信任', async () => {
  let clock = 0;
  let calls = 0;
  let records = ['172.20.0.8'];
  const proxy = createProxyTrust(
    'web',
    async () => {
      calls++;
      if (!records) throw new Error('DNS unavailable');
      return records;
    },
    () => clock,
  );
  await Promise.all([proxy.refresh(), proxy.refresh(), proxy.refresh()]);
  assert.equal(calls, 1);
  records = ['172.20.0.9'];
  clock = 5001;
  await proxy.refresh();
  assert.equal(proxy.trust('172.20.0.8', 0), false);
  assert.equal(proxy.trust('172.20.0.9', 0), true);
  records = null;
  clock = 10002;
  await proxy.refresh();
  assert.equal(proxy.trust('172.20.0.9', 0), false);
  const disabled = createProxyTrust(null, async () => {
    throw new Error('Must not resolve');
  });
  await disabled.refresh();
  assert.equal(disabled.trust('127.0.0.1', 0), false);
});
test('配置拒绝无边界代理信任和 HTTPS 非 Secure cookie', () => {
  const env = {
    SHILING_DATABASE_URL: 'postgresql://shiling_app:fixture@localhost/shiling_test',
    SHILING_SETUP_TOKEN: 'fixture-setup-token-with-enough-length',
    SHILING_CSRF_SECRET: 'fixture-csrf-secret-with-enough-length',
    SHILING_DELIVERY_SECRET: 'fixture-delivery-secret-with-enough-length',
  };
  assert.equal(readApiConfig(env).trustedProxyHost, null);
  assert.equal(
    readApiConfig({ ...env, SHILING_TRUSTED_PROXY_HOST: 'web' }).trustedProxyHost,
    'web',
  );
  for (const value of ['true', '1', '*', '0.0.0.0/0', 'http://web', 'web:80', 'web,other'])
    assert.throws(() => readApiConfig({ ...env, SHILING_TRUSTED_PROXY_HOST: value }));
  assert.throws(() =>
    readApiConfig({
      ...env,
      SHILING_APP_ORIGIN: 'https://shiling.example',
      SHILING_COOKIE_SECURE: 'false',
    }),
  );
});
