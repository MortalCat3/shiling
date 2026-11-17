<script setup lang="ts">
import type { Asset, PublicAsset } from '../../app/models';
import { fileFormat } from './media';
import AssetThumb from './AssetThumb.vue';
import UiIcon from '../../components/ui/UiIcon.vue';
withDefaults(
  defineProps<{
    asset: Asset | PublicAsset;
    isPublic?: boolean;
    selectable?: boolean;
    selected?: boolean;
    canFavorite?: boolean;
    favoriteBusy?: boolean;
  }>(),
  { isPublic: false, selectable: false, selected: false, canFavorite: false, favoriteBusy: false },
);
const emit = defineEmits<{ open: []; select: []; favorite: [] }>();
</script>
<template>
  <article class="asset-card" :class="{ 'is-selected': selected }">
    <button
      :id="`asset-${asset.id}`"
      class="asset-open"
      :aria-label="`查看${asset.title}`"
      @click="emit('open')"
    >
      <AssetThumb :asset="asset" :is-public="isPublic" />
      <span class="asset-title" :title="asset.title">{{ asset.title }}</span>
    </button>
    <div class="asset-card-footer">
      <span>{{ fileFormat(asset) }}</span><span
        v-if="!isPublic && (asset as Asset).publicationState === 'active'"
        class="publication-dot"
        >已公开</span
      >
      <button
        v-if="canFavorite"
        class="card-favorite icon-button"
        :class="{ 'is-favorite': (asset as Asset).favorite }"
        :disabled="favoriteBusy"
        :aria-label="`${(asset as Asset).favorite ? '取消收藏' : '收藏'}${asset.title}`"
        :aria-pressed="(asset as Asset).favorite"
        @click="emit('favorite')"
      >
        <UiIcon name="heart" :size="16" />
      </button>
    </div>
    <label v-if="selectable" class="asset-select"
      ><input
        type="checkbox"
        :checked="selected"
        :aria-label="`选择${asset.title}`"
        @change="emit('select')"
    /></label>
  </article>
</template>
