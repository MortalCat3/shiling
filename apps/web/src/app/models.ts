// 浏览器 DTO 边界。共享合同为事实，附加字段仅承载页面呈现。
import type {
  TeamAsset as ContractAsset,
  PublicAsset as ContractPublicAsset,
  UploadItem as ContractUploadItem,
  Session as ContractSession,
} from '@shiling/contracts';
export type Actions = string[] | Record<string, boolean>;
export interface Revisioned {
  id: string;
  revision: string;
  actions?: Actions;
}
export interface Page<T> {
  items: T[];
  pageInfo?: { nextCursor?: string | null; hasMore: boolean };
}
export interface Brand {
  name?: string;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  primaryColor?: string;
  description?: string;
}
export interface Bootstrap {
  initialized: boolean;
  setupAllowed?: boolean;
  name?: string;
  publicEnabled?: boolean;
  brand?: Brand;
  product?: Brand & { brand?: Brand; publicEnabled?: boolean; publication?: { enabled?: boolean } };
}
export type Session = ContractSession & { user: ContractSession['user'] & { loginName?: string } };
export interface TypeCapability {
  id: string;
  name?: string;
  acceptUploads?: boolean;
  executePreview?: boolean;
  extensions?: string[];
  maxBytes?: number | string;
}
export interface Capabilities {
  permissionKeys?: string[];
  actions?: Actions;
  types?: TypeCapability[];
  maxBatchItems?: number;
  maxConcurrentUploads?: number;
}
export interface Tag extends Revisioned {
  name: string;
  description?: string;
  state?: string;
  status?: string;
}
export interface Collection extends Revisioned {
  name: string;
  description?: string;
  state?: string;
  lifecycle?: string;
  ownerId?: string;
  visibleItemCount?: number;
}
export interface Artifact {
  id: string;
  role: string;
  mediaType?: string;
  format?: string;
  bytes?: string | number;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  url?: string;
}
export interface Cover {
  artifactId?: string;
  url?: string;
  width?: number | null;
  height?: number | null;
}
export interface Asset extends ContractAsset {
  ownerId?: string;
  collections?: Collection[];
  cover?: Cover | null;
  format?: string;
  bytes?: string | number;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  dimensions?: { width: number; height: number };
  version?: {
    id: string;
    format?: string;
    bytes?: number | string;
    width?: number;
    height?: number;
    duration?: number;
    artifacts?: Artifact[];
  };
}
/** 独立公开投影：禁止通过团队 Asset 扩展或携带成员字段。 */
export interface PublicAsset extends ContractPublicAsset {
  dimensions?: { width: number; height: number };
  cover?: Cover | null;
  actions?: Actions;
}
export interface Facet {
  label: string;
  value: string;
  count?: number;
}
export interface Facets {
  tags?: Facet[];
  types?: Facet[];
}
export interface SafeError {
  code: string;
  message: string;
  retryable: boolean;
}
export interface UploadItem extends ContractUploadItem {
  title?: string;
  declaredBytes?: number | string;
  declaredMediaType?: string;
  typeId?: string;
  expectedSha256?: string;
}
export interface UploadBatch {
  id: string;
  createdAt?: string;
  items?: UploadItem[];
  stats?: Record<string, number>;
}
export interface Transfer {
  mode?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  partSize?: number;
  expiresAt?: string;
}
export interface Attempt {
  id?: string;
  attemptId?: string;
  transport?: string;
  transfer?: Transfer;
  transferDescriptor?: Transfer;
}
export interface Grant {
  url: string;
  method?: string;
  expiresAt?: string;
  downloadName?: string;
  contentType?: string;
}
export interface Publication {
  sourceChanged?: boolean;
  state: 'none' | 'active' | 'withdrawn';
  revision: string;
  publicUrl?: string;
  snapshot?: {
    title?: string | null;
    description?: string | null;
    publicTags?: string[] | null;
    versionId?: string;
    publishedAt?: string;
  } | null;
  actions?: Actions;
}
export interface Member extends Revisioned {
  loginName?: string;
  displayName?: string;
  state?: string;
  status?: string;
  roleId?: string;
  role?: { id: string; name: string };
}
export interface Role extends Revisioned {
  archivedAt?: string | null;
  name: string;
  permissionKeys: string[];
  system?: boolean;
  kind?: string;
  state?: string;
}
export interface Permission {
  key: string;
  dependencies?: string[];
  name?: string;
  description?: string;
  delegable?: boolean;
}
export interface Settings {
  revision: string;
  name?: string;
  executePreview?: boolean;
  brand?: Brand;
  publicEnabled?: boolean;
  publication?: { enabled: boolean };
  types?: TypeCapability[];
  publicationImpact?: { eligibleActiveCount: number; evaluatedAt: string };
  logoBrandingAssetId?: string | null;
  faviconBrandingAssetId?: string | null;
  [key: string]: unknown;
}
export interface Invitation extends Revisioned {
  userId?: string;
  state: string;
  token?: string;
  url?: string;
  expiresAt?: string | null;
  reservedLoginName?: string | null;
  role?: { id?: string; name: string };
}
export interface Job {
  id: string;
  actions?: Actions;
  kind?: string;
  state: string;
  safeError?: SafeError | null;
  attemptCount?: number;
  required?: boolean;
  assetId?: string;
  uploadItemId?: string;
  createdAt?: string;
  updatedAt?: string;
  attempts?: {
    id: string;
    attempt: number;
    state: string;
    startedAt: string;
    finishedAt?: string | null;
    errorCode?: string | null;
  }[];
}
export function allows(actions: Actions | undefined, action: string): boolean {
  return Array.isArray(actions) ? actions.includes(action) : actions?.[action] === true;
}
export function itemsOf<T>(value: Page<T> | T[]): T[] {
  return Array.isArray(value) ? value : value.items;
}
