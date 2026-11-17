import { isDemo } from '../demo/mode';
import { revisionHeader } from './revision-header';
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public fieldErrors?: { field: string; message: string }[],
    public retryAfter?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
let csrfToken = '';
const etags = new Map<string, string>();
export function setCsrfToken(token: string): void {
  csrfToken = token;
}
export function clearApiState(): void {
  csrfToken = '';
  etags.clear();
}
export function currentCsrfToken(): string {
  return csrfToken;
}
export function revisionTag(path: string, revision: string): string {
  return revisionHeader(revision, etags.get(path));
}
export interface ApiOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  etag?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  silentAuth?: boolean;
}
const SESSION_BOUND_PATHS = new Set([
  '/auth/session',
  '/auth/logout',
  '/auth/logout-all',
  '/auth/reauthenticate',
  '/auth/change-password',
]);
function isSessionBoundPath(path: string): boolean {
  return path.startsWith('/team/') || SESSION_BOUND_PATHS.has(path);
}
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('无效 API 路径');
  if (import.meta.env.DEV && isDemo) return (await import('../demo/api')).demoApi<T>(path, options);
  const method = options.method ?? 'GET';
  const headers = new Headers({ Accept: 'application/json', ...options.headers });
  if (options.body !== undefined && !(options.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  if (csrfToken && !['GET', 'HEAD'].includes(method)) headers.set('X-CSRF-Token', csrfToken);
  if (options.etag) headers.set('If-Match', options.etag);
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(options.body !== undefined
        ? { body: options.body instanceof FormData ? options.body : JSON.stringify(options.body) }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      method === 'GET'
        ? '暂时无法连接，请检查网络后重试。'
        : '尚未确认操作结果，请刷新状态后再决定是否重试。',
    );
  }
  const data: unknown =
    response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const problem = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const error = new ApiError(
      response.status,
      typeof problem.code === 'string' ? problem.code : `HTTP_${response.status}`,
      typeof problem.detail === 'string'
        ? problem.detail
        : typeof problem.message === 'string'
          ? problem.message
          : defaultError(response.status),
      typeof problem.requestId === 'string' ? problem.requestId : undefined,
      Array.isArray(problem.fieldErrors)
        ? (problem.fieldErrors as { field: string; message: string }[])
        : undefined,
      response.headers.get('Retry-After') ?? undefined,
    );
    if (response.status === 401 && isSessionBoundPath(path) && !options.silentAuth)
      window.dispatchEvent(new CustomEvent('shiling:session-expired'));
    throw error;
  }
  const tag = response.headers.get('ETag');
  if (tag) etags.set(path, tag);
  return data as T;
}
function defaultError(status: number): string {
  return (
    (
      {
        401: '登录已失效，请重新登录。',
        403: '当前账号没有执行此操作的权限。',
        404: '内容不可用或无权访问。',
        409: '状态已经变化，请刷新后重新确认。',
        412: '内容已被更新，请载入最新内容后重新确认。',
        428: '需要重新读取内容版本。',
        429: '操作较频繁，请稍后重试。',
        503: '服务暂不可用，请稍后重试。',
      } as Record<number, string>
    )[status] ?? '操作未完成，请稍后重试。'
  );
}
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.fieldErrors?.length) {
    return `${error.message} ${error.fieldErrors.map((field) => field.message).join('；')}`;
  }
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。';
}
export function operationKey(): string {
  return crypto.randomUUID();
}
export function safeResourceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (isDemo && url.protocol === 'blob:' && url.origin === window.location.origin)
      return url.href;
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
