import { ApiError, type ApiOptions } from '../app/http-client';
import type { Asset, Attempt, UploadItem } from '../app/models';
import { organizationApi } from './organization';
import { publicationApi, publicApi } from './publication';
import { administrationApi, administrationSession, adminSettings } from './administration';
import { assets, assetUrls, batchId, ownerId, tags, uploads } from './fixtures';
let scenario = 'normal';
let partialUsed = false;
let conflictUsed = false;
let signedIn = true;
const batches = [{ id: batchId, createdAt: '2026-11-16T08:00:00.000Z' }];
const attempts = new Map<string, UploadItem>();
export function setScenario(value: string): void {
  scenario = value;
  signedIn = !['anonymous', 'setup'].includes(value);
  partialUsed = false;
  conflictUsed = false;
}
function consumeConflict(): boolean {
  if (conflictUsed) return false;
  conflictUsed = true;
  return true;
}
const clone = <T>(value: T): T => structuredClone(value);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function bodyOf(options: ApiOptions): Record<string, unknown> {
  return options.body && typeof options.body === 'object'
    ? (options.body as Record<string, unknown>)
    : {};
}
function getAsset(id: string): Asset {
  const asset = assets.find((item) => item.id === id);
  if (!asset) throw new ApiError(404, 'NOT_FOUND', '演示素材不可用。');
  return asset;
}
function page<T>(items: T[], query: URLSearchParams) {
  const start = Number(query.get('cursor') || 0);
  const end = start + 18;
  return {
    items: items.slice(start, end),
    pageInfo: { hasMore: end < items.length, nextCursor: end < items.length ? String(end) : null },
  };
}
function filtered(query: URLSearchParams, favorites = false) {
  return assets
    .filter(
      (asset) =>
        (query.get('state') === 'archived'
          ? asset.lifecycle === 'archived'
          : asset.lifecycle === 'active') &&
        (!favorites || asset.favorite) &&
        (!query.get('q') ||
          (asset.title + asset.description)
            .toLocaleLowerCase()
            .includes(query.get('q')!.toLocaleLowerCase())) &&
        (!query.get('typeId') || asset.typeId === query.get('typeId')) &&
        (!query.get('owner') || asset.owner.id === ownerId) &&
        (!query.get('collectionId') ||
          asset.collections?.some((item) => item.id === query.get('collectionId'))) &&
        query.getAll('tagId').every((id) => asset.tags.some((tag) => tag.id === id)),
    )
    .sort((a, b) =>
      query.get('sort') === 'titleAsc'
        ? a.title.localeCompare(b.title, 'zh-CN')
        : b.createdAt.localeCompare(a.createdAt),
    );
}
function batchView(id: string) {
  const batch = batches.find((entry) => entry.id === id);
  if (!batch) throw new ApiError(404, 'NOT_FOUND', '演示批次不存在。');
  return { ...batch, items: uploads.filter((item) => item.batchId === id) };
}
export async function demoApi<T>(path: string, options: ApiOptions = {}): Promise<T> {
  await delay(120);
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const url = new URL(path, location.origin),
    route = url.pathname,
    query = url.searchParams,
    body = bodyOf(options),
    method = options.method ?? 'GET';
  const result = await handle();
  return clone(result) as T;
  async function handle(): Promise<unknown> {
    if (route === '/bootstrap')
      return {
        initialized: scenario !== 'setup',
        publicEnabled: scenario !== 'public-closed' && adminSettings.publicEnabled,
        brand: adminSettings.brand,
      };
    if (route === '/auth/logout' || route === '/auth/logout-all') {
      signedIn = false;
      return;
    }
    if (route === '/auth/login') {
      if (!body.loginName || !body.password)
        throw new ApiError(400, 'INVALID_INPUT', '请输入演示账号和密码。');
      signedIn = true;
      return administrationSession(scenario === 'forbidden');
    }
    if (route === '/auth/session') {
      if (!signedIn) throw new ApiError(401, 'UNAUTHENTICATED', '演示会话已退出。');
      return administrationSession(scenario === 'forbidden');
    }
    if (route === '/auth/reauthenticate') return administrationSession(scenario === 'forbidden');
    if (route === '/auth/change-password') {
      signedIn = false;
      return;
    }
    if (route === '/auth/invitations/inspect')
      return { reservedLoginName: null, roleName: '创作者', expiresAt: '2026-12-01T08:00:00.000Z' };
    if (route === '/auth/recovery/inspect') return { expiresAt: '2026-12-01T08:00:00.000Z' };
    if (
      ['/auth/invitations/accept', '/auth/recovery/complete', '/setup/initialize'].includes(route)
    )
      throw new ApiError(
        501,
        'DEMO_IDENTITY_READ_ONLY',
        '演示不创建账号或变更凭据，请在真实服务环境验证。',
      );
    if (route.startsWith('/team/admin/'))
      return administrationApi(route, query, options, scenario, consumeConflict);
    if (route === '/team/capabilities')
      return {
        types: [
          {
            id: 'image',
            name: '图片',
            acceptUploads: true,
            extensions: ['png', 'jpg', 'jpeg', 'webp'],
            maxBytes: '16777216',
          },
          {
            id: 'video',
            name: '视频',
            acceptUploads: true,
            extensions: ['mp4'],
            maxBytes: '67108864',
          },
          { id: 'web_motion', name: '动效', acceptUploads: false, extensions: ['html', 'zip'] },
        ],
        maxBatchItems: 100,
        maxConcurrentUploads: 2,
      };
    if (route.startsWith('/public/')) return publicApi(route, query, options, scenario);
    if (route.startsWith('/team/collections') || route.startsWith('/team/tags'))
      return organizationApi(route, query, options, scenario, consumeConflict);
    if (route === '/team/assets/facets')
      return {
        types: [
          { value: 'image', label: '图片' },
          { value: 'video', label: '视频' },
          { value: 'web_motion', label: '动效' },
        ],
        tags: tags.map((tag) => ({ value: tag.id, label: tag.name })),
      };
    if (route === '/team/assets' || route === '/team/me/favorites') {
      if (scenario === 'error' || (scenario === 'more-error' && query.has('cursor')))
        throw new ApiError(
          503,
          'DEMO_READ_FAILURE',
          '演示：暂时无法加载素材。切回正常内容后可重试。',
        );
      return page(scenario === 'empty' ? [] : filtered(query, route.includes('favorites')), query);
    }
    const favorite = route.match(/^\/team\/me\/favorites\/([^/]+)$/);
    if (favorite) {
      getAsset(favorite[1]!).favorite = method === 'PUT';
      return;
    }
    if (route === '/team/asset-batch-operations') {
      const items = body.items as { assetId: string; expectedRevision: string }[];
      const shouldFail = scenario === 'partial' && !partialUsed;
      const results = items.map((entry, index) => {
        const asset = getAsset(entry.assetId);
        if (asset.owner.id !== ownerId)
          return { assetId: asset.id, outcome: 'failed', code: 'FORBIDDEN' };
        if (shouldFail && index === items.length - 1)
          return { assetId: asset.id, outcome: 'failed', code: 'REVISION_CONFLICT' };
        if (entry.expectedRevision !== asset.revision)
          return { assetId: asset.id, outcome: 'failed', code: 'REVISION_CONFLICT' };
        if (body.action === 'archive') {
          asset.lifecycle = 'archived';
          asset.publicationState = 'withdrawn';
        } else if (body.action === 'restore') asset.lifecycle = 'active';
        else if (body.action === 'addTags')
          asset.tags = [
            ...new Map(
              [
                ...asset.tags,
                ...tags.filter((tag) => (body.tagIds as string[]).includes(tag.id)),
              ].map((tag) => [tag.id, tag]),
            ).values(),
          ];
        else if (body.action === 'removeTags')
          asset.tags = asset.tags.filter((tag) => !(body.tagIds as string[]).includes(tag.id));
        asset.revision = String(Number(asset.revision) + 1);
        return { assetId: asset.id, outcome: 'success' };
      });
      partialUsed = true;
      return { results };
    }
    const assetMatch = route.match(/^\/team\/assets\/([^/]+)(?:\/(.+))?$/);
    if (assetMatch) {
      const asset = getAsset(assetMatch[1]!),
        action = assetMatch[2];
      if (action && ['publication', 'publish', 'withdraw'].includes(action))
        return publicationApi(asset, action, options, scenario, consumeConflict);
      if (action === 'delivery-grants') {
        if (asset.lifecycle === 'archived' && body.purpose !== 'preview')
          throw new ApiError(409, 'ARCHIVED', '请先恢复素材。');
        const resource = assetUrls.get(String(body.artifactId));
        if (!resource) throw new ApiError(404, 'ARTIFACT_UNAVAILABLE', '演示文件不可用。');
        return {
          url: resource,
          downloadName:
            asset.title +
            (asset.typeId === 'video' && body.purpose !== 'preview' ? '.mp4' : '.png'),
          method: 'GET',
        };
      }
      if (action === 'motion-preview-grants')
        throw new ApiError(503, 'DISABLED', '动效执行仍关闭。');
      if (action === 'archive' || action === 'restore') {
        if (asset.owner.id !== ownerId)
          throw new ApiError(403, 'FORBIDDEN', '不能修改他人的素材。');
        asset.lifecycle = action === 'archive' ? 'archived' : 'active';
        asset.publicationState = 'withdrawn';
        asset.revision = String(Number(asset.revision) + 1);
        return asset;
      }
      if (action) throw new ApiError(501, 'DEMO_UNSUPPORTED', '此操作不在当前演示范围。');
      if (method === 'PATCH') {
        if (asset.owner.id !== ownerId)
          throw new ApiError(403, 'FORBIDDEN', '不能修改他人的素材。');
        if (scenario === 'conflict' && !conflictUsed) {
          conflictUsed = true;
          asset.title += ' · 已更新';
          asset.revision = String(Number(asset.revision) + 1);
          throw new ApiError(412, 'PRECONDITION_FAILED', '素材已被更新，当前输入已保留。');
        }
        if (options.etag !== `"${asset.revision}"`)
          throw new ApiError(412, 'PRECONDITION_FAILED', '版本已变化，请重新核对。');
        asset.title = String(body.title);
        asset.description = String(body.description);
        asset.tags = tags.filter((tag) => (body.tagIds as string[]).includes(tag.id));
        asset.revision = String(Number(asset.revision) + 1);
      }
      return {
        ...asset,
        actions:
          asset.lifecycle === 'archived'
            ? ['restore']
            : asset.owner.id === ownerId
              ? [
                  'edit',
                  'download',
                  'archive',
                  asset.publicationState === 'active' ? 'updatePublication' : 'publish',
                  ...(asset.publicationState === 'active' ? ['withdraw'] : []),
                ]
              : ['download', ...(asset.publicationState === 'active' ? ['withdraw'] : [])],
      };
    }
    if (route === '/team/upload-batches') {
      if (method === 'POST') {
        const batch = { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
        batches.unshift(batch);
        return batch;
      }
      return { items: batches.map((batch) => batchView(batch.id)) };
    }
    const batchMatch = route.match(/^\/team\/upload-batches\/([^/]+)(\/items)?$/);
    if (batchMatch) {
      if (batchMatch[2] && method === 'POST') {
        const type = String(body.declaredMediaType);
        if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(type))
          throw new ApiError(
            400,
            'UNSUPPORTED_TYPE',
            '演示仅接受 PNG、JPG、WEBP 或 MP4；动效包保持关闭。',
          );
        if (Number(body.declaredBytes) > (type === 'video/mp4' ? 67108864 : 16777216))
          throw new ApiError(413, 'TOO_LARGE', '文件超过演示限制。');
        const item: UploadItem = {
          id: crypto.randomUUID(),
          batchId: batchMatch[1]!,
          clientItemId: String(body.clientItemId),
          fileName: String(body.fileName),
          attemptId: null,
          transportState: 'pending',
          processingState: null,
          uiState: 'queued',
          assetId: null,
          revision: '1',
          metadata: body.initialMetadata as UploadItem['metadata'],
          safeError: null,
          organizationWarnings: [],
          progress: { receivedBytes: '0', totalBytes: String(body.declaredBytes) },
          actions: Object.fromEntries(['cancel', 'editMetadata'].map((key) => [key, true])),
          typeId: type === 'video/mp4' ? 'video' : 'image',
        };
        uploads.push(item);
        return item;
      }
      return batchView(batchMatch[1]!);
    }
    const uploadMatch = route.match(/^\/team\/upload-items\/([^/]+)(?:\/(.+))?$/);
    if (uploadMatch) {
      const item = uploads.find((entry) => entry.id === uploadMatch[1]);
      if (!item) throw new ApiError(404, 'NOT_FOUND', '上传项不可用。');
      if (
        uploadMatch[2] === 'attempts' ||
        (uploadMatch[2] === 'retry' && body.scope === 'transfer')
      ) {
        const id = crypto.randomUUID();
        attempts.set(id, item);
        item.attemptId = id;
        return { attemptId: id };
      }
      if (uploadMatch[2] === 'cancel') {
        item.uiState = 'canceled';
        item.processingState = 'canceled';
        item.actions = { editMetadata: true };
        return item;
      }
      if (uploadMatch[2] === 'retry') {
        item.uiState = 'processing';
        item.safeError = null;
        setTimeout(() => {
          item.uiState = 'ready';
          item.processingState = 'ready';
          item.assetId = assets[2]!.id;
          item.actions = { editMetadata: true };
        }, 1800);
        return item;
      }
      if (method === 'PATCH') {
        item.metadata = { ...item.metadata, ...body } as UploadItem['metadata'];
        item.revision = String(Number(item.revision) + 1);
        return item;
      }
      return item;
    }
    const complete = route.match(/^\/team\/upload-attempts\/([^/]+)\/complete$/);
    if (complete) {
      const item = attempts.get(complete[1]!);
      if (!item) throw new ApiError(404, 'NOT_FOUND', '传输不可用。');
      item.transportState = 'verified';
      item.processingState = 'processing';
      item.uiState = 'processing';
      setTimeout(() => {
        if (item.uiState === 'canceled') return;
        item.processingState = 'ready';
        item.uiState = 'ready';
        if (item.assetId) getAsset(item.assetId).lifecycle = 'active';
        item.actions = { editMetadata: true };
        window.dispatchEvent(new CustomEvent('shiling:assets-changed'));
      }, 1600);
      return item;
    }
    throw new ApiError(501, 'DEMO_UNSUPPORTED', '此操作不在第一批演示范围；真实空间不受影响。');
  }
}
export async function demoTransfer(
  file: File,
  attempt: Attempt,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<Record<string, never>> {
  const item = attempts.get(attempt.attemptId ?? attempt.id ?? '');
  if (!item) throw new Error('演示传输不存在。');
  for (let i = 1; i <= 5; i++) {
    await delay(160);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    onProgress(Math.round((file.size * i) / 5));
  }
  const resource = URL.createObjectURL(file),
    id = crypto.randomUUID();
  let width = 720,
    height = 540;
  if (file.type.startsWith('image/')) {
    const bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close();
  }
  const base = clone(assets[1]!);
  const original = {
    id: `${id}:original`,
    role: 'original',
    mediaType: file.type,
    bytes: String(file.size),
    width,
    height,
  };
  const thumbnail = {
    ...original,
    id: `${id}:thumbnail`,
    role: 'thumbnail',
    mediaType: 'image/png',
  };
  assetUrls.set(original.id, resource);
  assetUrls.set(
    thumbnail.id,
    file.type.startsWith('image/') ? resource : assetUrls.get(assets[3]!.artifacts[0]!.id)!,
  );
  assetUrls.set(`${id}:playback`, resource);
  assets.unshift({
    ...base,
    lifecycle: 'pending',
    id,
    title: item.metadata.title,
    description: item.metadata.description,
    owner: { id: ownerId, displayName: '演示创作者' },
    typeId: file.type === 'video/mp4' ? 'video' : 'image',
    createdAt: new Date().toISOString(),
    revision: '1',
    favorite: false,
    tags: [],
    collections: [],
    width,
    height,
    artifacts: [
      thumbnail,
      original,
      ...(file.type === 'video/mp4'
        ? [{ ...original, id: `${id}:playback`, role: 'playback_video' }]
        : []),
    ],
  });
  item.assetId = id;
  item.progress.receivedBytes = String(file.size);
  return {};
}
