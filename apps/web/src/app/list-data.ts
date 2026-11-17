import { api } from './http-client';
import { itemsOf, type Page } from './models';

/** 字典与选择器需要完整候选集；素材瀑布流仍按用户操作分页。 */
export async function readChoices<T extends { id: string }>(path: string): Promise<T[]> {
  const result: T[] = [];
  const ids = new Set<string>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams(path.split('?')[1]);
    query.set('limit', '100');
    if (cursor) query.set('cursor', cursor);
    const page = await api<Page<T> | T[]>(`${path.split('?')[0]}?${query}`);
    for (const item of itemsOf(page)) {
      if (!ids.has(item.id)) {
        result.push(item);
        ids.add(item.id);
      }
    }
    const next = !Array.isArray(page) && page.pageInfo?.hasMore ? page.pageInfo.nextCursor : null;
    if (!next) return result;
    if (seen.has(next)) throw new Error('列表分页状态异常，请刷新后重试。');
    seen.add(next);
    cursor = next;
  } while (cursor);
  return result;
}
