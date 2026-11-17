import {
  isPermissionKey,
  type PermissionKey,
  type Role,
  type Session,
  type User,
} from '@shiling/contracts';
import { AppError } from '../../errors.js';
import type { Queryable, Transaction } from '../../ports/database.js';
import { csrfForToken, hashToken } from './security.js';

export interface IdentityOptions {
  setupToken: string;
  csrfSecret: string;
  sessionTtlSeconds?: number;
  freshAuthSeconds?: number;
  invitationTtlSeconds?: number;
  recoveryTtlSeconds?: number;
}

export interface Actor {
  id: string;
  userId: string;
  identityId: string;
  sessionId: string;
  roleKey: string;
  permissionKeys: PermissionKey[];
  session: Session;
}

interface SessionRow {
  session_id: string;
  identity_id: string;
  user_id: string;
  display_name: string;
  user_status: User['status'];
  user_revision: string;
  auth_epoch: string;
  role_id: string;
  role_key: string;
  role_name: string;
  role_kind: Role['kind'];
  role_revision: string;
  reauthenticated_at: Date;
  expires_at: Date;
  permission_keys: string[];
}

// A single lock serializes identity governance, acceptance and credential changes.
// Other domains can take shared row locks through authorize() for their own transaction.
export async function lockIdentityWrites(tx: Transaction): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('shiling:identity-write',0))");
}

export async function authorizeSession(
  db: Queryable,
  token: string,
  options: IdentityOptions,
  permission?: PermissionKey,
  fresh = false,
  lock = false,
): Promise<Actor> {
  if (!token || token.length > 512) throw new AppError(401, 'AUTH_REQUIRED', '请重新登录。');
  const result = await db.query<SessionRow>(
    `
    SELECT s.id session_id,s.identity_id,u.id user_id,u.display_name,u.status user_status,
      u.revision user_revision,u.auth_epoch,r.id role_id,r.key role_key,r.name role_name,
      r.kind role_kind,r.revision role_revision,s.reauthenticated_at,s.expires_at,
      ARRAY(SELECT rp.permission_key FROM shiling.role_permissions rp WHERE rp.role_id=r.id ORDER BY rp.permission_key) permission_keys
    FROM shiling.sessions s JOIN shiling.users u ON u.id=s.user_id
      JOIN shiling.identities i ON i.id=s.identity_id AND i.user_id=u.id
      JOIN shiling.roles r ON r.id=u.role_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
      AND u.status='active' AND i.status='active' AND r.archived_at IS NULL AND s.auth_epoch=u.auth_epoch
    ${lock ? 'FOR SHARE OF s,u,i,r' : ''}`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) throw new AppError(401, 'AUTH_REQUIRED', '登录状态已失效，请重新登录。');
  // Read permissions after row locks: a role edit may have committed while the
  // locking SELECT waited, and its command snapshot must not grant stale keys.
  const currentKeys = lock
    ? (
        await db.query<{ permission_key: string }>(
          'SELECT permission_key FROM shiling.role_permissions WHERE role_id=$1 ORDER BY permission_key',
          [row.role_id],
        )
      ).rows.map((entry) => entry.permission_key)
    : row.permission_keys;
  const permissionKeys = currentKeys.filter(isPermissionKey);
  if (permission && !permissionKeys.includes(permission))
    throw new AppError(403, 'FORBIDDEN', '没有执行此操作的权限。');
  if (
    fresh &&
    Date.now() - row.reauthenticated_at.getTime() > (options.freshAuthSeconds ?? 600) * 1000
  ) {
    throw new AppError(403, 'FRESH_AUTH_REQUIRED', '请先验证当前密码。');
  }
  const session: Session = {
    user: {
      id: row.user_id,
      displayName: row.display_name,
      status: row.user_status,
      roleId: row.role_id,
      revision: row.user_revision,
    },
    role: {
      id: row.role_id,
      key: row.role_key,
      name: row.role_name,
      kind: row.role_kind,
      revision: row.role_revision,
    },
    permissionKeys,
    authzVersion: `${row.auth_epoch}:${row.role_revision}`,
    csrfToken: csrfForToken(token, options.csrfSecret),
    expiresAt: row.expires_at.toISOString(),
  };
  return {
    id: row.user_id,
    userId: row.user_id,
    identityId: row.identity_id,
    sessionId: row.session_id,
    roleKey: row.role_key,
    permissionKeys,
    session,
  };
}
