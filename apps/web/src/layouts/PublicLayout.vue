<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { brand, identity } from '../app/session';
import { detailOrigin, closeDetail } from '../app/navigation';
import BrandMark from '../components/BrandMark.vue';
import AssetDetailPage from '../features/assets/AssetDetailPage.vue';
const route = useRoute(),
  router = useRouter();
const background = computed(() =>
  route.params.assetId && detailOrigin.value?.path === '/public' ? detailOrigin.value : null,
);
</script>
<template>
  <div class="public-shell">
    <header class="public-header">
      <RouterLink to="/public" class="brand-link" :aria-label="(brand.name || '拾灵') + '公开素材'"
        ><BrandMark
      /></RouterLink>
      <span class="public-caption">公开素材</span>
      <RouterLink v-if="identity.session" to="/app/library" class="button quiet"
        >进入团队空间</RouterLink
      >
      <RouterLink v-else to="/login" class="button quiet">成员登录</RouterLink>
    </header>
    <main id="main-content">
      <RouterView v-slot="{ Component }" :route="background || route"
        ><KeepAlive include="LibraryPage" :max="2"
          ><component :is="Component" :key="(background || route).path" /></KeepAlive
      ></RouterView>
    </main>
    <footer class="public-footer">
      <span>{{ brand.name || '拾灵' }} · 公开素材</span
      ><span>由团队成员明确公开，保留原件以供下载。</span>
    </footer>
    <AssetDetailPage
      v-if="background"
      :key="String(route.params.assetId)"
      is-public
      dialog
      @close="closeDetail(router)"
    />
  </div>
</template>
