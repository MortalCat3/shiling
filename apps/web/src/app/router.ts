import { isDemo } from '../demo/mode';
import { createRouter, createWebHistory } from 'vue-router';
import { identity, loadSession, safeReturnTo } from './session';
import { detailOrigin } from './navigation';
export const router = createRouter({
  history: createWebHistory(isDemo ? '/demo/' : import.meta.env.BASE_URL),
  routes: [
    { path: '/', component: () => import('../features/identity/EntryPage.vue') },
    { path: '/setup', component: () => import('../features/identity/SetupPage.vue') },
    { path: '/login', component: () => import('../features/identity/LoginPage.vue') },
    {
      path: '/accept-invitation',
      component: () => import('../features/identity/TokenPage.vue'),
      props: { mode: 'invitation' },
    },
    {
      path: '/recover-account',
      component: () => import('../features/identity/TokenPage.vue'),
      props: { mode: 'recovery' },
    },
    {
      path: '/app',
      component: () => import('../layouts/TeamLayout.vue'),
      meta: { authenticated: true },
      children: [
        { path: '', redirect: '/app/library' },
        { path: 'library', component: () => import('../features/assets/LibraryPage.vue') },
        {
          path: 'assets/:assetId',
          component: () => import('../features/assets/AssetDetailPage.vue'),
        },
        {
          path: 'uploads/:batchId?',
          component: () => import('../features/ingestion/UploadWorkspacePage.vue'),
        },
        {
          path: 'favorites',
          component: () => import('../features/assets/LibraryPage.vue'),
          props: { scope: 'favorites' },
        },
        {
          path: 'archive',
          component: () => import('../features/assets/LibraryPage.vue'),
          props: { scope: 'archive' },
        },
        { path: 'collections', component: () => import('../features/library/CollectionsPage.vue') },
        {
          path: 'collections/:collectionId',
          component: () => import('../features/assets/LibraryPage.vue'),
          props: { scope: 'collection' },
        },
        { path: 'account', component: () => import('../features/identity/AccountPage.vue') },
        {
          path: 'admin/members',
          component: () => import('../features/administration/MembersPage.vue'),
        },
        {
          path: 'admin/roles',
          component: () => import('../features/administration/RolesPage.vue'),
        },
        { path: 'admin/tags', component: () => import('../features/library/TagsPage.vue') },
        {
          path: 'admin/settings/:section?',
          component: () => import('../features/administration/SettingsPage.vue'),
        },
        {
          path: 'admin/:section(health|tasks|audit)',
          component: () => import('../features/administration/OperationsPage.vue'),
        },
      ],
    },
    {
      path: '/public',
      component: () => import('../layouts/PublicLayout.vue'),
      children: [
        {
          path: '',
          component: () => import('../features/assets/LibraryPage.vue'),
          props: { scope: 'public' },
        },
        {
          path: 'assets/:assetId',
          component: () => import('../features/assets/AssetDetailPage.vue'),
          props: { isPublic: true },
        },
      ],
    },
    { path: '/:pathMatch(.*)*', component: () => import('../features/identity/NotFoundPage.vue') },
  ],
  scrollBehavior(to, from, saved) {
    if (detailOrigin.value && (to.params.assetId || to.fullPath === detailOrigin.value.fullPath))
      return false;
    return saved ?? { top: 0 };
  },
});
router.beforeEach(async (to) => {
  if (to.meta.authenticated) {
    try {
      await loadSession();
    } catch {
      return { path: '/login', query: { returnTo: safeReturnTo(to.fullPath), unavailable: '1' } };
    }
    if (!identity.session)
      return { path: '/login', query: { returnTo: safeReturnTo(to.fullPath) } };
  }
  return true;
});
router.afterEach((to) => {
  if (!to.params.assetId && detailOrigin.value && to.fullPath !== detailOrigin.value.fullPath)
    detailOrigin.value = null;
});
