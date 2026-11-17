import type { PgBoss } from 'pg-boss';
import { AppError } from '../../errors.js';
import type { TaskQueue } from '../../ports/tasks.js';

/** Uses pg-boss's transaction adapter, not a second outbox or a separate connection. */
export function createTaskQueue(boss: PgBoss): TaskQueue {
  return {
    async enqueue(transaction, name, data) {
      const id = await boss.send(name, data, {
        db: { executeSql: async (sql, values) => transaction.query(sql, values) },
        retryLimit: 2,
        retryDelay: 5,
        expireInSeconds: 900,
      });
      if (!id) throw new AppError(503, 'QUEUE_ENQUEUE_FAILED', '任务暂时无法提交，请重试。', true);
      return id;
    },
  };
}
