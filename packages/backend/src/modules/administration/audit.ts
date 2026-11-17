import { randomUUID } from 'node:crypto';
import type { Transaction } from '../../ports/database.js';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string;
  outcome?: 'success' | 'denied' | 'failed';
  changes?: Record<string, unknown>;
}
export async function appendAudit(transaction: Transaction, entry: AuditEntry): Promise<void> {
  await transaction.query(
    `INSERT INTO shiling.audit_events
    (id,actor_kind,actor_id,action,resource_type,resource_id,outcome,request_id,changes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      randomUUID(),
      entry.actorId === null ? 'system' : 'user',
      entry.actorId,
      entry.action,
      entry.resourceType,
      entry.resourceId,
      entry.outcome ?? 'success',
      entry.requestId,
      JSON.stringify(entry.changes ?? {}),
    ],
  );
}
