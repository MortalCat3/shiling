<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Collection } from '../../app/models';
import { api, ApiError, errorMessage, operationKey, revisionTag } from '../../app/http-client';
import UiDialog from '../../components/ui/UiDialog.vue';
import UiNotice from '../../components/ui/UiNotice.vue';
import UiButton from '../../components/ui/UiButton.vue';
const props = defineProps<{ collection?: Collection | null }>();
const emit = defineEmits<{ close: []; saved: [collection: Collection] }>();
const name = ref(props.collection?.name || ''),
  description = ref(props.collection?.description || '');
const revision = ref(props.collection?.revision || '');
const busy = ref(false),
  error = ref(''),
  conflict = ref(false),
  latest = ref('');
const dirty = computed(
  () =>
    name.value !== (props.collection?.name || '') ||
    description.value !== (props.collection?.description || ''),
);
let key = operationKey();
watch([name, description], () => {
  key = operationKey();
});
function close(): void {
  if (!busy.value && (!dirty.value || window.confirm('集合信息尚未保存，放弃本次修改？')))
    emit('close');
}
async function reloadRevision(): Promise<void> {
  if (!props.collection) return;
  busy.value = true;
  try {
    const item = await api<Collection>('/team/collections/' + props.collection.id);
    revision.value = item.revision;
    latest.value = '当前名称：' + item.name + '。你的输入已保留，请核对后再保存。';
    conflict.value = false;
    error.value = '';
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function save(): Promise<void> {
  if (busy.value || conflict.value || !name.value.trim()) return;
  busy.value = true;
  error.value = '';
  const path = '/team/collections' + (props.collection ? '/' + props.collection.id : '');
  try {
    const item = await api<Collection>(path, {
      method: props.collection ? 'PATCH' : 'POST',
      body: { name: name.value.trim(), description: description.value },
      ...(props.collection ? { etag: revisionTag(path, revision.value) } : { idempotencyKey: key }),
    });
    emit('saved', item);
  } catch (cause) {
    error.value = errorMessage(cause);
    conflict.value = cause instanceof ApiError && [409, 412].includes(cause.status);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <UiDialog
    :title="collection ? '编辑集合' : '新建集合'"
    class="organization-dialog"
    :dismissible="!busy"
    @close="close"
  >
    <form class="form-stack" @submit.prevent="save">
      <p class="form-hint">集合仅用于整理主题，不会改变素材的所有者、权限或公开状态。</p>
      <UiNotice v-if="error" tone="error"
        >{{ error
        }}<button v-if="conflict" type="button" class="text-button" @click="reloadRevision">
          读取最新版本，保留输入
        </button></UiNotice
      >
      <UiNotice v-if="latest" tone="warning">{{ latest }}</UiNotice>
      <label
        >集合名称<input
          v-model="name"
          required
          maxlength="200"
          placeholder="例如：春日品牌提案"
          :disabled="busy"
      /></label>
      <label
        >集合说明<textarea
          v-model="description"
          rows="4"
          maxlength="5000"
          placeholder="为这个主题留下一点背景"
          :disabled="busy"
        />
      </label>
      <div class="form-footer">
        <UiButton :disabled="busy" @click="close">取消</UiButton
        ><UiButton
          type="submit"
          variant="primary"
          :busy="busy"
          :disabled="!name.trim() || conflict"
          >{{ collection ? '保存修改' : '创建集合' }}</UiButton
        >
      </div>
    </form>
  </UiDialog>
</template>
