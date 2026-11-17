import { api, safeResourceUrl } from '../../app/http-client';
import type { Artifact, Asset, Grant, PublicAsset } from '../../app/models';
export function artifactsOf(asset: Asset | PublicAsset): Artifact[] {
  return asset.artifacts ?? ('version' in asset ? asset.version?.artifacts : undefined) ?? [];
}
export function assetEndpoint(id: string, isPublic: boolean): string {
  return `/${isPublic ? 'public' : 'team'}/assets/${encodeURIComponent(id)}`;
}
export async function delivery(
  id: string,
  artifactId: string,
  purpose: 'preview' | 'download' | 'playback',
  isPublic: boolean,
): Promise<Grant> {
  const grant = await api<Grant>(`${assetEndpoint(id, isPublic)}/delivery-grants`, {
    method: 'POST',
    body: { artifactId, purpose },
  });
  if (!safeResourceUrl(grant.url)) throw new Error('服务返回的文件地址不可用。');
  return grant;
}
export async function downloadAsset(asset: Asset | PublicAsset, isPublic: boolean): Promise<void> {
  const original = artifactsOf(asset).find((item) => item.role === 'original');
  if (!original) throw new Error('当前没有可下载的原件描述，请打开详情后重试。');
  const grant = await delivery(asset.id, original.id, 'download', isPublic);
  const link = document.createElement('a');
  link.href = grant.url;
  link.rel = 'noopener';
  link.download = grant.downloadName ?? '';
  link.click();
}
export function fileFormat(asset: Asset | PublicAsset): string {
  const format =
    asset.format || artifactsOf(asset).find((item) => item.role === 'original')?.mediaType || '';
  return (
    (
      {
        'image/jpeg': 'JPG',
        'image/png': 'PNG',
        'image/webp': 'WEBP',
        'image/avif': 'AVIF',
        'video/mp4': 'MP4',
        'image/svg+xml': 'SVG',
      } as Record<string, string>
    )[format] ||
    (format ? (format.split('/').pop()?.toUpperCase() ?? format) : typeLabel(asset.typeId))
  );
}
export function dimensionsLabel(asset: Asset | PublicAsset): string {
  const width = asset.dimensions?.width ?? asset.width;
  const height = asset.dimensions?.height ?? asset.height;
  return width && height ? `${width} × ${height}` : '—';
}
export function typeLabel(typeId: string): string {
  return (
    ({ image: '图片', video: '视频', web_motion: '动效' } as Record<string, string>)[typeId] ??
    typeId
  );
}
export function presentAsset<T extends Asset | PublicAsset>(asset: T): T {
  const preview = artifactsOf(asset).find(
    (item) =>
      ['thumbnail', 'poster', 'preview_image'].includes(item.role) &&
      item.mediaType?.startsWith('image/'),
  );
  const original = artifactsOf(asset).find((item) => item.role === 'original');
  return {
    ...asset,
    ...(preview
      ? { cover: { artifactId: preview.id, width: preview.width, height: preview.height } }
      : {}),
    ...(original?.width && original.height
      ? { dimensions: { width: original.width, height: original.height } }
      : {}),
    ...('revision' in asset && original
      ? { bytes: original.bytes, format: original.mediaType }
      : {}),
  };
}
