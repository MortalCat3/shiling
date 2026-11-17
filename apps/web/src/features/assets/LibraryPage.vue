<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError, errorMessage, operationKey } from '../../app/http-client';
import { allows, itemsOf } from '../../app/models';
import type { Asset, PublicAsset, Page, Facets, Tag, Collection } from '../../app/models';
import { readChoices } from '../../app/list-data';
import { can, identity } from '../../app/session';
import { detailOrigin, openDetail } from '../../app/navigation';
import { formatBytes, formatDate } from '@shiling/ui';
import AssetCard from './AssetCard.vue';
import CollectionActions from '../library/CollectionActions.vue';
import CollectionAssetPicker from '../library/CollectionAssetPicker.vue';
import UiButton from '../../components/ui/UiButton.vue';
import AssetThumb from './AssetThumb.vue';
import AssetFilters from './AssetFilters.vue';
import UiDialog from '../../components/ui/UiDialog.vue';
import UiSegmented from '../../components/ui/UiSegmented.vue';
import { libraryQueryKey } from './query-key';
import { retainBatchFailures } from './batch-results';
import { typeLabel, presentAsset, fileFormat, dimensionsLabel } from './media';
import UiIcon from '../../components/ui/UiIcon.vue';
import UiNotice from '../../components/ui/UiNotice.vue';
import UiState from '../../components/ui/UiState.vue';
const props = withDefaults(
  defineProps<{ scope?: 'library' | 'favorites' | 'archive' | 'collection' | 'public' }>(),
  { scope: 'library' },
);
const route = useRoute();
const router = useRouter();
const isPublic = computed(() => props.scope === 'public');
const currentRoute = computed(() =>
  route.params.assetId && detailOrigin.value ? detailOrigin.value : route,
);
const rows = ref<(Asset | PublicAsset)[]>([]);
const facets = ref<Facets>({});
const error = ref('');
const facetError = ref('');
const busy = ref(false);
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);
const selected = ref(new Set<string>());
const selecting = ref(false);
const filtersOpen = ref(false);
const smallScreen = ref(window.matchMedia('(max-width: 760px)').matches);
const screenQuery = window.matchMedia('(max-width: 760px)');
function resize(): void {
  smallScreen.value = screenQuery.matches;
}
const filterCollections = ref<Collection[]>([]);
const favoritePending = ref(new Set<string>());
const failedAssets = ref<Asset[]>([]);
const batchResults = ref<{ assetId: string; title: string; code: string }[]>([]);
const moreFailed = ref(false);
const publicUnavailable = ref(false);
const collectionError = ref('');
const addingToCollection = ref(false);
const collectionArchived = computed(
  () =>
    currentCollection.value?.state === 'archived' ||
    currentCollection.value?.lifecycle === 'archived',
);
let facetGeneration = 0;
const queryInput = ref('');
const composing = ref(false);
const batchBusy = ref(false);
const batchMessage = ref('');
const batchMode = ref('');
const tagChoices = ref<Tag[]>([]);
const collectionChoices = ref<Collection[]>([]);
const currentCollection = ref<Collection | null>(null);
const selectedTagIds = ref<string[]>([]);
const selectedCollectionId = ref('');
let generation = 0;
let controller: AbortController | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const title = computed(
  () =>
    ({
      library: '素材库',
      favorites: '我的收藏',
      archive: '归档素材',
      collection: currentCollection.value?.name || '集合素材',
      public: '公开素材',
    })[props.scope],
);
const view = computed(() => (currentRoute.value.query.view === 'list' ? 'list' : 'grid'));
const filters = computed(() => currentRoute.value.query);
const type = computed(() => String(filters.value.typeId ?? ''));
const tagKey = computed(() => (isPublic.value ? 'tag' : 'tagId'));
const activeTags = computed(() => {
  const value = filters.value[tagKey.value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? [value]
      : [];
});
const hasFilters = computed(() =>
  Boolean(
    filters.value.q ||
    filters.value.typeId ||
    activeTags.value.length ||
    filters.value.owner ||
    filters.value.collectionId,
  ),
);
const filterCount = computed(
  () =>
    activeTags.value.length +
    Number(Boolean(filters.value.owner)) +
    Number(Boolean(filters.value.collectionId)),
);
const types = computed(() => {
  const values =
    (!isPublic.value ? identity.capabilities?.types : undefined)?.map((item) => ({
      value: item.id,
      label: item.name || typeLabel(item.id),
    })) ??
    facets.value.types ??
    [];
  return [
    { value: '', label: '全部' },
    ...values.map((item) => ({ value: item.value, label: item.label })),
  ];
});
const pagePath = route.path;
const querySignature = computed(() => {
  const query = { ...currentRoute.value.query };
  delete query.view;
  return libraryQueryKey(
    currentRoute.value.path,
    props.scope,
    currentRoute.value.params.collectionId,
    query,
  );
});
function parameters(cursor?: string): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ['q', 'typeId', tagKey.value, 'sort']) {
    const value = filters.value[key];
    for (const entry of Array.isArray(value) ? value : [value])
      if (entry) params.append(key, entry);
  }
  if (!isPublic.value && filters.value.owner === 'me') params.set('owner', 'me');
  if (props.scope === 'archive') params.set('state', 'archived');
  if (!isPublic.value && filters.value.collectionId && props.scope !== 'collection')
    params.set('collectionId', String(filters.value.collectionId));
  if (props.scope === 'collection')
    params.set('collectionId', String(currentRoute.value.params.collectionId));
  if (cursor) params.set('cursor', cursor);
  return params;
}
function endpoint(): string {
  return isPublic.value
    ? '/public/assets'
    : props.scope === 'favorites'
      ? '/team/me/favorites'
      : '/team/assets';
}
async function load(more = false): Promise<void> {
  if (currentRoute.value.path !== pagePath) return;
  if (more && (busy.value || !nextCursor.value)) return;
  const local = ++generation;
  controller?.abort();
  controller = new AbortController();
  busy.value = true;
  moreFailed.value = false;
  error.value = '';
  publicUnavailable.value = false;
  if (!more) {
    selected.value = new Set();
    nextCursor.value = null;
  }
  try {
    const result = await api<Page<Asset | PublicAsset>>(
      `${endpoint()}?${parameters(more ? (nextCursor.value ?? undefined) : undefined)}`,
      { signal: controller.signal },
    );
    if (local !== generation) return;
    const incoming = itemsOf(result).map(presentAsset);
    rows.value = more
      ? [
          ...rows.value,
          ...incoming.filter((item) => !rows.value.some((previous) => previous.id === item.id)),
        ]
      : incoming;
    nextCursor.value = result.pageInfo?.nextCursor ?? null;
    hasMore.value = result.pageInfo?.hasMore ?? false;
  } catch (cause) {
    if (local !== generation || (cause instanceof DOMException && cause.name === 'AbortError'))
      return;
    moreFailed.value = more;
    if (!more) rows.value = [];
    publicUnavailable.value = isPublic.value && cause instanceof ApiError && cause.status === 404;
    if (publicUnavailable.value) {
      rows.value = [];
      facets.value = {};
      hasMore.value = false;
    }
    error.value =
      cause instanceof ApiError && cause.status === 404 && isPublic.value
        ? '公开入口当前不可用。'
        : errorMessage(cause);
    if (cause instanceof ApiError && cause.code === 'INVALID_CURSOR') {
      hasMore.value = false;
      nextCursor.value = null;
    }
  } finally {
    if (local === generation) busy.value = false;
  }
}
async function loadFacets(): Promise<void> {
  if (currentRoute.value.path !== pagePath) return;
  facetError.value = '';
  const local = ++facetGeneration;
  try {
    const params = parameters();
    if (!isPublic.value && props.scope === 'favorites') params.set('favorite', 'true');
    const result = await api<Facets>(
      `${isPublic.value ? '/public' : '/team'}/assets/facets?${params}`,
    );
    if (local === facetGeneration) facets.value = result;
  } catch {
    if (local !== facetGeneration) return;
    facetError.value = '筛选项暂时无法加载，已有素材仍可浏览。';
  }
}
function updateQuery(patch: Record<string, string | string[] | undefined>, replace = false): void {
  const query = { ...currentRoute.value.query, ...patch };
  for (const key of Object.keys(query))
    if (query[key] === '' || query[key] === undefined) delete query[key];
  const location = { path: currentRoute.value.path, query };
  void (replace ? router.replace(location) : router.push(location));
}
function search(): void {
  if (composing.value) return;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(
    () => updateQuery({ q: queryInput.value.trim() || undefined }, true),
    250,
  );
}
function clearFilters(): void {
  updateQuery({
    q: undefined,
    typeId: undefined,
    tagId: undefined,
    tag: undefined,
    owner: undefined,
    collectionId: undefined,
  });
}
async function toggleFilters(): Promise<void> {
  filtersOpen.value = !filtersOpen.value;
  if (filtersOpen.value && !isPublic.value && can('collections.read')) {
    try {
      filterCollections.value = await readChoices<Collection>('/team/collections');
    } catch (cause) {
      facetError.value = errorMessage(cause);
    }
  }
}
async function favorite(asset: Asset | PublicAsset): Promise<void> {
  if (isPublic.value || favoritePending.value.has(asset.id)) return;
  const item = asset as Asset;
  favoritePending.value = new Set([...favoritePending.value, item.id]);
  try {
    await api(`/team/me/favorites/${item.id}`, { method: item.favorite ? 'DELETE' : 'PUT' });
    item.favorite = !item.favorite;
    if (props.scope === 'favorites' && !item.favorite)
      rows.value = rows.value.filter((row) => row.id !== item.id);
  } catch (cause) {
    batchMessage.value = errorMessage(cause);
  } finally {
    const next = new Set(favoritePending.value);
    next.delete(item.id);
    favoritePending.value = next;
  }
}
function toggleTag(value: string): void {
  const values = new Set(activeTags.value);
  if (values.has(value)) values.delete(value);
  else values.add(value);
  updateQuery({ [tagKey.value]: [...values] });
}
function toggleSelection(id: string): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}
function selectAll(): void {
  selected.value =
    selected.value.size === rows.value.length
      ? new Set()
      : new Set(rows.value.map((item) => item.id));
}
function canArchive(): boolean {
  return can('assets.archiveOwn') || can('assets.governAny');
}
async function prepare(mode: string): Promise<void> {
  batchMode.value = mode;
  batchMessage.value = '';
  selectedTagIds.value = [];
  selectedCollectionId.value = '';
  try {
    if (mode === 'addTags' || mode === 'removeTags')
      tagChoices.value = await readChoices<Tag>(
        mode === 'removeTags' ? '/team/tags?state=all' : '/team/tags',
      );
    if (mode === 'collection')
      collectionChoices.value = (await readChoices<Collection>('/team/collections')).filter(
        (item) => allows(item.actions, 'manageItems'),
      );
  } catch (cause) {
    batchMessage.value = errorMessage(cause);
  }
}
async function batch(action: string): Promise<void> {
  if (!selected.value.size || selected.value.size > 100) {
    batchMessage.value = '每次请选择 1–100 项素材进行批量操作。';
    return;
  }
  if (
    ['archive', 'restore'].includes(action) &&
    !window.confirm(
      action === 'archive'
        ? `归档所选 ${selected.value.size} 项素材？已公开内容会撤回，原件保留。`
        : `恢复所选 ${selected.value.size} 项素材？不会重新公开。`,
    )
  )
    return;
  batchBusy.value = true;
  batchMessage.value = '';
  try {
    if (action === 'collection' || action === 'removeCollection') {
      const target =
        action === 'removeCollection'
          ? currentCollection.value
          : collectionChoices.value.find((item) => item.id === selectedCollectionId.value);
      if (!target) throw new Error('请选择可维护的团队集合。');
      if (
        action === 'removeCollection' &&
        !window.confirm(
          `从此集合移除所选 ${selected.value.size} 项素材？素材本身仍保留在团队素材库。`,
        )
      )
        return;
      await api(`/team/collections/${target.id}/items:batch`, {
        method: 'POST',
        body: {
          action: action === 'removeCollection' ? 'remove' : 'add',
          assetIds: [...selected.value],
          expectedRevision: target.revision,
        },
        idempotencyKey: operationKey(),
      });
      batchMessage.value =
        action === 'removeCollection'
          ? '所选条目已整体移出集合，素材原件保留。'
          : '所选素材已整体加入集合。';
      selected.value = new Set();
      if (props.scope === 'collection') {
        await load();
        await loadCollection();
      }
    } else {
      const candidates = [
        ...new Map([...failedAssets.value, ...rows.value].map((item) => [item.id, item])).values(),
      ];
      const items = candidates
        .filter((item) => selected.value.has(item.id) && 'revision' in item)
        .map((item) => ({ assetId: item.id, expectedRevision: (item as Asset).revision }));
      const result = await api<{
        results?: { assetId: string; outcome: string; code?: string }[];
        items?: { assetId: string; outcome: string; code?: string }[];
      }>('/team/asset-batch-operations', {
        method: 'POST',
        body: {
          action,
          items,
          ...(['addTags', 'removeTags'].includes(action) ? { tagIds: selectedTagIds.value } : {}),
        },
        idempotencyKey: operationKey(),
      });
      const outcomes = result.results ?? result.items ?? [];
      const failed = outcomes.filter(
        (item) => item.outcome !== 'success' && item.outcome !== 'succeeded',
      );
      const retained = retainBatchFailures(
        candidates.filter((item): item is Asset => 'revision' in item),
        failed,
      );
      failedAssets.value = retained.assets;
      batchResults.value = retained.results;
      batchMessage.value = `完成 ${outcomes.length - failed.length} 项${failed.length ? `，${failed.length} 项未完成：${failed.map((item) => item.code ?? '状态冲突').join('、')}` : ''}。`;
      await load();
      selected.value = new Set(failed.map((item) => item.assetId));
    }
    batchMode.value = '';
  } catch (cause) {
    batchMessage.value = errorMessage(cause);
    if (action === 'collection' || action === 'removeCollection') {
      batchMessage.value +=
        cause instanceof ApiError && cause.status < 500
          ? ' 本次集合条目整批未变，选择已保留。'
          : ' 结果暂未确认，请刷新集合核对；选择已保留。';
      if (action === 'removeCollection') await loadCollection();
      else
        collectionChoices.value = (
          await readChoices<Collection>('/team/collections').catch(() => [])
        ).filter((item) => allows(item.actions, 'manageItems'));
    }
  } finally {
    batchBusy.value = false;
  }
}
function refresh(): void {
  void load();
  void loadFacets();
  void loadCollection();
}
async function loadCollection(): Promise<void> {
  if (props.scope !== 'collection' || currentRoute.value.path !== pagePath) return;
  collectionError.value = '';
  try {
    currentCollection.value = await api<Collection>(
      `/team/collections/${currentRoute.value.params.collectionId}`,
    );
  } catch (cause) {
    currentCollection.value = null;
    collectionError.value = errorMessage(cause);
  }
}
watch(
  querySignature,
  () => {
    if (currentRoute.value.path !== pagePath) return;
    queryInput.value = String(filters.value.q ?? '');
    selected.value = new Set();
    failedAssets.value = [];
    batchResults.value = [];
    batchMode.value = '';
    rows.value = [];
    refresh();
  },
  { immediate: true },
);
onMounted(() => {
  window.addEventListener('shiling:assets-changed', refresh);
  screenQuery.addEventListener('change', resize);
});
onActivated(() => {
  queryInput.value = String(filters.value.q ?? '');
});
onBeforeUnmount(() => {
  generation++;
  facetGeneration++;
  screenQuery.removeEventListener('change', resize);
  controller?.abort();
  if (searchTimer) clearTimeout(searchTimer);
  window.removeEventListener('shiling:assets-changed', refresh);
});
</script>
<template>
  <section
    class="page-content library-page"
    :class="{ 'public-library': isPublic, 'collection-library': scope === 'collection' }"
  >
    <RouterLink v-if="scope === 'collection'" to="/app/collections" class="detail-back text-link"
      ><UiIcon name="arrow" :size="16" />全部集合</RouterLink
    >
    <header class="page-heading library-heading">
      <div>
        <h1 id="results-heading" tabindex="-1">{{ title }}</h1>
        <p>
          {{
            scope === 'archive'
              ? '归档保留原件，恢复后仅团队可见。'
              : scope === 'favorites'
                ? '把喜欢的留下，让下一次创作更近一点。'
                : scope === 'collection'
                  ? currentCollection?.description || '围绕主题，一起收集。'
                  : isPublic
                    ? '发现值得使用的素材。'
                    : '收集灵感，也找到下一份好素材。'
          }}
        </p>
      </div>
      <span class="result-count" aria-live="polite">{{
        busy ? '正在加载' : `已加载 ${rows.length} 项`
      }}</span>
    </header>
    <div v-if="scope === 'collection' && currentCollection" class="collection-context">
      <span class="badge">{{ collectionArchived ? '已归档集合' : '团队共享' }}</span>
      <span class="muted">{{
        collectionArchived
          ? '关联保留；恢复集合后可继续整理。'
          : '只组织素材，不改变权限或公开状态。'
      }}</span>
      <div class="actions">
        <UiButton
          v-if="allows(currentCollection.actions, 'manageItems')"
          variant="primary"
          @click="addingToCollection = true"
          ><UiIcon name="plus" />添加素材</UiButton
        >
        <CollectionActions :collection="currentCollection" @changed="refresh" />
      </div>
    </div>
    <UiNotice v-if="collectionError" tone="error"
      >{{ collectionError
      }}<button class="text-button" @click="refresh">重新读取集合</button></UiNotice
    >
    <CollectionAssetPicker
      v-if="addingToCollection && currentCollection"
      :collection="currentCollection"
      @close="addingToCollection = false"
      @saved="
        addingToCollection = false;
        refresh();
      "
    />
    <UiState
      v-if="publicUnavailable"
      title="公开内容暂不可用"
      description="此入口目前无法访问，请稍后重试或联系分享者。"
      ><button class="button" @click="refresh">重新读取</button></UiState
    >
    <template v-if="!publicUnavailable && !collectionError">
      <form
        v-if="isPublic"
        class="public-search global-search"
        role="search"
        @submit.prevent="updateQuery({ q: queryInput.trim() || undefined })"
      >
        <UiIcon name="search" /><input
          v-model="queryInput"
          aria-label="搜索公开素材"
          placeholder="搜索灵感、风格、关键词"
          @compositionstart="composing = true"
          @compositionend="
            composing = false;
            search();
          "
          @input="search"
        /><button class="button" type="submit">搜索</button>
      </form>
      <div class="filter-bar library-tools">
        <UiSegmented
          label="素材类型"
          :value="type"
          :options="types"
          @change="updateQuery({ typeId: $event || undefined })"
        />
        <div class="toolbar-actions">
          <button
            class="button quiet filter-trigger"
            :class="{ 'is-active': filtersOpen || filterCount }"
            :aria-expanded="filtersOpen"
            @click="toggleFilters"
          >
            <UiIcon name="filter" :size="17" />筛选<span v-if="filterCount" class="filter-count">{{
              filterCount
            }}</span>
          </button>
          <label class="sort-control"
            ><span class="sr-only">排序</span
            ><select
              :value="filters.sort || (isPublic ? 'publishedAtDesc' : 'createdAtDesc')"
              @change="updateQuery({ sort: ($event.target as HTMLSelectElement).value })"
            >
              <option :value="isPublic ? 'publishedAtDesc' : 'createdAtDesc'">
                {{ isPublic ? '最近公开' : '最近上传' }}
              </option>
              <option v-if="!isPublic" value="updatedAtDesc">最近更新</option>
              <option value="titleAsc">名称排序</option>
            </select></label
          >
          <UiSegmented
            label="素材视图"
            :value="view"
            :options="[
              { value: 'grid', label: '网格视图', icon: 'grid' },
              { value: 'list', label: '列表视图', icon: 'list' },
            ]"
            icon-only
            @change="updateQuery({ view: $event })"
          />
          <button
            v-if="!isPublic && rows.length && !collectionArchived"
            class="button quiet select-trigger"
            :aria-pressed="selecting"
            @click="
              selecting = !selecting;
              selected = new Set();
              failedAssets = [];
              batchResults = [];
            "
          >
            <UiIcon name="check" :size="16" />{{ selecting ? '完成选择' : '选择' }}
          </button>
        </div>
      </div>
      <component
        :is="smallScreen ? UiDialog : 'div'"
        v-if="filtersOpen"
        title="筛选素材"
        class="filter-container"
        @close="filtersOpen = false"
      >
        <AssetFilters
          :tags="facets.tags || []"
          :active-tags="activeTags"
          :owner="filters.owner === 'me'"
          :collections="filterCollections"
          :collection-id="String(filters.collectionId || '')"
          :show-collection="!isPublic && scope !== 'collection' && can('collections.read')"
          :is-public="isPublic"
          @tag="toggleTag"
          @owner="updateQuery({ owner: filters.owner === 'me' ? undefined : 'me' })"
          @collection="updateQuery({ collectionId: $event || undefined })"
          @clear="clearFilters"
        />
        <button v-if="smallScreen" class="button primary full-width" @click="filtersOpen = false">
          查看结果
        </button>
      </component>
      <div v-if="hasFilters" class="active-filters">
        <span class="muted">当前条件</span>
        <button v-if="filters.q" class="chip" @click="updateQuery({ q: undefined })">
          “{{ filters.q }}”<UiIcon name="close" :size="12" />
        </button>
        <button v-for="tag in activeTags" :key="tag" class="chip" @click="toggleTag(tag)">
          {{ facets.tags?.find((item) => item.value === tag)?.label || '所选标签'
          }}<UiIcon name="close" :size="12" />
        </button>
        <button v-if="filters.owner" class="chip" @click="updateQuery({ owner: undefined })">
          本人上传<UiIcon name="close" :size="12" />
        </button>
        <button
          v-if="filters.collectionId"
          class="chip"
          @click="updateQuery({ collectionId: undefined })"
        >
          {{ filterCollections.find((item) => item.id === filters.collectionId)?.name || '所选集合'
          }}<UiIcon name="close" :size="12" />
        </button>
        <button class="text-button" @click="clearFilters">清除全部</button>
      </div>
      <UiNotice v-if="facetError" tone="warning"
        >{{ facetError }}
        <button class="text-button" @click="loadFacets">重试筛选</button></UiNotice
      >
      <div v-if="selecting" class="selection-bar">
        <label class="checkbox-row"
          ><input
            type="checkbox"
            :checked="rows.length > 0 && selected.size === rows.length"
            @change="selectAll"
          />已加载项全选</label
        ><span>已选 {{ selected.size }} 项</span
        ><button
          v-if="
            scope !== 'archive' &&
            !collectionArchived &&
            (can('assets.editOwn') || can('assets.governAny'))
          "
          class="button compact"
          :disabled="!selected.size || batchBusy"
          @click="prepare('addTags')"
        >
          添加标签</button
        ><button
          v-if="scope !== 'archive' && (can('assets.editOwn') || can('assets.governAny'))"
          class="button compact"
          :disabled="!selected.size || batchBusy"
          @click="prepare('removeTags')"
        >
          移除标签</button
        ><button
          v-if="
            scope !== 'archive' && (can('collections.manageOwn') || can('collections.governAny'))
          "
          class="button compact"
          :disabled="!selected.size || batchBusy"
          @click="prepare('collection')"
        >
          加入集合</button
        ><button
          v-if="
            scope === 'collection' &&
            currentCollection &&
            allows(currentCollection.actions, 'manageItems')
          "
          class="button compact"
          :disabled="!selected.size || batchBusy"
          @click="batch('removeCollection')"
        >
          移出此集合</button
        ><button
          v-if="canArchive()"
          class="button compact"
          :disabled="!selected.size || batchBusy"
          @click="batch(scope === 'archive' ? 'restore' : 'archive')"
        >
          {{ scope === 'archive' ? '恢复' : '归档' }}
        </button>
      </div>
      <form v-if="batchMode" class="inset-panel form-stack" @submit.prevent="batch(batchMode)">
        <h2>{{ batchMode === 'collection' ? '加入团队集合' : '选择标签' }}</h2>
        <select
          v-if="batchMode === 'collection'"
          v-model="selectedCollectionId"
          aria-label="目标集合"
          required
        >
          <option value="">选择可维护的集合</option>
          <option
            v-for="collection in collectionChoices"
            :key="collection.id"
            :value="collection.id"
          >
            {{ collection.name }}
          </option>
        </select>
        <div v-else class="chip-group">
          <label
            v-for="tag in tagChoices.filter(
              (item) =>
                batchMode === 'removeTags' ||
                (item.state !== 'disabled' && item.status !== 'disabled'),
            )"
            :key="tag.id"
            class="checkbox-row"
            ><input v-model="selectedTagIds" type="checkbox" :value="tag.id" />{{ tag.name }}</label
          >
          <p v-if="!tagChoices.length" class="muted">暂无可选标签。</p>
        </div>
        <div class="actions">
          <button
            class="button primary"
            :disabled="batchBusy || (batchMode !== 'collection' && !selectedTagIds.length)"
          >
            确认</button
          ><button type="button" class="button" @click="batchMode = ''">取消</button>
        </div>
      </form>
      <div v-if="batchResults.length" class="batch-results" role="status">
        <strong>{{ batchResults.length }} 项需要处理</strong>
        <ul>
          <li v-for="result in batchResults" :key="result.assetId">
            <span>{{ result.title }}</span><span>{{ result.code }}</span>
          </li>
        </ul>
        <p>失败项仍被选中。修正原因后可再次执行；版本冲突请打开详情核对。</p>
      </div>
      <UiNotice v-if="batchMessage">{{ batchMessage }}</UiNotice><UiNotice v-if="error" tone="error"
        >{{ error }}
        <button class="text-button" @click="load(moreFailed)">
          {{ moreFailed ? '重试加载更多' : '重新加载' }}
        </button></UiNotice
      ><UiState v-if="busy && !rows.length" title="正在加载素材" busy /><UiState
        v-else-if="!rows.length && !error"
        :title="
          hasFilters
            ? '没有找到匹配素材'
            : scope === 'favorites'
              ? '还没有收藏素材'
              : scope === 'archive'
                ? '没有归档素材'
                : '这里还没有素材'
        "
        :description="
          hasFilters
            ? '试试其他关键词，或清除筛选。'
            : isPublic
              ? '团队公开素材后，将出现在这里。'
              : scope === 'collection'
                ? collectionArchived
                  ? '这个归档集合目前没有可见素材。'
                  : '点击“添加素材”，从团队素材库开始收集。'
                : '处理合格的素材会出现在素材库中。'
        "
        ><button v-if="hasFilters" class="button" @click="clearFilters">清除筛选</button
        ><RouterLink
          v-if="
            !isPublic &&
            scope !== 'collection' &&
            scope !== 'archive' &&
            can('uploads.create') &&
            !hasFilters
          "
          to="/app/uploads"
          class="button primary"
          >上传素材</RouterLink
        ></UiState
      >
      <div v-if="rows.length && view === 'grid'" class="asset-masonry">
        <AssetCard
          v-for="asset in rows"
          :key="asset.id"
          :asset="asset"
          :is-public="isPublic"
          :selectable="selecting"
          :selected="selected.has(asset.id)"
          :can-favorite="!isPublic && scope !== 'archive' && can('favorites.manageOwn')"
          :favorite-busy="favoritePending.has(asset.id)"
          @favorite="favorite(asset)"
          @open="openDetail(router, asset.id, isPublic)"
          @select="toggleSelection(asset.id)"
        />
      </div>
      <div v-if="rows.length && view === 'list'" class="asset-list">
        <div class="asset-list-heading">
          <span>素材</span><span>规格</span><span v-if="!isPublic">文件大小</span
          ><span v-if="!isPublic">上传时间</span><span>操作</span>
        </div>
        <div
          v-for="asset in rows"
          :key="asset.id"
          class="asset-list-row"
          :class="{ 'is-selected': selected.has(asset.id) }"
        >
          <div class="list-identity">
            <input
              v-if="selecting"
              type="checkbox"
              :checked="selected.has(asset.id)"
              :aria-label="`选择${asset.title}`"
              @change="toggleSelection(asset.id)"
            />
            <button
              :id="`asset-${asset.id}`"
              class="list-title"
              @click="openDetail(router, asset.id, isPublic)"
            >
              <AssetThumb :asset="asset" :is-public="isPublic" compact /><span
                ><strong>{{ asset.title }}</strong
                ><small>{{ typeLabel(asset.typeId) }} · {{ fileFormat(asset) }}</small></span
              >
            </button>
          </div>
          <span class="list-spec">{{ dimensionsLabel(asset) }}</span><span
            v-if="!isPublic"
            class="list-size"
            >{{ formatBytes((asset as Asset).bytes) }}</span
          ><span v-if="!isPublic" class="list-date">{{
            formatDate((asset as Asset).createdAt)
          }}</span>
          <button
            v-if="!isPublic && scope !== 'archive' && can('favorites.manageOwn')"
            class="icon-button card-favorite"
            :class="{ 'is-favorite': (asset as Asset).favorite }"
            :aria-label="`${(asset as Asset).favorite ? '取消收藏' : '收藏'}${asset.title}`"
            :aria-pressed="(asset as Asset).favorite"
            :disabled="favoritePending.has(asset.id)"
            @click="favorite(asset)"
          >
            <UiIcon name="heart" :size="18" />
          </button>
          <button v-else class="text-button" @click="openDetail(router, asset.id, isPublic)">
            查看
          </button>
        </div>
      </div>
      <div v-if="hasMore" class="load-more">
        <button class="button" :disabled="busy" @click="load(true)">
          {{ busy ? '正在加载…' : '加载更多' }}
        </button>
      </div>
      <p v-else-if="rows.length" class="list-end">已显示 {{ rows.length }} 项</p>
    </template>
  </section>
</template>
