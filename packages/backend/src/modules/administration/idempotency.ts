import { createHash, randomUUID } from 'node:crypto';
import type { Transaction } from '../../ports/database.js';
import { AppError } from '../../errors.js';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}
export function requestHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export interface IdempotencyClaim {
  id: string;
  replay: boolean;
  resourceRefs: Record<string, unknown>;
}
export async function claimIdempotency(
  transaction: Transaction,
  actorId: string,
  operation: string,
  key: string,
  hash: string,
): Promise<IdempotencyClaim> {
  if (key.length < 8 || key.length > 128)
    throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', '请提供有效的幂等键。');
  await transaction.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
    `${actorId}:${operation}:${key}`,
  ]);
  await transaction.query(
    `DELETE FROM shiling.idempotency_records WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3 AND expires_at<=now()`,
    [actorId, operation, key],
  );
  const existing = await transaction.query<{
    id: string;
    request_hash: string;
    state: string;
    resource_refs: Record<string, unknown>;
  }>(
    `SELECT id,request_hash,state,resource_refs FROM shiling.idempotency_records WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3 FOR UPDATE`,
    [actorId, operation, key],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.request_hash !== hash)
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '该幂等键已用于不同请求。');
    if (row.state !== 'completed')
      throw new AppError(409, 'REQUEST_IN_PROGRESS', '请求仍在处理中。', true);
    return { id: row.id, replay: true, resourceRefs: row.resource_refs };
  }
  const id = randomUUID();
  await transaction.query(
    `INSERT INTO shiling.idempotency_records (id,actor_id,operation,idempotency_key,request_hash,state,resource_refs,expires_at) VALUES ($1,$2,$3,$4,$5,'started','{}',now()+interval '24 hours')`,
    [id, actorId, operation, key, hash],
  );
  return { id, replay: false, resourceRefs: {} };
}
export async function completeIdempotency(
  transaction: Transaction,
  id: string,
  resourceRefs: Record<string, unknown>,
): Promise<void> {
  await transaction.query(
    `UPDATE shiling.idempotency_records SET state='completed',resource_refs=$2::jsonb WHERE id=$1`,
    [id, JSON.stringify(resourceRefs)],
  );
}
