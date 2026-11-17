<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import UiIcon from './UiIcon.vue';
const props = withDefaults(
  defineProps<{ title: string; wide?: boolean; dismissible?: boolean }>(),
  { wide: false, dismissible: true },
);
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
let previous: HTMLElement | null = null;
let oldOverflow = '';
function close(): void {
  if (props.dismissible) emit('close');
}
onMounted(() => {
  previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  oldOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  dialog.value?.showModal();
});
onBeforeUnmount(() => {
  dialog.value?.close();
  document.body.style.overflow = oldOverflow;
  if (previous?.isConnected) previous.focus();
});
</script>
<template>
  <dialog
    ref="dialog"
    class="dialog"
    :class="{ 'dialog-wide': wide }"
    :aria-label="title"
    @cancel.prevent="close"
    @click="
      (event) => {
        if (event.target === dialog) close();
      }
    "
  >
    <div class="dialog-content">
      <header class="dialog-header">
        <h2 tabindex="-1" autofocus>{{ title }}</h2>
        <button
          v-if="dismissible"
          class="icon-button"
          type="button"
          aria-label="关闭"
          @click="close"
        >
          <UiIcon name="close" />
        </button>
      </header>
      <slot />
    </div>
  </dialog>
</template>
