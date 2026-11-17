import { AppError, toProblem } from '@shiling/backend';
import type { FastifyInstance } from 'fastify';

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const validationIssues =
      typeof error === 'object' &&
      error !== null &&
      'validation' in error &&
      Array.isArray(error.validation)
        ? error.validation
        : null;
    const validation = validationIssues !== null;
    const missingExpectedRevision =
      validationIssues?.some((issue: unknown) => {
        if (typeof issue !== 'object' || issue === null || !('params' in issue)) return false;
        const params = issue.params;
        return (
          typeof params === 'object' &&
          params !== null &&
          'missingProperty' in params &&
          params.missingProperty === 'expectedRevision'
        );
      }) ?? false;
    const statusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : null;
    const normalized = missingExpectedRevision
      ? new AppError(428, 'PRECONDITION_REQUIRED', '请求必须携带当前修订号。')
      : validation
        ? new AppError(400, 'VALIDATION_ERROR', '请求字段不符合要求。')
        : statusCode === 413
          ? new AppError(413, 'PAYLOAD_TOO_LARGE', '请求内容超过当前实例限制。')
          : statusCode === 429
            ? new AppError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试。', true)
            : error;
    const problem = toProblem(normalized, request.id);
    if (problem.status >= 500)
      request.log.error({ err: error, code: problem.code }, 'Request failed');
    else request.log.info({ code: problem.code, status: problem.status }, 'Request rejected');
    return reply
      .code(problem.status)
      .type('application/problem+json')
      .header('Cache-Control', 'no-store')
      .send(problem);
  });

  app.setNotFoundHandler((request, reply) => {
    const problem = toProblem(
      new AppError(404, 'ROUTE_NOT_FOUND', '请求的接口不存在。'),
      request.id,
    );
    return reply
      .code(404)
      .type('application/problem+json')
      .header('Cache-Control', 'no-store')
      .send(problem);
  });
}
