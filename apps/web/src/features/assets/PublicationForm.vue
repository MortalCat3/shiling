<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api, ApiError, errorMessage, operationKey } from '../../app/http-client';
import { allows, type Asset, type Publication } from '../../app/models';
import { publicEnabled } from '../../app/session';
import { changedPublicFields } from './publication-draft';
import UiNotice from '../../components/ui/UiNotice.vue';
import UiButton from '../../components/ui/UiButton.vue';
const props = defineProps<{ asset: Asset }>();
const emit = defineEmits<{ saved: []; cancel: [] }>();
const source = ref(props.asset),
  title = ref(props.asset.title),
  description = ref(''),
  tagIds = ref<string[]>([]);
const publication = ref<Publication | null>(null);
const loading = ref(true),
  saving = ref(false),
  error = ref(''),
  needsReview = ref(false),
  confirmed = ref(false);
let key = operationKey();
const draft = computed(() => ({
  title: title.value,
  description: description.value,
  publicTags: source.value.tags
    .filter((tag) => tagIds.value.includes(tag.id))
    .map((tag) => tag.name),
}));
const changes = computed(() => changedPublicFields(publication.value?.snapshot, draft.value));
const invalidTags = computed(() =>
  tagIds.value.some((id) => !source.value.tags.some((tag) => tag.id === id)),
);
const permitted = computed(
  () =>
    publicEnabled.value &&
    (allows(source.value.actions, 'publish') || allows(source.value.actions, 'updatePublication')),
);
async function load(initial = false): Promise<void> {
  loading.value = true;
  error.value = '';
  confirmed.value = false;
  try {
    const [state, latest] = await Promise.all([
      api<Publication>('/team/assets/' + props.asset.id + '/publication'),
      api<Asset>('/team/assets/' + props.asset.id),
    ]);
    source.value = latest;
    publication.value = state;
    key = operationKey();
    if (initial) {
      title.value = state.snapshot?.title ?? latest.title;
      description.value = state.snapshot?.description ?? '';
      tagIds.value = latest.tags
        .filter((tag) => state.snapshot?.publicTags?.includes(tag.name))
        .map((tag) => tag.id);
    }
    needsReview.value = false;
  } catch (cause) {
    error.value = errorMessage(cause);
    needsReview.value = true;
  } finally {
    loading.value = false;
  }
}
async function submit(): Promise<void> {
  if (
    !publication.value ||
    !confirmed.value ||
    !permitted.value ||
    needsReview.value ||
    invalidTags.value ||
    saving.value
  )
    return;
  saving.value = true;
  error.value = '';
  try {
    const versionId = source.value.currentVersionId ?? source.value.version?.id;
    if (!versionId) throw new Error('素材版本信息缺失，请重新读取。');
    await api('/team/assets/' + props.asset.id + '/publish', {
      method: 'POST',
      body: {
        expectedAssetRevision: source.value.revision,
        expectedPublicationRevision: publication.value.revision,
        versionId,
        publicMetadata: {
          title: title.value.trim(),
          description: description.value,
          tagIds: tagIds.value,
        },
      },
      idempotencyKey: key,
    });
    emit('saved');
  } catch (cause) {
    error.value = errorMessage(cause);
    needsReview.value = cause instanceof ApiError && [409, 412].includes(cause.status);
    confirmed.value = false;
  } finally {
    saving.value = false;
  }
}
watch(
  [title, description, tagIds],
  () => {
    confirmed.value = false;
    key = operationKey();
  },
  { deep: true },
);
onMounted(() => load(true));
</script>
<template>
  <form class="form-stack publication-form" @submit.prevent="submit">
    <div>
      <h2>{{ publication?.state === 'active' ? '更新公开快照' : '公开这份素材' }}</h2>
      <p class="form-hint">公开内容单独保存。团队信息后续修改，不会自动同步到这里。</p>
    </div>
    <p v-if="loading" role="status">正在核对素材与公开状态…</p>
    <UiNotice v-if="error" tone="error"
      >{{ error
      }}<button
        type="button"
        class="text-button"
        :disabled="loading || saving"
        @click="load(false)"
      >
        重新核对，保留草稿
      </button></UiNotice
    >
    <UiNotice v-if="!loading && !permitted" tone="warning"
      >当前不可公开。仅素材所有者在公开入口开启时可执行此操作。</UiNotice
    >
    <details v-if="publication?.snapshot" class="snapshot-before" open>
      <summary>当前公开快照</summary>
      <strong>{{ publication.snapshot.title }}</strong>
      <p>{{ publication.snapshot.description || '无公开说明' }}</p>
      <div class="chip-group">
        <span v-for="tag in publication.snapshot.publicTags" :key="tag" class="chip">{{
          tag
        }}</span>
      </div>
      <p v-if="publication.sourceChanged" class="form-hint">
        团队信息已有变更，公开页面仍使用此快照。
      </p>
    </details>
    <fieldset :disabled="loading || saving" class="publication-fields">
      <legend>{{ publication?.state === 'active' ? '本次公开内容' : '填写公开内容' }}</legend>
      <label>公开标题<input v-model="title" required maxlength="200" /></label>
      <label>公开说明<textarea v-model="description" rows="4" maxlength="5000" /></label>
      <button
        type="button"
        class="text-button"
        @click="
          title = source.title;
          description = source.description || '';
        "
      >
        使用当前团队标题与说明
      </button>
      <fieldset>
        <legend>公开标签</legend>
        <p class="form-hint">仅选择素材关联的标签；公开时保存标签名称。</p>
        <div class="publication-tags">
          <label v-for="tag in source.tags" :key="tag.id" class="checkbox-row"
            ><input v-model="tagIds" type="checkbox" :value="tag.id" />{{ tag.name }}</label
          >
        </div>
        <p v-if="!source.tags.length" class="form-hint">这份素材还没有关联标签。</p>
        <UiNotice v-if="invalidTags" tone="warning"
          >部分所选标签已不再关联，核对后重新选择。<button
            type="button"
            class="text-button"
            @click="tagIds = tagIds.filter((id) => source.tags.some((tag) => tag.id === id))"
          >
            移除失效选择
          </button></UiNotice
        >
      </fieldset>
    </fieldset>
    <section class="snapshot-preview" aria-label="游客将看到的内容">
      <h3>游客将看到</h3>
      <strong>{{ title.trim() || '请填写公开标题' }}</strong>
      <p>{{ description || '无公开说明' }}</p>
      <div class="chip-group">
        <span v-for="tag in draft.publicTags" :key="tag" class="chip">{{ tag }}</span>
      </div>
      <small v-if="publication?.state === 'active'"
        >本次变化：{{ changes.length ? changes.join('、') : '公开文字与标签未变' }}</small
      >
    </section>
    <UiNotice
      >游客可浏览、预览并下载此版本原件。公开页面不展示成员身份；请同时核对原件中的文字、画面及内嵌信息。</UiNotice
    >
    <label class="checkbox-row publication-confirm"
      ><input
        v-model="confirmed"
        type="checkbox"
        required
        :disabled="loading || saving || !permitted || needsReview || invalidTags"
      />我已核对公开内容与原件，确认向游客开放。</label
    >
    <div class="form-footer publication-footer">
      <UiButton :disabled="saving" @click="emit('cancel')">取消</UiButton
      ><UiButton
        type="submit"
        variant="primary"
        :busy="saving"
        :disabled="
          loading || !publication || !confirmed || !permitted || needsReview || invalidTags
        "
        >{{ publication?.state === 'active' ? '更新公开快照' : '确认公开' }}</UiButton
      >
    </div>
  </form>
</template>
