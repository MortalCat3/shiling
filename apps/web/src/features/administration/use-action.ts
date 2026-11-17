import { ref } from 'vue';
import { ApiError, errorMessage } from '../../app/http-client';
export function useAction() {
  const busy = ref(false);
  const error = ref('');
  const message = ref('');
  const freshAuth = ref(false);
  const conflict = ref(false);
  async function run(operation: () => Promise<void | false>, success = ''): Promise<boolean> {
    if (busy.value) return false;
    busy.value = true;
    error.value = '';
    conflict.value = false;
    message.value = '';
    try {
      if ((await operation()) === false) return false;
      message.value = success;
      return true;
    } catch (cause) {
      conflict.value = cause instanceof ApiError && [409, 412, 428].includes(cause.status);
      if (cause instanceof ApiError && cause.code === 'FRESH_AUTH_REQUIRED') freshAuth.value = true;
      else error.value = errorMessage(cause);
      return false;
    } finally {
      busy.value = false;
    }
  }
  function reauthenticated(): void {
    freshAuth.value = false;
    message.value = '身份已确认，请核对当前信息后再次提交。';
  }
  return { busy, error, message, freshAuth, conflict, run, reauthenticated };
}
