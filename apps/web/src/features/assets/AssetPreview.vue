<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Asset, PublicAsset, Grant } from '../../app/models';
import { api, errorMessage, safeResourceUrl } from '../../app/http-client';
import { artifactsOf, assetEndpoint, delivery } from './media';
import UiIcon from '../../components/ui/UiIcon.vue';
import UiNotice from '../../components/ui/UiNotice.vue';
const props = withDefaults(
  defineProps<{ asset: Asset | PublicAsset; isPublic?: boolean; archived?: boolean }>(),
  { isPublic: false, archived: false },
);
const imageUrl = ref('');
const videoUrl = ref('');
const frameUrl = ref('');
const error = ref('');
const busy = ref(false);
const zoom = ref(1);
const video = ref<HTMLVideoElement>();
const artifacts = computed(() => artifactsOf(props.asset));
let generation = 0;
async function load(): Promise<void> {
  const current = ++generation;
  video.value?.pause();
  zoom.value = 1;
  error.value = '';
  imageUrl.value = '';
  videoUrl.value = '';
  frameUrl.value = '';
  const cover = props.asset.cover;
  const artifact = artifacts.value.find(
    (item) =>
      (props.archived
        ? ['thumbnail', 'poster']
        : ['preview_image', 'thumbnail', 'poster']
      ).includes(item.role) && item.mediaType?.startsWith('image/'),
  );
  try {
    const direct = safeResourceUrl(cover?.url);
    if (direct) imageUrl.value = direct;
    else {
      const id = cover?.artifactId ?? artifact?.id;
      if (id) {
        const grant = await delivery(props.asset.id, id, 'preview', props.isPublic);
        if (current === generation) imageUrl.value = grant.url;
      }
    }
  } catch (cause) {
    if (current === generation) error.value = errorMessage(cause);
  }
}
async function play(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    if (props.archived) throw new Error('请先恢复素材再播放。');
    if (props.asset.typeId === 'web_motion') {
      const grant = await api<Grant>(
        `${assetEndpoint(props.asset.id, props.isPublic)}/motion-preview-grants`,
        { method: 'POST' },
      );
      const safe = safeResourceUrl(grant.url);
      if (!safe || new URL(safe).origin === location.origin)
        throw new Error('隔离预览地址不可用，不能在主站执行动效。');
      frameUrl.value = safe;
    } else {
      const artifact = artifacts.value.find((item) => item.role === 'playback_video');
      if (!artifact) throw new Error('暂无可播放的文件。');
      videoUrl.value = (
        await delivery(props.asset.id, artifact.id, 'playback', props.isPublic)
      ).url;
    }
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
function pause(): void {
  if (document.hidden) {
    video.value?.pause();
    frameUrl.value = '';
  }
}
watch(() => props.asset, load, { immediate: true });
onMounted(() => document.addEventListener('visibilitychange', pause));
onBeforeUnmount(() => {
  generation++;
  video.value?.pause();
  frameUrl.value = '';
  document.removeEventListener('visibilitychange', pause);
});
</script>
<template>
  <div class="preview-column">
    <div class="preview-stage" :class="{ 'is-zoomed': zoom > 1 }">
      <iframe
        v-if="frameUrl"
        :src="frameUrl"
        sandbox="allow-scripts allow-same-origin"
        referrerpolicy="no-referrer"
        title="隔离动效预览"
        allow="autoplay 'none'; camera 'none'; microphone 'none'; geolocation 'none'"
      /><video
        v-else-if="videoUrl"
        ref="video"
        :src="videoUrl"
        :poster="imageUrl || undefined"
        controls
        playsinline
        preload="metadata"
        @error="error = '当前浏览器无法播放此预览，可重试或下载获准原件。'"
      /><img
        v-else-if="imageUrl"
        :src="imageUrl"
        :alt="asset.title"
        :style="{ transform: `scale(${zoom})` }"
        @error="error = '预览暂时无法加载，原件状态不受此影响。'"
      />
      <div v-else class="cover-placeholder">
        <UiIcon :name="asset.typeId" :size="48" /><span>暂无静态预览</span>
      </div>
    </div>
    <div class="preview-controls">
      <template v-if="asset.typeId === 'image'"
        ><button class="button compact" :disabled="!imageUrl" @click="zoom = 1">适配</button
        ><button
          class="button compact"
          :disabled="!imageUrl || zoom >= 3"
          aria-label="放大预览"
          @click="zoom = Math.min(3, zoom + 0.25)"
        >
          <UiIcon name="plus" :size="16" /></button
        ><button
          class="button compact"
          :disabled="zoom <= 1"
          aria-label="缩小预览"
          @click="zoom = Math.max(1, zoom - 0.25)"
        >
          <UiIcon name="minus" :size="16" /></button></template
      ><button v-else-if="!archived" class="button" :disabled="busy" @click="play">
        <UiIcon name="play" />{{
          busy
            ? '正在取得授权…'
            : frameUrl
              ? '重新打开动效'
              : videoUrl
                ? '重新获取播放授权'
                : '打开预览'
        }}</button
      ><button v-if="frameUrl" class="button" @click="frameUrl = ''">停止动效</button
      ><button v-if="error" class="button compact" @click="load">重试封面</button>
    </div>
    <UiNotice v-if="archived">已归档，仅显示安全静态预览。恢复后可下载和播放。</UiNotice
    ><UiNotice v-if="error" tone="error">{{ error }}</UiNotice>
  </div>
</template>
