<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { identity, loadBootstrap, loadSession, publicEnabled } from '../../app/session';
import { errorMessage } from '../../app/http-client';
import UiState from '../../components/ui/UiState.vue';
const router = useRouter();
const error = ref('');
async function enter(): Promise<void> {
  error.value = '';
  try {
    const info = await loadBootstrap();
    if (!info.initialized) {
      await router.replace('/setup');
      return;
    }
    await loadSession();
    await router.replace(
      identity.session ? '/app/library' : publicEnabled.value ? '/public' : '/login',
    );
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
onMounted(enter);
</script>
<template>
  <main id="main-content" class="auth-shell">
    <UiState
      :title="error ? '暂时无法打开拾灵' : '正在连接拾灵'"
      :description="error"
      :busy="!error"
      ><button v-if="error" class="button" @click="enter">重试</button></UiState
    >
  </main>
</template>
