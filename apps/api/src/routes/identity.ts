import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { AppError, currentIntakePolicy } from '@shiling/backend';
import {
  BootstrapSchema,
  ChangeMemberRoleRequestSchema,
  ChangePasswordRequestSchema,
  ExpectedRevisionSchema,
  InitializeRequestSchema,
  InvitationAcceptRequestSchema,
  InvitationCreateRequestSchema,
  InvitationSchema,
  LoginRequestSchema,
  PERMISSION_DEPENDENCIES,
  PERMISSION_KEYS,
  PageQuerySchema,
  ReauthenticateRequestSchema,
  RecoveryCompleteRequestSchema,
  RecoveryInspectResponseSchema,
  RecoveryTokenCreateResponseSchema,
  RoleWriteSchema,
  TokenRequestSchema,
  UuidSchema,
  pageSchema,
} from '@shiling/contracts';
import type { PermissionKey } from '@shiling/contracts';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../config.js';
import {
  clearSessionCookie,
  requireCookieMutationToken,
  requireExpectedRevision,
  requireIdempotencyKey,
  requireMutationSession,
  requireSameOrigin,
  requireSession,
  setRevision,
  setSessionCookie,
} from '../http/security.js';
import type { ApiRuntime } from '../runtime.js';

const IdParamsSchema = Type.Object({ id: UuidSchema }, { additionalProperties: false });
const RolePatchSchema = RoleWriteSchema;
const EmptyBodySchema = Type.Object({}, { additionalProperties: false });
const InvitationQuerySchema = Type.Object(
  {
    ...PageQuerySchema.properties,
    state: Type.Optional(
      Type.Union([Type.Literal('pending'), Type.Literal('accepted'), Type.Literal('revoked')]),
    ),
  },
  { additionalProperties: false },
);
const permissionNames: Record<PermissionKey, string> = {
  'assets.read': '查看团队素材',
  'assets.download': '下载素材',
  'assets.editOwn': '编辑本人素材',
  'assets.archiveOwn': '归档本人素材',
  'assets.governAny': '治理全部素材',
  'uploads.create': '上传素材',
  'uploads.readOwn': '查看本人上传',
  'uploads.cancelOwn': '取消本人上传',
  'uploads.retryOwn': '重试本人上传',
  'uploads.governAny': '治理全部上传',
  'publications.publishOwn': '公开本人素材',
  'publications.withdrawOwn': '撤回本人公开',
  'publications.withdrawAny': '治理撤回公开',
  'tags.read': '使用标签',
  'tags.manage': '治理标签字典',
  'collections.read': '查看团队合集',
  'collections.create': '创建团队合集',
  'collections.manageOwn': '管理本人合集',
  'collections.governAny': '治理全部合集',
  'favorites.manageOwn': '管理个人收藏',
  'system.members.manage': '管理成员',
  'system.roles.manage': '管理角色',
  'system.settings.manage': '管理系统设置',
  'system.operations.read': '查看运行状态',
  'system.jobs.manage': '管理后台任务',
  'system.audit.read': '查看审计记录',
};

export function registerIdentityRoutes(
  instance: FastifyInstance,
  config: ApiConfig,
  runtime: ApiRuntime,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  app.get(
    '/api/v1/bootstrap',
    { schema: { response: { 200: BootstrapSchema } } },
    async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return runtime.identity.bootstrap();
    },
  );

  app.post(
    '/api/v1/setup/initialize',
    {
      schema: { body: InitializeRequestSchema },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      requireSameOrigin(request, config);
      const result = await runtime.identity.initialize(request.body, request.id);
      return reply.code(201).header('Cache-Control', 'no-store').send(result);
    },
  );

  app.post(
    '/api/v1/auth/login',
    {
      schema: { body: LoginRequestSchema },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      requireSameOrigin(request, config);
      const result = await runtime.identity.login(request.body, request.id);
      setSessionCookie(reply, config, result.sessionToken, result.expiresAt);
      return reply.header('Cache-Control', 'no-store').send(result.session);
    },
  );

  app.get('/api/v1/auth/session', async (request, reply) => {
    const { session } = await requireSession(request, config, runtime.identity);
    return reply.header('Cache-Control', 'no-store').send(session);
  });

  app.post('/api/v1/auth/logout', { schema: { body: EmptyBodySchema } }, async (request, reply) => {
    const token = requireCookieMutationToken(request, config);
    await runtime.identity.logout(token, request.id);
    clearSessionCookie(reply, config);
    return reply.code(204).send();
  });

  app.post(
    '/api/v1/auth/logout-all',
    { schema: { body: EmptyBodySchema } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, runtime.identity);
      await runtime.identity.logoutAll(token, request.id);
      clearSessionCookie(reply, config);
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/v1/auth/reauthenticate',
    {
      schema: { body: ReauthenticateRequestSchema },
      config: { rateLimit: { max: 8, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, runtime.identity);
      const session = await runtime.identity.reauthenticate(
        token,
        request.body.password,
        request.id,
      );
      return reply.header('Cache-Control', 'no-store').send({ session });
    },
  );

  app.patch(
    '/api/v1/auth/change-password',
    {
      schema: { body: ChangePasswordRequestSchema },
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, runtime.identity);
      await runtime.identity.changePassword(token, request.body, request.id);
      clearSessionCookie(reply, config);
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/v1/auth/invitations/inspect',
    {
      schema: { body: TokenRequestSchema },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request) => runtime.identity.inspectInvitation(request.body.token),
  );

  app.post(
    '/api/v1/auth/invitations/accept',
    {
      schema: { body: InvitationAcceptRequestSchema },
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      requireSameOrigin(request, config);
      const result = await runtime.identity.acceptInvitation(request.body, request.id);
      return reply.code(201).header('Cache-Control', 'no-store').send(result);
    },
  );

  app.post(
    '/api/v1/auth/recovery/inspect',
    {
      schema: {
        body: TokenRequestSchema,
        response: { 200: RecoveryInspectResponseSchema },
      },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request) => runtime.identity.inspectRecovery(request.body.token),
  );

  app.post(
    '/api/v1/auth/recovery/complete',
    {
      schema: { body: RecoveryCompleteRequestSchema },
      config: { rateLimit: { max: 8, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      requireSameOrigin(request, config);
      await runtime.identity.completeRecovery(request.body, request.id);
      return reply.code(204).send();
    },
  );

  app.get('/api/v1/team/capabilities', async (request) => {
    const { session } = await requireSession(request, config, runtime.identity);
    const policy = await runtime.database.transaction((tx) =>
      currentIntakePolicy(tx, config.uploadMaxBytes),
    );
    const definitions = [
      { id: 'image' as const, name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
      { id: 'video' as const, name: '视频', extensions: ['mp4'] },
      { id: 'web_motion' as const, name: '动效', extensions: ['html', 'htm', 'zip'] },
    ];
    return {
      permissionKeys: session.permissionKeys,
      authzVersion: session.authzVersion,
      types: definitions.map((definition) => ({
        ...definition,
        acceptUploads: policy.acceptTypes.includes(definition.id),
        executePreview: false,
        maxBytes: policy.maxBytes[definition.id],
      })),
      maxBatchItems: 100,
      maxConcurrentUploads: 4,
    };
  });

  app.get(
    '/api/v1/team/admin/members',
    { schema: { querystring: PageQuerySchema } },
    async (request) => {
      const { token } = await requireSession(request, config, runtime.identity);
      return runtime.identity.listMembers(token, request.query);
    },
  );

  for (const [path, status] of [
    ['/api/v1/team/admin/members/:id/disable', 'suspended'],
    ['/api/v1/team/admin/members/:id/enable', 'active'],
  ] as const) {
    app.post(
      path,
      { schema: { params: IdParamsSchema, body: ExpectedRevisionSchema } },
      async (request, reply) => {
        const { token } = await requireMutationSession(request, config, runtime.identity);
        const member = await runtime.identity.setMemberStatus(
          token,
          request.params.id,
          status,
          request.body.expectedRevision,
          request.id,
        );
        setRevision(reply, member.revision);
        return member;
      },
    );
  }

  app.post(
    '/api/v1/team/admin/members/:id/change-role',
    { schema: { params: IdParamsSchema, body: ChangeMemberRoleRequestSchema } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, runtime.identity);
      const member = await runtime.identity.changeMemberRole(
        token,
        request.params.id,
        request.body.roleId,
        request.body.expectedRevision,
        request.id,
      );
      setRevision(reply, member.revision);
      return member;
    },
  );

  app.post(
    '/api/v1/team/admin/members/:id/recovery-tokens',
    {
      schema: {
        params: IdParamsSchema,
        body: EmptyBodySchema,
        response: {
          200: RecoveryTokenCreateResponseSchema,
          201: RecoveryTokenCreateResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, runtime.identity);
      const result = await runtime.identity.createRecoveryToken(token, request.params.id, {
        requestId: request.id,
        idempotencyKey: requireIdempotencyKey(request),
      });
      return reply
        .code(result.replayed ? 200 : 201)
        .header('Cache-Control', 'no-store')
        .send(result);
    },
  );

  app.post(
    '/api/v1/team/admin/invitations',
    { schema: { body: InvitationCreateRequestSchema } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, runtime.identity);
      const result = await runtime.identity.createInvitation(token, request.body, {
        requestId: request.id,
        idempotencyKey: requireIdempotencyKey(request),
      });
      setRevision(reply, result.invitation.revision);
      return reply
        .code(result.replayed ? 200 : 201)
        .header('Cache-Control', 'no-store')
        .send(result);
    },
  );

  app.get(
    '/api/v1/team/admin/invitations',
    {
      schema: {
        querystring: InvitationQuerySchema,
        response: { 200: pageSchema(InvitationSchema) },
      },
    },
    async (request, reply) => {
      const { token } = await requireSession(request, config, runtime.identity);
      reply.header('Cache-Control', 'no-store');
      return runtime.identity.listInvitations(token, request.query);
    },
  );

  app.get(
    '/api/v1/team/admin/invitations/:id',
    { schema: { params: IdParamsSchema } },
    async (request, reply) => {
      const { token } = await requireSession(request, config, runtime.identity);
      const invitation = await runtime.identity.getInvitation(token, request.params.id);
      setRevision(reply, invitation.revision);
      return invitation;
    },
  );

  app.post(
    '/api/v1/team/admin/invitations/:id/revoke',
    { schema: { params: IdParamsSchema, body: ExpectedRevisionSchema } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, runtime.identity);
      const invitation = await runtime.identity.revokeInvitation(
        token,
        request.params.id,
        request.body.expectedRevision,
        request.id,
      );
      setRevision(reply, invitation.revision);
      return invitation;
    },
  );

  app.post(
    '/api/v1/team/admin/invitations/:id/reissue',
    { schema: { params: IdParamsSchema, body: ExpectedRevisionSchema } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, runtime.identity);
      const result = await runtime.identity.reissueInvitation(
        token,
        request.params.id,
        request.body.expectedRevision,
        { requestId: request.id, idempotencyKey: requireIdempotencyKey(request) },
      );
      setRevision(reply, result.invitation.revision);
      return reply.header('Cache-Control', 'no-store').send(result);
    },
  );

  app.get('/api/v1/team/admin/roles', async (request) => {
    const { token } = await requireSession(request, config, runtime.identity);
    return { items: await runtime.identity.listRoles(token) };
  });

  app.get('/api/v1/team/admin/permission-catalog', async (request) => {
    const { session } = await requireSession(request, config, runtime.identity);
    if (!session.permissionKeys.includes('system.roles.manage')) {
      throw new AppError(403, 'FORBIDDEN', '没有查看角色能力目录的权限。');
    }
    return {
      items: PERMISSION_KEYS.map((key) => ({
        key,
        name: permissionNames[key],
        delegable: !key.startsWith('system.'),
        dependencies: PERMISSION_DEPENDENCIES[key] ?? [],
      })),
    };
  });

  app.post(
    '/api/v1/team/admin/roles',
    { schema: { body: RoleWriteSchema } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, runtime.identity);
      const role = await runtime.identity.createRole(token, request.body, {
        requestId: request.id,
        idempotencyKey: requireIdempotencyKey(request),
      });
      setRevision(reply, role.revision);
      return reply.code(201).send(role);
    },
  );

  app.patch(
    '/api/v1/team/admin/roles/:id',
    { schema: { params: IdParamsSchema, body: RolePatchSchema } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, runtime.identity);
      const role = await runtime.identity.updateRole(
        token,
        request.params.id,
        request.body,
        requireExpectedRevision(request),
        request.id,
      );
      setRevision(reply, role.revision);
      return role;
    },
  );

  app.post(
    '/api/v1/team/admin/roles/:id/retire',
    { schema: { params: IdParamsSchema, body: ExpectedRevisionSchema } },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, runtime.identity);
      const role = await runtime.identity.retireRole(
        token,
        request.params.id,
        request.body.expectedRevision,
        request.id,
      );
      setRevision(reply, role.revision);
      return role;
    },
  );
}
