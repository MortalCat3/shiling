<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { safeResourceUrl } from './app/http-client';
import { brand, forgetSession, identity, loadBootstrap } from './app/session';
import { detailOrigin } from './app/navigation';
import { isDemo } from './demo/mode';
const DemoBar =
  import.meta.env.DEV && isDemo ? defineAsyncComponent(() => import('./demo/DemoBar.vue')) : null;
const route = useRoute();
const router = useRouter();
const faviconSelector = 'link[data-shiling-favicon]';
function applyFavicon(value: string | null | undefined): void {
  const href = safeResourceUrl(value);
  let link = document.head.querySelector<HTMLLinkElement>(faviconSelector);
  if (!href) {
    link?.remove();
    return;
  }
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.dataset.shilingFavicon = '';
    document.head.append(link);
  }
  link.href = href;
}
function expire(): void {
  // Explicit sign-out already cleared identity; late requests must not replace its navigation.
  if (!identity.session) return;
  const returnTo = route.fullPath;
  forgetSession();
  detailOrigin.value = null;
  void router.replace({ path: '/login', query: { returnTo, expired: '1' } });
}
onMounted(() => {
  window.addEventListener('shiling:session-expired', expire);
  void loadBootstrap().catch(() => undefined);
});
onBeforeUnmount(() => window.removeEventListener('shiling:session-expired', expire));
watch(
  brand,
  (value) => {
    document.title = value.name || '拾灵';
    if (value.primaryColor && /^#[\da-f]{6}$/i.test(value.primaryColor))
      document.documentElement.style.setProperty('--brand', value.primaryColor);
    applyFavicon(value.faviconUrl);
  },
  { immediate: true },
);
</script>
<template>
  <component :is="DemoBar" v-if="isDemo" /><a class="skip-link" href="#main-content">跳到主要内容</a
  ><RouterView
    v-if="!route.meta.authenticated || identity.session"
    :key="
      identity.epoch +
      (['/accept-invitation', '/recover-account'].includes(route.path) ? route.path : '')
    "
  />
</template>
