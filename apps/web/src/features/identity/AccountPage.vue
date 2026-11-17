<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { formatDate } from '@shiling/ui';
import { api } from '../../app/http-client';
import { forgetSession, identity, logout } from '../../app/session';
import { useAction } from '../administration/use-action';
import { useConfirmation } from '../administration/use-confirmation';
import UiNotice from '../../components/ui/UiNotice.vue';
import UiButton from '../../components/ui/UiButton.vue';
import UiConfirm from '../../components/ui/UiConfirm.vue';
import ReauthenticateForm from './ReauthenticateForm.vue';
const router = useRouter();
const currentPassword = ref('');
const newPassword = ref('');
const repeatedPassword = ref('');
const { busy, error, message, freshAuth, run, reauthenticated } = useAction();
const { confirmation, ask, settle } = useConfirmation();
async function changePassword(): Promise<void> {
  if (newPassword.value !== repeatedPassword.value) {
    error.value = '两次输入的新密码不一致，请检查后重试。';
    return;
  }
  await run(async () => {
    try {
      await api('/auth/change-password', {
        method: 'PATCH',
        body: { currentPassword: currentPassword.value, newPassword: newPassword.value },
      });
      forgetSession();
      await router.replace({ path: '/login', query: { passwordChanged: '1' } });
    } finally {
      currentPassword.value = '';
      newPassword.value = '';
      repeatedPassword.value = '';
    }
  });
}
async function logoutAll(): Promise<void> {
  if (
    !(await ask(
      '退出全部会话',
      '此账号在所有设备上的登录都将失效，包括当前设备。再次使用时需要重新登录。',
      '退出全部会话',
    ))
  )
    return;
  await run(async () => {
    await logout(true);
    await router.replace('/login');
  });
}
</script>
<template>
  <section class="page-content admin-page">
    <header class="page-heading">
      <div>
        <h1>我的账号</h1>
        <p>管理你的账号安全与登录状态。</p>
      </div>
    </header>
    <UiNotice v-if="error" tone="error">{{ error }}</UiNotice><UiNotice
      v-if="message"
      tone="success"
      >{{ message }}</UiNotice
    >
    <section class="admin-section">
      <div class="section-intro">
        <h2>个人信息</h2>
        <p>团队内部的身份与角色。</p>
      </div>
      <dl class="admin-facts">
        <div>
          <dt>显示名称</dt>
          <dd>{{ identity.session?.user.displayName || '成员' }}</dd>
        </div>
        <div>
          <dt>当前角色</dt>
          <dd>{{ identity.session?.role.name }}</dd>
        </div>
        <div>
          <dt>账号状态</dt>
          <dd><span class="status-label">正常使用</span></dd>
        </div>
      </dl>
    </section>
    <section class="admin-section">
      <div class="section-intro">
        <h2>修改密码</h2>
        <p>更新后所有旧会话失效，<br class="desktop-only" />需要使用新密码重新登录。</p>
      </div>
      <form class="form-stack admin-form" @submit.prevent="changePassword">
        <label
          >当前密码<input
            v-model="currentPassword"
            type="password"
            required
            maxlength="256"
            autocomplete="current-password" /></label
        ><label
          >新密码<input
            v-model="newPassword"
            type="password"
            required
            minlength="12"
            maxlength="256"
            autocomplete="new-password"
          /><span class="form-hint">使用 12–256 个字符。</span></label
        ><label
          >再次输入新密码<input
            v-model="repeatedPassword"
            type="password"
            required
            minlength="12"
            maxlength="256"
            autocomplete="new-password"
        /></label>
        <div><UiButton type="submit" variant="primary" :busy="busy">保存新密码</UiButton></div>
      </form>
    </section>
    <section class="admin-section">
      <div class="section-intro">
        <h2>登录会话</h2>
        <p>在共用设备登录后，可在此结束所有会话。</p>
      </div>
      <div class="form-stack admin-form">
        <p>当前会话有效至 {{ formatDate(identity.session?.expiresAt) }}</p>
        <div><UiButton :busy="busy" @click="logoutAll">退出全部会话</UiButton></div>
      </div>
    </section>
    <ReauthenticateForm v-if="freshAuth" @confirmed="reauthenticated" @cancel="freshAuth = false" />
    <UiConfirm
      v-if="confirmation"
      v-bind="confirmation"
      @confirm="settle(true)"
      @close="settle(false)"
    />
  </section>
</template>
