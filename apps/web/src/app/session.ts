import { computed, reactive } from 'vue';
import { ApiError, api, clearApiState, setCsrfToken } from './http-client';
import type { Bootstrap, Brand, Capabilities, Session } from './models';
export const identity = reactive<{
  session: Session | null;
  bootstrap: Bootstrap | null;
  capabilities: Capabilities | null;
  loaded: boolean;
  epoch: number;
}>({ session: null, bootstrap: null, capabilities: null, loaded: false, epoch: 0 });
let pendingSession: Promise<void> | null = null;
export const brand = computed<Brand>(
  () =>
    identity.bootstrap?.brand ??
    identity.bootstrap?.product?.brand ??
    identity.bootstrap?.product ?? { name: identity.bootstrap?.name ?? '拾灵' },
);
export const publicEnabled = computed(
  () =>
    identity.bootstrap?.publicEnabled ??
    identity.bootstrap?.product?.publicEnabled ??
    identity.bootstrap?.product?.publication?.enabled ??
    false,
);
export function can(permission: string): boolean {
  return identity.session?.permissionKeys.some((key) => key === permission) ?? false;
}
export async function loadBootstrap(): Promise<Bootstrap> {
  identity.bootstrap = await api<Bootstrap>('/bootstrap');
  return identity.bootstrap;
}
export function acceptSession(session: Session): void {
  if (identity.session && identity.session.user.id !== session.user.id) identity.epoch += 1;
  identity.session = session;
  identity.loaded = true;
  setCsrfToken(session.csrfToken);
}
export function forgetSession(): void {
  const hadIdentity = identity.session !== null || identity.capabilities !== null;
  identity.session = null;
  identity.capabilities = null;
  identity.loaded = true;
  if (hadIdentity) identity.epoch += 1;
  clearApiState();
}
export async function loadSession(force = false): Promise<void> {
  if (identity.loaded && !force) return;
  if (pendingSession) return pendingSession;
  pendingSession = (async () => {
    try {
      acceptSession(await api<Session>('/auth/session', { silentAuth: true }));
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 401)
        forgetSession();
      else throw error;
    } finally {
      pendingSession = null;
    }
  })();
  return pendingSession;
}
export async function login(loginName: string, password: string): Promise<void> {
  acceptSession(
    await api<Session>('/auth/login', { method: 'POST', body: { loginName, password } }),
  );
}
export async function logout(all = false): Promise<void> {
  try {
    await api(all ? '/auth/logout-all' : '/auth/logout', { method: 'POST', body: {} });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
  }
  forgetSession();
}
export async function loadCapabilities(): Promise<Capabilities> {
  identity.capabilities = await api<Capabilities>('/team/capabilities');
  return identity.capabilities;
}
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' &&
    /^\/(app|public)(\/|\?|$)/.test(value) &&
    !value.includes('\\') &&
    !value.includes('//')
    ? value
    : '/app/library';
}
