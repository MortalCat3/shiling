<script setup lang="ts">
import UiIcon from './UiIcon.vue';
defineProps<{
  label: string;
  value: string;
  options: { value: string; label: string; icon?: string }[];
  iconOnly?: boolean;
}>();
const emit = defineEmits<{ change: [value: string] }>();
</script>
<template>
  <div class="segmented" role="group" :aria-label="label">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      :class="{ active: value === option.value }"
      :aria-label="option.label"
      :aria-pressed="value === option.value"
      :title="iconOnly ? option.label : undefined"
      @click="emit('change', option.value)"
    >
      <UiIcon v-if="option.icon" :name="option.icon" :size="18" /><span
        :class="{ 'sr-only': iconOnly }"
        >{{ option.label }}</span
      >
    </button>
  </div>
</template>
