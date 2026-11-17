<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api, ApiError, errorMessage, operationKey, revisionTag } from '../../app/http-client';
import type { Tag } from '../../app/models';
import { readChoices } from '../../app/list-data';
import { can } from '../../app/session';
import UiNotice from '../../components/ui/UiNotice.vue';
import UiState from '../../components/ui/UiState.vue';
import UiButton from '../../components/ui/UiButton.vue';
import UiDialog from '../../components/ui/UiDialog.vue';
import UiSegmented from '../../components/ui/UiSegmented.vue';
import UiIcon from '../../components/ui/UiIcon.vue';
const tags = ref<Tag[]>([]),
  editing = ref<Tag | null>(null),
  formOpen = ref(false);
const name = ref(''),
  description = ref(''),
  query = ref(''),
  scope = ref('active');
const busy = ref(false),
  saving = ref(false),
  error = ref(''),
  formError = ref(''),
  message = ref(''),
  conflict = ref(false);
let key = operationKey();
watch([name, description], () => {
  key = operationKey();
});
const visible = computed(() =>
  tags.value.filter(
    (tag) =>
      (scope.value === 'all' || tag.state === scope.value) &&
      (tag.name + (tag.description || '')).includes(query.value.trim()),
  ),
);
async function load(): Promise<void> {
  if (!can('tags.manage')) return;
  busy.value = true;
  error.value = '';
  try {
    tags.value = await readChoices<Tag>('/team/tags?state=all');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
function edit(tag: Tag | null): void {
  editing.value = tag;
  name.value = tag?.name || '';
  description.value = tag?.description || '';
  formError.value = '';
  conflict.value = false;
  key = operationKey();
  formOpen.value = true;
}
function close(): void {
  if (
    !saving.value &&
    ((name.value === (editing.value?.name || '') &&
      description.value === (editing.value?.description || '')) ||
      window.confirm('标签信息尚未保存，放弃本次修改？'))
  )
    formOpen.value = false;
}
async function reloadTag(): Promise<void> {
  saving.value = true;
  try {
    const all = await readChoices<Tag>('/team/tags?state=all');
    const latest = all.find((tag) => tag.id === editing.value?.id);
    if (!latest) throw new Error('标签已不可用。');
    editing.value = latest;
    conflict.value = false;
    formError.value = '已读取最新版本，当前输入保留，请核对后保存。';
  } catch (cause) {
    formError.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function save(): Promise<void> {
  if (!name.value.trim() || conflict.value || saving.value) return;
  const target = editing.value,
    path = '/team/tags' + (target ? '/' + target.id : '');
  saving.value = true;
  formError.value = '';
  try {
    await api(path, {
      method: target ? 'PATCH' : 'POST',
      body: { name: name.value.trim(), description: description.value },
      ...(target ? { etag: revisionTag(path, target.revision) } : { idempotencyKey: key }),
    });
    formOpen.value = false;
    message.value = '标签已保存，既有公开快照保持不变。';
    await load();
    window.dispatchEvent(new CustomEvent('shiling:assets-changed'));
  } catch (cause) {
    formError.value = errorMessage(cause);
    conflict.value = cause instanceof ApiError && cause.status === 412;
  } finally {
    saving.value = false;
  }
}
async function change(tag: Tag): Promise<void> {
  const disabled = tag.state === 'disabled';
  if (
    !window.confirm(
      disabled
        ? '启用标签“' + tag.name + '”？'
        : '停用标签“' + tag.name + '”？已有素材关联保留，不能再新增关联。',
    )
  )
    return;
  saving.value = true;
  error.value = '';
  try {
    await api('/team/tags/' + tag.id + (disabled ? '/enable' : '/disable'), {
      method: 'POST',
      body: { expectedRevision: tag.revision },
      idempotencyKey: operationKey(),
    });
    await load();
    window.dispatchEvent(new CustomEvent('shiling:assets-changed'));
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section class="page-content tags-page">
    <header class="page-heading">
      <div>
        <h1>标签字典</h1>
        <p>统一团队用语，让每一份素材更容易被找到。</p>
      </div>
      <UiButton v-if="can('tags.manage')" variant="primary" @click="edit(null)"
        ><UiIcon name="plus" />新建标签</UiButton
      >
    </header>
    <UiState
      v-if="!can('tags.manage')"
      title="没有标签治理权限"
      description="普通成员可在素材编辑时选择已有标签。"
    />
    <template v-else>
      <div class="organization-toolbar">
        <UiSegmented
          label="标签状态"
          :value="scope"
          :options="[
            { value: 'active', label: '可选用' },
            { value: 'disabled', label: '已停用' },
            { value: 'all', label: '全部' },
          ]"
          @change="scope = $event"
        /><label class="local-search"
          ><UiIcon name="search" :size="17" /><input
            v-model="query"
            aria-label="搜索标签"
            placeholder="搜索标签名称或说明" /></label
        ><span class="result-count">{{ visible.length }} 个标签</span>
      </div>
      <p class="scope-note">普通成员选择已有标签。停用保留关联；改名不会改写公开快照。</p>
      <UiNotice v-if="error" tone="error"
        >{{ error }}<button class="text-button" @click="load">重新读取</button></UiNotice
      ><UiNotice v-if="message" tone="success">{{ message }}</UiNotice>
      <UiState
        v-if="!visible.length && !error"
        :busy="busy"
        :title="busy ? '正在加载标签' : '没有匹配的标签'"
        description="可调整状态或搜索条件。"
      />
      <div class="tag-records">
        <article v-for="tag in visible" :key="tag.id" class="tag-record">
          <UiIcon name="tag" :size="20" />
          <div>
            <h2>{{ tag.name }}</h2>
            <p>{{ tag.description || '暂无说明' }}</p>
          </div>
          <span class="badge">{{ tag.state === 'disabled' ? '已停用' : '可选用' }}</span>
          <div class="actions">
            <UiButton
              variant="quiet"
              :disabled="saving"
              :aria-label="'编辑标签' + tag.name"
              @click="edit(tag)"
              >编辑</UiButton
            ><UiButton
              variant="quiet"
              :disabled="saving"
              :aria-label="(tag.state === 'disabled' ? '启用标签' : '停用标签') + tag.name"
              @click="change(tag)"
              >{{ tag.state === 'disabled' ? '启用' : '停用' }}</UiButton
            >
          </div>
        </article>
      </div>
      <UiDialog
        v-if="formOpen"
        :title="editing ? '编辑标签' : '新建标签'"
        class="organization-dialog"
        :dismissible="!saving"
        @close="close"
      >
        <form class="form-stack" @submit.prevent="save">
          <UiNotice v-if="formError" tone="warning"
            >{{ formError
            }}<button v-if="conflict" type="button" class="text-button" @click="reloadTag">
              读取最新版本，保留输入
            </button></UiNotice
          ><label>标签名称<input v-model="name" required maxlength="40" :disabled="saving" /></label
          ><label
            >标签说明<textarea v-model="description" rows="4" maxlength="5000" :disabled="saving" />
          </label>
          <div class="form-footer">
            <UiButton :disabled="saving" @click="close">取消</UiButton
            ><UiButton
              type="submit"
              variant="primary"
              :busy="saving"
              :disabled="conflict || !name.trim()"
              >保存标签</UiButton
            >
          </div>
        </form>
      </UiDialog>
    </template>
  </section>
</template>
