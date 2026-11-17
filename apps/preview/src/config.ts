import { isIP } from 'node:net';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export interface PreviewConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: (typeof logLevels)[number];
}

export function readPreviewConfig(env: NodeJS.ProcessEnv = process.env): PreviewConfig {
  const host = env['SHILING_PREVIEW_HOST'] ?? '127.0.0.1';
  const hostnameValid =
    host.length <= 253 &&
    host.split('.').every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
  if (isIP(host) === 0 && !hostnameValid) {
    throw new Error(
      'SHILING_PREVIEW_HOST must be an IP address or hostname, without a URL scheme or port.',
    );
  }

  const rawPort = env['SHILING_PREVIEW_PORT'] ?? '3001';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SHILING_PREVIEW_PORT must be an integer between 1 and 65535.');
  }

  const rawLevel = env['SHILING_LOG_LEVEL'] ?? 'info';
  const logLevel = logLevels.find((level) => level === rawLevel);
  if (logLevel === undefined) {
    throw new Error('SHILING_LOG_LEVEL must be fatal, error, warn, info, debug, trace, or silent.');
  }

  return Object.freeze({ host, port, logLevel });
}
