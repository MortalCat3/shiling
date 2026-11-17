<script setup lang="ts">
import UiIcon from './UiIcon.vue';
withDefaults(
  defineProps<{ title: string; description?: string; icon?: string; busy?: boolean }>(),
  { description: '', icon: 'folder', busy: false },
);
</script>
<template>
  <div class="empty-state" :aria-busy="busy">
    <span class="empty-symbol"><UiIcon :name="icon" :size="30" /></span>
    <h2>{{ title }}</h2>
    <p v-if="description">{{ description }}</p>
    <slot />
  </div>
</template>
