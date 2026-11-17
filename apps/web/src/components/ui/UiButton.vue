<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'default' | 'primary' | 'quiet';
    busy?: boolean;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
  }>(),
  { variant: 'default', busy: false, disabled: false, type: 'button' },
);
</script>
<template>
  <button
    :type="type"
    class="button"
    :class="[variant, { 'is-busy': busy }]"
    :disabled="disabled || busy"
    :aria-busy="busy || undefined"
  >
    <span v-if="busy" class="button-spinner" aria-hidden="true" /><slot />
  </button>
</template>
