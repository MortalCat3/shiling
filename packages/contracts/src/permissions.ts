import { Type } from '@sinclair/typebox';

export const PERMISSION_KEYS = [
  'assets.read',
  'assets.download',
  'assets.editOwn',
  'assets.archiveOwn',
  'assets.governAny',
  'uploads.create',
  'uploads.readOwn',
  'uploads.cancelOwn',
  'uploads.retryOwn',
  'uploads.governAny',
  'publications.publishOwn',
  'publications.withdrawOwn',
  'publications.withdrawAny',
  'tags.read',
  'tags.manage',
  'collections.read',
  'collections.create',
  'collections.manageOwn',
  'collections.governAny',
  'favorites.manageOwn',
  'system.members.manage',
  'system.roles.manage',
  'system.settings.manage',
  'system.operations.read',
  'system.jobs.manage',
  'system.audit.read',
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export const PermissionKeySchema = Type.Union(PERMISSION_KEYS.map((key) => Type.Literal(key)));
export const DEFAULT_MEMBER_PERMISSIONS: readonly PermissionKey[] = PERMISSION_KEYS.filter(
  (key) =>
    !key.startsWith('system.') &&
    !key.endsWith('governAny') &&
    key !== 'publications.withdrawAny' &&
    key !== 'tags.manage',
);
export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value);
}
export const PERMISSION_DEPENDENCIES: Partial<Record<PermissionKey, readonly PermissionKey[]>> = {
  'assets.download': ['assets.read'],
  'assets.editOwn': ['assets.read', 'tags.read'],
  'assets.archiveOwn': ['assets.read'],
  'assets.governAny': ['assets.read', 'tags.read'],
  'uploads.create': ['uploads.readOwn'],
  'uploads.cancelOwn': ['uploads.readOwn'],
  'uploads.retryOwn': ['uploads.readOwn'],
  'collections.create': ['collections.read', 'assets.read'],
  'collections.manageOwn': ['collections.read', 'assets.read'],
  'collections.governAny': ['collections.read', 'assets.read'],
  'favorites.manageOwn': ['assets.read'],
  'publications.publishOwn': ['assets.read'],
  'publications.withdrawOwn': ['assets.read'],
  'publications.withdrawAny': ['assets.read'],
  'tags.manage': ['tags.read'],
  'uploads.governAny': ['uploads.readOwn'],
};
