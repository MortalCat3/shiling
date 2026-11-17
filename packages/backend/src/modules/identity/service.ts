import { randomUUID } from 'node:crypto';
import {
  PERMISSION_DEPENDENCIES,
  isPermissionKey,
  type Invitation,
  type PermissionKey,
  type Role,
  type User,
} from '@shiling/contracts';
import { AppError, assertRevision, mapDatabaseError } from '../../errors.js';
import type { Database, Queryable, Transaction } from '../../ports/database.js';
import { appendAudit } from '../administration/audit.js';
import {
  claimIdempotency,
  completeIdempotency,
  requestHash,
} from '../administration/idempotency.js';
import { authorizeSession, lockIdentityWrites, type IdentityOptions } from './authorization.js';
import {
  constantTimeTextEqual,
  hashPassword,
  hashToken,
  newToken,
  normalizeDisplayName,
  normalizeLoginName,
  verifyDummyPassword,
  verifyPassword,
} from './security.js';

const ADMIN_ROLE_ID = '00000000-0000-4000-8000-000000000001';
interface UserRow {
  id: string;
  display_name: string;
  status: User['status'];
  role_id: string;
  revision: string;
}
interface RoleRow {
  id: string;
  key: string;
  name: string;
  kind: Role['kind'];
  revision: string;
  archived_at: Date | null;
}
interface CredentialRow {
  user_id: string;
  identity_id: string;
  password_hash: string;
  auth_epoch: string;
  status: string;
  identity_status: string;
  archived_at: Date | null;
}
interface InvitationRow {
  id: string;
  user_id: string;
  revision: string;
  state: Invitation['state'];
  expires_at: Date | null;
  subject: string | null;
}
export interface RoleDefinition extends Role {
  permissionKeys: PermissionKey[];
  archivedAt: string | null;
}
export interface InvitationInput {
  loginName?: string;
  roleId: string;
  expiresInSeconds?: number;
}
export interface MutationContext {
  requestId: string;
  idempotencyKey: string;
}
function userDto(row: UserRow): User {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    roleId: row.role_id,
    revision: row.revision,
  };
}
function roleDto(row: RoleRow): Role {
  return { id: row.id, key: row.key, name: row.name, kind: row.kind, revision: row.revision };
}
function invitationDto(row: InvitationRow): Invitation {
  return {
    id: row.id,
    userId: row.user_id,
    revision: row.revision,
    state: row.state,
    expiresAt: row.expires_at?.toISOString() ?? null,
    reservedLoginName: row.subject,
  };
}

async function getUser(db: Queryable, id: string): Promise<User> {
  const row = (
    await db.query<UserRow>(
      'SELECT id,display_name,status,role_id,revision FROM shiling.users WHERE id=$1',
      [id],
    )
  ).rows[0];
  if (!row) throw new AppError(404, 'MEMBER_NOT_FOUND', '成员不存在。');
  return userDto(row);
}
async function getRole(db: Queryable, id: string): Promise<RoleRow> {
  const row = (
    await db.query<RoleRow>(
      'SELECT id,key,name,kind,revision,archived_at FROM shiling.roles WHERE id=$1',
      [id],
    )
  ).rows[0];
  if (!row || row.archived_at) throw new AppError(409, 'ROLE_UNAVAILABLE', '角色不存在或已停用。');
  return row;
}
async function invitationById(db: Queryable, id: string): Promise<Invitation> {
  const row = (
    await db.query<InvitationRow>(
      `SELECT v.id,v.user_id,v.revision,v.state,i.subject,t.expires_at
    FROM shiling.invitations v LEFT JOIN shiling.identities i ON i.user_id=v.user_id AND i.provider_key='password'
    LEFT JOIN LATERAL(SELECT expires_at FROM shiling.auth_tokens WHERE invitation_id=v.id ORDER BY created_at DESC,id DESC LIMIT 1)t ON true
    WHERE v.id=$1`,
      [id],
    )
  ).rows[0];
  if (!row) throw new AppError(404, 'INVITATION_NOT_FOUND', '邀请不存在。');
  return invitationDto(row);
}
async function revokeSessions(tx: Transaction, userId: string, reason: string): Promise<void> {
  await tx.query(
    'UPDATE shiling.sessions SET revoked_at=now(),revoke_reason=$2 WHERE user_id=$1 AND revoked_at IS NULL',
    [userId, reason],
  );
}
async function protectLastAdmin(tx: Transaction, userId: string): Promise<void> {
  const current = (
    await tx.query<{ status: string; key: string }>(
      'SELECT u.status,r.key FROM shiling.users u JOIN shiling.roles r ON r.id=u.role_id WHERE u.id=$1',
      [userId],
    )
  ).rows[0];
  if (current?.status === 'active' && current.key === 'sysadmin') {
    const count = (
      await tx.query<{ count: string }>(
        "SELECT count(*) FROM shiling.users WHERE status='active' AND role_id=$1",
        [ADMIN_ROLE_ID],
      )
    ).rows[0];
    if (Number(count?.count ?? 0) <= 1)
      throw new AppError(409, 'LAST_ADMIN_REQUIRED', '必须保留至少一位可用的系统管理员。');
  }
}
function validatePermissions(keys: readonly string[]): PermissionKey[] {
  const result: PermissionKey[] = [];
  for (const key of new Set(keys)) {
    if (!isPermissionKey(key) || key.startsWith('system.'))
      throw new AppError(400, 'INVALID_ROLE_PERMISSION', '自定义角色只能授予有效的业务能力。');
    result.push(key);
  }
  for (const key of result) {
    for (const dependency of PERMISSION_DEPENDENCIES[key] ?? []) {
      if (!result.includes(dependency))
        throw new AppError(400, 'ROLE_DEPENDENCY_MISSING', `能力 ${key} 缺少依赖 ${dependency}。`);
    }
  }
  return result.sort();
}
function roleName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80)
    throw new AppError(400, 'INVALID_ROLE_NAME', '角色名称长度应为 1 至 80 个字符。');
  return name;
}

export function createIdentityService(database: Database, options: IdentityOptions) {
  if (options.setupToken.length < 32 || options.csrfSecret.length < 32)
    throw new Error('Setup token and CSRF secret must contain at least 32 characters.');
  for (const value of [
    options.sessionTtlSeconds ?? 86400,
    options.freshAuthSeconds ?? 600,
    options.invitationTtlSeconds ?? 86400,
    options.recoveryTtlSeconds ?? 900,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 604800)
      throw new Error('Identity TTL must be a positive integer no greater than 604800 seconds.');
  }
  async function write<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await database.transaction(async (tx) => {
        await lockIdentityWrites(tx);
        return work(tx);
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }
  async function credential(
    db: Queryable,
    where: 'subject' | 'identity',
    value: string,
  ): Promise<CredentialRow | undefined> {
    return (
      await db.query<CredentialRow>(
        `SELECT u.id user_id,i.id identity_id,p.password_hash,u.auth_epoch,u.status,i.status identity_status,r.archived_at
      FROM shiling.identities i JOIN shiling.users u ON u.id=i.user_id JOIN shiling.roles r ON r.id=u.role_id
      JOIN shiling.password_credentials p ON p.identity_id=i.id WHERE i.provider_key='password' AND ${where === 'subject' ? 'i.subject' : 'i.id'}=$1`,
        [value],
      )
    ).rows[0];
  }
  async function checkCurrentPassword(token: string, password: string) {
    const actor = await authorizeSession(database, token, options);
    const found = await credential(database, 'identity', actor.identityId);
    if (!found || !(await verifyPassword(password, found.password_hash)))
      throw new AppError(403, 'INVALID_CREDENTIALS', '当前密码不正确。');
    return { actor, passwordHash: found.password_hash };
  }
  async function roleDefinition(db: Queryable, id: string): Promise<RoleDefinition> {
    const row = (
      await db.query<RoleRow>(
        'SELECT id,key,name,kind,revision,archived_at FROM shiling.roles WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!row) throw new AppError(404, 'ROLE_NOT_FOUND', '角色不存在。');
    const permissions = await db.query<{ permission_key: string }>(
      'SELECT permission_key FROM shiling.role_permissions WHERE role_id=$1 ORDER BY permission_key',
      [id],
    );
    return {
      ...roleDto(row),
      permissionKeys: permissions.rows.map((entry) => entry.permission_key).filter(isPermissionKey),
      archivedAt: row.archived_at?.toISOString() ?? null,
    };
  }

  return {
    authorize: (tx: Transaction, token: string, permission?: PermissionKey, fresh = false) =>
      authorizeSession(tx, token, options, permission, fresh, true),
    async bootstrap() {
      const row = (
        await database.query<{
          initialized_at: Date | null;
          logo_branding_asset_id: string | null;
          favicon_branding_asset_id: string | null;
          values: {
            name?: string;
            brandDescription?: string;
            primaryColor?: string;
            publicEnabled?: boolean;
          };
        }>(
          `SELECT initialized_at,logo_branding_asset_id,favicon_branding_asset_id,values
          FROM shiling.product_settings WHERE id=1`,
        )
      ).rows[0];
      if (!row) throw new AppError(503, 'DATABASE_NOT_READY', '服务尚未完成数据库准备。', true);
      const name = row.values.name ?? '拾灵';
      return {
        initialized: row.initialized_at !== null,
        name,
        publicEnabled: row.values.publicEnabled ?? false,
        brand: {
          name,
          description: row.values.brandDescription ?? '收集灵感，让好素材被再次使用。',
          primaryColor:
            typeof row.values.primaryColor === 'string' &&
            /^#[0-9a-fA-F]{6}$/.test(row.values.primaryColor)
              ? row.values.primaryColor.toLowerCase()
              : '#7657c8',
          logoUrl: row.logo_branding_asset_id
            ? `/api/v1/branding/logo?v=${row.logo_branding_asset_id}`
            : null,
          faviconUrl: row.favicon_branding_asset_id
            ? `/api/v1/branding/favicon?v=${row.favicon_branding_asset_id}`
            : null,
        },
        loginMethods: ['password'] as ['password'],
      };
    },
    async initialize(
      input: { setupToken: string; loginName: string; displayName: string; password: string },
      requestId: string,
    ) {
      if (!constantTimeTextEqual(input.setupToken, options.setupToken))
        throw new AppError(403, 'INVALID_SETUP_TOKEN', '初始化凭据无效。');
      const subject = normalizeLoginName(input.loginName);
      const displayName = normalizeDisplayName(input.displayName);
      const passwordHash = await hashPassword(input.password);
      return write(async (tx) => {
        const settings = (
          await tx.query<{ initialized_at: Date | null }>(
            'SELECT initialized_at FROM shiling.product_settings WHERE id=1 FOR UPDATE',
          )
        ).rows[0];
        if (!settings)
          throw new AppError(503, 'DATABASE_NOT_READY', '服务尚未完成数据库准备。', true);
        if (settings.initialized_at)
          throw new AppError(409, 'ALREADY_INITIALIZED', '平台已完成初始化。');
        const userId = randomUUID();
        const identityId = randomUUID();
        await tx.query(
          "INSERT INTO shiling.users(id,display_name,status,role_id,activated_at) VALUES($1,$2,'active',$3,now())",
          [userId, displayName, ADMIN_ROLE_ID],
        );
        await tx.query(
          "INSERT INTO shiling.identities(id,user_id,provider_key,subject,verified_at) VALUES($1,$2,'password',$3,now())",
          [identityId, userId, subject],
        );
        await tx.query(
          'INSERT INTO shiling.password_credentials(identity_id,password_hash) VALUES($1,$2)',
          [identityId, passwordHash],
        );
        await tx.query(
          'UPDATE shiling.product_settings SET initialized_at=now(),updated_by=$1 WHERE id=1',
          [userId],
        );
        await appendAudit(tx, {
          actorId: userId,
          action: 'identity.initialize',
          resourceType: 'user',
          resourceId: userId,
          requestId,
        });
        // Deliberately no session: initialization and login are distinct contracts.
        return { initialized: true as const, user: await getUser(tx, userId) };
      });
    },
    async login(input: { loginName: string; password: string }, requestId: string) {
      let subject: string;
      try {
        subject = normalizeLoginName(input.loginName);
      } catch {
        await verifyDummyPassword(input.password);
        throw new AppError(401, 'INVALID_CREDENTIALS', '账号或密码不正确。');
      }
      const found = await credential(database, 'subject', subject);
      const validPassword = found
        ? await verifyPassword(input.password, found.password_hash)
        : (await verifyDummyPassword(input.password), false);
      if (
        !found ||
        !validPassword ||
        found.status !== 'active' ||
        found.identity_status !== 'active' ||
        found.archived_at
      )
        throw new AppError(401, 'INVALID_CREDENTIALS', '账号或密码不正确。');
      return write(async (tx) => {
        const current = await credential(tx, 'identity', found.identity_id);
        if (
          !current ||
          current.password_hash !== found.password_hash ||
          current.status !== 'active' ||
          current.identity_status !== 'active' ||
          current.archived_at
        )
          throw new AppError(401, 'INVALID_CREDENTIALS', '账号或密码不正确。');
        const sessionToken = newToken();
        const sessionId = randomUUID();
        const expiresAt = new Date(Date.now() + (options.sessionTtlSeconds ?? 86400) * 1000);
        await tx.query(
          'INSERT INTO shiling.sessions(id,user_id,identity_id,token_hash,auth_epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
          [
            sessionId,
            current.user_id,
            current.identity_id,
            hashToken(sessionToken),
            current.auth_epoch,
            expiresAt,
          ],
        );
        await appendAudit(tx, {
          actorId: current.user_id,
          action: 'identity.login',
          resourceType: 'session',
          resourceId: sessionId,
          requestId,
        });
        return {
          sessionToken,
          expiresAt: expiresAt.toISOString(),
          session: (await authorizeSession(tx, sessionToken, options)).session,
        };
      });
    },
    async getSession(token: string) {
      return (await authorizeSession(database, token, options)).session;
    },
    async reauthenticate(token: string, password: string, requestId: string) {
      const checked = await checkCurrentPassword(token, password);
      return write(async (tx) => {
        const actor = await authorizeSession(tx, token, options);
        if (
          (await credential(tx, 'identity', actor.identityId))?.password_hash !==
          checked.passwordHash
        )
          throw new AppError(403, 'INVALID_CREDENTIALS', '密码已发生变化，请重新登录。');
        await tx.query('UPDATE shiling.sessions SET reauthenticated_at=now() WHERE id=$1', [
          actor.sessionId,
        ]);
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'identity.reauthenticate',
          resourceType: 'session',
          resourceId: actor.sessionId,
          requestId,
        });
        return (await authorizeSession(tx, token, options)).session;
      });
    },
    async logout(token: string, requestId: string): Promise<void> {
      await write(async (tx) => {
        const row = (
          await tx.query<{ id: string; user_id: string }>(
            'UPDATE shiling.sessions SET revoked_at=now(),revoke_reason=$2 WHERE token_hash=$1 AND revoked_at IS NULL RETURNING id,user_id',
            [hashToken(token), 'logout'],
          )
        ).rows[0];
        if (row)
          await appendAudit(tx, {
            actorId: row.user_id,
            action: 'identity.logout',
            resourceType: 'session',
            resourceId: row.id,
            requestId,
          });
      });
    },
    async logoutAll(token: string, requestId: string): Promise<void> {
      await write(async (tx) => {
        const actor = await authorizeSession(tx, token, options, undefined, true);
        await tx.query('UPDATE shiling.users SET auth_epoch=auth_epoch+1 WHERE id=$1', [actor.id]);
        await revokeSessions(tx, actor.id, 'logout_all');
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'identity.logout_all',
          resourceType: 'user',
          resourceId: actor.id,
          requestId,
        });
      });
    },
    async changePassword(
      token: string,
      input: { currentPassword: string; newPassword: string },
      requestId: string,
    ): Promise<void> {
      const checked = await checkCurrentPassword(token, input.currentPassword);
      const passwordHash = await hashPassword(input.newPassword);
      await write(async (tx) => {
        const actor = await authorizeSession(tx, token, options);
        if (
          (await credential(tx, 'identity', actor.identityId))?.password_hash !==
          checked.passwordHash
        )
          throw new AppError(409, 'CREDENTIALS_CHANGED', '密码已发生变化，请重新登录。');
        await tx.query(
          'UPDATE shiling.password_credentials SET password_hash=$2,changed_at=now() WHERE identity_id=$1',
          [actor.identityId, passwordHash],
        );
        await tx.query('UPDATE shiling.users SET auth_epoch=auth_epoch+1 WHERE id=$1', [actor.id]);
        await revokeSessions(tx, actor.id, 'password_changed');
        await tx.query(
          "UPDATE shiling.auth_tokens SET revoked_at=now() WHERE user_id=$1 AND purpose='recovery' AND consumed_at IS NULL AND revoked_at IS NULL",
          [actor.id],
        );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'identity.password_changed',
          resourceType: 'user',
          resourceId: actor.id,
          requestId,
        });
      });
    },
    async createInvitation(token: string, input: InvitationInput, context: MutationContext) {
      const subject = input.loginName === undefined ? null : normalizeLoginName(input.loginName);
      const ttl = input.expiresInSeconds ?? options.invitationTtlSeconds ?? 86400;
      if (!Number.isSafeInteger(ttl) || ttl < 300 || ttl > 604800)
        throw new AppError(400, 'INVALID_EXPIRY', '邀请有效期应为 5 分钟至 7 天。');
      return write(async (tx) => {
        const actor = await authorizeSession(tx, token, options, 'system.members.manage', true);
        const claim = await claimIdempotency(
          tx,
          actor.id,
          'invitations.create',
          context.idempotencyKey,
          requestHash({ subject, roleId: input.roleId, ttl }),
        );
        if (claim.replay)
          return {
            invitation: await invitationById(tx, String(claim.resourceRefs.invitationId)),
            token: null,
            replayed: true,
          };
        const role = await getRole(tx, input.roleId);
        if (role.key === 'sysadmin')
          throw new AppError(
            400,
            'INVITATION_ADMIN_FORBIDDEN',
            '普通邀请不能创建系统管理员，请先邀请为成员后再调整角色。',
          );
        const userId = randomUUID();
        const invitationId = randomUUID();
        const invitationToken = newToken();
        await tx.query(
          "INSERT INTO shiling.users(id,display_name,status,role_id,created_by) VALUES($1,$2,'invited',$3,$4)",
          [userId, subject ?? '待接受邀请', role.id, actor.id],
        );
        if (subject)
          await tx.query(
            "INSERT INTO shiling.identities(id,user_id,provider_key,subject) VALUES($1,$2,'password',$3)",
            [randomUUID(), userId, subject],
          );
        await tx.query('INSERT INTO shiling.invitations(id,user_id,created_by) VALUES($1,$2,$3)', [
          invitationId,
          userId,
          actor.id,
        ]);
        await tx.query(
          "INSERT INTO shiling.auth_tokens(id,user_id,invitation_id,purpose,token_hash,issued_by,expires_at) VALUES($1,$2,$3,'invitation',$4,$5,now()+($6::int * interval '1 second'))",
          [randomUUID(), userId, invitationId, hashToken(invitationToken), actor.id, ttl],
        );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'identity.invitation_created',
          resourceType: 'invitation',
          resourceId: invitationId,
          requestId: context.requestId,
        });
        await completeIdempotency(tx, claim.id, { invitationId });
        return {
          invitation: await invitationById(tx, invitationId),
          token: invitationToken,
          replayed: false,
        };
      });
    },
    async getInvitation(token: string, invitationId: string) {
      await authorizeSession(database, token, options, 'system.members.manage');
      return invitationById(database, invitationId);
    },
    async listInvitations(
      token: string,
      input: { cursor?: string; limit?: number; state?: Invitation['state'] } = {},
    ) {
      await authorizeSession(database, token, options, 'system.members.manage');
      const limit = input.limit ?? 40;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new AppError(400, 'INVALID_PAGE_LIMIT', '每页数量应为 1 至 100。');
      let afterId: string | null = null;
      if (input.cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as {
            id: string;
            state: string | null;
            scope: string;
          };
          if (
            decoded.scope !== 'invitations:id:asc' ||
            decoded.state !== (input.state ?? null) ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decoded.id)
          )
            throw new Error('cursor');
          afterId = decoded.id;
        } catch {
          throw new AppError(400, 'INVALID_CURSOR', '分页条件已变化，请刷新列表。');
        }
      }
      const rows = (
        await database.query<{ id: string }>(
          'SELECT id FROM shiling.invitations WHERE ($1::text IS NULL OR state=$1) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',
          [input.state ?? null, afterId, limit + 1],
        )
      ).rows;
      const hasMore = rows.length > limit;
      const selected = rows.slice(0, limit);
      const items: Invitation[] = [];
      for (const row of selected) items.push(await invitationById(database, row.id));
      const last = selected.at(-1);
      return {
        items,
        pageInfo: {
          hasMore,
          nextCursor:
            hasMore && last
              ? Buffer.from(
                  JSON.stringify({
                    scope: 'invitations:id:asc',
                    state: input.state ?? null,
                    id: last.id,
                  }),
                ).toString('base64url')
              : null,
        },
      };
    },
    async revokeInvitation(
      token: string,
      invitationId: string,
      expectedRevision: string,
      requestId: string,
    ) {
      return write(async (tx) => {
        const actor = await authorizeSession(tx, token, options, 'system.members.manage', true);
        const invitation = await invitationById(tx, invitationId);
        assertRevision(invitation.revision, expectedRevision);
        if (invitation.state === 'accepted')
          throw new AppError(409, 'INVITATION_ACCEPTED', '邀请已被接受，不能撤销。');
        if (invitation.state === 'revoked') return invitation;
        await tx.query(
          "UPDATE shiling.invitations SET state='revoked',revoked_at=now() WHERE id=$1",
          [invitationId],
        );
        await tx.query(
          'UPDATE shiling.auth_tokens SET revoked_at=now() WHERE invitation_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL',
          [invitationId],
        );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'identity.invitation_revoked',
          resourceType: 'invitation',
          resourceId: invitationId,
          requestId,
        });
        return invitationById(tx, invitationId);
      });
    },
    async reissueInvitation(
      token: string,
      invitationId: string,
      expectedRevision: string,
      context: MutationContext,
    ) {
      return write(async (tx) => {
        const actor = await authorizeSession(tx, token, options, 'system.members.manage', true);
        const claim = await claimIdempotency(
          tx,
          actor.id,
          'invitations.reissue',
          context.idempotencyKey,
          requestHash({ invitationId, expectedRevision }),
        );
        if (claim.replay)
          return {
            invitation: await invitationById(tx, invitationId),
            token: null,
            replayed: true,
          };
        const invitation = await invitationById(tx, invitationId);
        assertRevision(invitation.revision, expectedRevision);
        if (
          invitation.state === 'accepted' ||
          (await getUser(tx, invitation.userId)).status !== 'invited'
        )
          throw new AppError(409, 'INVITATION_ACCEPTED', '邀请已被接受，不能重新签发。');
        const user = await getUser(tx, invitation.userId);
        const role = await getRole(tx, user.roleId);
        if (role.key === 'sysadmin')
          throw new AppError(409, 'INVITATION_ADMIN_FORBIDDEN', '邀请不能授予系统管理员角色。');
        await tx.query(
          'UPDATE shiling.auth_tokens SET revoked_at=now() WHERE invitation_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL',
          [invitationId],
        );
        await tx.query(
          "UPDATE shiling.invitations SET state='pending',revoked_at=NULL WHERE id=$1",
          [invitationId],
        );
        const invitationToken = newToken();
        await tx.query(
          "INSERT INTO shiling.auth_tokens(id,user_id,invitation_id,purpose,token_hash,issued_by,expires_at) VALUES($1,$2,$3,'invitation',$4,$5,now()+($6::int * interval '1 second'))",
          [
            randomUUID(),
            invitation.userId,
            invitationId,
            hashToken(invitationToken),
            actor.id,
            options.invitationTtlSeconds ?? 86400,
          ],
        );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'identity.invitation_reissued',
          resourceType: 'invitation',
          resourceId: invitationId,
          requestId: context.requestId,
        });
        await completeIdempotency(tx, claim.id, { invitationId });
        return {
          invitation: await invitationById(tx, invitationId),
          token: invitationToken,
          replayed: false,
        };
      });
    },
    async inspectInvitation(invitationToken: string) {
      const row = (
        await database.query<{ expires_at: Date; subject: string | null; role_name: string }>(
          `SELECT t.expires_at,i.subject,r.name role_name FROM shiling.auth_tokens t
        JOIN shiling.invitations v ON v.id=t.invitation_id JOIN shiling.users u ON u.id=t.user_id JOIN shiling.roles r ON r.id=u.role_id
        LEFT JOIN shiling.identities i ON i.user_id=u.id AND i.provider_key='password'
        WHERE t.token_hash=$1 AND t.purpose='invitation' AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>now()
        AND v.state='pending' AND u.status='invited' AND r.archived_at IS NULL AND r.key<>'sysadmin'`,
          [hashToken(invitationToken)],
        )
      ).rows[0];
      if (!row) throw new AppError(410, 'INVITATION_UNAVAILABLE', '邀请已失效，请联系管理员。');
      return {
        expiresAt: row.expires_at.toISOString(),
        reservedLoginName: row.subject,
        roleName: row.role_name,
      };
    },
    async acceptInvitation(
      input: { token: string; loginName: string; displayName: string; password: string },
      requestId: string,
    ) {
      const subject = normalizeLoginName(input.loginName);
      const displayName = normalizeDisplayName(input.displayName);
      const passwordHash = await hashPassword(input.password);
      return write(async (tx) => {
        const row = (
          await tx.query<{
            token_id: string;
            invitation_id: string;
            user_id: string;
            identity_id: string | null;
            subject: string | null;
          }>(
            `SELECT t.id token_id,v.id invitation_id,u.id user_id,i.id identity_id,i.subject
          FROM shiling.auth_tokens t JOIN shiling.invitations v ON v.id=t.invitation_id JOIN shiling.users u ON u.id=t.user_id JOIN shiling.roles r ON r.id=u.role_id
          LEFT JOIN shiling.identities i ON i.user_id=u.id AND i.provider_key='password'
          WHERE t.token_hash=$1 AND t.purpose='invitation' AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>now()
          AND v.state='pending' AND u.status='invited' AND r.archived_at IS NULL AND r.key<>'sysadmin'`,
            [hashToken(input.token)],
          )
        ).rows[0];
        if (!row) throw new AppError(410, 'INVITATION_UNAVAILABLE', '邀请已失效，请联系管理员。');
        if (row.subject && row.subject !== subject)
          throw new AppError(409, 'INVITATION_LOGIN_RESERVED', '请使用邀请中预留的账号。');
        const identityId = row.identity_id ?? randomUUID();
        if (row.identity_id)
          await tx.query(
            "UPDATE shiling.identities SET verified_at=now(),status='active' WHERE id=$1",
            [identityId],
          );
        else
          await tx.query(
            "INSERT INTO shiling.identities(id,user_id,provider_key,subject,verified_at) VALUES($1,$2,'password',$3,now())",
            [identityId, row.user_id, subject],
          );
        await tx.query(
          'INSERT INTO shiling.password_credentials(identity_id,password_hash) VALUES($1,$2)',
          [identityId, passwordHash],
        );
        await tx.query(
          "UPDATE shiling.users SET display_name=$2,status='active',activated_at=now() WHERE id=$1",
          [row.user_id, displayName],
        );
        await tx.query(
          "UPDATE shiling.invitations SET state='accepted',accepted_at=now() WHERE id=$1",
          [row.invitation_id],
        );
        await tx.query('UPDATE shiling.auth_tokens SET consumed_at=now() WHERE id=$1', [
          row.token_id,
        ]);
        await appendAudit(tx, {
          actorId: row.user_id,
          action: 'identity.invitation_accepted',
          resourceType: 'invitation',
          resourceId: row.invitation_id,
          requestId,
        });
        return { user: await getUser(tx, row.user_id) };
      });
    },
    async createRecoveryToken(token: string, memberId: string, context: MutationContext) {
      return write(async (tx) => {
        const actor = await authorizeSession(tx, token, options, 'system.members.manage', true);
        const claim = await claimIdempotency(
          tx,
          actor.id,
          'recovery.create',
          context.idempotencyKey,
          requestHash({ memberId }),
        );
        if (claim.replay)
          return { token: null, expiresAt: String(claim.resourceRefs.expiresAt), replayed: true };
        const user = await getUser(tx, memberId);
        const identity = (
          await tx.query<{ id: string }>(
            "SELECT i.id FROM shiling.identities i JOIN shiling.password_credentials p ON p.identity_id=i.id WHERE i.user_id=$1 AND i.provider_key='password'",
            [memberId],
          )
        ).rows[0];
        if (user.status === 'invited' || !identity)
          throw new AppError(409, 'RECOVERY_UNAVAILABLE', '该成员尚未建立可恢复的本地账号。');
        await tx.query(
          "UPDATE shiling.auth_tokens SET revoked_at=now() WHERE user_id=$1 AND purpose='recovery' AND consumed_at IS NULL AND revoked_at IS NULL",
          [memberId],
        );
        const recoveryToken = newToken();
        const tokenId = randomUUID();
        const expiresAt = new Date(Date.now() + (options.recoveryTtlSeconds ?? 900) * 1000);
        await tx.query(
          "INSERT INTO shiling.auth_tokens(id,user_id,purpose,token_hash,issued_by,expires_at) VALUES($1,$2,'recovery',$3,$4,$5)",
          [tokenId, memberId, hashToken(recoveryToken), actor.id, expiresAt],
        );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'identity.recovery_issued',
          resourceType: 'user',
          resourceId: memberId,
          requestId: context.requestId,
          changes: { targetIsSystemAdmin: user.roleId === ADMIN_ROLE_ID },
        });
        await completeIdempotency(tx, claim.id, { tokenId, expiresAt: expiresAt.toISOString() });
        return { token: recoveryToken, expiresAt: expiresAt.toISOString(), replayed: false };
      });
    },
    async inspectRecovery(recoveryToken: string) {
      const row = (
        await database.query<{ expires_at: Date }>(
          `SELECT t.expires_at FROM shiling.auth_tokens t JOIN shiling.users u ON u.id=t.user_id
        JOIN shiling.identities i ON i.user_id=u.id AND i.provider_key='password' JOIN shiling.password_credentials p ON p.identity_id=i.id
        WHERE t.token_hash=$1 AND t.purpose='recovery' AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>now() AND u.status<>'invited'`,
          [hashToken(recoveryToken)],
        )
      ).rows[0];
      if (!row) throw new AppError(410, 'RECOVERY_UNAVAILABLE', '恢复凭据已失效，请联系管理员。');
      return { expiresAt: row.expires_at.toISOString() };
    },
    async completeRecovery(
      input: { token: string; newPassword: string },
      requestId: string,
    ): Promise<void> {
      const passwordHash = await hashPassword(input.newPassword);
      await write(async (tx) => {
        const row = (
          await tx.query<{
            token_id: string;
            user_id: string;
            identity_id: string;
            role_id: string;
          }>(
            `SELECT t.id token_id,u.id user_id,i.id identity_id,u.role_id FROM shiling.auth_tokens t
          JOIN shiling.users u ON u.id=t.user_id JOIN shiling.identities i ON i.user_id=u.id AND i.provider_key='password'
          JOIN shiling.password_credentials p ON p.identity_id=i.id WHERE t.token_hash=$1 AND t.purpose='recovery'
          AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>now() AND u.status<>'invited'`,
            [hashToken(input.token)],
          )
        ).rows[0];
        if (!row) throw new AppError(410, 'RECOVERY_UNAVAILABLE', '恢复凭据已失效，请联系管理员。');
        await tx.query(
          'UPDATE shiling.password_credentials SET password_hash=$2,changed_at=now() WHERE identity_id=$1',
          [row.identity_id, passwordHash],
        );
        await tx.query('UPDATE shiling.users SET auth_epoch=auth_epoch+1 WHERE id=$1', [
          row.user_id,
        ]);
        await revokeSessions(tx, row.user_id, 'password_recovered');
        await tx.query('UPDATE shiling.auth_tokens SET consumed_at=now() WHERE id=$1', [
          row.token_id,
        ]);
        await appendAudit(tx, {
          actorId: row.user_id,
          action: 'identity.recovery_completed',
          resourceType: 'user',
          resourceId: row.user_id,
          requestId,
          changes: { targetIsSystemAdmin: row.role_id === ADMIN_ROLE_ID },
        });
      });
    },
    async listMembers(token: string, input: { cursor?: string; limit?: number } = {}) {
      await authorizeSession(database, token, options, 'system.members.manage');
      const limit = input.limit ?? 40;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new AppError(400, 'INVALID_PAGE_LIMIT', '每页数量应为 1 至 100。');
      let cursorId: string | null = null;
      if (input.cursor !== undefined) {
        try {
          const decoded: unknown = JSON.parse(
            Buffer.from(input.cursor, 'base64url').toString('utf8'),
          );
          if (
            typeof decoded !== 'object' ||
            decoded === null ||
            !('scope' in decoded) ||
            decoded.scope !== 'members:id:asc' ||
            !('id' in decoded) ||
            typeof decoded.id !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decoded.id)
          )
            throw new Error('Invalid cursor');
          cursorId = decoded.id;
        } catch {
          throw new AppError(400, 'INVALID_CURSOR', '分页游标无效，请刷新列表。');
        }
      }
      const rows = (
        await database.query<UserRow>(
          'SELECT id,display_name,status,role_id,revision FROM shiling.users WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2',
          [cursorId, limit + 1],
        )
      ).rows;
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(userDto);
      const last = items.at(-1);
      return {
        items,
        pageInfo: {
          hasMore,
          nextCursor:
            hasMore && last
              ? Buffer.from(JSON.stringify({ scope: 'members:id:asc', id: last.id })).toString(
                  'base64url',
                )
              : null,
        },
      };
    },
    async setMemberStatus(
      token: string,
      memberId: string,
      status: 'active' | 'suspended',
      expectedRevision: string,
      requestId: string,
    ) {
      return write(async (tx) => {
        const actor = await authorizeSession(tx, token, options, 'system.members.manage', true);
        const user = await getUser(tx, memberId);
        assertRevision(user.revision, expectedRevision);
        if (user.status === 'invited')
          throw new AppError(
            409,
            'INVITATION_REQUIRED',
            '待接受邀请的成员应通过邀请流程激活或撤销邀请。',
          );
        if (user.status === status) return user;
        if (status === 'suspended') await protectLastAdmin(tx, memberId);
        else await getRole(tx, user.roleId);
        await tx.query(
          "UPDATE shiling.users SET status=$2,suspended_at=CASE WHEN $2='suspended' THEN now() ELSE NULL END,auth_epoch=auth_epoch+1 WHERE id=$1",
          [memberId, status],
        );
        await revokeSessions(
          tx,
          memberId,
          status === 'suspended' ? 'member_suspended' : 'member_restored',
        );
        if (status === 'suspended')
          await tx.query(
            'UPDATE shiling.auth_tokens SET revoked_at=now() WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL',
            [memberId],
          );
        await appendAudit(tx, {
          actorId: actor.id,
          action: `identity.member_${status}`,
          resourceType: 'user',
          resourceId: memberId,
          requestId,
          changes: { status },
        });
        return getUser(tx, memberId);
      });
    },
    async changeMemberRole(
      token: string,
      memberId: string,
      roleId: string,
      expectedRevision: string,
      requestId: string,
    ) {
      return write(async (tx) => {
        const actor = await authorizeSession(tx, token, options, 'system.roles.manage', true);
        const user = await getUser(tx, memberId);
        assertRevision(user.revision, expectedRevision);
        const role = await getRole(tx, roleId);
        if (user.roleId === roleId) return user;
        if (user.status === 'invited' && role.key === 'sysadmin')
          throw new AppError(
            400,
            'INVITATION_ADMIN_FORBIDDEN',
            '待接受邀请的成员不能设为系统管理员。',
          );
        await protectLastAdmin(tx, memberId);
        await tx.query('UPDATE shiling.users SET role_id=$2,auth_epoch=auth_epoch+1 WHERE id=$1', [
          memberId,
          roleId,
        ]);
        await revokeSessions(tx, memberId, 'role_changed');
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'identity.member_role_changed',
          resourceType: 'user',
          resourceId: memberId,
          requestId,
          changes: { previousRoleId: user.roleId, roleId },
        });
        return getUser(tx, memberId);
      });
    },
    async listRoles(token: string) {
      await authorizeSession(database, token, options, 'system.roles.manage');
      const roles = await database.query<{ id: string }>(
        'SELECT id FROM shiling.roles ORDER BY created_at,id',
      );
      return Promise.all(roles.rows.map((row) => roleDefinition(database, row.id)));
    },
    async createRole(
      token: string,
      input: { name: string; permissionKeys: string[] },
      context: MutationContext,
    ) {
      const name = roleName(input.name);
      const permissions = validatePermissions(input.permissionKeys);
      return write(async (tx) => {
        const actor = await authorizeSession(tx, token, options, 'system.roles.manage', true);
        const claim = await claimIdempotency(
          tx,
          actor.id,
          'roles.create',
          context.idempotencyKey,
          requestHash({ name, permissions }),
        );
        if (claim.replay) return roleDefinition(tx, String(claim.resourceRefs.roleId));
        const id = randomUUID();
        await tx.query("INSERT INTO shiling.roles(id,key,name,kind) VALUES($1,$2,$3,'custom')", [
          id,
          `custom_${id}`,
          name,
        ]);
        for (const permission of permissions)
          await tx.query(
            'INSERT INTO shiling.role_permissions(role_id,permission_key) VALUES($1,$2)',
            [id, permission],
          );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'identity.role_created',
          resourceType: 'role',
          resourceId: id,
          requestId: context.requestId,
          changes: { permissionKeys: permissions },
        });
        await completeIdempotency(tx, claim.id, { roleId: id });
        return roleDefinition(tx, id);
      });
    },
    async updateRole(
      token: string,
      roleId: string,
      input: { name: string; permissionKeys: string[] },
      expectedRevision: string,
      requestId: string,
    ) {
      const name = roleName(input.name);
      const permissions = validatePermissions(input.permissionKeys);
      return write(async (tx) => {
        const actor = await authorizeSession(tx, token, options, 'system.roles.manage', true);
        const role = await getRole(tx, roleId);
        assertRevision(role.revision, expectedRevision, true);
        if (role.kind === 'system')
          throw new AppError(403, 'SYSTEM_ROLE_IMMUTABLE', '系统管理员角色不能修改。');
        await tx.query('UPDATE shiling.roles SET name=$2 WHERE id=$1', [roleId, name]);
        await tx.query('DELETE FROM shiling.role_permissions WHERE role_id=$1', [roleId]);
        for (const permission of permissions)
          await tx.query(
            'INSERT INTO shiling.role_permissions(role_id,permission_key) VALUES($1,$2)',
            [roleId, permission],
          );
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'identity.role_updated',
          resourceType: 'role',
          resourceId: roleId,
          requestId,
          changes: { permissionKeys: permissions },
        });
        return roleDefinition(tx, roleId);
      });
    },
    async retireRole(token: string, roleId: string, expectedRevision: string, requestId: string) {
      return write(async (tx) => {
        const actor = await authorizeSession(tx, token, options, 'system.roles.manage', true);
        const role = await getRole(tx, roleId);
        assertRevision(role.revision, expectedRevision);
        if (role.kind === 'system')
          throw new AppError(403, 'SYSTEM_ROLE_IMMUTABLE', '系统管理员角色不能停用。');
        if (
          (await tx.query('SELECT id FROM shiling.users WHERE role_id=$1 LIMIT 1', [roleId]))
            .rowCount
        )
          throw new AppError(409, 'ROLE_IN_USE', '请先为使用此角色的成员调整角色。');
        await tx.query('UPDATE shiling.roles SET archived_at=now() WHERE id=$1', [roleId]);
        await appendAudit(tx, {
          actorId: actor.id,
          action: 'identity.role_retired',
          resourceType: 'role',
          resourceId: roleId,
          requestId,
        });
        return roleDefinition(tx, roleId);
      });
    },
  };
}
export type IdentityService = ReturnType<typeof createIdentityService>;
