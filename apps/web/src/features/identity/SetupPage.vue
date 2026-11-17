<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, errorMessage } from '../../app/http-client';
import { loadBootstrap } from '../../app/session';
import BrandMark from '../../components/BrandMark.vue';
import UiNotice from '../../components/ui/UiNotice.vue';
const router = useRouter();
let active = true;
const setupToken = ref('');
const loginName = ref('');
const displayName = ref('');
const password = ref('');
const repeatedPassword = ref('');
const verified = ref(false);
const busy = ref(false);
const error = ref('');
const checking = ref(true);
const unknownResult = ref(false);
async function check(): Promise<void> {
  checking.value = true;
  verified.value = false;
  try {
    const info = await loadBootstrap();
    if (!active) return;
    verified.value = !info.initialized;
    if (info.initialized) await router.replace({ path: '/login', query: { initialized: '1' } });
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    checking.value = false;
  }
}
async function submit(): Promise<void> {
  if (!verified.value || busy.value) return;
  if (password.value !== repeatedPassword.value) {
    error.value = '两次输入的密码不一致，请检查后重试。';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await api('/setup/initialize', {
      method: 'POST',
      body: {
        setupToken: setupToken.value,
        loginName: loginName.value.trim(),
        displayName: displayName.value.trim(),
        password: password.value,
      },
    });
    setupToken.value = '';
    password.value = '';
    await check();
  } catch (cause) {
    error.value = errorMessage(cause);
    unknownResult.value = true;
    await check();
  } finally {
    busy.value = false;
    setupToken.value = '';
    password.value = '';
    repeatedPassword.value = '';
  }
}
onMounted(check);
onBeforeUnmount(() => {
  active = false;
  setupToken.value = '';
  password.value = '';
  repeatedPassword.value = '';
});
</script>
<template>
  <main id="main-content" class="auth-shell login-shell identity-entry">
    <section class="auth-card login-card">
      <BrandMark />
      <h1>开始使用拾灵</h1>
      <p class="muted">使用部署者提供的一次性凭据，建立第一个管理员账号。</p>
      <UiNotice v-if="error" tone="error">{{ error }}</UiNotice>
      <p v-if="checking" role="status">正在检查初始化状态…</p>
      <button v-else-if="!verified" class="button" :disabled="busy" @click="check">
        重新检查初始化状态
      </button>
      <form v-else class="form-stack" @submit.prevent="submit">
        <label
          >初始化凭据<input
            v-model="setupToken"
            type="password"
            required
            autocomplete="off" /></label
        ><label
          >登录账号<input
            v-model="loginName"
            required
            autocomplete="username"
            minlength="3"
            maxlength="64"
        /></label>
        <label
          >显示名称<input
            v-model="displayName"
            required
            maxlength="80"
            autocomplete="nickname" /></label
        ><label
          >密码<input
            v-model="password"
            type="password"
            required
            minlength="12"
            maxlength="256"
            autocomplete="new-password" /></label
        ><label
          >再次输入密码<input
            v-model="repeatedPassword"
            type="password"
            required
            minlength="12"
            maxlength="256"
            autocomplete="new-password"
        /></label>
        <p class="form-hint">密码使用 12–256 个字符。</p>
        <button class="button primary" :disabled="busy">
          {{ busy ? '正在建立管理员…' : '建立管理员' }}</button><button
          v-if="unknownResult"
          type="button"
          class="button"
          @click="check"
        >
          查询初始化结果
        </button>
      </form>
      <p class="form-hint">
        管理员建立后，此入口会关闭。随后登录继续配置品牌、素材类型与公开策略。
      </p>
    </section>
  </main>
</template>
