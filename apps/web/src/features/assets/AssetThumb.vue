<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Asset, PublicAsset } from '../../app/models';
import { safeResourceUrl } from '../../app/http-client';
import { delivery } from './media';
import UiIcon from '../../components/ui/UiIcon.vue';
const props = withDefaults(
  defineProps<{ asset: Asset | PublicAsset; isPublic?: boolean; compact?: boolean }>(),
  { isPublic: false, compact: false },
);
const root = ref<HTMLElement>();
const imageUrl = ref('');
const failed = ref(false);
const loaded = ref(false);
let visible = false;
let generation = 0;
let observer: IntersectionObserver | undefined;
const ratio = computed(() => {
  const width = props.asset.cover?.width ?? props.asset.dimensions?.width ?? props.asset.width;
  const height = props.asset.cover?.height ?? props.asset.dimensions?.height ?? props.asset.height;
  return width && height ? `${width} / ${height}` : '4 / 3';
});
async function load(): Promise<void> {
  const version = ++generation;
  failed.value = false;
  loaded.value = false;
  imageUrl.value = '';
  try {
    const direct = safeResourceUrl(props.asset.cover?.url);
    const url =
      direct ??
      (props.asset.cover?.artifactId
        ? (await delivery(props.asset.id, props.asset.cover.artifactId, 'preview', props.isPublic))
            .url
        : '');
    if (version === generation) {
      imageUrl.value = url;
      loaded.value = true;
    }
  } catch {
    if (version === generation) {
      failed.value = true;
      loaded.value = true;
    }
  }
}
onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        visible = true;
        void load();
        observer?.disconnect();
      }
    },
    { rootMargin: '300px' },
  );
  if (root.value) observer.observe(root.value);
});
watch(
  () => [props.asset.id, props.asset.cover?.artifactId, props.asset.cover?.url],
  () => {
    if (visible) void load();
  },
);
onBeforeUnmount(() => {
  generation++;
  observer?.disconnect();
});
</script>
<template>
  <span
    ref="root"
    class="asset-cover"
    :class="{ 'thumb-compact': compact }"
    :style="compact ? undefined : { aspectRatio: ratio }"
  >
    <img
      v-if="imageUrl && !failed"
      :src="imageUrl"
      alt=""
      loading="lazy"
      decoding="async"
      @error="failed = true"
    />
    <span v-else class="cover-placeholder"
      ><UiIcon :name="asset.typeId" :size="compact ? 20 : 28" /><small v-if="!compact">{{
        failed ? '预览暂不可用' : loaded ? '暂无预览' : '载入预览'
      }}</small></span
    >
    <span v-if="asset.typeId === 'video' && !compact" class="media-kind"
      ><UiIcon name="play" :size="13" />MP4</span
    >
  </span>
</template>
