import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../errors.js';
import type { ArtifactRow } from './repository.js';

export type DeliveryPurpose = 'preview' | 'download' | 'playback';
export interface DeliveryClaims {
  scope: 'team' | 'public';
  assetId: string;
  versionId: string;
  artifactId: string;
  purpose: DeliveryPurpose;
  expiresAt: number;
  runtimeEpoch: string;
  publicationRevision?: string;
  accessEpoch?: string;
  sessionId?: string;
  authzVersion?: string;
}
export function createDeliverySigner(secret: string) {
  if (secret.length < 32) throw new Error('Delivery secret must contain at least 32 characters.');
  function signature(payload: string): Buffer {
    return createHmac('sha256', secret).update(`shiling-delivery-v1:${payload}`).digest();
  }
  return {
    sign(claims: DeliveryClaims): string {
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return `${payload}.${signature(payload).toString('base64url')}`;
    },
    verify(value: string): DeliveryClaims {
      if (value.length > 4096)
        throw new AppError(404, 'CONTENT_UNAVAILABLE', '文件访问授权已失效。');
      const [payload, encoded, extra] = value.split('.');
      if (!payload || !encoded || extra !== undefined)
        throw new AppError(404, 'CONTENT_UNAVAILABLE', '文件访问授权已失效。');
      const actual = Buffer.from(encoded, 'base64url');
      const expected = signature(payload);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new AppError(404, 'CONTENT_UNAVAILABLE', '文件访问授权已失效。');
      try {
        const claims = JSON.parse(
          Buffer.from(payload, 'base64url').toString('utf8'),
        ) as DeliveryClaims;
        if (
          !['team', 'public'].includes(claims.scope) ||
          !['preview', 'download', 'playback'].includes(claims.purpose) ||
          !Number.isSafeInteger(claims.expiresAt) ||
          claims.expiresAt <= Date.now()
        )
          throw new Error('expired');
        return claims;
      } catch {
        throw new AppError(404, 'CONTENT_UNAVAILABLE', '文件访问授权已失效。');
      }
    },
  };
}
export function allowArtifactPurpose(
  artifact: ArtifactRow,
  purpose: DeliveryPurpose,
  archived = false,
): void {
  const allowed =
    purpose === 'download'
      ? artifact.role === 'original' && !archived
      : purpose === 'playback'
        ? artifact.role === 'playback_video' && !archived
        : ['thumbnail', 'preview_image', 'poster'].includes(artifact.role);
  if (!allowed || artifact.state !== 'stored' || artifact.integrity_state !== 'verified')
    throw new AppError(404, 'CONTENT_UNAVAILABLE', '该文件当前不可访问。');
}
const extensions: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'text/html': 'html',
  'application/zip': 'zip',
};
export function safeDownloadName(title: string, mediaType: string): string {
  const extension = extensions[mediaType];
  if (!extension) throw new AppError(409, 'MEDIA_TYPE_UNSUPPORTED', '文件格式不能用于下载。');
  const safe = [...title.normalize('NFC')]
    .filter(
      (character) =>
        character.charCodeAt(0) >= 32 &&
        character.charCodeAt(0) !== 127 &&
        !'/\\<>:"|?*'.includes(character),
    )
    .join('')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 100);
  return `${safe || '素材'}.${extension}`;
}
