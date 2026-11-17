<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { formatBytes, formatDate } from '@shiling/ui';
import { api, ApiError, errorMessage, operationKey, revisionTag } from '../../app/http-client';
import type { Attempt, UploadBatch, UploadItem, Page, Capabilities } from '../../app/models';
import { allows, itemsOf } from '../../app/models';
import { can, loadCapabilities } from '../../app/session';
import { sha256, transferFile } from './upload-transport';
import UiIcon from '../../components/ui/UiIcon.vue';
import UiNotice from '../../components/ui/UiNotice.vue';
import UiState from '../../components/ui/UiState.vue';
const route = useRoute();
const router = useRouter();
const batches = ref<UploadBatch[]>([]);
const batch = ref<UploadBatch | null>(null);
const items = ref<UploadItem[]>([]);
const capabilities = ref<Capabilities | null>(null);
const error = ref('');
const info = ref('');
const busy = ref(false);
const adding = ref(false);
const dragging = ref(false);
const localStatus = ref<
  Record<string, { phase: string; bytes: number; total: number; error?: string }>
>({});
const input = ref<HTMLInputElement>();
const retryInput = ref<HTMLInputElement>();
const retryItem = ref<UploadItem | null>(null);
const statusFilter = ref('all');
const editing = ref<UploadItem | null>(null);
const editTitle = ref('');
const editDescription = ref('');
const metadataError = ref('');
const controllers = new Map<string, AbortController>();
const fileHashes = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let active = true;
let polling = false;
const batchId = computed(() =>
  typeof route.params.batchId === 'string' ? route.params.batchId : batch.value?.id,
);
const readyCount = computed(() => items.value.filter((item) => item.uiState === 'ready').length);
const failedCount = computed(() => items.value.filter((item) => item.uiState === 'failed').length);
const pendingCount = computed(
  () =>
    items.value.filter((item) => !['ready', 'failed', 'canceled', 'expired'].includes(item.uiState))
      .length,
);
const visibleItems = computed(() =>
  items.value.filter(
    (item) =>
      statusFilter.value === 'all' ||
      (statusFilter.value === 'active' &&
        !['ready', 'failed', 'canceled', 'expired'].includes(item.uiState)) ||
      item.uiState === statusFilter.value,
  ),
);
const uploadAllowed = computed(
  () =>
    can('uploads.create') &&
    capabilities.value !== null &&
    (capabilities.value.types?.some((type) => type.acceptUploads !== false) ?? true),
);
const acceptedExtensions = computed(() =>
  (capabilities.value?.types ?? [])
    .filter((type) => type.acceptUploads !== false)
    .flatMap((type) => type.extensions ?? [])
    .map((extension) => `.${extension}`)
    .join(','),
);
function label(item: UploadItem): string {
  const local = localStatus.value[item.id];
  if (local?.phase === 'cancelling') return '正在确认取消';
  if (local?.phase === 'hashing') return '正在核对本地文件';
  if (local?.phase === 'interrupted') return '传输中断';
  if (local?.phase === 'uploading')
    return `上传中 ${Math.round((local.bytes / Math.max(1, local.total)) * 100)}%`;
  if (item.uiState === 'queued')
    return item.transportState === 'verified' ? '等待处理' : '等待上传';
  return (
    (
      {
        uploading: '上传中',
        verifying: '核验中',
        processing: '处理中',
        ready: '团队可用',
        failed: '处理失败',
        canceled: '已取消',
        expired: '已过期',
      } as Record<string, string>
    )[item.uiState] ?? '状态待确认'
  );
}
async function fetchBatches(): Promise<void> {
  try {
    batches.value = itemsOf(await api<Page<UploadBatch> | UploadBatch[]>('/team/upload-batches'));
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
async function refresh(): Promise<void> {
  if (!batchId.value || polling || !active) return;
  const requestedBatchId = batchId.value;
  polling = true;
  try {
    const result = await api<UploadBatch>(`/team/upload-batches/${requestedBatchId}`);
    if (batchId.value !== requestedBatchId) return;
    batch.value = result;
    items.value = result.items ?? [];
    for (const item of items.value)
      if (
        ['ready', 'failed', 'canceled', 'expired'].includes(item.uiState) &&
        !controllers.has(item.id)
      )
        delete localStatus.value[item.id];
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    polling = false;
  }
}
function schedule(): void {
  timer = setTimeout(async () => {
    if (!active) return;
    if (!document.hidden) await refresh();
    schedule();
  }, 2500);
}
async function initialize(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    capabilities.value = await loadCapabilities();
    await fetchBatches();
    await refresh();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function addFiles(files: File[]): Promise<void> {
  if (!files.length || adding.value || !uploadAllowed.value) return;
  const maximum = capabilities.value?.maxBatchItems;
  if (maximum && files.length > maximum) {
    error.value = `每批最多添加 ${maximum} 个文件。`;
    return;
  }
  adding.value = true;
  error.value = '';
  info.value = '';
  try {
    let currentId = batchId.value;
    if (!currentId) {
      const clientBatchId = operationKey();
      const created = await api<UploadBatch>('/team/upload-batches', {
        method: 'POST',
        body: { clientBatchId },
        idempotencyKey: clientBatchId,
      });
      batch.value = created;
      currentId = created.id;
      await router.replace(`/app/uploads/${created.id}`);
    }
    const queue = [...files];
    const concurrency = Math.min(4, Math.max(1, capabilities.value?.maxConcurrentUploads ?? 2));
    async function next(): Promise<void> {
      const file = queue.shift();
      if (!file || !active) return;
      let item: UploadItem | undefined;
      try {
        const hash = await sha256(file);
        const clientItemId = operationKey();
        item = await api<UploadItem>(`/team/upload-batches/${currentId}/items`, {
          method: 'POST',
          body: {
            clientItemId,
            fileName: file.name,
            declaredBytes: String(file.size),
            declaredMediaType: file.type || 'application/octet-stream',
            expectedSha256: hash,
            initialMetadata: {
              title: file.name.replace(/\.[^.]+$/, ''),
              description: '',
              tagIds: [],
              collectionIds: [],
            },
          },
          idempotencyKey: clientItemId,
        });
        fileHashes.set(item.id, hash);
        items.value = [...items.value.filter((existing) => existing.id !== item?.id), item];
        await upload(item, file);
      } catch (cause) {
        error.value = `${file.name}：${errorMessage(cause)}`;
        if (item)
          localStatus.value[item.id] = {
            phase: 'interrupted',
            bytes: 0,
            total: file.size,
            error: errorMessage(cause),
          };
      }
      await next();
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => next()));
    await refresh();
    await fetchBatches();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    adding.value = false;
    if (input.value) input.value.value = '';
  }
}
async function upload(item: UploadItem, file: File, retry = false): Promise<void> {
  const controller = new AbortController();
  controllers.set(item.id, controller);
  localStatus.value[item.id] = { phase: 'uploading', bytes: 0, total: file.size };
  try {
    let attempt: Attempt;
    if (retry) {
      const response = await api<Attempt>(`/team/upload-items/${item.id}/retry`, {
        method: 'POST',
        body: { scope: 'transfer' },
        idempotencyKey: operationKey(),
      });
      if (!response.attemptId && !response.id) {
        throw new Error('重试请求已收到，请刷新任务状态后继续，勿重复创建传输。');
      }
      attempt = response;
    } else
      attempt = await api<Attempt>(`/team/upload-items/${item.id}/attempts`, {
        method: 'POST',
        idempotencyKey: operationKey(),
      });
    const manifest = await transferFile(file, attempt, controller.signal, (bytes) => {
      localStatus.value[item.id] = { phase: 'uploading', bytes, total: file.size };
    });
    const attemptId = attempt.attemptId ?? attempt.id;
    await api(`/team/upload-attempts/${attemptId}/complete`, {
      method: 'POST',
      body: manifest,
      idempotencyKey: operationKey(),
    });
    delete localStatus.value[item.id];
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'AbortError'))
      localStatus.value[item.id] = {
        phase: 'interrupted',
        bytes: localStatus.value[item.id]?.bytes ?? 0,
        total: file.size,
        error: errorMessage(cause),
      };
    throw cause;
  } finally {
    controllers.delete(item.id);
  }
}
async function cancel(item: UploadItem): Promise<void> {
  localStatus.value[item.id] = {
    phase: 'cancelling',
    bytes: 0,
    total: Number(item.progress.totalBytes),
  };
  controllers.get(item.id)?.abort();
  try {
    await api(`/team/upload-items/${item.id}/cancel`, {
      method: 'POST',
      idempotencyKey: operationKey(),
    });
    delete localStatus.value[item.id];
    await refresh();
  } catch (cause) {
    info.value =
      cause instanceof ApiError && cause.code === 'UPLOAD_ALREADY_READY'
        ? '素材已进入团队库，可打开详情后归档。'
        : errorMessage(cause);
    await refresh();
  }
}
async function retry(item: UploadItem): Promise<void> {
  error.value = '';
  if (item.transportState === 'verified') {
    try {
      await api(`/team/upload-items/${item.id}/retry`, {
        method: 'POST',
        body: { scope: 'processing' },
        idempotencyKey: operationKey(),
      });
      await refresh();
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  } else {
    retryItem.value = item;
    retryInput.value?.click();
  }
}
async function reselect(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  const item = retryItem.value;
  if (!file || !item) return;
  try {
    if (
      file.size !== Number(item.progress.totalBytes) ||
      (item.fileName && file.name !== item.fileName)
    )
      throw new Error('请选择原来的同一文件；其他内容应新建上传项。');
    const hash = await sha256(file);
    const expected = fileHashes.get(item.id) ?? item.expectedSha256;
    if (expected && expected !== hash) throw new Error('文件内容已改变，请新建上传项。');
    await upload(item, file, true);
    await refresh();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    (event.target as HTMLInputElement).value = '';
    retryItem.value = null;
  }
}
function edit(item: UploadItem): void {
  editing.value = item;
  editTitle.value = item.metadata?.title ?? item.title ?? item.fileName ?? '';
  editDescription.value = item.metadata?.description ?? '';
  metadataError.value = '';
}
async function saveMetadata(): Promise<void> {
  const item = editing.value;
  if (!item) return;
  const path = `/team/upload-items/${item.id}/metadata`;
  try {
    await api(path, {
      method: 'PATCH',
      body: {
        title: editTitle.value.trim(),
        description: editDescription.value,
        tagIds: item.metadata.tagIds,
        collectionIds: item.metadata.collectionIds,
      },
      etag: revisionTag(path, item.revision),
    });
    editing.value = null;
    await refresh();
  } catch (cause) {
    metadataError.value =
      cause instanceof ApiError && cause.status === 409
        ? '素材已入库。输入已保留，请打开素材详情重新确认后保存。'
        : errorMessage(cause);
    await refresh();
  }
}
function leave(event: BeforeUnloadEvent): void {
  if (controllers.size || adding.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
watch(
  () => route.params.batchId,
  () => {
    if (route.path.startsWith('/app/uploads')) {
      if (!route.params.batchId) batch.value = null;
      items.value = [];
      void refresh();
    }
  },
);
onMounted(() => {
  void initialize();
  schedule();
  window.addEventListener('beforeunload', leave);
});
onBeforeUnmount(() => {
  active = false;
  if (timer) clearTimeout(timer);
  controllers.forEach((controller) => controller.abort());
  fileHashes.clear();
  window.removeEventListener('beforeunload', leave);
});
</script>
<template>
  <section class="page-content upload-workspace">
    <header class="page-heading">
      <div>
        <h1>上传工作区</h1>
        <p>从本地文件，到团队可用的好素材。</p>
      </div>
      <button class="button primary" :disabled="!uploadAllowed || adding" @click="input?.click()">
        <UiIcon name="plus" />添加文件
      </button>
    </header>
    <div class="upload-layout">
      <aside class="upload-history">
        <div class="section-heading">
          <h2>上传批次</h2>
          <RouterLink to="/app/uploads" class="icon-button" aria-label="新建上传批次"
            ><UiIcon name="plus" :size="17"
          /></RouterLink>
        </div>
        <nav aria-label="上传批次">
          <RouterLink to="/app/uploads" :class="{ active: !batchId }"
            ><UiIcon name="upload" :size="17" /><span
              >新建批次<small>选择文件开始</small></span
            ></RouterLink
          ><RouterLink
            v-for="entry in batches"
            :key="entry.id"
            :to="`/app/uploads/${entry.id}`"
            :class="{ active: entry.id === batchId }"
            ><UiIcon name="folder" :size="17" /><span
              >{{ entry.createdAt ? formatDate(entry.createdAt) : '上传批次'
              }}<small>{{
                entry.items?.length ? `${entry.items.length} 个文件` : '查看处理结果'
              }}</small></span
            ></RouterLink
          >
        </nav>
      </aside>
      <div class="upload-body">
        <p class="upload-privacy">
          <UiIcon name="users" :size="16" />处理合格后团队可见，公开需另行确认。
        </p>
        <UiNotice v-if="error" tone="error"
          >{{ error }} <button class="text-button" @click="initialize">刷新状态</button></UiNotice
        ><UiNotice v-if="info">{{ info }}</UiNotice
        ><UiNotice
          v-if="
            capabilities?.types?.some((type) => type.id === 'web_motion' && !type.acceptUploads)
          "
          tone="warning"
          >当前部署未启用动效包上传（HTML / ZIP），可上传图片与 MP4 视频。</UiNotice
        ><input
          ref="input"
          type="file"
          multiple
          :accept="acceptedExtensions || undefined"
          class="sr-only"
          tabindex="-1"
          @change="addFiles(Array.from(($event.target as HTMLInputElement).files ?? []))"
        /><input
          ref="retryInput"
          type="file"
          class="sr-only"
          tabindex="-1"
          @change="reselect"
        /><button
          class="drop-zone"
          :class="{ dragging, 'drop-zone-compact': items.length }"
          :disabled="!uploadAllowed || adding"
          @click="input?.click()"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="
            dragging = false;
            addFiles(Array.from($event.dataTransfer?.files ?? []));
          "
        >
          <UiIcon name="upload" :size="42" /><strong>{{
            adding ? '正在核对文件并上传…' : '拖入文件，开始上传'
          }}</strong
          ><span>{{
            capabilities?.types
              ?.filter((type) => type.acceptUploads !== false)
              .map((type) => type.name || type.id)
              .join('、') || '图片、MP4 视频'
          }}</span
          ><small>{{
            uploadAllowed
              ? '也可以点击选择文件；具体格式和上限按当前实例配置执行'
              : '上传能力暂不可用，请检查权限或重试读取配置'
          }}</small>
        </button>
        <ol class="upload-stages" aria-label="上传处理流程">
          <li>传输文件</li>
          <li>核验原件</li>
          <li>生成预览</li>
          <li>团队可用</li>
        </ol>
        <div class="upload-toolbar">
          <div class="chip-group">
            <button
              v-for="filter in [
                { id: 'all', label: `全部 ${items.length}` },
                { id: 'active', label: `进行中 ${pendingCount}` },
                { id: 'ready', label: `可用 ${readyCount}` },
                { id: 'failed', label: `失败 ${failedCount}` },
              ]"
              :key="filter.id"
              class="chip"
              :class="{ active: statusFilter === filter.id }"
              :aria-pressed="statusFilter === filter.id"
              @click="statusFilter = filter.id"
            >
              {{ filter.label }}
            </button>
          </div>
        </div>
        <UiState v-if="busy && !items.length" title="正在加载上传任务" busy /><UiState
          v-else-if="!visibleItems.length && !error"
          :title="statusFilter === 'all' ? '等待第一份素材' : '此状态下没有任务'"
          :description="
            statusFilter === 'all'
              ? '可以选择多个文件，逐项查看传输、处理和入库结果。'
              : '切换其他状态，查看此批次的全部任务。'
          "
          icon="upload"
        />
        <div v-else class="upload-items">
          <div class="upload-table-heading">
            <span>素材</span><span>状态</span><span>操作</span>
          </div>
          <article v-for="item in visibleItems" :key="item.id" class="upload-item">
            <div class="upload-file">
              <span class="file-symbol"><UiIcon :name="item.typeId || 'file'" :size="28" /></span>
              <div>
                <strong>{{
                  item.metadata?.title || item.title || item.fileName || '上传文件'
                }}</strong>
                <p>{{ item.fileName }} · {{ formatBytes(item.progress.totalBytes) }}</p>
              </div>
            </div>
            <div class="upload-status">
              <span class="status-label" :class="`status-${item.uiState}`"
                ><span class="status-dot" />{{ label(item) }}</span
              ><progress
                v-if="localStatus[item.id]?.phase === 'uploading'"
                :value="localStatus[item.id]?.bytes ?? 0"
                :max="localStatus[item.id]?.total || 1"
                :aria-label="`${item.fileName || '文件'}上传进度`"
              /><small v-if="item.uiState === 'processing'"
                >正在处理，完成后会自动进入团队库。</small
              ><small v-if="item.safeError" class="error-text">{{ item.safeError.message }}</small
              ><small v-if="localStatus[item.id]?.error" class="error-text">{{
                localStatus[item.id]?.error
              }}</small
              ><small
                v-for="warning in item.organizationWarnings ?? []"
                :key="warning.code"
                class="warning-text"
                >整理提醒：{{ warning.message }}</small
              >
            </div>
            <div class="upload-actions">
              <RouterLink
                v-if="item.uiState === 'ready' && item.assetId"
                :to="`/app/assets/${item.assetId}`"
                class="text-button"
                >查看素材</RouterLink
              ><button
                v-if="
                  allows(item.actions, 'cancel') &&
                  !['ready', 'canceled', 'expired'].includes(item.uiState)
                "
                class="text-button"
                :disabled="localStatus[item.id]?.phase === 'cancelling'"
                @click="cancel(item)"
              >
                取消</button
              ><button
                v-if="allows(item.actions, 'retry') && !controllers.has(item.id)"
                class="text-button"
                @click="retry(item)"
              >
                {{ item.transportState === 'verified' ? '重试处理' : '重选文件重试' }}</button
              ><button
                v-if="allows(item.actions, 'editMetadata')"
                class="text-button"
                @click="edit(item)"
              >
                编辑信息</button
              ><RouterLink
                v-if="item.uiState === 'ready' && item.organizationWarnings?.length"
                :to="`/app/assets/${item.assetId}`"
                class="text-button"
                >补齐整理</RouterLink
              >
            </div>
          </article>
        </div>
        <form v-if="editing" class="form-stack inset-panel" @submit.prevent="saveMetadata">
          <h2>编辑上传信息</h2>
          <UiNotice v-if="metadataError" tone="error">{{ metadataError }}</UiNotice><label
            >标题<input v-model="editTitle" required /></label
          ><label>说明<textarea v-model="editDescription" rows="3" /></label>
          <div class="actions">
            <button class="button primary">保存</button
            ><button type="button" class="button" @click="editing = null">取消</button
            ><RouterLink
              v-if="items.find((item) => item.id === editing?.id)?.assetId"
              :to="`/app/assets/${items.find((item) => item.id === editing?.id)?.assetId}`"
              class="text-link"
              >打开入库素材</RouterLink
            >
          </div>
        </form>
        <p v-if="items.length" class="form-hint">
          文件已接收后可离开本页；任务完成后可在素材库查看。取消不会永久删除已入库素材。
        </p>
      </div>
    </div>
  </section>
</template>
