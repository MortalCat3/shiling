import { join } from 'node:path';
import { buildArtifact, ensureOutputDirectory, inspectInput, runCommand } from './shared.js';
import type { MediaInput, VideoInspection, VideoProcessResult } from './types.js';
import { MediaProcessingError } from './types.js';

export interface VideoLimits {
  readonly maxBytes: number;
  readonly maxDurationMs: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly probeTimeoutMs: number;
  readonly transcodeTimeoutMs: number;
}

export const defaultVideoLimits: VideoLimits = Object.freeze({
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxDurationMs: 30 * 60 * 1_000,
  maxWidth: 7_680,
  maxHeight: 4_320,
  probeTimeoutMs: 15_000,
  transcodeTimeoutMs: 20 * 60 * 1_000,
});

interface ProbeStream {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly pix_fmt?: string;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: string;
}

interface ProbePayload {
  readonly streams?: readonly ProbeStream[];
  readonly format?: { readonly format_name?: string; readonly duration?: string };
}

function parseDurationMs(payload: ProbePayload, video: ProbeStream): number {
  const seconds = Number(video.duration ?? payload.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new MediaProcessingError('VIDEO_DURATION_MISSING', '无法识别视频时长。');
  }
  return Math.round(seconds * 1_000);
}

export async function inspectVideo(
  input: Pick<MediaInput, 'inputPath' | 'originalFilename'>,
  limits: VideoLimits = defaultVideoLimits,
): Promise<VideoInspection> {
  const original = await inspectInput(input.inputPath, limits.maxBytes);
  const probe = await runCommand(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input.inputPath],
    { timeoutMs: limits.probeTimeoutMs },
  );
  let payload: ProbePayload;
  try {
    payload = JSON.parse(probe.stdout) as ProbePayload;
  } catch (error) {
    throw new MediaProcessingError('VIDEO_PROBE_INVALID', '视频探测结果无效。', false, error);
  }
  if (
    !(payload.format?.format_name ?? '').split(',').some((name) => name === 'mp4' || name === 'mov')
  ) {
    throw new MediaProcessingError('VIDEO_CONTAINER_UNSUPPORTED', '当前仅支持 MP4 容器。');
  }
  const video = payload.streams?.find((stream) => stream.codec_type === 'video');
  if (video?.width === undefined || video.height === undefined || video.codec_name === undefined) {
    throw new MediaProcessingError('VIDEO_STREAM_MISSING', '未找到可用的视频轨道。');
  }
  if (video.width > limits.maxWidth || video.height > limits.maxHeight) {
    throw new MediaProcessingError('VIDEO_DIMENSION_LIMIT', '视频尺寸超过当前实例限制。');
  }
  const durationMs = parseDurationMs(payload, video);
  if (durationMs > limits.maxDurationMs) {
    throw new MediaProcessingError('VIDEO_DURATION_LIMIT', '视频时长超过当前实例限制。');
  }
  const audio = payload.streams?.find((stream) => stream.codec_type === 'audio');
  return {
    type: 'video',
    mediaType: 'video/mp4',
    bytes: original.bytes,
    sha256: original.sha256,
    metadata: {
      width: video.width,
      height: video.height,
      durationMs,
      videoCodec: video.codec_name,
      audioCodec: audio?.codec_name ?? null,
      pixelFormat: video.pix_fmt ?? null,
    },
  };
}

export async function processVideo(
  input: MediaInput,
  limits: VideoLimits = defaultVideoLimits,
): Promise<VideoProcessResult> {
  const inspected = await inspectVideo(input, limits);
  const { width, height, durationMs } = inspected.metadata;

  await ensureOutputDirectory(input.outputDirectory);
  const playbackPath = join(input.outputDirectory, 'playback.mp4');
  const posterPath = join(input.outputDirectory, 'poster.png');
  await runCommand(
    'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      input.inputPath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease,format=yuv420p",
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      playbackPath,
    ],
    { timeoutMs: limits.transcodeTimeoutMs },
  );
  await runCommand(
    'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(Math.min(Math.max(durationMs / 10_000, 0.1), 5)),
      '-i',
      input.inputPath,
      '-frames:v',
      '1',
      '-vf',
      "scale='min(1280,iw)':-2:force_original_aspect_ratio=decrease",
      posterPath,
    ],
    { timeoutMs: Math.min(limits.transcodeTimeoutMs, 60_000) },
  );

  const artifacts = await Promise.all([
    buildArtifact('playback', playbackPath, 'video/mp4', {
      width: Math.min(width, 1_920),
      height: Math.round((height * Math.min(width, 1_920)) / width / 2) * 2,
      durationMs,
    }),
    buildArtifact('poster', posterPath, 'image/png'),
  ]);
  return {
    kind: 'video',
    detectedContentType: 'video/mp4',
    originalBytes: inspected.bytes,
    originalSha256: inspected.sha256,
    metadata: inspected.metadata,
    artifacts,
  };
}
