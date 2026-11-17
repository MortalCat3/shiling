<script setup lang="ts">
import { computed } from 'vue';
import { brand } from '../app/session';
import { safeResourceUrl } from '../app/http-client';
const logo = computed(() => safeResourceUrl(brand.value.logoUrl));
</script>
<template>
  <span class="brand-mark"
    ><img v-if="logo" :src="logo" :alt="brand.name || '拾灵'" /><span v-else class="brand-word"
      >{{ brand.name || '拾灵' }}<small>shiling</small></span
    ></span
  >
</template>
