import { onBeforeUnmount, ref } from 'vue';
export function useConfirmation() {
  const confirmation = ref<{ title: string; description: string; label: string } | null>(null);
  let resolve: ((answer: boolean) => void) | undefined;
  function settle(answer: boolean): void {
    confirmation.value = null;
    resolve?.(answer);
    resolve = undefined;
  }
  function ask(title: string, description: string, label = '确认'): Promise<boolean> {
    settle(false);
    confirmation.value = { title, description, label };
    return new Promise<boolean>((done) => {
      resolve = done;
    });
  }
  onBeforeUnmount(() => settle(false));
  return { confirmation, ask, settle };
}
