export type MediaKind = 'image' | 'video' | 'motion';

export type ArtifactRole = 'thumbnail' | 'preview' | 'poster' | 'playback' | 'manifest';

export interface MediaInput {
  readonly inputPath: string;
  readonly outputDirectory: string;
  readonly originalFilename: string;
}

export interface ProcessedArtifact {
  readonly role: ArtifactRole;
  readonly filePath: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
}

export interface ImageMetadata {
  readonly width: number;
  readonly height: number;
  readonly format: 'jpeg' | 'png' | 'webp' | 'gif';
  readonly animated: boolean;
  readonly pages: number;
}

export interface VideoMetadata {
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly videoCodec: string;
  readonly audioCodec: string | null;
  readonly pixelFormat: string | null;
}

export interface MotionMetadata {
  readonly packageType: 'html' | 'zip';
  readonly entrypoint: string;
  readonly entryCount: number;
  readonly expandedBytes: number;
  readonly externalReferenceCount: number;
  readonly executionReady: false;
}

export interface ImageInspection {
  readonly type: 'image';
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly metadata: ImageMetadata;
}

export interface VideoInspection {
  readonly type: 'video';
  readonly mediaType: 'video/mp4';
  readonly bytes: number;
  readonly sha256: string;
  readonly metadata: VideoMetadata;
}

export interface MotionInspection {
  readonly type: 'web_motion';
  readonly mediaType: 'text/html' | 'application/zip';
  readonly bytes: number;
  readonly sha256: string;
  readonly metadata: MotionMetadata;
  readonly warnings: readonly string[];
}

export type MediaInspection = ImageInspection | VideoInspection | MotionInspection;

export interface ImageProcessResult {
  readonly kind: 'image';
  readonly detectedContentType: string;
  readonly originalBytes: number;
  readonly originalSha256: string;
  readonly metadata: ImageMetadata;
  readonly artifacts: readonly ProcessedArtifact[];
}

export interface VideoProcessResult {
  readonly kind: 'video';
  readonly detectedContentType: 'video/mp4';
  readonly originalBytes: number;
  readonly originalSha256: string;
  readonly metadata: VideoMetadata;
  readonly artifacts: readonly ProcessedArtifact[];
}

export interface MotionProcessResult {
  readonly kind: 'motion';
  readonly detectedContentType: 'text/html' | 'application/zip';
  readonly originalBytes: number;
  readonly originalSha256: string;
  readonly metadata: MotionMetadata;
  readonly artifacts: readonly ProcessedArtifact[];
  readonly warnings: readonly string[];
}

export type MediaProcessResult = ImageProcessResult | VideoProcessResult | MotionProcessResult;

export class MediaProcessingError extends Error {
  readonly code: string;
  readonly safeMessage: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable = false, cause?: unknown) {
    super(safeMessage, cause === undefined ? undefined : { cause });
    this.name = 'MediaProcessingError';
    this.code = code;
    this.safeMessage = safeMessage;
    this.retryable = retryable;
  }
}
