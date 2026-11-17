import { isDemo } from '../../demo/mode';
import { api, currentCsrfToken, safeResourceUrl } from '../../app/http-client';
import type { Attempt } from '../../app/models';
export async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
function send(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const safe = safeResourceUrl(url);
    if (!safe) {
      reject(new Error('上传地址不可用。'));
      return;
    }
    const request = new XMLHttpRequest();
    const local = new URL(safe).origin === location.origin;
    request.open('PUT', safe);
    request.withCredentials = local;
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === 'content-length') {
        if (Number(value) !== body.size) {
          reject(new Error('上传授权的字节数与所选文件不符。'));
          return;
        }
        continue; // 浏览器自动生成该受限请求头。
      }
      if (/^(cookie|host|origin|referer|connection|set-cookie)$/i.test(key)) continue;
      request.setRequestHeader(key, value);
    }
    if (local && currentCsrfToken()) request.setRequestHeader('X-CSRF-Token', currentCsrfToken());
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    const stop = (): void => request.abort();
    signal.addEventListener('abort', stop, { once: true });
    request.onload = () => {
      signal.removeEventListener('abort', stop);
      if (request.status >= 200 && request.status < 300) resolve(request.getResponseHeader('ETag'));
      else reject(new Error(`传输未被接收（${request.status}），请刷新任务状态后重试。`));
    };
    request.onerror = () => {
      signal.removeEventListener('abort', stop);
      reject(new Error('传输中断，请检查网络并刷新任务状态。'));
    };
    request.onabort = () => {
      signal.removeEventListener('abort', stop);
      reject(new DOMException('传输已中断', 'AbortError'));
    };
    if (signal.aborted) {
      reject(new DOMException('传输已中断', 'AbortError'));
      return;
    }
    request.send(body);
  });
}
export async function transferFile(
  file: File,
  attempt: Attempt,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<Record<string, unknown>> {
  if (import.meta.env.DEV && isDemo)
    return (await import('../../demo/api')).demoTransfer(file, attempt, signal, onProgress);
  const id = attempt.attemptId ?? attempt.id;
  if (!id) throw new Error('上传尝试没有返回有效标识。');
  const descriptor = attempt.transfer ?? attempt.transferDescriptor;
  const mode = descriptor?.mode ?? attempt.transport;
  if (mode === 'local' || mode === 'server_stream') {
    await send(
      descriptor?.url ?? `/api/v1/team/upload-attempts/${id}/content`,
      file,
      { 'Content-Type': 'application/octet-stream', ...descriptor?.headers },
      signal,
      onProgress,
    );
    return {};
  }
  if (mode === 's3-multipart' || mode === 'multipart') {
    const partSize = descriptor?.partSize;
    if (!partSize || partSize < 1) throw new Error('分片上传参数不可用。');
    const parts: { partNumber: number; etag: string }[] = [];
    const count = Math.ceil(file.size / partSize);
    for (let partNumber = 1; partNumber <= count; partNumber++) {
      const response = await api<{
        parts: { partNumber: number; url: string; headers?: Record<string, string> }[];
      }>(`/team/upload-attempts/${id}/parts`, {
        method: 'POST',
        body: { partNumbers: [partNumber] },
        signal,
      });
      const part = response.parts.find((entry) => entry.partNumber === partNumber);
      if (!part) throw new Error('分片授权不可用。');
      const offset = (partNumber - 1) * partSize;
      const etag = await send(
        part.url,
        file.slice(offset, offset + partSize),
        part.headers ?? {},
        signal,
        (bytes) => onProgress(offset + bytes),
      );
      if (!etag) throw new Error('未获得分片完成凭据，请检查存储跨域配置后重试。');
      parts.push({ partNumber, etag });
    }
    return { parts };
  }
  if ((mode === 'provider' || mode === 's3') && descriptor?.url) {
    await send(descriptor.url, file, descriptor.headers ?? {}, signal, onProgress);
    return {};
  }
  throw new Error('当前浏览器尚不能使用服务器返回的上传方式，请联系管理员检查存储配置。');
}
