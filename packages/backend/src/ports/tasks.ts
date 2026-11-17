import type { Transaction } from './database.js';

export const TASK_NAMES = {
  verify: 'shiling-upload-verify',
  process: 'shiling-media-process',
  cleanup: 'shiling-storage-cleanup',
} as const;
export type TaskName = (typeof TASK_NAMES)[keyof typeof TASK_NAMES];
export interface CleanupTask {
  reason: 'startup' | 'periodic' | 'followup';
}
export interface TaskQueue {
  enqueue(transaction: Transaction, name: TaskName, data: Record<string, unknown>): Promise<string>;
}
