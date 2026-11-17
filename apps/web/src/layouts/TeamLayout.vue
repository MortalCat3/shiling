<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { brand, can, identity, logout, loadCapabilities } from '../app/session';
import { detailOrigin, closeDetail } from '../app/navigation';
import { errorMessage } from '../app/http-client';
import BrandMark from '../components/BrandMark.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiNotice from '../components/ui/UiNotice.vue';
import AssetDetailPage from '../features/assets/AssetDetailPage.vue';
const route = useRoute();
const router = useRouter();
const menuOpen = ref(false);
const sidebar = ref<HTMLElement>();
const menuButton = ref<HTMLButtonElement>();
const accountMenu = ref<HTMLDetailsElement>();
function closeAccountMenu(): void {
  if (accountMenu.value) accountMenu.value.open = false;
}
const mobileMedia = window.matchMedia('(max-width: 760px)');
function onViewportChange(): void {
  if (!mobileMedia.matches) menuOpen.value = false;
}
onMounted(() => {
  mobileMedia.addEventListener('change', onViewportChange);
  if (!identity.capabilities) void loadCapabilities().catch(() => undefined);
});
onBeforeUnmount(() => mobileMedia.removeEventListener('change', onViewportChange));
const search = ref('');
const searchScope = computed(() => {
  const current = background.value || route;
  return /^\/app\/(library|favorites|archive)$/.test(current.path) ||
    /^\/app\/collections\/[^/]+$/.test(current.path)
    ? current
    : null;
});
const searchLabel = computed(() =>
  searchScope.value?.path.includes('favorites')
    ? '搜索我的收藏'
    : searchScope.value?.path.includes('collections/')
      ? '搜索当前集合'
      : searchScope.value?.path.includes('archive')
        ? '搜索归档素材'
        : '搜索素材',
);
const adminOpen = ref(false);
const composing = ref(false);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const error = ref('');
watch(menuOpen, async (open) => {
  await nextTick();
  if (open) sidebar.value?.querySelector<HTMLElement>('button, a')?.focus();
  else menuButton.value?.focus();
});
function menuKey(event: KeyboardEvent): void {
  if (!menuOpen.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    menuOpen.value = false;
  }
  if (event.key === 'Tab') {
    const items = Array.from(
      sidebar.value?.querySelectorAll<HTMLElement>('a, button:not([disabled])') ?? [],
    );
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
}
const background = computed(() =>
  route.params.assetId && detailOrigin.value?.path.startsWith('/app') ? detailOrigin.value : null,
);
const nav = computed(() =>
  [
    { path: '/app/library', label: '全部素材', icon: 'grid', show: can('assets.read') },
    { path: '/app/collections', label: '集合', icon: 'folder', show: can('collections.read') },
    { path: '/app/favorites', label: '我的收藏', icon: 'heart', show: can('favorites.manageOwn') },
    { path: '/app/uploads', label: '上传任务', icon: 'upload', show: can('uploads.readOwn') },
  ].filter((item) => item.show),
);
const admin = computed(() =>
  [
    { path: '/app/admin/members', label: '成员', permission: 'system.members.manage' },
    { path: '/app/admin/roles', label: '角色', permission: 'system.roles.manage' },
    { path: '/app/admin/tags', label: '标签', permission: 'tags.manage' },
    { path: '/app/admin/settings/brand', label: '设置', permission: 'system.settings.manage' },
    { path: '/app/admin/tasks', label: '任务', permission: 'system.operations.read' },
    { path: '/app/admin/health', label: '系统状态', permission: 'system.operations.read' },
    { path: '/app/admin/audit', label: '审计', permission: 'system.audit.read' },
  ].filter((item) => can(item.permission)),
);
watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false;
    closeAccountMenu();
    search.value =
      typeof (background.value || route).query.q === 'string'
        ? String((background.value || route).query.q)
        : '';
    if (route.path.startsWith('/app/admin')) adminOpen.value = true;
  },
  { immediate: true },
);
function find(): void {
  if (composing.value) return;
  if (searchTimer) clearTimeout(searchTimer);
  const query = searchScope.value ? { ...searchScope.value.query } : {};
  if (search.value.trim()) query.q = search.value.trim();
  else delete query.q;
  void router.replace({
    path: searchScope.value?.path || '/app/library',
    query,
  });
}
function scheduleSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  if (!composing.value) searchTimer = setTimeout(find, 250);
}
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
});
async function signOut(): Promise<void> {
  try {
    await logout();
    await router.replace('/login');
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
</script>
<template>
  <div class="team-shell">
    <button v-if="menuOpen" class="nav-backdrop" aria-label="关闭导航" @click="menuOpen = false" />
    <aside
      ref="sidebar"
      class="sidebar"
      :class="{ 'is-open': menuOpen }"
      :role="menuOpen ? 'dialog' : undefined"
      :aria-modal="menuOpen || undefined"
      aria-label="团队导航"
      @keydown="menuKey"
    >
      <button
        v-if="menuOpen"
        class="icon-button mobile-menu"
        aria-label="关闭导航"
        @click="menuOpen = false"
      >
        <UiIcon name="close" />
      </button>
      <RouterLink to="/app/library" class="brand-link" :aria-label="`${brand.name || '拾灵'}素材库`"
        ><BrandMark
      /></RouterLink>
      <p class="workspace-label">团队空间</p>
      <nav>
        <RouterLink v-for="item in nav" :key="item.path" :to="item.path" class="nav-item"
          ><UiIcon :name="item.icon" />{{ item.label }}</RouterLink
        >
      </nav>
      <div v-if="admin.length" class="sidebar-section">
        <button
          class="nav-item admin-toggle"
          :aria-expanded="adminOpen"
          @click="adminOpen = !adminOpen"
        >
          <UiIcon name="settings" />管理空间<UiIcon name="chevron" :size="14" />
        </button>
        <nav v-if="adminOpen" class="admin-nav" aria-label="管理">
          <RouterLink v-for="item in admin" :key="item.path" :to="item.path">{{
            item.label
          }}</RouterLink>
        </nav>
      </div>
      <div class="sidebar-bottom">
        <RouterLink
          v-if="can('assets.archiveOwn') || can('assets.governAny')"
          to="/app/archive"
          class="nav-item"
          ><UiIcon name="archive" />归档素材</RouterLink
        >
        <p class="sidebar-note">灵感在这里，创作从这里。</p>
      </div>
    </aside>
    <div class="team-main" :inert="menuOpen">
      <header class="topbar">
        <button
          ref="menuButton"
          class="icon-button mobile-menu"
          aria-label="打开导航"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
        >
          <UiIcon name="menu" />
        </button>
        <form class="global-search" role="search" @submit.prevent="find">
          <UiIcon name="search" /><input
            v-model="search"
            :aria-label="searchLabel"
            :placeholder="`${searchLabel}，发现下一份灵感`"
            @input="scheduleSearch"
            @compositionstart="composing = true"
            @compositionend="
              composing = false;
              scheduleSearch();
            "
          /><button
            v-if="search"
            type="button"
            class="icon-button"
            aria-label="清除搜索"
            @click="
              search = '';
              find();
            "
          >
            <UiIcon name="close" :size="16" />
          </button>
          <button
            v-if="searchScope && searchScope.path !== '/app/library'"
            type="button"
            class="search-all text-button"
            @click="
              router.push({
                path: '/app/library',
                query: search.trim() ? { q: search.trim() } : {},
              })
            "
          >
            搜全库
          </button>
        </form>
        <RouterLink
          v-if="can('uploads.create') && !route.path.startsWith('/app/uploads')"
          to="/app/uploads"
          class="button primary upload-button"
          aria-label="上传素材"
          ><UiIcon name="plus" /><span>上传素材</span></RouterLink
        >
        <details ref="accountMenu" class="account-menu">
          <summary class="icon-button" aria-label="账号菜单"><UiIcon name="user" /></summary>
          <div class="account-popover">
            <strong>{{
              identity.session?.user.displayName || identity.session?.user.loginName
            }}</strong><RouterLink to="/app/account" @click="closeAccountMenu">我的账号</RouterLink
            ><RouterLink to="/public" @click="closeAccountMenu">公开素材页</RouterLink
            ><button type="button" @click="signOut">退出登录</button>
          </div>
        </details>
      </header>
      <main id="main-content">
        <UiNotice v-if="error" tone="error">{{ error }}</UiNotice><RouterView
          v-slot="{ Component }"
          :route="background || route"
          ><KeepAlive include="LibraryPage,UploadWorkspacePage" :max="8"
            ><component
              :is="Component"
              :key="
                (background || route).path.startsWith('/app/uploads')
                  ? 'uploads'
                  : (background || route).path
              " /></KeepAlive
        ></RouterView>
      </main>
    </div>
    <AssetDetailPage
      v-if="background"
      :key="String(route.params.assetId)"
      dialog
      @close="closeDetail(router)"
    />
  </div>
</template>
