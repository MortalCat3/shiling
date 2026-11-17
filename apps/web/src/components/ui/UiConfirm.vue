<script setup lang="ts">
import UiDialog from './UiDialog.vue';
import UiButton from './UiButton.vue';
defineProps<{ title: string; description: string; label: string }>();
const emit = defineEmits<{ confirm: []; close: [] }>();
</script>
<template>
  <UiDialog :title="title" @close="emit('close')">
    <p class="confirmation-copy">{{ description }}</p>
    <div class="dialog-actions">
      <UiButton @click="emit('close')">取消</UiButton
      ><UiButton variant="primary" @click="emit('confirm')">{{ label }}</UiButton>
    </div>
  </UiDialog>
</template>
