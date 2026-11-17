<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../../app/http-client';
import type { Asset, Page } from '../../app/models';
import AssetThumb from '../assets/AssetThumb.vue';
import { presentAsset } from '../assets/media';
import UiIcon from '../../components/ui/UiIcon.vue';
const props = defineProps<{ id: string; empty?: boolean }>();
const root = ref<HTMLElement>(),
  items = ref<Asset[]>([]),
  failed = ref(false),
  loaded = ref(false);
const controller = new AbortController();
let observer: IntersectionObserver | undefined;
async function load(): Promise<void> {
  observer?.disconnect();
  if (props.empty) {
    loaded.value = true;
    return;
  }
  try {
    const page = await api<Page<Asset>>('/team/collections/' + props.id + '/items?limit=3', {
      signal: controller.signal,
    });
    items.value = page.items.slice(0, 3).map(presentAsset);
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'AbortError')) failed.value = true;
  } finally {
    loaded.value = true;
  }
}
onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load();
    },
    { rootMargin: '200px' },
  );
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  controller.abort();
});
</script>
<template>
  <div
    ref="root"
    class="collection-cover"
    :class="{ 'has-covers': items.length, 'single-cover': items.length === 1 }"
    aria-hidden="true"
  >
    <AssetThumb v-for="item in items" :key="item.id" :asset="item" compact />
    <span v-if="!items.length" class="collection-cover-empty"
      ><UiIcon :name="failed ? 'image' : 'folder'" :size="26" />{{
        failed ? '预览暂不可用' : loaded ? '等待收集第一份灵感' : '读取集合预览'
      }}</span
    >
  </div>
</template>
