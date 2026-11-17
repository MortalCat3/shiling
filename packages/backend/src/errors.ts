import type { Problem } from '@shiling/contracts';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function toProblem(error: unknown, requestId: string): Problem {
  const known =
    error instanceof AppError
      ? error
      : new AppError(500, 'INTERNAL_ERROR', '服务暂时无法完成请求。');
  return {
    type: `urn:shiling:problem:${known.code.toLowerCase()}`,
    title: known.code,
    status: known.status,
    detail: known.message,
    instance: `urn:shiling:request:${requestId}`,
    code: known.code,
    requestId,
    retryable: known.retryable,
  };
}

export function assertRevision(actual: string, expected: string | undefined, patch = false): void {
  if (expected === undefined)
    throw new AppError(428, 'PRECONDITION_REQUIRED', '请提供当前资源修订号。');
  if (!/^[1-9][0-9]*$/.test(expected) || actual !== expected) {
    throw new AppError(
      patch ? 412 : 409,
      patch ? 'PRECONDITION_FAILED' : 'REVISION_CONFLICT',
      '内容已变化，请刷新后重试。',
    );
  }
}

export function mapDatabaseError(error: unknown): never {
  if (error instanceof AppError) throw error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === '23505') throw new AppError(409, 'RESOURCE_CONFLICT', '名称或请求已存在。');
  if (code === '23503')
    throw new AppError(409, 'RESOURCE_IN_USE', '资源仍被引用或关联目标已经变化。');
  if (code === '40001' || code === '40P01')
    throw new AppError(409, 'CONCURRENT_CHANGE', '操作发生并发冲突，请重试。', true);
  throw error;
}
