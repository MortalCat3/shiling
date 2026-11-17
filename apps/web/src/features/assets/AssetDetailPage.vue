<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { formatBytes, formatDate } from '@shiling/ui';
import { api, ApiError, errorMessage, operationKey, revisionTag } from '../../app/http-client';
import { allows } from '../../app/models';
import { readChoices } from '../../app/list-data';
import type { Asset, PublicAsset, Tag, Collection, Publication } from '../../app/models';
import { can, publicEnabled } from '../../app/session';
import { closeDetail } from '../../app/navigation';
import {
  assetEndpoint,
  artifactsOf,
  downloadAsset,
  typeLabel,
  presentAsset,
  fileFormat,
} from './media';
import UiButton from '../../components/ui/UiButton.vue';
import UiDialog from '../../components/ui/UiDialog.vue';
import UiIcon from '../../components/ui/UiIcon.vue';
import UiNotice from '../../components/ui/UiNotice.vue';
import UiState from '../../components/ui/UiState.vue';
import AssetPreview from './AssetPreview.vue';
import PublicationForm from './PublicationForm.vue';
const props = withDefaults(defineProps<{ isPublic?: boolean; dialog?: boolean }>(), {
  isPublic: false,
  dialog: false,
});
const emit = defineEmits<{ close: [] }>();
const route = useRoute();
const router = useRouter();
const asset = ref<Asset | PublicAsset | null>(null);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const saving = ref(false);
const favoriting = ref(false);
const mode = ref<'view' | 'edit' | 'publish' | 'collection'>('view');
const title = ref('');
const description = ref('');
const tagIds = ref<string[]>([]);
const tags = ref<Tag[]>([]);
const collections = ref<Collection[]>([]);
const collectionId = ref('');
const latestConflict = ref('');
let generation = 0;
const id = computed(() => String(route.params.assetId));
const teamAsset = computed(() => (!props.isPublic ? (asset.value as Asset | null) : null));
const archived = computed(() => teamAsset.value?.lifecycle === 'archived');
const original = computed(() =>
  asset.value ? artifactsOf(asset.value).find((item) => item.role === 'original') : undefined,
);
const dirty = computed(
  () =>
    mode.value === 'edit' &&
    teamAsset.value &&
    (title.value !== teamAsset.value.title ||
      description.value !== (teamAsset.value.description ?? '') ||
      JSON.stringify([...tagIds.value].sort()) !==
        JSON.stringify((teamAsset.value.tags ?? []).map((tag) => tag.id).sort())),
);
function action(name: string): boolean {
  return Boolean(asset.value && allows(asset.value.actions, name));
}
async function load(): Promise<void> {
  const current = ++generation;
  busy.value = true;
  error.value = '';
  try {
    const result = props.isPublic
      ? await api<PublicAsset>(assetEndpoint(id.value, true))
      : await api<Asset>(assetEndpoint(id.value, false));
    if (current === generation) asset.value = presentAsset(result);
  } catch (cause) {
    if (current === generation) {
      error.value =
        props.isPublic && cause instanceof ApiError && cause.status === 404
          ? '此内容暂不可用，请返回公开素材页或联系分享者。'
          : errorMessage(cause);
      asset.value = null;
    }
  } finally {
    if (current === generation) busy.value = false;
  }
}
function confirmLeave(): boolean {
  return (
    !(dirty.value || mode.value === 'publish') || window.confirm('修改尚未保存，放弃本次修改？')
  );
}
function close(): void {
  if (!confirmLeave()) return;
  mode.value = 'view';
  if (props.dialog) emit('close');
  else void closeDetail(router);
}
async function edit(): Promise<void> {
  if (!teamAsset.value) return;
  title.value = teamAsset.value.title;
  description.value = teamAsset.value.description ?? '';
  tagIds.value = teamAsset.value.tags?.map((tag) => tag.id) ?? [];
  mode.value = 'edit';
  latestConflict.value = '';
  try {
    tags.value = await readChoices<Tag>('/team/tags?state=all');
  } catch (cause) {
    notice.value = errorMessage(cause);
  }
}
async function save(): Promise<void> {
  if (!teamAsset.value) return;
  saving.value = true;
  notice.value = '';
  const path = assetEndpoint(id.value, false);
  try {
    asset.value = presentAsset(
      await api<Asset>(path, {
        method: 'PATCH',
        body: { title: title.value.trim(), description: description.value, tagIds: tagIds.value },
        etag: revisionTag(path, teamAsset.value.revision),
      }),
    );
    mode.value = 'view';
    changed();
    notice.value =
      teamAsset.value?.publicationState === 'active'
        ? '团队信息已保存，公开页面仍使用此前快照。'
        : '素材信息已保存。';
  } catch (cause) {
    notice.value = errorMessage(cause);
    if (cause instanceof ApiError && cause.status === 412) {
      const latest = await api<Asset>(path).catch(() => null);
      if (latest) {
        latestConflict.value = `最新标题：${latest.title}；说明：${latest.description || '无'}。当前输入已保留，请核对后重新保存。`;
        asset.value = latest;
      }
    }
  } finally {
    saving.value = false;
  }
}
function changed(): void {
  window.dispatchEvent(new CustomEvent('shiling:assets-changed'));
}
async function download(): Promise<void> {
  if (!asset.value) return;
  saving.value = true;
  notice.value = '';
  try {
    await downloadAsset(asset.value, props.isPublic);
  } catch (cause) {
    notice.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function favorite(): Promise<void> {
  if (!teamAsset.value || favoriting.value) return;
  favoriting.value = true;
  try {
    await api(`/team/me/favorites/${id.value}`, {
      method: teamAsset.value.favorite ? 'DELETE' : 'PUT',
    });
    teamAsset.value.favorite = !teamAsset.value.favorite;
    changed();
  } catch (cause) {
    notice.value = errorMessage(cause);
  } finally {
    favoriting.value = false;
  }
}
async function lifecycle(): Promise<void> {
  if (!teamAsset.value) return;
  const restore = archived.value;
  if (
    !window.confirm(
      restore
        ? '恢复后仅团队可见，不会重新公开。确认恢复？'
        : '归档会从素材库隐藏并撤回公开，原件继续保留。确认归档？',
    )
  )
    return;
  saving.value = true;
  try {
    await api(`/team/assets/${id.value}/${restore ? 'restore' : 'archive'}`, {
      method: 'POST',
      body: { expectedRevision: teamAsset.value.revision },
      idempotencyKey: operationKey(),
    });
    await load();
    changed();
  } catch (cause) {
    notice.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function withdraw(): Promise<void> {
  if (!window.confirm('撤回后将停止签发新的公开下载和预览授权。确认撤回？')) return;
  saving.value = true;
  try {
    const publication = await api<Publication>(`/team/assets/${id.value}/publication`);
    await api(`/team/assets/${id.value}/withdraw`, {
      method: 'POST',
      body: { expectedRevision: publication.revision },
      idempotencyKey: operationKey(),
    });
    await load();
    changed();
    notice.value = '公开已撤回，新的游客预览与下载授权已停止。';
  } catch (cause) {
    notice.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function copyLink(isPublicLink: boolean): Promise<void> {
  const path = `${isPublicLink ? '/public' : '/app'}/assets/${id.value}`;
  const link = new URL(router.resolve(path).href, location.origin).href;
  try {
    await navigator.clipboard.writeText(link);
    notice.value = '链接已复制。复制链接不会改变访问权限。';
  } catch {
    notice.value = `请手动复制链接：${link}`;
  }
}
async function chooseCollection(): Promise<void> {
  mode.value = 'collection';
  try {
    collections.value = (await readChoices<Collection>('/team/collections')).filter((item) =>
      allows(item.actions, 'manageItems'),
    );
  } catch (cause) {
    notice.value = errorMessage(cause);
  }
}
async function addToCollection(): Promise<void> {
  const target = collections.value.find((item) => item.id === collectionId.value);
  if (!target) return;
  saving.value = true;
  try {
    await api(`/team/collections/${target.id}/items:batch`, {
      method: 'POST',
      body: { action: 'add', assetIds: [id.value], expectedRevision: target.revision },
      idempotencyKey: operationKey(),
    });
    mode.value = 'view';
    await load();
    notice.value = '已加入团队集合。';
  } catch (cause) {
    notice.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function published(): Promise<void> {
  mode.value = 'view';
  await load();
  changed();
  notice.value = '公开快照已保存。游客可获取此版本的原件。';
}
function beforeUnload(event: BeforeUnloadEvent): void {
  if (dirty.value || mode.value === 'publish') {
    event.preventDefault();
    event.returnValue = '';
  }
}
watch(
  id,
  () => {
    mode.value = 'view';
    void load();
  },
  { immediate: true },
);
window.addEventListener('beforeunload', beforeUnload);
onBeforeUnmount(() => {
  generation++;
  window.removeEventListener('beforeunload', beforeUnload);
});
const stopNavigationGuard = router.beforeEach((to, from) => {
  if (String(from.params.assetId ?? '') === id.value && to.fullPath !== from.fullPath)
    return confirmLeave();
  return true;
});
onBeforeUnmount(stopNavigationGuard);
</script>
<template>
  <component
    :is="dialog ? UiDialog : 'section'"
    :title="asset?.title || '素材详情'"
    :wide="dialog"
    :class="{ 'page-content': !dialog, 'detail-page': !dialog }"
    @close="close"
    ><template v-if="!dialog"
      ><button class="text-button detail-back" @click="close">
        <UiIcon name="arrow" />{{ isPublic ? '返回公开素材' : '返回素材库' }}
      </button>
      <h1>{{ asset?.title || '素材详情' }}</h1></template
    ><UiState v-if="busy && !asset" title="正在加载素材" busy /><UiState
      v-else-if="error"
      title="内容不可用或无权访问"
      :description="error"
      ><button class="button" @click="load">重试</button></UiState
    >
    <div v-else-if="asset" class="detail-columns">
      <AssetPreview :asset="asset" :is-public="isPublic" :archived="archived" />
      <aside class="detail-info">
        <UiNotice v-if="notice">{{ notice }}</UiNotice><template v-if="mode === 'edit' && teamAsset"
          ><form class="form-stack" @submit.prevent="save">
            <h2>编辑团队信息</h2>
            <UiNotice v-if="latestConflict" tone="warning">{{ latestConflict }}</UiNotice><label
              >标题<input v-model="title" required maxlength="200" /></label
            ><label>说明<textarea v-model="description" rows="5" maxlength="5000" /></label>
            <fieldset>
              <legend>标签</legend>
              <div class="chip-group">
                <label v-for="tag in tags" :key="tag.id" class="checkbox-row"
                  ><input
                    v-model="tagIds"
                    type="checkbox"
                    :value="tag.id"
                    :disabled="
                      (tag.state === 'disabled' || tag.status === 'disabled') &&
                      !tagIds.includes(tag.id)
                    "
                  />{{ tag.name }}{{ tag.state === 'disabled' ? '（已停用）' : '' }}</label
                >
              </div>
            </fieldset>
            <div class="actions">
              <button class="button primary" :disabled="saving">保存</button
              ><button
                class="button"
                type="button"
                @click="
                  () => {
                    if (confirmLeave()) mode = 'view';
                  }
                "
              >
                取消
              </button>
            </div>
          </form></template
        ><PublicationForm
          v-else-if="mode === 'publish' && teamAsset"
          :asset="teamAsset"
          @saved="published"
          @cancel="mode = 'view'"
        />
        <form
          v-else-if="mode === 'collection'"
          class="form-stack"
          @submit.prevent="addToCollection"
        >
          <h2>加入团队集合</h2>
          <label
            >集合<select v-model="collectionId" required>
              <option value="">请选择可维护的集合</option>
              <option v-for="collection in collections" :key="collection.id" :value="collection.id">
                {{ collection.name }}
              </option>
            </select></label
          >
          <p v-if="!collections.length" class="muted">暂无可维护的集合，可先到集合页面创建。</p>
          <div class="actions">
            <button class="button primary" :disabled="saving || !collectionId">加入集合</button
            ><button class="button" type="button" @click="mode = 'view'">取消</button>
          </div>
        </form>
        <template v-else
          ><div class="detail-context">
            <span>{{ typeLabel(asset.typeId) }}</span><span>{{
              archived ? '已归档' : isPublic ? '公开素材' : '团队素材'
            }}</span>
          </div>
          <div v-if="!isPublic && !archived" class="detail-quick-actions">
            <button
              v-if="can('favorites.manageOwn')"
              class="button quiet"
              :aria-pressed="teamAsset?.favorite"
              :disabled="favoriting"
              @click="favorite"
            >
              <UiIcon name="heart" :size="17" />{{ teamAsset?.favorite ? '已收藏' : '收藏' }}
            </button>
            <button
              v-if="can('collections.manageOwn') || can('collections.governAny')"
              class="button quiet"
              @click="chooseCollection"
            >
              <UiIcon name="folder" :size="17" />加入集合
            </button>
            <button v-if="action('edit')" class="button quiet" @click="edit">编辑信息</button>
          </div>
          <p class="asset-description">{{ asset.description || '暂无说明' }}</p>
          <div class="chip-group">
            <span
              v-for="tag in isPublic
                ? ((asset as PublicAsset).publicTags ?? [])
                : (teamAsset?.tags?.map((item) => item.name) ?? [])"
              :key="tag"
              class="chip"
              >{{ tag }}</span
            >
          </div>
          <dl class="metadata">
            <div>
              <dt>素材类型</dt>
              <dd>{{ typeLabel(asset.typeId) }}</dd>
            </div>
            <div>
              <dt>格式</dt>
              <dd>{{ fileFormat(asset) }}</dd>
            </div>
            <div>
              <dt>尺寸</dt>
              <dd>
                {{
                  asset.dimensions
                    ? `${asset.dimensions.width} × ${asset.dimensions.height}`
                    : asset.width && asset.height
                      ? `${asset.width} × ${asset.height}`
                      : '—'
                }}
              </dd>
            </div>
            <div v-if="original?.bytes">
              <dt>文件大小</dt>
              <dd>{{ formatBytes(original.bytes) }}</dd>
            </div>
            <div v-if="!isPublic">
              <dt>访问范围</dt>
              <dd>
                {{
                  archived
                    ? '已归档'
                    : teamAsset?.publicationState === 'active'
                      ? '团队 · 已公开'
                      : '仅团队'
                }}
              </dd>
            </div>
            <div v-if="isPublic">
              <dt>公开时间</dt>
              <dd>{{ formatDate((asset as PublicAsset).publishedAt) }}</dd>
            </div>
          </dl>
          <UiButton
            v-if="!archived && (isPublic || action('download'))"
            class="full-width download-action"
            variant="primary"
            :busy="saving"
            :disabled="!original"
            @click="download"
          >
            <UiIcon name="download" />{{ saving ? '正在取得原件…' : '下载原件' }}
          </UiButton>
          <p v-if="!original && !archived" class="form-hint">原件描述暂不可用，可刷新详情重试。</p>
          <details class="detail-secondary">
            <summary>
              {{ isPublic ? '分享链接' : '链接与公开设置' }}<UiIcon name="chevron" :size="15" />
            </summary>
            <div class="detail-actions">
              <button
                v-if="!isPublic && !archived && (action('publish') || action('updatePublication'))"
                class="button primary"
                :disabled="!publicEnabled"
                @click="mode = 'publish'"
              >
                {{
                  teamAsset?.publicationState === 'active' ? '更新公开信息' : '公开素材'
                }}</button><button
                v-if="!isPublic && action('withdraw')"
                class="button"
                :disabled="saving"
                @click="withdraw"
              >
                撤回公开</button
              ><button class="button" @click="copyLink(isPublic)">
                <UiIcon name="link" />{{ isPublic ? '复制链接' : '复制团队链接' }}</button
              ><button
                v-if="!isPublic && teamAsset?.publicationState === 'active' && publicEnabled"
                class="button"
                @click="copyLink(true)"
              >
                复制公开链接</button
              ><button
                v-if="!isPublic && (action('archive') || action('restore'))"
                class="text-button"
                :disabled="saving"
                @click="lifecycle"
              >
                {{ archived ? '恢复素材' : '归档素材' }}
              </button>
            </div>
          </details>
          <p
            v-if="!isPublic && !publicEnabled && (action('publish') || action('updatePublication'))"
            class="form-hint"
          >
            实例公开入口当前关闭；不影响团队使用。
          </p>
          <div v-if="!isPublic && teamAsset?.collections?.length" class="detail-collections">
            <h3>所属集合</h3>
            <RouterLink
              v-for="collection in teamAsset.collections"
              :key="collection.id"
              :to="`/app/collections/${collection.id}`"
              class="chip"
              >{{ collection.name }}</RouterLink
            >
          </div></template
        >
      </aside>
    </div></component
  >
</template>
