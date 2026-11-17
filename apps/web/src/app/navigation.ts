import { shallowRef } from 'vue';
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router';
export const detailOrigin = shallowRef<RouteLocationNormalizedLoaded | null>(null);
let previousScroll = 0;
let triggerId = '';
export async function openDetail(router: Router, id: string, isPublic: boolean): Promise<void> {
  detailOrigin.value = router.currentRoute.value;
  previousScroll = window.scrollY;
  triggerId = `asset-${id}`;
  await router.push(`${isPublic ? '/public' : '/app'}/assets/${encodeURIComponent(id)}`);
}
export async function closeDetail(router: Router): Promise<void> {
  const origin = detailOrigin.value;
  if (origin) {
    await new Promise<void>((resolve) => {
      const stop = router.afterEach((to, _from, failure) => {
        stop();
        if (!failure && to.fullPath === origin.fullPath) {
          detailOrigin.value = null;
          requestAnimationFrame(() => {
            window.scrollTo({ top: previousScroll });
            (
              document.getElementById(triggerId) ?? document.getElementById('results-heading')
            )?.focus();
          });
        }
        resolve();
      });
      router.back();
    });
  } else
    await router.push(
      router.currentRoute.value.path.startsWith('/public') ? '/public' : '/app/library',
    );
}
