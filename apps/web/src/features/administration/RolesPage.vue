<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, operationKey, revisionTag } from '../../app/http-client';
import { itemsOf } from '../../app/models';
import type { Page, Permission, Role } from '../../app/models';
import { can, loadSession } from '../../app/session';
import { useAction } from './use-action';
import { useConfirmation } from './use-confirmation';
import { togglePermission } from './permission-selection';
import UiNotice from '../../components/ui/UiNotice.vue';
import UiState from '../../components/ui/UiState.vue';
import UiDialog from '../../components/ui/UiDialog.vue';
import UiConfirm from '../../components/ui/UiConfirm.vue';
import UiButton from '../../components/ui/UiButton.vue';
import ReauthenticateForm from '../identity/ReauthenticateForm.vue';
const roles = ref<Role[]>([]),
  permissions = ref<Permission[]>([]);
const editing = ref<Role | null>(null),
  editor = ref(false),
  name = ref(''),
  selected = ref<string[]>([]);
const archived = ref(false);
let createKey = operationKey();
const { busy, error, message, freshAuth, conflict, run, reauthenticated } = useAction();
const { confirmation, ask, settle } = useConfirmation();
const visibleRoles = computed(() =>
  roles.value.filter((r) => Boolean(r.archivedAt) === archived.value),
);
const fixed = computed(() => editing.value?.kind === 'system' || !!editing.value?.archivedAt);
const groups = computed(() =>
  [
    ['assets', '素材'],
    ['uploads', '上传'],
    ['collections', '集合'],
    ['tags', '标签'],
    ['publications', '公开'],
    ['favorites', '收藏'],
  ].map(([key, title]) => ({
    key,
    title,
    items: permissions.value.filter((p) => p.key.startsWith(key + '.') && p.delegable !== false),
  })),
);
async function data(): Promise<void> {
  if (!can('system.roles.manage')) return;
  const [r, p] = await Promise.all([
    api<Page<Role> | Role[]>('/team/admin/roles'),
    api<Page<Permission> | Permission[]>('/team/admin/permission-catalog'),
  ]);
  roles.value = itemsOf(r);
  permissions.value = itemsOf(p);
}
async function load(): Promise<void> {
  await run(data);
}
function edit(role: Role | null): void {
  createKey = operationKey();
  editing.value = role;
  name.value = role?.name ?? '';
  selected.value = [...(role?.permissionKeys ?? [])];
  error.value = '';
  editor.value = true;
}
async function save(): Promise<void> {
  if (fixed.value || !can('system.roles.manage') || !permissions.value.length) return;
  const role = editing.value;
  const path = role ? '/team/admin/roles/' + role.id : '/team/admin/roles';
  await run(async () => {
    await api(path, {
      method: role ? 'PATCH' : 'POST',
      body: { name: name.value.trim(), permissionKeys: selected.value },
      ...(role ? { etag: revisionTag(path, role.revision) } : { idempotencyKey: createKey }),
    });
    editor.value = false;
    await loadSession(true);
    await data();
  }, '角色已保存，后续请求使用当前权限。');
}
async function refreshDraft(): Promise<void> {
  await run(async () => {
    await data();
    const latest = roles.value.find((r) => r.id === editing.value?.id);
    if (!latest) {
      editor.value = false;
      throw new Error('角色已不可用，请重新选择。');
    }
    editing.value = latest;
  }, '已读取最新版本，保留你的草稿。请核对能力后再次保存。');
}
async function retire(role: Role): Promise<void> {
  if (
    !(await ask(
      '归档「' + role.name + '」',
      '请先为使用此角色的成员和有效邀请调整角色。归档后不能再用于邀请或成员分配。',
      '归档角色',
    ))
  )
    return;
  await run(async () => {
    await api('/team/admin/roles/' + role.id + '/retire', {
      method: 'POST',
      body: { expectedRevision: role.revision },
      idempotencyKey: operationKey(),
    });
    await data();
  }, '角色已归档。');
}
onMounted(load);
</script>
<template>
  <section class="page-content admin-page">
    <header class="page-heading">
      <div>
        <h1>角色与能力</h1>
        <p>为不同协作方式配置能力，每位成员使用一个角色。</p>
      </div>
      <UiButton
        v-if="can('system.roles.manage')"
        variant="primary"
        :disabled="busy"
        @click="edit(null)"
        >新建角色</UiButton
      >
    </header>
    <UiState
      v-if="!can('system.roles.manage')"
      title="没有角色管理权限"
      description="请联系管理员调整你的访问权限。"
    />
    <template v-else>
      <UiNotice v-if="error && !editor" tone="error"
        >{{ error
        }}<button class="text-button" :disabled="busy" @click="load">重新读取</button></UiNotice
      ><UiNotice v-if="message" tone="success">{{ message }}</UiNotice>
      <div class="admin-toolbar">
        <div class="admin-tabs" role="group" aria-label="角色状态">
          <button
            :aria-pressed="!archived"
            :class="{ active: !archived }"
            @click="archived = false"
          >
            使用中</button
          ><button :aria-pressed="archived" :class="{ active: archived }" @click="archived = true">
            已归档
          </button>
        </div>
        <button class="text-button" :disabled="busy" @click="load">刷新</button>
      </div>
      <div class="admin-records">
        <article v-for="role in visibleRoles" :key="role.id" class="admin-record">
          <div class="record-primary">
            <strong>{{ role.name }}</strong>
            <p>
              {{ role.permissionKeys.length }} 项能力<span v-if="role.kind === 'system'">
                · 固定系统角色</span
              >
            </p>
          </div>
          <div class="actions">
            <UiButton variant="quiet" @click="edit(role)">{{
              role.kind === 'system' || role.archivedAt ? '查看能力' : '编辑能力'
            }}</UiButton><UiButton
              v-if="role.kind !== 'system' && !role.archivedAt"
              variant="quiet"
              :disabled="busy"
              @click="retire(role)"
              >归档</UiButton
            >
          </div>
        </article>
      </div>
      <UiState
        v-if="!visibleRoles.length"
        :title="busy ? '正在读取角色' : archived ? '暂无归档角色' : '暂无角色'"
        :busy="busy"
        description="角色用于明确协作边界，可按工作需要配置。"
      />
      <p class="admin-footnote">系统能力不可委派。任何角色都不能代替他人公开素材。</p>
      <UiDialog
        v-if="editor"
        class="admin-detail-dialog"
        :title="fixed ? '查看角色能力' : editing ? '编辑角色能力' : '新建角色'"
        wide
        :dismissible="!busy"
        @close="editor = false"
      >
        <form class="form-stack role-editor" @submit.prevent="save">
          <UiNotice v-if="message" tone="success">{{ message }}</UiNotice>
          <UiNotice v-if="error" tone="error"
            >{{ error
            }}<button
              v-if="conflict && editing"
              type="button"
              class="text-button"
              :disabled="busy"
              @click="refreshDraft"
            >
              读取最新版本，保留草稿
            </button></UiNotice
          >
          <label>角色名称<input v-model="name" required maxlength="80" :readonly="fixed" /></label>
          <p class="form-hint">
            已选
            {{ selected.length }} 项能力。勾选时补齐必要能力，取消基础能力时也会取消依赖它的能力。
          </p>
          <fieldset v-for="group in groups" :key="group.key" class="permission-group">
            <legend>{{ group.title }}</legend>
            <div class="permission-options">
              <label v-for="permission in group.items" :key="permission.key" class="checkbox-row"
                ><input
                  type="checkbox"
                  :checked="selected.includes(permission.key)"
                  :disabled="fixed || busy"
                  @change="
                    selected = togglePermission(
                      selected,
                      permission.key,
                      ($event.target as HTMLInputElement).checked,
                      permissions,
                    )
                  "
                /><span
                  >{{ permission.name || permission.key
                  }}<small v-if="permission.key.endsWith('Any') || permission.key === 'tags.manage'"
                    >影响整个团队</small
                  ></span
                ></label
              >
            </div>
          </fieldset>
          <p v-if="editing?.kind === 'system'" class="form-hint">
            系统管理员还拥有全部系统管理能力；固定角色不能编辑或归档。
          </p>
          <div class="dialog-actions">
            <UiButton :disabled="busy" @click="editor = false">{{
              fixed ? '关闭' : '取消'
            }}</UiButton><UiButton
              v-if="!fixed"
              type="submit"
              variant="primary"
              :busy="busy"
              :disabled="!permissions.length || !name.trim()"
              >保存角色</UiButton
            >
          </div>
        </form>
      </UiDialog>
    </template>
    <ReauthenticateForm v-if="freshAuth" @confirmed="reauthenticated" @cancel="freshAuth = false" />
    <UiConfirm
      v-if="confirmation"
      v-bind="confirmation"
      @confirm="settle(true)"
      @close="settle(false)"
    />
  </section>
</template>
