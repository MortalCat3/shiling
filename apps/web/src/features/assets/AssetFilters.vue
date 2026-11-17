<script setup lang="ts">
import type { Collection, Facet } from '../../app/models';
defineProps<{
  tags: Facet[];
  activeTags: string[];
  owner: boolean;
  collections: Collection[];
  collectionId: string;
  showCollection: boolean;
  isPublic: boolean;
}>();
const emit = defineEmits<{
  tag: [value: string];
  owner: [];
  collection: [value: string];
  clear: [];
}>();
</script>
<template>
  <div class="asset-filters">
    <fieldset>
      <legend>标签 <span class="muted">同时匹配所选标签</span></legend>
      <div class="chip-group">
        <button
          v-for="tag in tags"
          :key="tag.value"
          class="chip"
          :class="{ active: activeTags.includes(tag.value) }"
          :aria-pressed="activeTags.includes(tag.value)"
          @click="emit('tag', tag.value)"
        >
          {{ tag.label }}
        </button>
      </div>
      <p v-if="!tags.length" class="muted">当前范围没有可用标签。</p>
    </fieldset>
    <div class="filter-fields">
      <label v-if="showCollection"
        >集合<select
          :value="collectionId"
          @change="emit('collection', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">所有集合</option>
          <option v-for="collection in collections" :key="collection.id" :value="collection.id">
            {{ collection.name }}
          </option>
        </select></label
      >
      <label v-if="!isPublic" class="checkbox-row"
        ><input type="checkbox" :checked="owner" @change="emit('owner')" />仅本人上传</label
      >
      <button class="text-button" @click="emit('clear')">清除全部筛选</button>
    </div>
  </div>
</template>
