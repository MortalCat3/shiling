import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: (typeof logLevels)[number];
  readonly databaseUrl: string;
  readonly migrationDatabaseUrl: string | null;
  readonly migrationOwnerRole: string | null;
  readonly storageDriver: 'local';
  readonly localStorageRoot: string;
  readonly appOrigin: string;
  readonly publicOrigin: string;
  readonly previewOrigin: string;
  readonly cookieSecure: boolean;
  readonly trustedProxyHost: string | null;
  readonly setupToken: string;
  readonly csrfSecret: string;
  readonly deliverySecret: string;
  readonly deliveryGrantTtlSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly uploadMaxBytes: number;
  readonly temporaryObjectRetentionSeconds: number;
}

export interface MigrationConfig {
  readonly databaseUrl: string;
  readonly ownerRole: string | null;
  readonly runtimeRole: string;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function readSecret(env: NodeJS.ProcessEnv, name: string, minimum: number): string {
  const value = env[name];
  if (value === undefined || value.length < minimum || value.length > 1_024) {
    throw new Error(`${name} must be configured with at least ${minimum} characters.`);
  }
  return value;
}

function readTrustedProxyHost(env: NodeJS.ProcessEnv): string | null {
  const value = env['SHILING_TRUSTED_PROXY_HOST'];
  if (!value) return null;
  if (isIP(value)) return value;
  if (
    value.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) ||
    value.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
    ['true', 'false'].includes(value) ||
    /^\d+$/.test(value)
  ) {
    throw new Error('SHILING_TRUSTED_PROXY_HOST must name one trusted proxy host or IP address.');
  }
  return value;
}

function readDatabaseUrl(env: NodeJS.ProcessEnv, name: string, required: boolean): string | null {
  const value = env[name];
  if (value === undefined) {
    if (required) throw new Error(`${name} must be configured.`);
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL.`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${name} must use postgres:// or postgresql://.`);
  }
  if (url.pathname.length <= 1) throw new Error(`${name} must select a dedicated database.`);
  return value;
}

function readOwnerRole(env: NodeJS.ProcessEnv): string | null {
  const ownerRole = env['SHILING_DATABASE_OWNER_ROLE'] ?? null;
  if (ownerRole !== null && !/^[a-z][a-z0-9_]{0,62}$/.test(ownerRole)) {
    throw new Error('SHILING_DATABASE_OWNER_ROLE must be a simple PostgreSQL role identifier.');
  }
  return ownerRole;
}

function readRuntimeRole(env: NodeJS.ProcessEnv): string {
  const runtimeRole = env['SHILING_DATABASE_RUNTIME_ROLE'] ?? 'shiling_app';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(runtimeRole)) {
    throw new Error('SHILING_DATABASE_RUNTIME_ROLE must be a simple PostgreSQL role identifier.');
  }
  return runtimeRole;
}

function readOrigin(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const value = env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} must be configured.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP origin.`);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(`${name} must contain only an http(s) scheme, host, and optional port.`);
  }
  return url.origin;
}

function resolveConfiguredPath(env: NodeJS.ProcessEnv, value: string): string {
  if (isAbsolute(value)) return value;
  const base = env['INIT_CWD'] ?? process.cwd();
  if (!isAbsolute(base)) throw new Error('INIT_CWD must be an absolute path when configured.');
  return resolve(base, value);
}

export function readApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const host = env['SHILING_API_HOST'] ?? '127.0.0.1';
  const hostnameValid =
    host.length <= 253 &&
    host.split('.').every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
  if (isIP(host) === 0 && !hostnameValid) {
    throw new Error(
      'SHILING_API_HOST must be an IP address or hostname, without a URL scheme or port.',
    );
  }

  const port = readInteger(env, 'SHILING_API_PORT', 3000, 1, 65_535);

  const rawLevel = env['SHILING_LOG_LEVEL'] ?? 'info';
  const logLevel = logLevels.find((level) => level === rawLevel);
  if (logLevel === undefined) {
    throw new Error('SHILING_LOG_LEVEL must be fatal, error, warn, info, debug, trace, or silent.');
  }

  const databaseUrl = readDatabaseUrl(env, 'SHILING_DATABASE_URL', true);
  if (databaseUrl === null) throw new Error('SHILING_DATABASE_URL must be configured.');
  const migrationDatabaseUrl = readDatabaseUrl(env, 'SHILING_MIGRATION_DATABASE_URL', false);
  const migrationOwnerRole = readOwnerRole(env);
  const storageDriver = env['SHILING_STORAGE_DRIVER'] ?? 'local';
  if (storageDriver !== 'local') {
    throw new Error(
      'SHILING_STORAGE_DRIVER must be local in this release; S3 requires its adapter.',
    );
  }
  const rawStorageRoot = env['SHILING_LOCAL_STORAGE_ROOT'] ?? './data/storage';
  const localStorageRoot = resolveConfiguredPath(env, rawStorageRoot);
  const appOrigin = readOrigin(env, 'SHILING_APP_ORIGIN', 'http://127.0.0.1:5173');
  const publicOrigin = readOrigin(env, 'SHILING_PUBLIC_ORIGIN', appOrigin);
  const previewOrigin = readOrigin(env, 'SHILING_PREVIEW_ORIGIN', 'http://preview.localhost:3001');
  const cookieSecure = readBoolean(env, 'SHILING_COOKIE_SECURE', appOrigin.startsWith('https://'));
  if (appOrigin.startsWith('https://') && !cookieSecure) {
    throw new Error('SHILING_COOKIE_SECURE cannot be false for an HTTPS app origin.');
  }
  const setupToken = readSecret(env, 'SHILING_SETUP_TOKEN', 32);
  const csrfSecret = readSecret(env, 'SHILING_CSRF_SECRET', 32);
  const deliverySecret = readSecret(env, 'SHILING_DELIVERY_SECRET', 32);
  const deliveryGrantTtlSeconds = readInteger(
    env,
    'SHILING_DELIVERY_GRANT_TTL_SECONDS',
    120,
    30,
    600,
  );
  const sessionTtlSeconds = readInteger(env, 'SHILING_SESSION_TTL_HOURS', 168, 1, 24 * 30) * 3_600;
  const uploadMaxBytes = readInteger(
    env,
    'SHILING_UPLOAD_MAX_BYTES',
    2 * 1024 * 1024 * 1024,
    1_024,
    10 * 1024 * 1024 * 1024,
  );
  const temporaryObjectRetentionSeconds =
    readInteger(env, 'SHILING_TEMP_OBJECT_RETENTION_HOURS', 24, 1, 24 * 30) * 3_600;

  return Object.freeze({
    host,
    port,
    logLevel,
    databaseUrl,
    migrationDatabaseUrl,
    migrationOwnerRole,
    storageDriver,
    localStorageRoot,
    appOrigin,
    publicOrigin,
    previewOrigin,
    cookieSecure,
    trustedProxyHost: readTrustedProxyHost(env),
    setupToken,
    csrfSecret,
    deliverySecret,
    deliveryGrantTtlSeconds,
    sessionTtlSeconds,
    uploadMaxBytes,
    temporaryObjectRetentionSeconds,
  });
}

export function readMigrationConfig(env: NodeJS.ProcessEnv = process.env): MigrationConfig {
  const databaseUrl = readDatabaseUrl(env, 'SHILING_MIGRATION_DATABASE_URL', true);
  if (databaseUrl === null) throw new Error('SHILING_MIGRATION_DATABASE_URL must be configured.');
  return Object.freeze({
    databaseUrl,
    ownerRole: readOwnerRole(env),
    runtimeRole: readRuntimeRole(env),
  });
}
