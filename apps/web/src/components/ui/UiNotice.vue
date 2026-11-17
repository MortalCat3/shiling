<script setup lang="ts">
withDefaults(defineProps<{ tone?: 'error' | 'success' | 'info' | 'warning'; title?: string }>(), {
  tone: 'info',
  title: '',
});
</script>
<template>
  <div class="notice" :class="`notice-${tone}`" :role="tone === 'error' ? 'alert' : 'status'">
    <strong v-if="title">{{ title }}</strong><slot />
  </div>
</template>
