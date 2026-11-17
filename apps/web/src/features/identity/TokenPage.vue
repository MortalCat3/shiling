<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, errorMessage } from '../../app/http-client';
import { identity, logout, loadSession } from '../../app/session';
import BrandMark from '../../components/BrandMark.vue';
import UiNotice from '../../components/ui/UiNotice.vue';
const props = defineProps<{ mode: 'invitation' | 'recovery' }>();
const router = useRouter();
let token = '';
let active = true;
const loginName = ref('');
const displayName = ref('');
const password = ref('');
const repeatedPassword = ref('');
const reserved = ref(false);
const roleName = ref('');
const valid = ref(false);
const busy = ref(true);
const error = ref('');
const success = ref(false);
async function inspect(): Promise<void> {
  const fragment = location.hash.slice(1);
  token = new URLSearchParams(fragment).get('token') ?? fragment;
  history.replaceState(history.state, '', location.pathname + location.search);
  if (!token) {
    error.value = '链接凭据已移除，请重新打开原邀请或恢复链接。';
    busy.value = false;
    return;
  }
  try {
    await loadSession();
    if (!active) return;
    const info = await api<{ reservedLoginName?: string | null; roleName?: string }>(
      props.mode === 'invitation' ? '/auth/invitations/inspect' : '/auth/recovery/inspect',
      { method: 'POST', body: { token } },
    );
    loginName.value = info.reservedLoginName ?? '';
    reserved.value = Boolean(info.reservedLoginName);
    roleName.value = info.roleName ?? '';
    valid.value = true;
  } catch {
    error.value = '此链接不可用、已过期或已被使用，请联系管理员。';
  } finally {
    busy.value = false;
  }
}
async function submit(): Promise<void> {
  if (busy.value || !valid.value || identity.session) return;
  if (password.value !== repeatedPassword.value) {
    error.value = '两次输入的密码不一致，请检查后重试。';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await api(
      props.mode === 'invitation' ? '/auth/invitations/accept' : '/auth/recovery/complete',
      {
        method: 'POST',
        body:
          props.mode === 'invitation'
            ? {
                token,
                loginName: loginName.value.trim(),
                displayName: displayName.value,
                password: password.value,
              }
            : { token, newPassword: password.value },
      },
    );
    token = '';
    password.value = '';
    success.value = true;
    valid.value = false;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
    password.value = '';
    repeatedPassword.value = '';
  }
}
async function signOut(): Promise<void> {
  busy.value = true;
  try {
    await logout();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
onMounted(inspect);
onBeforeUnmount(() => {
  active = false;
  token = '';
  password.value = '';
  repeatedPassword.value = '';
});
</script>
<template>
  <main id="main-content" class="auth-shell login-shell identity-entry">
    <section class="auth-card login-card">
      <BrandMark />
      <h1>{{ mode === 'invitation' ? '加入团队' : '设置新密码' }}</h1>
      <p class="muted">
        {{
          mode === 'invitation'
            ? '建立你的账号，开始收集与协作。'
            : '设置新密码后，所有旧会话将失效。'
        }}
      </p>
      <UiNotice v-if="error" tone="error">{{ error }}</UiNotice><UiNotice
        v-if="success"
        tone="success"
        >{{
          mode === 'invitation' ? '账号已激活' : '密码已更新，旧会话已失效'
        }}。请使用新密码登录。</UiNotice
      ><button v-if="success" class="button primary" @click="router.replace('/login')">
        前往登录
      </button>
      <p v-if="busy && !valid" role="status">正在验证链接…</p>
      <UiNotice v-if="identity.session" tone="warning"
        >当前已有登录身份。请先退出当前账号，再重新打开原邀请或恢复链接。<button
          class="button"
          :disabled="busy"
          @click="signOut"
        >
          退出当前账号
        </button></UiNotice
      >
      <form v-if="valid && !identity.session" class="form-stack" @submit.prevent="submit">
        <template v-if="mode === 'invitation'"
          ><p v-if="roleName" class="muted">邀请角色：{{ roleName }}</p>
          <label
            >登录账号<input
              v-model="loginName"
              :readonly="reserved"
              required
              minlength="3"
              maxlength="64"
              pattern="[A-Za-z0-9._-]{3,64}"
              autocomplete="username" /></label
          ><label
            >显示名称<input
              v-model="displayName"
              required
              maxlength="80"
              autocomplete="nickname" /></label></template
        ><label
          >新密码<input
            v-model="password"
            type="password"
            required
            minlength="12"
            maxlength="256"
            autocomplete="new-password" /></label
        ><span class="form-hint">使用 12–256 个字符。</span
        ><label
          >再次输入密码<input
            v-model="repeatedPassword"
            type="password"
            required
            minlength="12"
            maxlength="256"
            autocomplete="new-password" /></label
        ><button class="button primary" :disabled="busy">
          {{ busy ? '正在提交…' : mode === 'invitation' ? '接受邀请' : '保存新密码' }}
        </button>
      </form>
      <p v-if="!valid && !busy && !success" class="form-hint">
        如需新链接，请联系团队管理员重新签发。
      </p>
      <RouterLink v-if="!success" to="/login" class="text-link">返回登录</RouterLink>
    </section>
  </main>
</template>
