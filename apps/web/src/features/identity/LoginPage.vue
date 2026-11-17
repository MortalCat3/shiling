<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, errorMessage } from '../../app/http-client';
import { login, publicEnabled, safeReturnTo } from '../../app/session';
import UiButton from '../../components/ui/UiButton.vue';
import BrandMark from '../../components/BrandMark.vue';
import UiNotice from '../../components/ui/UiNotice.vue';
const route = useRoute();
const router = useRouter();
const loginName = ref('');
const password = ref('');
const showPassword = ref(false);
const busy = ref(false);
const error = ref('');
async function submit(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await login(loginName.value.trim(), password.value);
    password.value = '';
    await router.replace(safeReturnTo(route.query.returnTo));
  } catch (cause) {
    error.value = errorMessage(cause);
    if (cause instanceof ApiError && cause.retryAfter)
      error.value += ` 请在 ${cause.retryAfter} 秒后再试。`;
    password.value = '';
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <main id="main-content" class="auth-shell login-shell">
    <section class="auth-card login-card">
      <BrandMark />
      <h1>登录团队空间</h1>
      <p class="muted">继续收集灵感，找到创作需要的好素材。</p>
      <UiNotice v-if="route.query.initialized">管理员已建立，请登录后继续配置。</UiNotice
      ><UiNotice v-if="route.query.passwordChanged" tone="success"
        >密码已更新，请使用新密码登录。</UiNotice
      ><UiNotice v-if="route.query.expired" tone="warning"
        >登录已失效，请重新登录。未提交的操作不会自动执行。</UiNotice
      ><UiNotice v-if="route.query.unavailable" tone="warning"
        >暂时无法确认登录状态，请稍后重试。</UiNotice
      ><UiNotice v-if="error" tone="error">{{ error }}</UiNotice>
      <form class="form-stack" @submit.prevent="submit">
        <label
          >登录账号<input v-model="loginName" required autocomplete="username" autofocus /></label
        ><label
          >密码<span class="password-input"
            ><input
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              required
              autocomplete="current-password"
            /><button
              type="button"
              class="text-button"
              :aria-pressed="showPassword"
              @click="showPassword = !showPassword"
            >
              {{ showPassword ? '隐藏' : '显示' }}
            </button></span
          ></label
        ><UiButton type="submit" variant="primary" :busy="busy" class="full-width">{{
          busy ? '正在登录…' : '进入团队空间'
        }}</UiButton>
      </form>
      <details class="help-details">
        <summary>无法登录？</summary>
        <p>请联系管理员取得一次性恢复链接。恢复链接不会改变账号的停用状态或角色。</p>
      </details>
      <RouterLink v-if="publicEnabled" to="/public" class="text-link">浏览公开素材</RouterLink>
    </section>
  </main>
</template>
