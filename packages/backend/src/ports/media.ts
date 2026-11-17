export type MediaTypeKey = 'image' | 'video' | 'web_motion';
export interface MediaInspection {
  type: MediaTypeKey;
  mediaType: string;
  bytes: number;
  sha256: string;
  metadata: Record<string, unknown>;
}
export interface MediaArtifactOutput {
  role:
    'thumbnail' | 'preview_image' | 'poster' | 'playback_video' | 'motion_manifest' | 'loop_video';
  filePath: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  metadata: Record<string, unknown>;
}
export interface MediaProcessor {
  verify(input: { inputPath: string; originalFilename: string }): Promise<MediaInspection>;
  process(input: {
    inputPath: string;
    outputDirectory: string;
    originalFilename: string;
  }): Promise<{ artifacts: MediaArtifactOutput[]; metadata: Record<string, unknown> }>;
}
