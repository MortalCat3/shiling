<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api, ApiError, errorMessage, operationKey } from '../../app/http-client';
import type { Asset, Collection, Page } from '../../app/models';
import { presentAsset } from '../assets/media';
import AssetThumb from '../assets/AssetThumb.vue';
import UiDialog from '../../components/ui/UiDialog.vue';
import UiNotice from '../../components/ui/UiNotice.vue';
import UiButton from '../../components/ui/UiButton.vue';
import UiIcon from '../../components/ui/UiIcon.vue';
const props = defineProps<{ collection: Collection }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const rows = ref<Asset[]>([]),
  selected = ref(new Set<string>()),
  query = ref(''),
  cursor = ref<string | null>(null);
const busy = ref(false),
  saving = ref(false),
  error = ref(''),
  conflict = ref(false),
  moreFailed = ref(false);
const revision = ref(props.collection.revision);
let generation = 0;
async function load(more = false): Promise<void> {
  const local = ++generation;
  busy.value = true;
  error.value = '';
  moreFailed.value = false;
  const params = new URLSearchParams({ q: query.value, limit: '18' });
  if (more && cursor.value) params.set('cursor', cursor.value);
  try {
    const page = await api<Page<Asset>>('/team/assets?' + params);
    if (local !== generation) return;
    rows.value = more
      ? [...rows.value, ...page.items.map(presentAsset)]
      : page.items.map(presentAsset);
    cursor.value = page.pageInfo?.nextCursor || null;
  } catch (cause) {
    if (local === generation) {
      error.value = errorMessage(cause);
      moreFailed.value = more;
      if (!more) {
        rows.value = [];
        cursor.value = null;
      }
    }
  } finally {
    if (local === generation) busy.value = false;
  }
}
function select(id: string): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else if (next.size < 100) next.add(id);
  selected.value = next;
}
async function refreshRevision(): Promise<void> {
  saving.value = true;
  try {
    revision.value = (await api<Collection>('/team/collections/' + props.collection.id)).revision;
    conflict.value = false;
    error.value = '';
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function save(): Promise<void> {
  if (!selected.value.size || saving.value || conflict.value) return;
  saving.value = true;
  error.value = '';
  try {
    await api('/team/collections/' + props.collection.id + '/items:batch', {
      method: 'POST',
      body: { action: 'add', assetIds: [...selected.value], expectedRevision: revision.value },
      idempotencyKey: operationKey(),
    });
    window.dispatchEvent(new CustomEvent('shiling:assets-changed'));
    emit('saved');
  } catch (cause) {
    conflict.value = cause instanceof ApiError && [409, 412].includes(cause.status);
    error.value =
      errorMessage(cause) +
      (cause instanceof ApiError && cause.status < 500
        ? ' 本次整批未加入，选择已保留。'
        : ' 结果暂未确认，选择已保留；请刷新集合核对。');
  } finally {
    saving.value = false;
  }
}
onMounted(() => load());
onBeforeUnmount(() => {
  generation++;
});
</script>
<template>
  <UiDialog
    :title="'添加素材到“' + collection.name + '”'"
    class="collection-picker-dialog"
    :dismissible="!saving"
    @close="emit('close')"
  >
    <form class="picker-search local-search" @submit.prevent="load()">
      <UiIcon name="search" /><input
        v-model="query"
        aria-label="查找要加入集合的素材"
        placeholder="在团队素材库中查找"
      /><UiButton type="submit" :busy="busy">搜索</UiButton>
    </form>
    <p class="form-hint">只建立集合关联，不复制文件或改变权限。一次最多选择 100 项。</p>
    <UiNotice v-if="error" tone="error"
      >{{ error
      }}<button v-if="conflict" class="text-button" @click="refreshRevision">
        核对最新集合版本</button
      ><button v-else class="text-button" @click="load(moreFailed)">重试读取</button></UiNotice
    >
    <p v-if="busy && !rows.length" role="status">正在查找素材…</p>
    <p v-else-if="!rows.length && !error" class="empty-inline">
      没有找到可加入的素材，换一个关键词试试。
    </p>
    <div class="picker-grid">
      <label
        v-for="asset in rows"
        :key="asset.id"
        class="picker-option"
        :class="{ 'is-selected': selected.has(asset.id) }"
        ><AssetThumb :asset="asset" compact /><span
          ><strong>{{ asset.title }}</strong
          ><small>{{ asset.typeId === 'video' ? '视频' : '图片' }}</small></span
        ><input
          type="checkbox"
          :checked="selected.has(asset.id)"
          :aria-label="'选择' + asset.title"
          @change="select(asset.id)"
      /></label>
    </div>
    <UiButton v-if="cursor" :busy="busy" @click="load(true)">加载更多</UiButton>
    <div class="form-footer picker-footer">
      <span aria-live="polite">已选 {{ selected.size }} 项</span
      ><UiButton :disabled="saving" @click="emit('close')">取消</UiButton
      ><UiButton
        variant="primary"
        :busy="saving"
        :disabled="!selected.size || conflict"
        @click="save"
        >加入集合</UiButton
      >
    </div>
  </UiDialog>
</template>
