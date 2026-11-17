<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { formatBytes, formatDate } from '@shiling/ui';
import { api, operationKey } from '../../app/http-client';
import { allows } from '../../app/models';
import type { Job, Page } from '../../app/models';
import { can } from '../../app/session';
import { useAction } from './use-action';
import UiNotice from '../../components/ui/UiNotice.vue';
import UiState from '../../components/ui/UiState.vue';
import UiDialog from '../../components/ui/UiDialog.vue';
import UiButton from '../../components/ui/UiButton.vue';
import ReauthenticateForm from '../identity/ReauthenticateForm.vue';
interface Summary {
  evaluatedAt: string;
  database: { reachable: boolean };
  storage: {
    basis: 'databaseMetadata';
    storedBytes: string;
    storedObjects: string;
    integrityIssues: string;
  };
  preview: { configured: boolean; isolationReady: boolean; executionEnabled: boolean };
  publicEnabled: boolean;
}
interface Audit {
  id: string;
  action: string;
  createdAt: string;
  actorKind: string;
  actorId?: string | null;
  resourceType: string;
  resourceId?: string | null;
  outcome: string;
  requestId?: string;
  changes?: Record<string, unknown>;
}
const route = useRoute(),
  section = String(route.params.section);
const summary = ref<Summary | null>(null),
  jobs = ref<Job[]>([]),
  events = ref<Audit[]>([]);
const nextCursor = ref<string | null>(null),
  stateFilter = ref(''),
  actionFilter = ref(''),
  appliedAction = ref('');
const selectedJob = ref<Job | null>(null),
  selectedEvent = ref<Audit | null>(null);
const { busy, error, message, freshAuth, run, reauthenticated } = useAction();
const allowed = computed(() =>
  can(section === 'audit' ? 'system.audit.read' : 'system.operations.read'),
);
const title =
  ({ health: '系统状态', tasks: '处理任务', audit: '必要审计' } as Record<string, string>)[
    section
  ] || '运行状态';
const subtitle = (
  {
    health: '查看服务摘要，确认关键能力的当前状态。',
    tasks: '跟进素材处理，定位失败并按允许动作重试。',
    audit: '追溯关键操作与结果，记录仅对有权限的成员可见。',
  } as Record<string, string>
)[section];
const states: Record<string, string> = {
  pending: '等待中',
  queued: '排队中',
  running: '处理中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
};
const kinds: Record<string, string> = {
  'media.derive': '生成素材衍生文件',
  'media.optional.preview_image': '补充图片预览',
  image_process: '图片处理',
  video_process: '视频处理',
  image_required: '图片处理',
  image_optional: '补充预览',
  video_required: '视频处理',
  motion_required: '动效处理',
  preview: '生成预览',
  poster: '生成封面',
};
const actionNames: Record<string, string> = {
  'identity.invitation_created': '创建邀请',
  'identity.invitation_revoked': '撤销邀请',
  'identity.invitation_reissued': '重新签发邀请',
  'identity.role_updated': '更新角色',
  'identity.role_created': '创建角色',
  'identity.role_retired': '归档角色',
  'settings.updated': '更新产品设置',
  'administration.settings_updated': '更新产品设置',
  'administration.branding_asset_verified': '核验品牌图片',
  'identity.member_suspended': '停用账号',
  'identity.member_active': '恢复账号',
  'publication.snapshot_written': '保存公开快照',
  'administration.job_retried': '重试处理任务',
  'identity.member_disabled': '停用账号',
  'identity.member_enabled': '恢复账号',
  'identity.member_role_changed': '变更成员角色',
  'publication.published': '公开素材',
  'publication.withdrawn': '撤回公开',
  'job.retried': '重试处理任务',
};
const outcome = (v: string) =>
  (
    ({
      success: '成功',
      succeeded: '成功',
      failure: '失败',
      failed: '失败',
      denied: '已拒绝',
    }) as Record<string, string>
  )[v] || v;
async function data(more = false): Promise<void> {
  if (!allowed.value) return;
  if (section === 'health') {
    summary.value = await api<Summary>('/team/admin/operations');
    return;
  }
  const q = new URLSearchParams({ limit: '20' });
  if (more && nextCursor.value) q.set('cursor', nextCursor.value);
  if (section === 'tasks' && stateFilter.value) q.set('state', stateFilter.value);
  if (section === 'audit' && appliedAction.value) q.set('action', appliedAction.value);
  const p = await api<Page<Job | Audit>>(
    '/team/admin/' + (section === 'tasks' ? 'jobs' : 'audit-events') + '?' + q,
  );
  if (section === 'tasks')
    jobs.value = more
      ? [...jobs.value, ...(p.items as Job[]).filter((i) => !jobs.value.some((x) => x.id === i.id))]
      : (p.items as Job[]);
  else
    events.value = more
      ? [
          ...events.value,
          ...(p.items as Audit[]).filter((i) => !events.value.some((x) => x.id === i.id)),
        ]
      : (p.items as Audit[]);
  nextCursor.value = p.pageInfo?.hasMore ? (p.pageInfo.nextCursor ?? null) : null;
}
async function load(more = false): Promise<void> {
  await run(() => data(more));
}
async function queryAudit(): Promise<void> {
  appliedAction.value = actionFilter.value.trim();
  events.value = [];
  nextCursor.value = null;
  await load();
}
async function queryJobs(): Promise<void> {
  jobs.value = [];
  nextCursor.value = null;
  await load();
}
async function openJob(job: Job): Promise<void> {
  selectedJob.value = job;
  await run(async () => {
    selectedJob.value = await api<Job>('/team/admin/jobs/' + job.id);
  });
}
async function retry(job: Job): Promise<void> {
  if (!can('system.jobs.manage') || !allows(job.actions, 'retry')) return;
  await run(async () => {
    await api('/team/admin/jobs/' + job.id + '/retry', {
      method: 'POST',
      idempotencyKey: operationKey(),
    });
    if (selectedJob.value?.id === job.id)
      selectedJob.value = await api<Job>('/team/admin/jobs/' + job.id);
    await data();
  }, '重试已提交，请继续查看处理状态。');
}
onMounted(() => load());
</script>
<template>
  <section class="page-content admin-page">
    <header class="page-heading">
      <div>
        <h1>{{ title }}</h1>
        <p>{{ subtitle }}</p>
      </div>
      <UiButton v-if="allowed" :busy="busy" @click="load()">刷新</UiButton>
    </header>
    <UiState
      v-if="!allowed"
      title="没有此页面的访问权限"
      description="请联系管理员调整你的访问权限。"
    />
    <template v-else>
      <UiNotice v-if="error && !selectedJob" tone="error"
        >{{ error
        }}<button class="text-button" :disabled="busy" @click="load()">重新读取</button></UiNotice
      ><UiNotice v-if="message" tone="success">{{ message }}</UiNotice>
      <template v-if="section === 'health'"
        ><UiState
          v-if="!summary"
          :title="busy ? '正在读取系统状态' : '系统状态尚未加载'"
          :busy="busy"
          description="没有检查结果不代表业务已经就绪。"
        /><template v-else>
          <div class="admin-toolbar">
            <p class="muted">最近读取 {{ formatDate(summary.evaluatedAt) }}</p>
            <span class="status-label">服务摘要</span>
          </div>
          <div class="health-records">
            <article>
              <div>
                <h2>数据库访问</h2>
                <p>当前服务能否连接并读取数据库。</p>
              </div>
              <strong class="status-label" :class="{ 'is-error': !summary.database.reachable }">{{
                summary.database.reachable ? '可连接' : '不可连接'
              }}</strong>
            </article>
            <article>
              <div>
                <h2>存储元数据</h2>
                <p>
                  已登记 {{ summary.storage.storedObjects }} 个对象，共
                  {{ formatBytes(summary.storage.storedBytes) }}。
                </p>
                <p>此数值来自数据库，不代表磁盘剩余空间或存储实时健康。</p>
              </div>
              <strong
                class="status-label"
                :class="{ 'is-error': summary.storage.integrityIssues !== '0' }"
                >完整性异常 {{ summary.storage.integrityIssues }} 项</strong
              >
            </article>
            <article>
              <div>
                <h2>动效执行隔离</h2>
                <p>
                  预览配置{{ summary.preview.configured ? '已提供' : '未提供' }}；服务器隔离{{
                    summary.preview.isolationReady ? '已就绪' : '未就绪'
                  }}。
                </p>
                <p>只有服务器隔离通过验收后，才可开放主动动效执行。</p>
              </div>
              <strong class="status-label is-muted">{{
                summary.preview.executionEnabled && summary.preview.isolationReady
                  ? '已开放'
                  : '执行未开放'
              }}</strong>
            </article>
            <article>
              <div>
                <h2>公开入口</h2>
                <p>仅展示所有者显式公开的快照，素材入库不会自动公开。</p>
              </div>
              <strong class="status-label" :class="{ 'is-muted': !summary.publicEnabled }">{{
                summary.publicEnabled ? '开启' : '关闭'
              }}</strong>
            </article>
          </div>
          <p class="admin-footnote">
            此页提供运行摘要；完整业务就绪仍需上传、处理、存储与预览的实际验收。
          </p>
        </template></template
      >
      <template v-else-if="section === 'tasks'">
        <div class="admin-filter">
          <label
            >任务状态<select v-model="stateFilter" :disabled="busy" @change="queryJobs">
              <option value="">全部状态</option>
              <option v-for="(label, key) in states" :key="key" :value="key">{{ label }}</option>
            </select></label
          ><span class="muted">已加载 {{ jobs.length }} 项</span>
        </div>
        <div class="admin-records">
          <article v-for="job in jobs" :key="job.id" class="admin-record">
            <div class="record-primary">
              <button class="record-title" :disabled="busy" @click="openJob(job)">
                {{ kinds[job.kind || ''] || job.kind || '处理任务' }}
              </button>
              <p>
                {{ job.required ? '必要步骤' : '补充步骤' }} · 已尝试 {{ job.attemptCount || 0 }} 次
                · {{ formatDate(job.updatedAt) }}
              </p>
              <p v-if="job.safeError" class="error-text">{{ job.safeError.message }}</p>
            </div>
            <span
              class="status-label"
              :class="{
                'is-error': job.state === 'failed',
                'is-muted': ['pending', 'queued', 'canceled'].includes(job.state),
              }"
              >{{ states[job.state] || job.state }}</span
            >
            <div class="actions">
              <UiButton variant="quiet" :disabled="busy" @click="openJob(job)">详情</UiButton
              ><UiButton
                v-if="can('system.jobs.manage') && allows(job.actions, 'retry')"
                :busy="busy"
                @click="retry(job)"
                >重试</UiButton
              >
            </div>
          </article>
        </div>
        <UiState
          v-if="!jobs.length"
          :title="busy ? '正在读取任务' : stateFilter ? '此状态下暂无任务' : '暂无处理任务'"
          :busy="busy"
          description="素材处理记录会显示在这里。"
        />
      </template>
      <template v-else>
        <form class="admin-filter audit-filter" @submit.prevent="queryAudit">
          <label
            >按动作精确筛选<input
              v-model="actionFilter"
              placeholder="例如 identity.role_updated"
              maxlength="120" /></label
          ><UiButton type="submit" :busy="busy">查询</UiButton
          ><UiButton
            v-if="appliedAction"
            variant="quiet"
            :disabled="busy"
            @click="
              actionFilter = '';
              queryAudit();
            "
            >清除</UiButton
          >
        </form>
        <div class="admin-records">
          <article v-for="event in events" :key="event.id" class="admin-record">
            <div class="record-primary">
              <button class="record-title" @click="selectedEvent = event">
                {{ actionNames[event.action] || event.action }}
              </button>
              <p>
                {{ event.actorKind === 'user' ? '成员操作' : '系统操作' }} ·
                {{ event.resourceType }} · {{ formatDate(event.createdAt) }}
              </p>
            </div>
            <span
              class="status-label"
              :class="{ 'is-error': ['failure', 'failed', 'denied'].includes(event.outcome) }"
              >{{ outcome(event.outcome) }}</span><UiButton
              variant="quiet"
              @click="selectedEvent = event"
              >详情</UiButton
            >
          </article>
        </div>
        <UiState
          v-if="!events.length"
          :title="busy ? '正在读取审计记录' : appliedAction ? '没有匹配的审计记录' : '暂无审计记录'"
          :busy="busy"
          description="关键治理操作的脱敏结果会保留在这里。"
        />
        <p class="admin-footnote">仅展示服务端提供的安全摘要，不包含密码、令牌或原始日志。</p>
      </template>
      <div v-if="nextCursor" class="load-more">
        <UiButton :busy="busy" @click="load(true)">加载更多记录</UiButton>
      </div>
    </template>
    <UiDialog
      v-if="selectedJob"
      class="admin-detail-dialog"
      title="处理任务详情"
      wide
      :dismissible="!busy"
      @close="selectedJob = null"
      ><div class="form-stack">
        <UiNotice v-if="error" tone="error"
          >{{ error
          }}<button class="text-button" :disabled="busy" @click="openJob(selectedJob)">
            重新读取详情
          </button></UiNotice
        ><UiNotice v-if="message" tone="success">{{ message }}</UiNotice>
        <dl class="admin-facts">
          <div>
            <dt>处理步骤</dt>
            <dd>{{ kinds[selectedJob.kind || ''] || selectedJob.kind }}</dd>
          </div>
          <div>
            <dt>当前状态</dt>
            <dd>{{ states[selectedJob.state] || selectedJob.state }}</dd>
          </div>
          <div>
            <dt>任务编号</dt>
            <dd class="technical-value">{{ selectedJob.id }}</dd>
          </div>
          <div>
            <dt>最近更新</dt>
            <dd>{{ formatDate(selectedJob.updatedAt) }}</dd>
          </div>
        </dl>
        <UiNotice v-if="selectedJob.safeError" tone="error"
          >{{ selectedJob.safeError.message
          }}<small class="technical-value">{{ selectedJob.safeError.code }}</small></UiNotice
        >
        <h3>处理尝试</h3>
        <ol v-if="selectedJob.attempts?.length" class="attempt-list">
          <li v-for="attempt in selectedJob.attempts" :key="attempt.id">
            <strong
              >第 {{ attempt.attempt }} 次 · {{ states[attempt.state] || attempt.state }}</strong
            >
            <p>
              {{ formatDate(attempt.startedAt)
              }}<template v-if="attempt.finishedAt">
                — {{ formatDate(attempt.finishedAt) }}</template
              >
            </p>
            <small v-if="attempt.errorCode" class="technical-value">{{ attempt.errorCode }}</small>
          </li>
        </ol>
        <p v-else class="muted">{{ busy ? '正在读取尝试记录…' : '尚无处理尝试记录。' }}</p>
        <div class="dialog-actions">
          <RouterLink
            v-if="selectedJob.assetId && can('assets.read')"
            class="button"
            :to="'/app/assets/' + selectedJob.assetId"
            >查看素材</RouterLink
          ><UiButton
            v-if="can('system.jobs.manage') && allows(selectedJob.actions, 'retry')"
            variant="primary"
            :busy="busy"
            @click="retry(selectedJob)"
            >重试任务</UiButton
          >
        </div>
      </div></UiDialog
    >
    <UiDialog
      v-if="selectedEvent"
      class="admin-detail-dialog"
      title="审计记录详情"
      wide
      @close="selectedEvent = null"
      ><dl class="admin-facts">
        <div>
          <dt>操作</dt>
          <dd>
            {{ actionNames[selectedEvent.action] || selectedEvent.action
            }}<small class="technical-value">{{ selectedEvent.action }}</small>
          </dd>
        </div>
        <div>
          <dt>结果</dt>
          <dd>{{ outcome(selectedEvent.outcome) }}</dd>
        </div>
        <div>
          <dt>时间</dt>
          <dd>{{ formatDate(selectedEvent.createdAt) }}</dd>
        </div>
        <div>
          <dt>操作者</dt>
          <dd>
            {{ selectedEvent.actorKind === 'user' ? '成员' : '系统'
            }}<small class="technical-value">{{ selectedEvent.actorId }}</small>
          </dd>
        </div>
        <div>
          <dt>关联资源</dt>
          <dd>
            {{ selectedEvent.resourceType
            }}<small class="technical-value">{{ selectedEvent.resourceId }}</small>
          </dd>
        </div>
        <div>
          <dt>请求编号</dt>
          <dd class="technical-value">{{ selectedEvent.requestId || '未提供' }}</dd>
        </div>
      </dl>
      <details
        v-if="selectedEvent.changes && Object.keys(selectedEvent.changes).length"
        class="audit-changes"
      >
        <summary>查看脱敏变更摘要</summary>
        <pre>{{ JSON.stringify(selectedEvent.changes, null, 2) }}</pre>
      </details></UiDialog
    >
    <ReauthenticateForm v-if="freshAuth" @confirmed="reauthenticated" @cancel="freshAuth = false" />
  </section>
</template>
