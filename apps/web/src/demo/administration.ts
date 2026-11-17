import {
  DEFAULT_MEMBER_PERMISSIONS,
  PERMISSION_KEYS,
  PERMISSION_DEPENDENCIES,
} from '@shiling/contracts';
import type { ApiOptions } from '../app/http-client';
import { ApiError } from '../app/http-client';
import type { Invitation, Job, Member, Role, Settings } from '../app/models';
import { demoSession, ownerId, assets } from './fixtures';
const adminId = '00000000-0000-4000-8000-000000000001';
const customId = 'a0000000-0000-4000-8000-000000000002';
const readerId = 'a0000000-0000-4000-8000-000000000003';
const catalogNames: Record<string, string> = {
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
  'collections.read': '查看团队集合',
  'collections.create': '创建团队集合',
  'collections.manageOwn': '管理本人集合',
  'collections.governAny': '治理全部集合',
  'favorites.manageOwn': '管理个人收藏',
};
export const adminRoles: Role[] = [
  {
    id: adminId,
    revision: '1',
    name: '系统管理员',
    kind: 'system',
    permissionKeys: [...PERMISSION_KEYS],
    archivedAt: null,
  },
  {
    id: customId,
    revision: '1',
    name: '创作者',
    kind: 'custom',
    permissionKeys: [...DEFAULT_MEMBER_PERMISSIONS],
    archivedAt: null,
  },
  {
    id: readerId,
    revision: '1',
    name: '素材浏览者',
    kind: 'custom',
    permissionKeys: [
      'assets.read',
      'assets.download',
      'tags.read',
      'collections.read',
      'favorites.manageOwn',
    ],
    archivedAt: null,
  },
  {
    id: 'a0000000-0000-4000-8000-000000000004',
    revision: '1',
    name: '内容整理员',
    kind: 'custom',
    permissionKeys: [...DEFAULT_MEMBER_PERMISSIONS, 'tags.manage', 'collections.governAny'],
    archivedAt: null,
  },
];
const names = [
  '演示管理员',
  '设计成员',
  '内容编辑',
  '产品同事',
  '素材整理员',
  '新受邀成员',
  '已停用成员',
  '品牌协作者',
];
const members: Member[] = Array.from({ length: 23 }, (_, i) => ({
  id: i === 0 ? ownerId : 'b0000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
  revision: '1',
  displayName: names[i] || '协作成员 ' + (i + 1),
  status: i === 5 ? 'invited' : i === 6 ? 'suspended' : 'active',
  roleId: i === 0 ? adminId : i === 3 ? readerId : customId,
}));
const invitations: Invitation[] = Array.from({ length: 22 }, (_, i) => ({
  id: 'c0000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
  userId: members[5]!.id,
  revision: '1',
  state: i === 1 ? 'accepted' : i === 2 ? 'revoked' : 'pending',
  expiresAt: '2026-12-01T08:00:00.000Z',
  reservedLoginName: i === 0 ? 'new.designer' : i === 1 ? 'content.editor' : null,
}));
const types = [
  {
    id: 'image',
    name: '图片',
    acceptUploads: true,
    executePreview: false,
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    maxBytes: 16777216,
  },
  {
    id: 'video',
    name: '视频',
    acceptUploads: true,
    executePreview: false,
    extensions: ['mp4'],
    maxBytes: 67108864,
  },
  {
    id: 'web_motion',
    name: '动效',
    acceptUploads: false,
    executePreview: false,
    extensions: ['html', 'htm', 'zip'],
    maxBytes: 16777216,
  },
];
export const adminSettings: Settings = {
  revision: '1',
  name: '拾灵',
  brand: {
    name: '拾灵',
    description: '创作团队的素材空间',
    primaryColor: '#244bc5',
    logoUrl: null,
    faviconUrl: null,
  },
  types,
  publicEnabled: true,
  executePreview: false,
  logoBrandingAssetId: null,
  faviconBrandingAssetId: null,
  publicationImpact: { eligibleActiveCount: 12, evaluatedAt: '2026-11-17T08:30:00.000Z' },
};
const jobs: Job[] = Array.from({ length: 23 }, (_, i) => ({
  id: 'd0000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
  kind: i === 4 ? 'media.optional.preview_image' : 'media.derive',
  state: ['failed', 'running', 'queued', 'succeeded', 'failed', 'canceled'][i % 6]!,
  required: i !== 4,
  attemptCount: i % 6 === 2 ? 0 : i === 0 ? 2 : 1,
  assetId: assets[i % assets.length]!.id,
  uploadItemId: '60000000-0000-4000-8000-000000000001',
  safeError:
    i % 6 === 0 || i === 4
      ? {
          code: 'MEDIA_PROCESSING_FAILED',
          message: '任务未能完成，可查看素材状态并按允许动作重试。',
          retryable: true,
        }
      : null,
  createdAt: '2026-11-17T08:00:00.000Z',
  updatedAt: '2026-11-17T08:25:00.000Z',
  actions: { retry: i % 6 === 0 || i === 4 },
}));
for (const job of jobs)
  job.attempts = Array.from({ length: job.attemptCount || 0 }, (_, i) => ({
    id: job.id + '-' + i,
    attempt: i + 1,
    state: job.safeError ? 'failed' : job.state === 'running' ? 'running' : job.state,
    startedAt: '2026-11-17T08:00:00.000Z',
    finishedAt: job.state === 'running' ? null : '2026-11-17T08:01:00.000Z',
    errorCode: job.safeError?.code || null,
  }));
const auditActions = [
  'identity.invitation_created',
  'identity.role_updated',
  'settings.updated',
  'identity.member_disabled',
  'publication.published',
];
const audits = Array.from({ length: 24 }, (_, i) => ({
  id: 'e0000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
  action: auditActions[i % auditActions.length]!,
  actorKind: 'user',
  actorId: ownerId,
  resourceType: i % 5 === 0 ? 'invitation' : i % 5 === 1 ? 'role' : 'settings',
  resourceId: i % 5 === 1 ? customId : null,
  outcome: 'success',
  requestId: 'demo-request-' + (i + 1),
  changes: i % 5 === 1 ? { permissionKeys: ['assets.read', 'assets.download'] } : {},
  createdAt: '2026-11-17T08:' + String(30 - i).padStart(2, '0') + ':00.000Z',
}));
export function administrationSession(restricted = false) {
  const role =
    adminRoles.find((r) => r.id === (restricted ? customId : members[0]!.roleId)) || adminRoles[0]!;
  return {
    ...demoSession,
    user: { ...demoSession.user, displayName: '演示管理员', roleId: role.id },
    role: {
      id: role.id,
      key: role.kind === 'system' ? 'sysadmin' : 'contributor',
      name: role.name,
      kind: role.kind as 'system' | 'custom',
      revision: role.revision,
    },
    permissionKeys: role.permissionKeys,
  };
}
function page<T>(items: T[], query: URLSearchParams, scenario: string) {
  const start = Number(query.get('cursor') || 0),
    limit = Number(query.get('limit') || 20);
  if (scenario === 'empty') return { items: [], pageInfo: { hasMore: false, nextCursor: null } };
  return {
    items: items.slice(start, start + limit),
    pageInfo: {
      hasMore: start + limit < items.length,
      nextCursor: start + limit < items.length ? String(start + limit) : null,
    },
  };
}
export function administrationApi(
  route: string,
  query: URLSearchParams,
  options: ApiOptions,
  scenario: string,
  consumeConflict: () => boolean,
): unknown {
  const method = options.method || 'GET',
    body = JSON.parse(JSON.stringify(options.body || {})) as Record<string, unknown>;
  if (scenario === 'forbidden') throw new ApiError(403, 'FORBIDDEN', '当前账号没有管理权限。');
  if (
    method === 'GET' &&
    (scenario === 'error' || (scenario === 'more-error' && query.has('cursor')))
  )
    throw new ApiError(503, 'DEMO_READ_FAILURE', '演示：暂时无法读取。切回正常内容后重试。');
  if (method !== 'GET' && scenario === 'fresh-auth')
    throw new ApiError(403, 'FRESH_AUTH_REQUIRED', '请再次确认身份。');
  if (method !== 'GET' && scenario === 'conflict' && consumeConflict())
    throw new ApiError(412, 'REVISION_CONFLICT', '内容已被更新，请读取最新版本并重新核对。');
  if (route === '/team/admin/members') return page(members, query, scenario);
  const member = route.match(/^\/team\/admin\/members\/([^/]+)\/(.+)$/);
  if (member) {
    const m = members.find((x) => x.id === member[1]);
    if (!m) throw new ApiError(404, 'NOT_FOUND', '成员不存在。');
    if (member[2] === 'recovery-tokens')
      return {
        token: 'synthetic-recovery-link',
        expiresAt: '2026-12-01T08:00:00.000Z',
        replayed: false,
      };
    if (m.id === ownerId && (member[2] === 'disable' || body.roleId !== adminId))
      throw new ApiError(409, 'LAST_ADMIN_REQUIRED', '必须保留最后一位正常的系统管理员。');
    if (String(body.expectedRevision) !== m.revision)
      throw new ApiError(412, 'REVISION_CONFLICT', '成员状态已经变化，请重新读取。');
    if (member[2] === 'change-role') m.roleId = String(body.roleId);
    else m.status = member[2] === 'disable' ? 'suspended' : 'active';
    m.revision = String(Number(m.revision) + 1);
    return m;
  }
  if (route === '/team/admin/invitations') {
    if (method === 'GET')
      return page(
        invitations.filter((i) => !query.get('state') || i.state === query.get('state')),
        query,
        scenario,
      );
    const invitation: Invitation = {
      id: crypto.randomUUID(),
      revision: '1',
      state: 'pending',
      userId: crypto.randomUUID(),
      reservedLoginName: (body.loginName as string) || null,
      expiresAt: '2026-12-01T08:00:00.000Z',
    };
    invitations.unshift(invitation);
    members.push({
      id: invitation.userId!,
      revision: '1',
      displayName: '待入组成员',
      status: 'invited',
      roleId: String(body.roleId),
    });
    return { invitation, token: 'synthetic-invitation-link' };
  }
  const invite = route.match(/^\/team\/admin\/invitations\/([^/]+)(?:\/(reissue|revoke))?$/);
  if (invite) {
    const i = invitations.find((x) => x.id === invite[1]);
    if (!i) throw new ApiError(404, 'NOT_FOUND', '邀请不存在。');
    if (method === 'GET') return i;
    i.revision = String(Number(i.revision) + 1);
    if (invite[2] === 'revoke') {
      i.state = 'revoked';
      return i;
    }
    return { invitation: i, token: 'synthetic-reissued-invitation-link' };
  }
  if (route === '/team/admin/permission-catalog')
    return {
      items: PERMISSION_KEYS.map((key) => ({
        key,
        name: catalogNames[key] || key,
        delegable: !key.startsWith('system.'),
        dependencies: PERMISSION_DEPENDENCIES[key] || [],
      })),
    };
  if (route === '/team/admin/roles') {
    if (method === 'GET') return scenario === 'empty' ? [] : adminRoles;
    const role: Role = {
      id: crypto.randomUUID(),
      revision: '1',
      kind: 'custom',
      name: String(body.name),
      permissionKeys: body.permissionKeys as string[],
      archivedAt: null,
    };
    adminRoles.push(role);
    return role;
  }
  const role = route.match(/^\/team\/admin\/roles\/([^/]+)(?:\/(retire))?$/);
  if (role) {
    const r = adminRoles.find((x) => x.id === role[1]);
    if (!r) throw new ApiError(404, 'NOT_FOUND', '角色不存在。');
    if (r.kind === 'system') throw new ApiError(403, 'SYSTEM_ROLE_IMMUTABLE', '系统角色不能变更。');
    if (role[2] === 'retire') {
      if (members.some((m) => m.roleId === r.id))
        throw new ApiError(409, 'ROLE_IN_USE', '请先为使用此角色的成员调整角色。');
      r.archivedAt = new Date().toISOString();
    } else {
      r.name = String(body.name);
      r.permissionKeys = body.permissionKeys as string[];
    }
    r.revision = String(Number(r.revision) + 1);
    return r;
  }
  if (route === '/team/admin/settings') {
    if (method !== 'GET') {
      if (body.brand) {
        adminSettings.brand = { ...adminSettings.brand, ...(body.brand as object) };
        adminSettings.name = adminSettings.brand.name ?? '拾灵';
      }
      if (body.types)
        adminSettings.types = (body.types as typeof types).map((t) => ({
          ...types.find((x) => x.id === t.id),
          ...t,
        }));
      if (typeof body.publicEnabled === 'boolean') adminSettings.publicEnabled = body.publicEnabled;
      if (body.logoBrandingAssetId === null) adminSettings.logoBrandingAssetId = null;
      if (body.faviconBrandingAssetId === null) adminSettings.faviconBrandingAssetId = null;
      adminSettings.revision = String(Number(adminSettings.revision) + 1);
    }
    return adminSettings;
  }
  if (route === '/team/admin/branding-assets')
    throw new ApiError(
      501,
      'DEMO_UPLOAD_UNAVAILABLE',
      '演示不保存品牌文件，请在真实服务环境核验上传。',
    );
  if (route === '/team/admin/operations')
    return {
      evaluatedAt: '2026-11-17T08:30:00.000Z',
      database: { reachable: true },
      storage: {
        basis: 'databaseMetadata',
        storedBytes: '258470912',
        storedObjects: '148',
        integrityIssues: '0',
      },
      jobs: [],
      assets: [],
      publicEnabled: adminSettings.publicEnabled,
      preview: { configured: false, isolationReady: false, executionEnabled: false },
    };
  if (route === '/team/admin/jobs')
    return page(
      jobs.filter((j) => !query.get('state') || j.state === query.get('state')),
      query,
      scenario,
    );
  const job = route.match(/^\/team\/admin\/jobs\/([^/]+)(?:\/(retry))?$/);
  if (job) {
    const j = jobs.find((x) => x.id === job[1]);
    if (!j) throw new ApiError(404, 'NOT_FOUND', '任务不存在。');
    if (job[2]) {
      j.state = 'queued';
      j.actions = { retry: false };
      j.safeError = null;
      return { jobId: j.id };
    }
    return {
      ...j,
      attempts: j.attempts,
    };
  }
  if (route === '/team/admin/audit-events')
    return page(
      audits.filter((e) => !query.get('action') || e.action === query.get('action')),
      query,
      scenario,
    );
  throw new ApiError(404, 'DEMO_NOT_FOUND', '演示记录不存在。');
}
