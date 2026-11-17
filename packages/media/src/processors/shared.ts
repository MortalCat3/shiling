import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ProcessedArtifact } from './types.js';
import { MediaProcessingError } from './types.js';

export async function ensureOutputDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o750 });
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const input = createReadStream(path);
  for await (const chunk of input) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function inspectInput(
  path: string,
  maxBytes: number,
): Promise<{
  readonly bytes: number;
  readonly sha256: string;
}> {
  const info = await stat(path);
  if (!info.isFile()) throw new MediaProcessingError('INPUT_NOT_FILE', '上传内容不是常规文件。');
  if (info.size <= 0) throw new MediaProcessingError('INPUT_EMPTY', '上传文件为空。');
  if (info.size > maxBytes) {
    throw new MediaProcessingError('INPUT_TOO_LARGE', '文件超过当前实例允许的大小。');
  }
  return { bytes: info.size, sha256: await hashFile(path) };
}

export async function buildArtifact(
  role: ProcessedArtifact['role'],
  filePath: string,
  contentType: string,
  dimensions: {
    readonly width?: number;
    readonly height?: number;
    readonly durationMs?: number;
  } = {},
): Promise<ProcessedArtifact> {
  const info = await stat(filePath);
  return {
    role,
    filePath,
    contentType,
    bytes: info.size,
    sha256: await hashFile(filePath),
    width: dimensions.width ?? null,
    height: dimensions.height ?? null,
    durationMs: dimensions.durationMs ?? null,
  };
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly maxOutputBytes?: number },
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else
        resolve({
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        });
    };

    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(new MediaProcessingError('PROCESS_OUTPUT_LIMIT', '媒体工具输出超过安全限制。'));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', (error) =>
      finish(
        new MediaProcessingError('PROCESS_START_FAILED', '媒体处理工具不可用。', false, error),
      ),
    );
    child.once('exit', (code, signal) => {
      if (code === 0) finish();
      else
        finish(
          new MediaProcessingError(
            'PROCESS_FAILED',
            `媒体处理失败（${signal ?? code ?? 'unknown'}）。`,
          ),
        );
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new MediaProcessingError('PROCESS_TIMEOUT', '媒体处理超过当前实例允许的时间。', true));
    }, options.timeoutMs);
    timer.unref();
  });
}
