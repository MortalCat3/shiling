import {
  AppError,
  constantTimeTextEqual,
  csrfForToken,
  type IdentityService,
} from '@shiling/backend';
import type { Session } from '@shiling/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiConfig } from '../config.js';

export function sessionCookieName(config: ApiConfig): string {
  return config.cookieSecure ? '__Host-shiling_session' : 'shiling_session';
}

export function setSessionCookie(
  reply: FastifyReply,
  config: ApiConfig,
  token: string,
  expiresAt: string,
): void {
  const maxAge = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1_000));
  reply.setCookie(sessionCookieName(config), token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: ApiConfig): void {
  reply.clearCookie(sessionCookieName(config), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
  });
}

export function requireSameOrigin(request: FastifyRequest, config: ApiConfig): void {
  const origin = request.headers.origin;
  if (origin !== config.appOrigin) {
    throw new AppError(403, 'ORIGIN_REJECTED', '请求来源不受信任。');
  }
}

export function sessionToken(request: FastifyRequest, config: ApiConfig): string {
  const token = request.cookies[sessionCookieName(config)];
  if (typeof token !== 'string' || token.length === 0) {
    throw new AppError(401, 'AUTH_REQUIRED', '请重新登录。');
  }
  return token;
}

export async function requireSession(
  request: FastifyRequest,
  config: ApiConfig,
  identity: IdentityService,
): Promise<{ readonly token: string; readonly session: Session }> {
  const token = sessionToken(request, config);
  return { token, session: await identity.getSession(token) };
}

export async function requireMutationSession(
  request: FastifyRequest,
  config: ApiConfig,
  identity: IdentityService,
): Promise<{ readonly token: string; readonly session: Session }> {
  requireSameOrigin(request, config);
  const authenticated = await requireSession(request, config, identity);
  const csrf = request.headers['x-csrf-token'];
  if (typeof csrf !== 'string' || !constantTimeTextEqual(csrf, authenticated.session.csrfToken)) {
    throw new AppError(403, 'CSRF_REJECTED', '安全校验已失效，请刷新页面后重试。');
  }
  return authenticated;
}

/**
 * Validates a cookie-bound mutation without requiring the session to still be active.
 * This is intentionally limited to logout: an expired or revoked session must still
 * prove same-origin possession of both the HttpOnly cookie and its derived CSRF token.
 */
export function requireCookieMutationToken(request: FastifyRequest, config: ApiConfig): string {
  requireSameOrigin(request, config);
  const token = sessionToken(request, config);
  const csrf = request.headers['x-csrf-token'];
  const expected = csrfForToken(token, config.csrfSecret);
  if (typeof csrf !== 'string' || !constantTimeTextEqual(csrf, expected)) {
    throw new AppError(403, 'CSRF_REJECTED', '安全校验已失效，请刷新页面后重试。');
  }
  return token;
}

export function requireExpectedRevision(request: FastifyRequest): string {
  const value = request.headers['if-match'];
  if (typeof value !== 'string') {
    throw new AppError(428, 'PRECONDITION_REQUIRED', '请提供当前资源修订号。');
  }
  const revision = /^(?:W\/)?"([1-9][0-9]*)"$/.exec(value)?.[1];
  if (revision === undefined) {
    throw new AppError(400, 'INVALID_PRECONDITION', 'If-Match 必须使用服务端返回的修订号。');
  }
  return revision;
}

export function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new AppError(428, 'IDEMPOTENCY_KEY_REQUIRED', '请提供有效的 Idempotency-Key。');
  }
  return value;
}

export function setRevision(reply: FastifyReply, revision: string): void {
  reply.header('ETag', `"${revision}"`);
}
