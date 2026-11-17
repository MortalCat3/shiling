<script setup lang="ts">
import { ref } from 'vue';
import { api, errorMessage } from '../../app/http-client';
import { loadSession } from '../../app/session';
import UiNotice from '../../components/ui/UiNotice.vue';
import UiDialog from '../../components/ui/UiDialog.vue';
const emit = defineEmits<{ confirmed: []; cancel: [] }>();
const password = ref('');
const error = ref('');
const busy = ref(false);
async function submit(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await api('/auth/reauthenticate', { method: 'POST', body: { password: password.value } });
    password.value = '';
    await loadSession(true);
    emit('confirmed');
  } catch (cause) {
    error.value = errorMessage(cause);
    password.value = '';
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <UiDialog title="再次确认身份" :dismissible="!busy" @close="emit('cancel')">
    <form class="form-stack" @submit.prevent="submit">
      <p class="muted">此操作需要确认密码。确认后请核对当前信息，再提交原操作。</p>
      <UiNotice v-if="error" tone="error">{{ error }}</UiNotice><label
        >当前密码<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          maxlength="256"
      /></label>
      <div class="actions">
        <button class="button primary" :disabled="busy">确认身份</button
        ><button class="button" type="button" :disabled="busy" @click="emit('cancel')">取消</button>
      </div>
    </form>
  </UiDialog>
</template>
