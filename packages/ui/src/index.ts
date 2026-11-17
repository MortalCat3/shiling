/** 浏览器无关的展示变量；业务权限、请求和状态机不进入 UI 包。 */
export const themeTokens = {
  '--surface': '#fafaf8',
  '--surface-muted': '#eceeea',
  '--surface-selected': '#e6e9e2',
  '--text': '#202320',
  '--text-muted': '#646b63',
  '--line': '#e3e6df',
  '--brand': '#244bc5',
  '--brand-soft': '#edf1ff',
  '--danger': '#bd3434',
  '--success': '#257648',
  '--warning': '#8a5c13',
  '--radius-control': '8px',
  '--radius-media': '10px',
  '--radius-dialog': '16px',
  '--sidebar-width': '200px',
  '--header-height': '64px',
} as const;
export function formatBytes(value: number | string | null | undefined): string {
  const bytes = Number(value);
  if (value == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}
