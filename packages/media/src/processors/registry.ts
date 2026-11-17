import { extname } from 'node:path';
import { inspectImage, processImage, type ImageLimits } from './image.js';
import { inspectMotion, processMotion, type MotionLimits } from './motion.js';
import type { MediaInput, MediaInspection, MediaProcessResult } from './types.js';
import { MediaProcessingError } from './types.js';
import { inspectVideo, processVideo, type VideoLimits } from './video.js';

export interface MediaProcessorLimits {
  readonly image?: ImageLimits;
  readonly video?: VideoLimits;
  readonly motion?: MotionLimits;
}

const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

export async function processMedia(
  input: MediaInput,
  limits: MediaProcessorLimits = {},
): Promise<MediaProcessResult> {
  const extension = extname(input.originalFilename).toLowerCase();
  if (imageExtensions.has(extension)) return await processImage(input, limits.image);
  if (extension === '.mp4') return await processVideo(input, limits.video);
  if (extension === '.html' || extension === '.htm' || extension === '.zip') {
    return await processMotion(input, limits.motion);
  }
  throw new MediaProcessingError('MEDIA_TYPE_UNSUPPORTED', '当前实例不支持这种素材类型。');
}

export async function inspectMedia(
  input: Pick<MediaInput, 'inputPath' | 'originalFilename'>,
  limits: MediaProcessorLimits = {},
): Promise<MediaInspection> {
  const extension = extname(input.originalFilename).toLowerCase();
  if (imageExtensions.has(extension)) return await inspectImage(input, limits.image);
  if (extension === '.mp4') return await inspectVideo(input, limits.video);
  if (extension === '.html' || extension === '.htm' || extension === '.zip') {
    return await inspectMotion(input, limits.motion);
  }
  throw new MediaProcessingError('MEDIA_TYPE_UNSUPPORTED', '当前实例不支持这种素材类型。');
}
