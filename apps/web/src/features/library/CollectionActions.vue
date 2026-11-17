<script setup lang="ts">
import { ref } from 'vue';
import { allows, type Collection } from '../../app/models';
import { api, errorMessage, operationKey } from '../../app/http-client';
import CollectionEditor from './CollectionEditor.vue';
import UiButton from '../../components/ui/UiButton.vue';
import UiNotice from '../../components/ui/UiNotice.vue';
const props = defineProps<{ collection: Collection }>();
const emit = defineEmits<{ changed: [] }>();
const editing = ref(false),
  busy = ref(false),
  error = ref('');
async function change(): Promise<void> {
  const restore = allows(props.collection.actions, 'restore');
  if (
    !window.confirm(
      restore
        ? '恢复集合？其中素材不会重新公开。'
        : '归档集合？素材和关联保留，素材的公开状态不变。',
    )
  )
    return;
  busy.value = true;
  error.value = '';
  try {
    await api('/team/collections/' + props.collection.id + (restore ? '/restore' : '/archive'), {
      method: 'POST',
      body: { expectedRevision: props.collection.revision },
      idempotencyKey: operationKey(),
    });
    emit('changed');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="collection-actions">
    <UiButton
      v-if="allows(collection.actions, 'edit')"
      variant="quiet"
      :aria-label="'编辑' + collection.name"
      @click="editing = true"
      >编辑</UiButton
    >
    <UiButton
      v-if="allows(collection.actions, 'archive') || allows(collection.actions, 'restore')"
      variant="quiet"
      :busy="busy"
      :aria-label="(allows(collection.actions, 'restore') ? '恢复' : '归档') + collection.name"
      @click="change"
      >{{ allows(collection.actions, 'restore') ? '恢复' : '归档' }}</UiButton
    >
    <UiNotice v-if="error" tone="error"
      >{{ error
      }}<button class="text-button" @click="emit('changed')">刷新集合状态</button></UiNotice
    >
  </div>
  <CollectionEditor
    v-if="editing"
    :collection="collection"
    @close="editing = false"
    @saved="
      editing = false;
      emit('changed');
    "
  />
</template>
