import { join } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { buildArtifact, ensureOutputDirectory, inspectInput } from './shared.js';
import type { ImageInspection, ImageProcessResult, MediaInput } from './types.js';
import { MediaProcessingError } from './types.js';

export interface ImageLimits {
  readonly maxBytes: number;
  readonly maxPixels: number;
  readonly previewEdge: number;
  readonly thumbnailEdge: number;
}

export const defaultImageLimits: ImageLimits = Object.freeze({
  maxBytes: 100 * 1024 * 1024,
  maxPixels: 120_000_000,
  previewEdge: 1_600,
  thumbnailEdge: 640,
});

const contentTypes = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
} as const;

export async function inspectImage(
  input: Pick<MediaInput, 'inputPath' | 'originalFilename'>,
  limits: ImageLimits = defaultImageLimits,
): Promise<ImageInspection> {
  const original = await inspectInput(input.inputPath, limits.maxBytes);
  let metadata: Metadata;
  try {
    metadata = await sharp(input.inputPath, {
      failOn: 'warning',
      limitInputPixels: limits.maxPixels,
      sequentialRead: true,
    }).metadata();
  } catch (error) {
    throw new MediaProcessingError('IMAGE_DECODE_FAILED', '图片无法安全解码。', false, error);
  }
  const format = metadata.format;
  if (format !== 'jpeg' && format !== 'png' && format !== 'webp' && format !== 'gif') {
    throw new MediaProcessingError(
      'IMAGE_FORMAT_UNSUPPORTED',
      '当前仅支持 JPEG、PNG、WebP 和 GIF 图片。',
    );
  }
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new MediaProcessingError('IMAGE_DIMENSIONS_MISSING', '无法识别图片尺寸。');
  }
  if (metadata.width * metadata.height > limits.maxPixels) {
    throw new MediaProcessingError('IMAGE_PIXEL_LIMIT', '图片像素总量超过当前实例限制。');
  }
  return {
    type: 'image',
    mediaType: contentTypes[format],
    bytes: original.bytes,
    sha256: original.sha256,
    metadata: {
      width: metadata.width,
      height: metadata.height,
      format,
      animated: (metadata.pages ?? 1) > 1,
      pages: metadata.pages ?? 1,
    },
  };
}

export async function processImage(
  input: MediaInput,
  limits: ImageLimits = defaultImageLimits,
): Promise<ImageProcessResult> {
  const inspected = await inspectImage(input, limits);

  await ensureOutputDirectory(input.outputDirectory);
  const previewPath = join(input.outputDirectory, 'preview.webp');
  const thumbnailPath = join(input.outputDirectory, 'thumbnail.webp');
  try {
    await sharp(input.inputPath, { failOn: 'warning', limitInputPixels: limits.maxPixels })
      .rotate()
      .resize(limits.previewEdge, limits.previewEdge, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 84, effort: 5 })
      .toFile(previewPath);
    await sharp(input.inputPath, { failOn: 'warning', limitInputPixels: limits.maxPixels })
      .rotate()
      .resize(limits.thumbnailEdge, limits.thumbnailEdge, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 80, effort: 4 })
      .toFile(thumbnailPath);
  } catch (error) {
    throw new MediaProcessingError('IMAGE_DERIVATIVE_FAILED', '图片预览生成失败。', true, error);
  }

  const [previewInfo, thumbnailInfo] = await Promise.all([
    sharp(previewPath).metadata(),
    sharp(thumbnailPath).metadata(),
  ]);
  const artifacts = await Promise.all([
    buildArtifact('preview', previewPath, 'image/webp', {
      width: previewInfo.width,
      height: previewInfo.height,
    }),
    buildArtifact('thumbnail', thumbnailPath, 'image/webp', {
      width: thumbnailInfo.width,
      height: thumbnailInfo.height,
    }),
  ]);

  return {
    kind: 'image',
    detectedContentType: inspected.mediaType,
    originalBytes: inspected.bytes,
    originalSha256: inspected.sha256,
    metadata: inspected.metadata,
    artifacts,
  };
}
