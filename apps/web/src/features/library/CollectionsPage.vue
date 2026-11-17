<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { errorMessage } from '../../app/http-client';
import { readChoices } from '../../app/list-data';
import type { Collection } from '../../app/models';
import { can } from '../../app/session';
import CollectionCover from './CollectionCover.vue';
import CollectionEditor from './CollectionEditor.vue';
import CollectionActions from './CollectionActions.vue';
import UiButton from '../../components/ui/UiButton.vue';
import UiIcon from '../../components/ui/UiIcon.vue';
import UiNotice from '../../components/ui/UiNotice.vue';
import UiState from '../../components/ui/UiState.vue';
import UiSegmented from '../../components/ui/UiSegmented.vue';
const route = useRoute(),
  router = useRouter();
const collections = ref<Collection[]>([]),
  busy = ref(false),
  error = ref(''),
  message = ref(''),
  creating = ref(false);
const query = ref('');
const archived = computed(() => route.query.state === 'archived');
const visible = computed(() =>
  collections.value.filter((item) =>
    (item.name + (item.description || ''))
      .toLocaleLowerCase()
      .includes(query.value.trim().toLocaleLowerCase()),
  ),
);
let generation = 0;
async function load(): Promise<void> {
  const local = ++generation;
  busy.value = true;
  error.value = '';
  try {
    const items = await readChoices<Collection>(
      '/team/collections?state=' + (archived.value ? 'archived' : 'active'),
    );
    if (local === generation) collections.value = items;
  } catch (cause) {
    if (local === generation) {
      error.value = errorMessage(cause);
      collections.value = [];
    }
  } finally {
    if (local === generation) busy.value = false;
  }
}
function state(value: string): void {
  void router.push({
    path: '/app/collections',
    query: value === 'archived' ? { state: value } : {},
  });
}
function saved(): void {
  creating.value = false;
  message.value = '集合已创建，可进入集合添加素材。';
  void load();
}
watch(
  archived,
  () => {
    collections.value = [];
    message.value = '';
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
});
</script>
<template>
  <section class="page-content collections-page">
    <header class="page-heading">
      <div>
        <h1>团队集合</h1>
        <p>把灵感收进主题，让下一次创作有迹可循。</p>
      </div>
      <UiButton
        v-if="can('collections.create') && !archived"
        variant="primary"
        @click="creating = true"
        ><UiIcon name="plus" />新建集合</UiButton
      >
    </header>
    <div class="organization-toolbar">
      <UiSegmented
        label="集合范围"
        :value="archived ? 'archived' : 'active'"
        :options="[
          { value: 'active', label: '团队集合' },
          { value: 'archived', label: '已归档' },
        ]"
        @change="state"
      />
      <label class="local-search"
        ><UiIcon name="search" :size="17" /><input
          v-model="query"
          aria-label="搜索集合"
          placeholder="搜索集合名称或说明" /></label
      ><span class="result-count" aria-live="polite">{{
        busy ? '正在读取' : visible.length + ' 个集合'
      }}</span>
    </div>
    <p class="scope-note">
      {{
        archived
          ? '归档保留集合与素材关联；恢复集合不会重新公开素材。'
          : '集合在团队内共享，不改变素材权限，也不会整体公开。'
      }}
    </p>
    <UiNotice v-if="error" tone="error"
      >{{ error }}<button class="text-button" @click="load">重新加载</button></UiNotice
    ><UiNotice v-if="message" tone="success">{{ message }}</UiNotice>
    <UiState v-if="busy && !collections.length" title="正在加载集合" busy />
    <UiState
      v-else-if="!visible.length && !error"
      :title="query ? '没有找到这个集合' : archived ? '没有归档集合' : '从一个主题开始'"
      :description="
        query
          ? '换一个关键词，或清除搜索。'
          : archived
            ? '归档后的集合会保留在这里。'
            : '为项目、风格或下一次创作创建集合，再把素材收进来。'
      "
    >
      <UiButton v-if="query" @click="query = ''">清除搜索</UiButton
      ><UiButton
        v-else-if="!archived && can('collections.create')"
        variant="primary"
        @click="creating = true"
        >新建集合</UiButton
      >
    </UiState>
    <div class="collection-board">
      <article v-for="collection in visible" :key="collection.id" class="collection-tile">
        <RouterLink :to="'/app/collections/' + collection.id" class="collection-open"
          ><CollectionCover
            :id="collection.id"
            :key="collection.id + ':' + collection.revision"
            :empty="collection.visibleItemCount === 0"
          />
          <div class="collection-copy">
            <h2>{{ collection.name }}</h2>
            <p>{{ collection.description || '还没有说明，先收集喜欢的素材。' }}</p>
            <span class="muted">{{ collection.visibleItemCount ?? '—' }} 项可见素材</span>
          </div></RouterLink
        >
        <CollectionActions :collection="collection" @changed="load" />
      </article>
    </div>
    <CollectionEditor v-if="creating" @close="creating = false" @saved="saved" />
  </section>
</template>
