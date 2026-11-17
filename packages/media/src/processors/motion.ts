import { createReadStream } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, posix } from 'node:path';
import yauzl from 'yauzl';
import { buildArtifact, ensureOutputDirectory, inspectInput } from './shared.js';
import type { MediaInput, MotionInspection, MotionProcessResult } from './types.js';
import { MediaProcessingError } from './types.js';

export interface MotionLimits {
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly maxExpandedBytes: number;
  readonly maxEntryBytes: number;
  readonly maxCompressionRatio: number;
  readonly scanTextBytes: number;
}

export const defaultMotionLimits: MotionLimits = Object.freeze({
  maxBytes: 250 * 1024 * 1024,
  maxEntries: 2_000,
  maxExpandedBytes: 750 * 1024 * 1024,
  maxEntryBytes: 250 * 1024 * 1024,
  maxCompressionRatio: 150,
  scanTextBytes: 2 * 1024 * 1024,
});

interface EntrySummary {
  readonly path: string;
  readonly bytes: number;
  readonly compressedBytes: number;
  readonly directory: boolean;
}

function validateEntryPath(name: string): void {
  if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new MediaProcessingError('MOTION_PATH_INVALID', '动效包包含不安全的文件路径。');
  }
  const normalized = posix.normalize(name);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new MediaProcessingError('MOTION_PATH_TRAVERSAL', '动效包包含路径穿越条目。');
  }
  if (normalized.includes('\0')) {
    throw new MediaProcessingError('MOTION_PATH_INVALID', '动效包包含不安全的文件名。');
  }
}

function isSymlink(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o120000;
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (error, zip) => {
        if (error !== null || zip === undefined) reject(error ?? new Error('ZIP open failed'));
        else resolve(zip);
      },
    );
  });
}

async function inspectZip(
  path: string,
  limits: MotionLimits,
): Promise<{
  readonly entries: readonly EntrySummary[];
  readonly externalReferenceCount: number;
}> {
  const zip = await openZip(path).catch((error: unknown) => {
    throw new MediaProcessingError('MOTION_ZIP_INVALID', 'ZIP 动效包无法安全读取。', false, error);
  });
  return await new Promise((resolve, reject) => {
    const entries: EntrySummary[] = [];
    const seen = new Set<string>();
    let expandedBytes = 0;
    let externalReferenceCount = 0;
    let finished = false;

    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      zip.close();
      reject(error);
    };

    zip.once('error', (error) =>
      fail(new MediaProcessingError('MOTION_ZIP_INVALID', 'ZIP 动效包读取失败。', false, error)),
    );
    zip.on('entry', (entry) => {
      try {
        validateEntryPath(entry.fileName);
        if (seen.has(entry.fileName))
          throw new MediaProcessingError('MOTION_DUPLICATE_ENTRY', '动效包包含重复文件。');
        if (isSymlink(entry))
          throw new MediaProcessingError('MOTION_SYMLINK_FORBIDDEN', '动效包不能包含符号链接。');
        seen.add(entry.fileName);
        if (entries.length + 1 > limits.maxEntries)
          throw new MediaProcessingError('MOTION_ENTRY_LIMIT', '动效包文件数量超过限制。');
        if (entry.uncompressedSize > limits.maxEntryBytes)
          throw new MediaProcessingError('MOTION_ENTRY_TOO_LARGE', '动效包中的单个文件超过限制。');
        expandedBytes += entry.uncompressedSize;
        if (expandedBytes > limits.maxExpandedBytes)
          throw new MediaProcessingError('MOTION_EXPANDED_LIMIT', '动效包展开后体积超过限制。');
        const ratio = entry.uncompressedSize / Math.max(entry.compressedSize, 1);
        if (ratio > limits.maxCompressionRatio)
          throw new MediaProcessingError('MOTION_COMPRESSION_RATIO', '动效包压缩比超过安全限制。');
        const directory = /\/$/.test(entry.fileName);
        entries.push({
          path: entry.fileName,
          bytes: entry.uncompressedSize,
          compressedBytes: entry.compressedSize,
          directory,
        });

        const scannable =
          !directory &&
          /\.(?:html?|css|js|mjs|json|svg)$/i.test(entry.fileName) &&
          entry.uncompressedSize <= limits.scanTextBytes;
        if (!scannable) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error !== null || stream === undefined) {
            fail(
              new MediaProcessingError(
                'MOTION_ENTRY_READ_FAILED',
                '动效包文件读取失败。',
                false,
                error,
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.once('error', fail);
          stream.once('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            externalReferenceCount += (text.match(/(?:https?:)?\/\//gi) ?? []).length;
            zip.readEntry();
          });
        });
      } catch (error) {
        fail(error);
      }
    });
    zip.once('end', () => {
      if (finished) return;
      finished = true;
      if (!seen.has('index.html')) {
        reject(
          new MediaProcessingError(
            'MOTION_ENTRYPOINT_MISSING',
            'ZIP 动效包根目录必须包含 index.html。',
          ),
        );
        return;
      }
      resolve({ entries, externalReferenceCount });
    });
    zip.readEntry();
  });
}

function safeTitle(filename: string): string {
  return (
    basename(filename, extname(filename))
      .replace(/[<>&"']/g, '')
      .slice(0, 80) || '网页动效'
  );
}

export async function processMotion(
  input: MediaInput,
  limits: MotionLimits = defaultMotionLimits,
): Promise<MotionProcessResult> {
  const inspected = await inspectMotion(input, limits);
  const { packageType, entryCount, expandedBytes, externalReferenceCount } = inspected.metadata;
  await ensureOutputDirectory(input.outputDirectory);

  const manifestPath = join(input.outputDirectory, 'manifest.json');
  const coverPath = join(input.outputDirectory, 'cover.svg');
  await writeFile(
    manifestPath,
    `${JSON.stringify({ packageType, entrypoint: 'index.html', entryCount, expandedBytes, externalReferenceCount, executionReady: false }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o640 },
  );
  const title = safeTitle(input.originalFilename);
  await writeFile(
    coverPath,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><rect width="1200" height="675" fill="#f3f1f8"/><rect x="72" y="72" width="1056" height="531" rx="32" fill="#fff" stroke="#ded9eb"/><circle cx="144" cy="143" r="22" fill="#7657c8"/><text x="190" y="159" font-family="system-ui,sans-serif" font-size="42" font-weight="650" fill="#191b20">${title}</text><text x="144" y="300" font-family="system-ui,sans-serif" font-size="28" fill="#737986">自包含网页动效 · ${packageType.toUpperCase()}</text><text x="144" y="356" font-family="system-ui,sans-serif" font-size="24" fill="#737986">交互执行需独立主机与服务器隔离；当前安全关闭</text></svg>`,
    { encoding: 'utf8', mode: 0o640 },
  );
  const artifacts = await Promise.all([
    buildArtifact('manifest', manifestPath, 'application/json'),
    buildArtifact('poster', coverPath, 'image/svg+xml', { width: 1_200, height: 675 }),
  ]);

  return {
    kind: 'motion',
    detectedContentType: inspected.mediaType,
    originalBytes: inspected.bytes,
    originalSha256: inspected.sha256,
    metadata: inspected.metadata,
    artifacts,
    warnings: inspected.warnings,
  };
}

export async function inspectMotion(
  input: Pick<MediaInput, 'inputPath' | 'originalFilename'>,
  limits: MotionLimits = defaultMotionLimits,
): Promise<MotionInspection> {
  const original = await inspectInput(input.inputPath, limits.maxBytes);
  const extension = extname(input.originalFilename).toLowerCase();
  let packageType: 'html' | 'zip';
  let entryCount: number;
  let expandedBytes: number;
  let externalReferenceCount: number;
  if (extension === '.html' || extension === '.htm') {
    packageType = 'html';
    const text = await readFile(input.inputPath, 'utf8');
    if (!/<(?:!doctype\s+html|html|body)[\s>]/i.test(text)) {
      throw new MediaProcessingError('MOTION_HTML_INVALID', 'HTML 动效缺少有效的文档结构。');
    }
    entryCount = 1;
    expandedBytes = original.bytes;
    externalReferenceCount = (text.match(/(?:https?:)?\/\//gi) ?? []).length;
  } else if (extension === '.zip') {
    packageType = 'zip';
    const inspected = await inspectZip(input.inputPath, limits);
    entryCount = inspected.entries.length;
    expandedBytes = inspected.entries.reduce((total, entry) => total + entry.bytes, 0);
    externalReferenceCount = inspected.externalReferenceCount;
  } else {
    throw new MediaProcessingError(
      'MOTION_FORMAT_UNSUPPORTED',
      '当前仅支持自包含 HTML 或 ZIP 动效包。',
    );
  }
  const warnings = [
    '不可信动效执行默认关闭；当前仅提供安全封面和源文件下载。',
    ...(externalReferenceCount > 0
      ? ['检测到外部资源引用；启用执行前必须移除或由服务器白名单验证。']
      : []),
  ];
  return {
    type: 'web_motion',
    mediaType: packageType === 'html' ? 'text/html' : 'application/zip',
    bytes: original.bytes,
    sha256: original.sha256,
    metadata: {
      packageType,
      entrypoint: 'index.html',
      entryCount,
      expandedBytes,
      externalReferenceCount,
      executionReady: false,
    },
    warnings,
  };
}

export async function copyMotionSourceForAttachment(
  inputPath: string,
  destinationPath: string,
): Promise<void> {
  createReadStream(inputPath).destroy();
  await copyFile(inputPath, destinationPath);
}
