<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { formatDate } from '@shiling/ui';
import { api, operationKey } from '../../app/http-client';
import { itemsOf } from '../../app/models';
import type { Invitation, Member, Page, Role } from '../../app/models';
import { can, identity, loadSession } from '../../app/session';
import { useAction } from './use-action';
import { useConfirmation } from './use-confirmation';
import UiNotice from '../../components/ui/UiNotice.vue';
import UiState from '../../components/ui/UiState.vue';
import UiDialog from '../../components/ui/UiDialog.vue';
import UiConfirm from '../../components/ui/UiConfirm.vue';
import UiButton from '../../components/ui/UiButton.vue';
import ReauthenticateForm from '../identity/ReauthenticateForm.vue';
const router = useRouter();
const members = ref<Member[]>([]),
  invitations = ref<Invitation[]>([]),
  roles = ref<Role[]>([]);
const memberCursor = ref<string | null>(null),
  invitationCursor = ref<string | null>(null);
const tab = ref('members'),
  query = ref(''),
  invitationState = ref('');
const loginName = ref(''),
  roleId = ref(''),
  link = ref(''),
  linkTitle = ref('');
const creating = ref(false),
  invite = ref<Invitation | null>(null),
  editing = ref<Member | null>(null),
  nextRole = ref('');
const invitationError = ref('');
let invitationKey = operationKey();
const { busy, error, message, freshAuth, conflict, run, reauthenticated } = useAction();
const { confirmation, ask, settle } = useConfirmation();
const customRoles = computed(() =>
  roles.value.filter((r) => r.kind !== 'system' && !r.system && !r.archivedAt),
);
const visibleMembers = computed(() =>
  members.value.filter((m) =>
    (m.displayName ?? '').toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()),
  ),
);
const cursor = <T,>(p: Page<T> | T[]) =>
  !Array.isArray(p) && p.pageInfo?.hasMore ? (p.pageInfo.nextCursor ?? null) : null;
const invitationLabels: Record<string, string> = {
  pending: '待接受',
  accepted: '已接受',
  revoked: '已撤销',
};
const roleName = (m: Member) =>
  m.role?.name || roles.value.find((r) => r.id === m.roleId)?.name || '角色不可见';
function status(m: Member): string {
  return (
    ({ active: '正常', suspended: '已停用', invited: '待接受邀请' } as Record<string, string>)[
      m.status ?? m.state ?? ''
    ] ?? '状态未知'
  );
}
function closeLink(): void {
  link.value = '';
  invite.value = null;
  linkTitle.value = '';
}
async function loadInvitations(more = false): Promise<void> {
  invitationError.value = '';
  const params = new URLSearchParams({ limit: '20' });
  if (invitationState.value) params.set('state', invitationState.value);
  if (more && invitationCursor.value) params.set('cursor', invitationCursor.value);
  try {
    const result = await api<Page<Invitation>>('/team/admin/invitations?' + params);
    invitations.value = more
      ? [
          ...invitations.value,
          ...result.items.filter((i) => !invitations.value.some((x) => x.id === i.id)),
        ]
      : result.items;
    invitationCursor.value = cursor(result);
  } catch {
    invitationError.value = '邀请记录暂时无法读取，已显示的记录和本次签发链接仍保留。';
  }
}
async function data(): Promise<void> {
  if (!can('system.members.manage')) return;
  const [m, r] = await Promise.all([
    api<Page<Member>>('/team/admin/members?limit=20'),
    can('system.roles.manage')
      ? api<Page<Role> | Role[]>('/team/admin/roles')
      : Promise.resolve([]),
  ]);
  members.value = m.items;
  memberCursor.value = cursor(m);
  roles.value = itemsOf(r);
  await loadInvitations();
}
async function load(): Promise<void> {
  await run(data);
}
async function more(): Promise<void> {
  await run(async () => {
    if (tab.value === 'invitations') {
      await loadInvitations(true);
      return;
    }
    if (!memberCursor.value) return;
    const p = await api<Page<Member>>(
      '/team/admin/members?limit=20&cursor=' + encodeURIComponent(memberCursor.value),
    );
    members.value.push(...p.items.filter((i) => !members.value.some((x) => x.id === i.id)));
    memberCursor.value = cursor(p);
  });
}
async function filterInvitations(): Promise<void> {
  invitations.value = [];
  invitationCursor.value = null;
  await run(() => loadInvitations());
}
function secretLink(token: string, route: string): string {
  return (
    new URL(router.resolve(route).href, location.origin).href +
    '#token=' +
    encodeURIComponent(token)
  );
}
async function createInvite(): Promise<void> {
  await run(async () => {
    const result = await api<{ invitation: Invitation; token: string | null }>(
      '/team/admin/invitations',
      {
        method: 'POST',
        body: {
          ...(loginName.value.trim() ? { loginName: loginName.value.trim() } : {}),
          roleId: roleId.value,
        },
        idempotencyKey: invitationKey,
      },
    );
    creating.value = false;
    invite.value = result.invitation;
    link.value = result.token ? secretLink(result.token, '/accept-invitation') : '';
    linkTitle.value = '邀请已创建';
    loginName.value = '';
    await data();
  }, '邀请已创建。请通过可信渠道交付链接。');
}
async function invitationAction(action: 'reissue' | 'revoke'): Promise<void> {
  const current = invite.value;
  if (
    !current ||
    !(await ask(
      action === 'reissue' ? '重新签发邀请' : '撤销邀请',
      action === 'reissue'
        ? '旧链接将立即失效。新链接只显示一次，请重新交付给受邀者。'
        : '未使用的邀请链接将立即失效。此操作不会撤销已完成的入组。',
      action === 'reissue' ? '重新签发' : '撤销邀请',
    ))
  )
    return;
  await run(
    async () => {
      const fresh = await api<Invitation>('/team/admin/invitations/' + current.id);
      const result = await api<Invitation | { invitation: Invitation; token: string | null }>(
        '/team/admin/invitations/' + current.id + '/' + action,
        {
          method: 'POST',
          body: { expectedRevision: fresh.revision },
          idempotencyKey: operationKey(),
        },
      );
      invite.value = 'invitation' in result ? result.invitation : result;
      link.value =
        'invitation' in result && result.token
          ? secretLink(result.token, '/accept-invitation')
          : '';
      if (action === 'revoke') closeLink();
      await data();
    },
    action === 'reissue' ? '邀请已重新签发，旧链接已失效。' : '邀请已撤销。',
  );
}
async function changeStatus(member: Member): Promise<void> {
  const disabled = (member.status ?? member.state) === 'suspended';
  if (
    !(await ask(
      (disabled ? '恢复' : '停用') + '「' + (member.displayName || '成员') + '」',
      disabled
        ? '恢复后可重新登录。旧会话和未入库上传不会自动恢复。'
        : '后续会话失效，未就绪上传停止入库。历史公开内容不会自动撤回；系统会保护最后一位管理员。',
      disabled ? '恢复账号' : '停用账号',
    ))
  )
    return;
  await run(
    async () => {
      await api('/team/admin/members/' + member.id + '/' + (disabled ? 'enable' : 'disable'), {
        method: 'POST',
        body: { expectedRevision: member.revision },
        idempotencyKey: operationKey(),
      });
      if (member.id === identity.session?.user.id) await loadSession(true);
      await data();
    },
    disabled ? '账号已恢复。' : '账号已停用。',
  );
}
async function changeRole(): Promise<void> {
  const current = editing.value;
  if (
    !current ||
    !(await ask(
      '确认变更角色',
      '「' +
        (current.displayName || '成员') +
        '」将使用「' +
        (roles.value.find((r) => r.id === nextRole.value)?.name || '所选角色') +
        '」。新权限立即用于后续请求。',
      '变更角色',
    ))
  )
    return;
  await run(async () => {
    await api('/team/admin/members/' + current.id + '/change-role', {
      method: 'POST',
      body: { roleId: nextRole.value, expectedRevision: current.revision },
      idempotencyKey: operationKey(),
    });
    editing.value = null;
    await loadSession(true);
    await data();
  }, '成员角色已更新。');
}
async function refreshMember(): Promise<void> {
  await run(async () => {
    if (!editing.value) return;
    let after: string | null = null;
    do {
      const page: Page<Member> = await api<Page<Member>>(
        '/team/admin/members?limit=100' + (after ? '&cursor=' + encodeURIComponent(after) : ''),
      );
      const latest = page.items.find((item) => item.id === editing.value?.id);
      if (latest) {
        editing.value = latest;
        return;
      }
      after = cursor(page);
    } while (after);
    editing.value = null;
    throw new Error('成员已不可用，请重新读取成员列表。');
  }, '已读取最新成员版本，保留角色选择。请核对后提交。');
}
async function recover(member: Member): Promise<void> {
  if (
    !(await ask(
      '生成密码恢复链接',
      '为「' +
        (member.displayName || '成员') +
        '」生成一次性链接。应用不会自动发送消息；恢复密码不会激活停用账号。',
      '生成恢复链接',
    ))
  )
    return;
  await run(async () => {
    const result = await api<{ token: string | null }>(
      '/team/admin/members/' + member.id + '/recovery-tokens',
      { method: 'POST', body: {}, idempotencyKey: operationKey() },
    );
    invite.value = null;
    link.value = result.token ? secretLink(result.token, '/recover-account') : '';
    linkTitle.value = '密码恢复链接';
  }, '恢复链接仅在本次签发时显示。');
}
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(link.value);
    message.value = '链接已复制。';
  } catch {
    message.value = '无法自动复制，请选择完整链接后手动复制。';
  }
}
onMounted(load);
onBeforeUnmount(closeLink);
</script>
<template>
  <section class="page-content admin-page">
    <header class="page-heading">
      <div>
        <h1>成员与邀请</h1>
        <p>让合适的人加入团队，保持清楚的协作边界。</p>
      </div>
      <UiButton
        v-if="can('system.members.manage')"
        variant="primary"
        :disabled="busy || !customRoles.length"
        @click="
          creating = true;
          invitationKey = operationKey();
          error = '';
        "
        >邀请成员</UiButton
      >
    </header>
    <UiState
      v-if="!can('system.members.manage')"
      title="没有成员管理权限"
      description="请联系管理员调整你的访问权限。"
    />
    <template v-else>
      <UiNotice v-if="error && !creating && !editing && !linkTitle" tone="error"
        >{{ error
        }}<button class="text-button" :disabled="busy" @click="load">重新读取</button></UiNotice
      ><UiNotice v-if="message" tone="success">{{ message }}</UiNotice>
      <div class="admin-toolbar">
        <div class="admin-tabs" role="group" aria-label="成员页面">
          <button
            :class="{ active: tab === 'members' }"
            :aria-pressed="tab === 'members'"
            @click="tab = 'members'"
          >
            团队成员</button
          ><button
            :class="{ active: tab === 'invitations' }"
            :aria-pressed="tab === 'invitations'"
            @click="tab = 'invitations'"
          >
            邀请记录
          </button>
        </div>
        <button class="text-button" :disabled="busy" @click="load">刷新</button>
      </div>
      <template v-if="tab === 'members'">
        <div class="admin-filter">
          <label class="search-field"
            ><span class="sr-only">筛选已加载成员</span
            ><input v-model="query" type="search" placeholder="筛选已加载成员的名称" /></label
          ><span class="muted">已加载 {{ members.length }} 位成员</span>
        </div>
        <div class="admin-records">
          <article
            v-for="member in visibleMembers"
            :key="member.id"
            class="admin-record member-record"
          >
            <div class="member-avatar" aria-hidden="true">
              {{ (member.displayName || '成员').slice(0, 1) }}
            </div>
            <div class="record-primary">
              <strong
                >{{ member.displayName || '待入组成员' }}
                <span v-if="member.id === identity.session?.user.id" class="self-label"
                  >你</span
                ></strong
              >
              <p>{{ roleName(member) }}</p>
            </div>
            <span class="status-label" :class="{ 'is-muted': member.status !== 'active' }">{{
              status(member)
            }}</span>
            <div class="actions">
              <UiButton
                v-if="can('system.roles.manage')"
                variant="quiet"
                :disabled="busy"
                @click="
                  editing = member;
                  nextRole = member.roleId || member.role?.id || '';
                  error = '';
                "
                >变更角色</UiButton
              ><UiButton
                v-if="member.status !== 'invited'"
                variant="quiet"
                :disabled="busy"
                @click="recover(member)"
                >恢复密码</UiButton
              ><UiButton
                v-if="member.status !== 'invited'"
                variant="quiet"
                :disabled="busy"
                @click="changeStatus(member)"
                >{{ member.status === 'suspended' ? '恢复账号' : '停用' }}</UiButton
              >
            </div>
          </article>
        </div>
        <UiState
          v-if="!visibleMembers.length"
          :title="busy ? '正在读取成员' : query ? '没有匹配的成员' : '暂无成员记录'"
          :busy="busy"
          description="筛选只作用于已加载成员，可清除筛选或继续加载。"
        />
      </template>
      <template v-else>
        <div class="admin-filter">
          <label
            >邀请状态<select v-model="invitationState" :disabled="busy" @change="filterInvitations">
              <option value="">全部状态</option>
              <option value="pending">待接受</option>
              <option value="accepted">已接受</option>
              <option value="revoked">已撤销</option>
            </select></label
          ><span class="muted">已加载 {{ invitations.length }} 条记录</span>
        </div>
        <UiNotice v-if="invitationError" tone="error"
          >{{ invitationError
          }}<button class="text-button" :disabled="busy" @click="filterInvitations">
            重试
          </button></UiNotice
        >
        <div class="admin-records">
          <article v-for="item in invitations" :key="item.id" class="admin-record">
            <div class="record-primary">
              <strong>{{ item.reservedLoginName || '由受邀者填写账号' }}</strong>
              <p>{{ item.expiresAt ? formatDate(item.expiresAt) + ' 到期' : '无有效期限' }}</p>
            </div>
            <span class="status-label" :class="{ 'is-muted': item.state !== 'pending' }">{{
              invitationLabels[item.state] || item.state
            }}</span><UiButton
              v-if="item.state === 'pending'"
              variant="quiet"
              :disabled="busy"
              @click="
                invite = item;
                link = '';
                linkTitle = '管理邀请';
                error = '';
              "
              >管理邀请</UiButton
            >
          </article>
        </div>
        <UiState
          v-if="!invitations.length && !invitationError"
          :title="busy ? '正在读取邀请' : '暂无邀请记录'"
          :busy="busy"
          description="邀请成员后，可在这里查看状态和管理链接。"
        />
      </template>
      <div v-if="tab === 'members' ? memberCursor : invitationCursor" class="load-more">
        <UiButton :busy="busy" @click="more"
          >加载更多{{ tab === 'members' ? '成员' : '邀请' }}</UiButton
        >
      </div>
      <p class="admin-footnote">
        成员身份只在团队内部显示。邀请链接与恢复链接需要你通过可信渠道交付。
      </p>
      <UiDialog v-if="creating" title="邀请成员" :dismissible="!busy" @close="creating = false"
        ><form class="form-stack" @submit.prevent="createInvite">
          <UiNotice v-if="error" tone="error">{{ error }}</UiNotice><label
            >邀请角色<select v-model="roleId" required>
              <option value="">选择一个角色</option>
              <option v-for="role in customRoles" :key="role.id" :value="role.id">
                {{ role.name }}
              </option>
            </select></label
          ><label
            >预留登录账号 <span class="muted">（可选）</span
            ><input
              v-model="loginName"
              maxlength="64"
              pattern="[A-Za-z0-9._-]{3,64}"
              placeholder="留空，由受邀者填写"
            /><span class="form-hint">3–64 个字母、数字、点、下划线或连字符。</span></label
          >
          <p class="form-hint">邀请不能直接授予系统管理员。链接只在签发时显示一次。</p>
          <div class="dialog-actions">
            <UiButton :disabled="busy" @click="creating = false">取消</UiButton
            ><UiButton type="submit" variant="primary" :busy="busy" :disabled="!roleId"
              >生成邀请链接</UiButton
            >
          </div>
        </form></UiDialog
      >
      <UiDialog v-if="linkTitle" :title="linkTitle" :dismissible="!busy" @close="closeLink"
        ><div class="form-stack">
          <UiNotice v-if="error" tone="error">{{ error }}</UiNotice>
          <p>
            {{
              link
                ? '请立即复制并交付。关闭后，完整链接不会再次显示。'
                : '完整链接仅在签发时显示。可以重新签发邀请，使旧链接失效。'
            }}
          </p>
          <label v-if="link"
            >一次性交付链接<textarea
              :value="link"
              readonly
              rows="3"
              @focus="($event.target as HTMLTextAreaElement).select()"
            /></label
          ><UiButton v-if="link" variant="primary" @click="copy">复制链接</UiButton>
          <p v-if="message" role="status" class="form-hint">{{ message }}</p>
          <div v-if="invite?.state === 'pending'" class="actions">
            <UiButton :disabled="busy" @click="invitationAction('reissue')">重新签发</UiButton
            ><UiButton variant="quiet" :disabled="busy" @click="invitationAction('revoke')"
              >撤销邀请</UiButton
            >
          </div>
          <div class="dialog-actions">
            <UiButton :disabled="busy" @click="closeLink">关闭并清除链接</UiButton>
          </div>
        </div></UiDialog
      >
      <UiDialog v-if="editing" title="变更成员角色" :dismissible="!busy" @close="editing = null"
        ><form class="form-stack" @submit.prevent="changeRole">
          <UiNotice v-if="message" tone="success">{{ message }}</UiNotice>
          <UiNotice v-if="error" tone="error"
            >{{ error
            }}<button v-if="conflict" type="button" class="text-button" @click="refreshMember">
              读取最新版本，保留选择
            </button></UiNotice
          >
          <p>{{ editing.displayName || '待入组成员' }} · 当前为{{ roleName(editing) }}</p>
          <label
            >新角色<select v-model="nextRole" required>
              <option
                v-for="role in roles.filter(
                  (r) => !r.archivedAt && (editing?.status !== 'invited' || r.kind !== 'system'),
                )"
                :key="role.id"
                :value="role.id"
              >
                {{ role.name }}
              </option>
            </select></label
          >
          <p class="form-hint">新权限立即影响后续请求。最后一位系统管理员不能被降级。</p>
          <div class="dialog-actions">
            <UiButton :disabled="busy" @click="editing = null">取消</UiButton
            ><UiButton
              type="submit"
              variant="primary"
              :busy="busy"
              :disabled="!nextRole || nextRole === editing.roleId"
              >确认变更</UiButton
            >
          </div>
        </form></UiDialog
      >
    </template>
    <ReauthenticateForm
      v-if="freshAuth"
      @confirmed="reauthenticated"
      @cancel="freshAuth = false"
    /><UiConfirm
      v-if="confirmation"
      v-bind="confirmation"
      @confirm="settle(true)"
      @close="settle(false)"
    />
  </section>
</template>
