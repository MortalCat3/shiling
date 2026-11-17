import { ApiError, type ApiOptions } from '../app/http-client';
import type { Asset, PublicAsset } from '../app/models';
import { assets, assetUrls, ownerId } from './fixtures';
interface Entry {
  revision: string;
  assetRevision: string;
  versionId: string;
  snapshot: PublicAsset;
}
const snapshots = new Map<string, Entry>();
function project(
  asset: Asset,
  title: string,
  description: string,
  publicTags: string[],
  revision: string,
): PublicAsset {
  return {
    id: asset.id,
    typeId: asset.typeId,
    title,
    description,
    publicTags: [...publicTags],
    publicationRevision: revision,
    publishedAt: new Date().toISOString(),
    format: asset.typeId === 'video' ? 'mp4' : 'png',
    width: asset.width || null,
    height: asset.height || null,
    duration: asset.duration || null,
    artifacts: structuredClone(asset.artifacts),
  };
}
for (const asset of assets.slice(0, 12)) {
  asset.publicationState = 'active';
  snapshots.set(asset.id, {
    revision: '1',
    assetRevision: asset.revision,
    versionId: asset.currentVersionId!,
    snapshot: project(
      asset,
      asset.title,
      '关于形状、色彩与留白的原创视觉练习。供创作参考与下载。',
      asset.tags.map((t) => t.name),
      '1',
    ),
  });
}
export function publicationApi(
  asset: Asset,
  action: string,
  options: ApiOptions,
  scenario: string,
  consumeConflict: () => boolean,
): unknown {
  const previous = snapshots.get(asset.id),
    body = (options.body || {}) as Record<string, unknown>,
    own = asset.owner.id === ownerId;
  if (action === 'publication')
    return {
      state: asset.publicationState,
      revision: previous?.revision || '0',
      snapshot:
        asset.publicationState === 'active' && previous
          ? {
              title: previous.snapshot.title,
              description: previous.snapshot.description,
              publicTags: previous.snapshot.publicTags,
              versionId: previous.versionId,
              publishedAt: previous.snapshot.publishedAt,
            }
          : null,
      sourceChanged: !!previous && previous.assetRevision !== asset.revision,
    };
  if (action === 'publish') {
    if (!own) throw new ApiError(403, 'FORBIDDEN', '只有所有者可以公开或更新快照。');
    if (scenario === 'public-closed' || asset.lifecycle !== 'active')
      throw new ApiError(409, 'INVALID_STATE', '公开入口或素材当前不可用。');
    if (scenario === 'conflict' && consumeConflict())
      asset.revision = String(Number(asset.revision) + 1);
    if (
      body.expectedAssetRevision !== asset.revision ||
      body.expectedPublicationRevision !== (previous?.revision || '0')
    )
      throw new ApiError(412, 'PRECONDITION_FAILED', '素材或公开版本已变化，请重新核对。');
    const metadata = body.publicMetadata as {
        title: string;
        description: string;
        tagIds: string[];
      },
      revision = String(Number(previous?.revision || '0') + 1);
    if (metadata.tagIds.some((id) => !asset.tags.some((t) => t.id === id)))
      throw new ApiError(400, 'INVALID_TAG', '标签已不再关联。');
    snapshots.set(asset.id, {
      revision,
      assetRevision: asset.revision,
      versionId: asset.currentVersionId!,
      snapshot: project(
        asset,
        metadata.title,
        metadata.description,
        asset.tags.filter((t) => metadata.tagIds.includes(t.id)).map((t) => t.name),
        revision,
      ),
    });
    asset.publicationState = 'active';
    return { state: 'active', revision };
  }
  if (body.expectedRevision !== previous?.revision)
    throw new ApiError(412, 'PRECONDITION_FAILED', '公开版本已变化。');
  asset.publicationState = 'withdrawn';
  if (previous) previous.revision = String(Number(previous.revision) + 1);
  return { state: 'withdrawn', revision: previous?.revision || '0' };
}
export function publicApi(
  route: string,
  query: URLSearchParams,
  options: ApiOptions,
  scenario: string,
): unknown {
  const unavailable = (): never => {
    throw new ApiError(404, 'NOT_FOUND', '内容不可用。');
  };
  if (scenario === 'public-closed') unavailable();
  if (scenario === 'error' || (scenario === 'more-error' && query.has('cursor')))
    throw new ApiError(503, 'DEMO_READ_FAILURE', '暂时无法读取公开素材，请重试。');
  const visible = assets
    .filter((a) => a.lifecycle === 'active' && a.publicationState === 'active')
    .map((a) => snapshots.get(a.id)!.snapshot);
  if (route === '/public/assets/facets')
    return {
      types: [...new Set(visible.map((a) => a.typeId))].map((value) => ({
        value,
        label: value === 'video' ? '视频' : '图片',
      })),
      tags: [...new Set(visible.flatMap((a) => a.publicTags))].map((value) => ({
        value,
        label: value,
      })),
    };
  if (route === '/public/assets') {
    const all = (scenario === 'empty' ? [] : visible)
      .filter(
        (a) =>
          (!query.get('q') || (a.title + a.description).includes(query.get('q')!)) &&
          (!query.get('typeId') || a.typeId === query.get('typeId')) &&
          query.getAll('tag').every((tag) => a.publicTags.includes(tag)),
      )
      .sort((a, b) =>
        query.get('sort') === 'titleAsc'
          ? a.title.localeCompare(b.title, 'zh-CN')
          : b.publishedAt.localeCompare(a.publishedAt),
      );
    const start = Number(query.get('cursor') || 0),
      end = start + 18;
    return {
      items: all.slice(start, end),
      pageInfo: { hasMore: end < all.length, nextCursor: end < all.length ? String(end) : null },
    };
  }
  const [, id, action] = route.match(/^\/public\/assets\/([^/]+)(?:\/(.+))?$/) || [];
  const item = visible.find((a) => a.id === id);
  if (!item) return unavailable();
  if (action === 'delivery-grants') {
    const body = options.body as { artifactId: string; purpose: string },
      url = assetUrls.get(body.artifactId);
    if (!item.artifacts.some((a) => a.id === body.artifactId) || !url) return unavailable();
    return {
      url,
      method: 'GET',
      downloadName: item.title + '.' + (body.purpose === 'preview' ? 'png' : item.format),
    };
  }
  if (action) return unavailable();
  return item;
}
