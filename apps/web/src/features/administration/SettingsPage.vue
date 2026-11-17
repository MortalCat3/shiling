<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from 'vue-router';
import { formatBytes, formatDate } from '@shiling/ui';
import { api, revisionTag, safeResourceUrl } from '../../app/http-client';
import type { Settings, TypeCapability } from '../../app/models';
import { can, loadBootstrap } from '../../app/session';
import { useAction } from './use-action';
import { useConfirmation } from './use-confirmation';
import UiConfirm from '../../components/ui/UiConfirm.vue';
import UiButton from '../../components/ui/UiButton.vue';
import UiNotice from '../../components/ui/UiNotice.vue';
import UiState from '../../components/ui/UiState.vue';
import ReauthenticateForm from '../identity/ReauthenticateForm.vue';
const route = useRoute();
const section = computed(() => String(route.params.section ?? 'brand'));
const settings = ref<Settings | null>(null);
const name = ref('');
const description = ref('');
const primaryColor = ref('#244bc5');
const enabled = ref(false);
const types = ref<TypeCapability[]>([]);
type BrandingPurpose = 'logo' | 'favicon';
const logoId = ref<string | null | undefined>();
const faviconId = ref<string | null | undefined>();
const logoName = ref('');
const faviconName = ref('');
const logoPreviewUrl = ref('');
const faviconPreviewUrl = ref('');
const { busy, error, message, freshAuth, conflict, run, reauthenticated } = useAction();
const { confirmation, ask, settle } = useConfirmation();
const baseline = ref('');
const draft = computed(() =>
  JSON.stringify(
    section.value === 'brand'
      ? [name.value, description.value, primaryColor.value, logoId.value, faviconId.value]
      : section.value === 'types'
        ? types.value
        : enabled.value,
  ),
);
const dirty = computed(() => !!baseline.value && draft.value !== baseline.value);
function beforeUnload(event: BeforeUnloadEvent): void {
  if (dirty.value) event.preventDefault();
}
onBeforeRouteLeave(
  async () =>
    !dirty.value ||
    (await ask('放弃未保存的设置？', '此页的修改尚未保存。离开后需要重新填写。', '放弃修改')),
);
onBeforeRouteUpdate(
  async (to, from) =>
    to.path === from.path ||
    !dirty.value ||
    (await ask('放弃未保存的设置？', '此页的修改尚未保存。切换分类后需要重新填写。', '放弃修改')),
);
function revokePreview(preview: typeof logoPreviewUrl): void {
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = '';
}
function resetBrandCandidates(): void {
  revokePreview(logoPreviewUrl);
  revokePreview(faviconPreviewUrl);
  logoId.value = undefined;
  faviconId.value = undefined;
  logoName.value = '';
  faviconName.value = '';
}
const displayedLogoUrl = computed(() =>
  logoId.value === null
    ? null
    : logoPreviewUrl.value || safeResourceUrl(settings.value?.brand?.logoUrl),
);
const displayedFaviconUrl = computed(() =>
  faviconId.value === null
    ? null
    : faviconPreviewUrl.value || safeResourceUrl(settings.value?.brand?.faviconUrl),
);
const canClearLogo = computed(
  () =>
    logoId.value !== null &&
    Boolean(logoId.value || settings.value?.logoBrandingAssetId || settings.value?.brand?.logoUrl),
);
const canClearFavicon = computed(
  () =>
    faviconId.value !== null &&
    Boolean(
      faviconId.value ||
      settings.value?.faviconBrandingAssetId ||
      settings.value?.brand?.faviconUrl,
    ),
);
function fill(value: Settings): void {
  settings.value = value;
  name.value = value.name ?? value.brand?.name ?? '';
  description.value = value.brand?.description ?? '';
  primaryColor.value = value.brand?.primaryColor ?? '#244bc5';
  enabled.value = value.publicEnabled ?? value.publication?.enabled ?? false;
  types.value = (value.types ?? []).map((type) => ({ ...type }));
}
async function load(): Promise<void> {
  if (!can('system.settings.manage')) return;
  if (
    dirty.value &&
    !(await ask('重新读取设置？', '未保存的修改将被替换为服务端当前设置。', '重新读取'))
  )
    return;
  await run(async () => {
    fill(await api<Settings>('/team/admin/settings'));
    resetBrandCandidates();
    baseline.value = draft.value;
  });
}
async function uploadBrand(event: Event, purpose: BrandingPurpose): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await run(
    async () => {
      const body = new FormData();
      body.append('purpose', purpose);
      body.append('file', file);
      const candidate = await api<{ brandingAssetId: string }>('/team/admin/branding-assets', {
        method: 'POST',
        body,
      });
      const preview = purpose === 'logo' ? logoPreviewUrl : faviconPreviewUrl;
      revokePreview(preview);
      preview.value = URL.createObjectURL(file);
      if (purpose === 'logo') {
        logoId.value = candidate.brandingAssetId;
        logoName.value = file.name;
      } else {
        faviconId.value = candidate.brandingAssetId;
        faviconName.value = file.name;
      }
    },
    `${purpose === 'logo' ? 'Logo' : '站点图标'}候选已核验；保存品牌设置后才会生效。`,
  );
  (event.target as HTMLInputElement).value = '';
}
function clearBrand(purpose: BrandingPurpose): void {
  if (purpose === 'logo') {
    revokePreview(logoPreviewUrl);
    logoId.value = null;
    logoName.value = '';
  } else {
    revokePreview(faviconPreviewUrl);
    faviconId.value = null;
    faviconName.value = '';
  }
}
async function save(): Promise<void> {
  const current = settings.value;
  if (!current || !can('system.settings.manage')) return;
  const path = '/team/admin/settings';
  await run(async () => {
    let body: Record<string, unknown>;
    if (section.value === 'publication') {
      const latest = await api<Settings>(path);
      settings.value = latest;
      const currentEnabled = latest.publicEnabled ?? latest.publication?.enabled ?? false;
      if (enabled.value && !currentEnabled) {
        if (!latest.publicationImpact) throw new Error('无法读取公开影响摘要，暂不能重新开启。');
        if (
          !(await ask(
            '重新开启公开入口',
            `重新开启后，当前符合条件的 ${latest.publicationImpact.eligibleActiveCount} 份公开快照将恢复可见。已撤回、已归档和从未公开的素材不会被公开。确认开启？`,
          ))
        )
          return false;
      }
      if (
        !enabled.value &&
        currentEnabled &&
        !(await ask('关闭公开入口', '关闭后不再签发公开访问授权，已有公开快照将保留。', '关闭入口'))
      )
        return false;
      body = { publicEnabled: enabled.value };
      const result = await api<Settings>(path, {
        method: 'PATCH',
        body,
        etag: revisionTag(path, latest.revision),
      });
      fill(result);
      baseline.value = draft.value;
      await loadBootstrap();
      return;
    }
    if (section.value === 'types')
      body = {
        types: types.value.map((type) => ({
          id: type.id,
          acceptUploads: type.acceptUploads,
          ...(type.maxBytes !== undefined ? { maxBytes: Number(type.maxBytes) } : {}),
        })),
      };
    else
      body = {
        ...(current.brand
          ? {
              brand: {
                name: name.value.trim(),
                description: description.value,
                primaryColor: primaryColor.value,
              },
            }
          : { name: name.value.trim() }),
        ...(logoId.value !== undefined ? { logoBrandingAssetId: logoId.value } : {}),
        ...(faviconId.value !== undefined ? { faviconBrandingAssetId: faviconId.value } : {}),
      };
    const result = await api<Settings>(path, {
      method: 'PATCH',
      body,
      etag: revisionTag(path, current.revision),
    });
    fill(result);
    resetBrandCandidates();
    baseline.value = draft.value;
    await loadBootstrap();
  }, '设置已保存。');
}
async function refreshVersion(): Promise<void> {
  await run(async () => {
    settings.value = await api<Settings>('/team/admin/settings');
  }, '已读取最新版本，保留你的草稿。保存将覆盖本页对应的配置，请核对后再次提交。');
}
onMounted(() => {
  void load();
  window.addEventListener('beforeunload', beforeUnload);
});
onBeforeUnmount(() => {
  resetBrandCandidates();
  window.removeEventListener('beforeunload', beforeUnload);
});
</script>
<template>
  <section class="page-content admin-page">
    <header class="page-heading">
      <div>
        <h1>产品设置</h1>
        <p>让素材空间符合团队的日常工作方式。</p>
      </div>
      <button
        v-if="can('system.settings.manage')"
        class="text-button"
        :disabled="busy"
        @click="load"
      >
        重新读取
      </button>
    </header>
    <nav class="admin-tabs settings-navigation" aria-label="设置分类">
      <RouterLink to="/app/admin/settings/brand">品牌</RouterLink
      ><RouterLink to="/app/admin/settings/types">类型与限额</RouterLink
      ><RouterLink to="/app/admin/settings/publication">公开策略</RouterLink>
    </nav>
    <UiState
      v-if="!can('system.settings.manage')"
      title="没有设置管理权限"
      description="请联系管理员调整你的访问权限。"
    />
    <template v-else>
      <UiNotice v-if="error" tone="error"
        >{{ error
        }}<button
          v-if="conflict"
          type="button"
          class="text-button"
          :disabled="busy"
          @click="refreshVersion"
        >
          读取最新版本，保留草稿
        </button></UiNotice
      ><UiNotice v-if="message" tone="success">{{ message }}</UiNotice>
      <UiState v-if="!settings && busy" title="正在读取设置" busy /><UiState
        v-else-if="!settings"
        title="设置尚未加载"
        description="请重新读取，现有设置不会被改变。"
      />
      <form v-if="settings" class="admin-settings-form" @submit.prevent="save">
        <template v-if="section === 'brand'">
          <section class="admin-section">
            <div class="section-intro">
              <h2>品牌信息</h2>
              <p>团队空间与公开页面使用同一份品牌配置。</p>
            </div>
            <div class="form-stack admin-form">
              <label>平台名称<input v-model="name" required maxlength="80" /></label
              ><label
                >简介<textarea
                  v-model="description"
                  rows="3"
                  maxlength="500"
                  :disabled="!settings.brand"
                /><span class="form-hint">{{ description.length }} / 500</span></label
              ><label
                >品牌主色<span class="color-field"
                  ><input
                    v-model="primaryColor"
                    type="color"
                    :disabled="!settings.brand"
                    aria-label="选择品牌主色" /><input
                    v-model="primaryColor"
                    pattern="#[0-9a-fA-F]{6}"
                    required
                    :disabled="!settings.brand"
                    aria-label="品牌颜色值" /></span
              ></label>
              <div class="brand-preview" :style="{ '--preview-brand': primaryColor }">
                <img
                  v-if="displayedLogoUrl"
                  :src="displayedLogoUrl"
                  alt=""
                  class="brand-preview-logo"
                /><strong>{{ name || '平台名称' }}</strong
                ><span>{{ description || '团队的素材空间' }}</span
                ><span class="brand-preview-button">上传素材</span>
              </div>
              <p class="form-hint">品牌预览；保存后应用。</p>
            </div>
          </section>
          <section class="admin-section">
            <div class="section-intro">
              <h2>标志与图标</h2>
              <p>支持 PNG、JPEG 和 WebP。文件经核验后，保存才会应用。</p>
            </div>
            <div class="form-stack admin-form">
              <div class="branding-row">
                <div class="branding-sample">
                  <img v-if="displayedLogoUrl" :src="displayedLogoUrl" alt="Logo 预览" /><span
                    v-else
                    >Logo</span
                  >
                </div>
                <div class="form-stack">
                  <label
                    >Logo 图片<input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      :disabled="busy"
                      @change="uploadBrand($event, 'logo')"
                  /></label>
                  <p class="form-hint">
                    {{
                      logoName
                        ? '待应用：' + logoName
                        : logoId === null
                          ? '保存后移除 Logo'
                          : '用于团队导航和公开页面'
                    }}
                  </p>
                  <button
                    v-if="canClearLogo"
                    type="button"
                    class="text-button"
                    :disabled="busy"
                    @click="clearBrand('logo')"
                  >
                    移除 Logo
                  </button>
                </div>
              </div>
              <div class="branding-row">
                <div class="branding-sample favicon">
                  <img
                    v-if="displayedFaviconUrl"
                    :src="displayedFaviconUrl"
                    alt="站点图标预览"
                  /><span v-else>图标</span>
                </div>
                <div class="form-stack">
                  <label
                    >站点图标<input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      :disabled="busy"
                      @change="uploadBrand($event, 'favicon')"
                  /></label>
                  <p class="form-hint">
                    {{
                      faviconName
                        ? '待应用：' + faviconName
                        : faviconId === null
                          ? '保存后移除站点图标'
                          : '用于浏览器标签页'
                    }}
                  </p>
                  <button
                    v-if="canClearFavicon"
                    type="button"
                    class="text-button"
                    :disabled="busy"
                    @click="clearBrand('favicon')"
                  >
                    移除站点图标
                  </button>
                </div>
              </div>
            </div>
          </section>
        </template>
        <template v-else-if="section === 'types'"
          ><section v-for="type in types" :key="type.id" class="admin-section">
            <div class="section-intro">
              <h2>{{ type.name || type.id }}</h2>
              <p>{{ type.extensions?.map((e) => e.toUpperCase()).join(' / ') }}</p>
            </div>
            <div class="form-stack admin-form">
              <label class="checkbox-row"
                ><input
                  v-model="type.acceptUploads"
                  type="checkbox"
                  :disabled="type.id === 'web_motion'"
                /><span>接收新上传<small>关闭后保留已有素材。</small></span></label
              ><label v-if="type.maxBytes !== undefined"
                >单个文件上限（字节）<input
                  v-model.number="type.maxBytes"
                  type="number"
                  min="1"
                  max="9007199254740991"
                  step="1"
                  required
                /><span class="form-hint">约 {{ formatBytes(type.maxBytes) }}</span></label
              >
              <p v-if="type.id === 'web_motion'" class="form-hint">
                动效上传与执行保持关闭，待服务器隔离和真实预览通过验收后开放。
              </p>
            </div>
          </section>
          <UiState
            v-if="!types.length"
            title="暂无可配置类型"
            description="请检查服务端类型注册和处理器状态。"
        /></template>
        <template v-else
          ><section class="admin-section">
            <div class="section-intro">
              <h2>游客公开入口</h2>
              <p>让游客浏览和下载所有者显式公开的素材。</p>
            </div>
            <div class="form-stack admin-form">
              <label class="checkbox-row"
                ><input v-model="enabled" type="checkbox" /><span
                  >启用公开入口<small>素材入库不会自动公开。</small></span
                ></label
              >
              <dl class="admin-facts">
                <div>
                  <dt>当前已保存</dt>
                  <dd>{{ settings.publicEnabled ? '开启' : '关闭' }}</dd>
                </div>
                <div v-if="settings.publicationImpact">
                  <dt>符合恢复条件</dt>
                  <dd>{{ settings.publicationImpact.eligibleActiveCount }} 份快照</dd>
                </div>
                <div v-if="settings.publicationImpact">
                  <dt>摘要读取时间</dt>
                  <dd>{{ formatDate(settings.publicationImpact.evaluatedAt) }}</dd>
                </div>
              </dl>
              <UiNotice v-if="!settings.publicationImpact" tone="warning"
                >影响摘要不可用，不能重新开启入口。</UiNotice
              >
              <p class="form-hint">
                重新开启会恢复仍有效且启用的既有快照。已撤回、已归档或从未公开的内容不会恢复，旧访问授权也不会重新生效。
              </p>
              <p class="form-hint">已签发的对象存储地址可能在其有限有效期内继续有效。</p>
            </div>
          </section></template
        >
        <footer class="admin-savebar">
          <span role="status">{{ dirty ? '有未保存的修改' : '已与当前设置同步' }}</span>
          <div class="actions">
            <UiButton :disabled="busy || !dirty" @click="load">放弃修改</UiButton
            ><UiButton
              type="submit"
              variant="primary"
              :busy="busy"
              :disabled="
                !dirty ||
                (section === 'publication' && enabled && !settings.publicationImpact) ||
                (section === 'types' && !types.length)
              "
              >保存设置</UiButton
            >
          </div>
        </footer>
      </form>
    </template>
    <ReauthenticateForm
      v-if="freshAuth"
      @confirmed="reauthenticated"
      @cancel="freshAuth = false"
    /><UiConfirm
      v-if="confirmation"
      v-bind="confirmation"
      @confirm="settle(true)"
      @close="settle(false)"
    />
  </section>
</template>
