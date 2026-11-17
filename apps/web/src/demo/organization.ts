import { ApiError, type ApiOptions } from '../app/http-client';
import { allows, type Collection, type Tag } from '../app/models';
import { assets, collections, tags, ownerId } from './fixtures';
export function collectionView(item: Collection): Collection {
  return {
    ...item,
    visibleItemCount: assets.filter(
      (a) => a.lifecycle === 'active' && a.collections?.some((c) => c.id === item.id),
    ).length,
  };
}
const fail = (status: number, message: string): never => {
  throw new ApiError(status, 'DEMO_STATE', message);
};
export function organizationApi(
  route: string,
  query: URLSearchParams,
  options: ApiOptions,
  scenario: string,
  consumeConflict: () => boolean,
): unknown {
  const method = options.method || 'GET',
    body = (options.body || {}) as Record<string, unknown>;
  const isCollection = route.startsWith('/team/collections'),
    list: (Collection | Tag)[] = isCollection ? collections : tags;
  const base = isCollection ? '/team/collections' : '/team/tags';
  const [id, action] = route.slice(base.length + 1).split('/');
  if (method === 'GET' && scenario === 'error')
    fail(503, '演示：暂时无法加载，请切回正常内容后重试。');
  if (route === base) {
    if (method === 'GET')
      return {
        items:
          scenario === 'empty'
            ? []
            : list
                .filter(
                  (item) =>
                    query.get('state') === 'all' || item.state === (query.get('state') || 'active'),
                )
                .map((item) => (isCollection ? collectionView(item as Collection) : item)),
      };
    const item = {
      id: crypto.randomUUID(),
      name: String(body.name),
      description: String(body.description || ''),
      revision: '1',
      state: 'active',
      ...(isCollection
        ? { ownerId, actions: { edit: true, manageItems: true, archive: true } }
        : {}),
    };
    list.unshift(item);
    return isCollection ? collectionView(item) : item;
  }
  const target = list.find((item) => item.id === id);
  if (!target) fail(404, '内容不可用。');
  const item = target!;
  if (method === 'GET') {
    if (isCollection && action === 'items') {
      const all = assets.filter(
        (a) => a.lifecycle === 'active' && a.collections?.some((c) => c.id === id),
      );
      return {
        items: all.slice(0, Number(query.get('limit') || 18)),
        pageInfo: { hasMore: false, nextCursor: null },
      };
    }
    return isCollection ? collectionView(item as Collection) : item;
  }
  if (
    isCollection &&
    !allows(
      item.actions,
      action === 'items:batch' ? 'manageItems' : method === 'PATCH' ? 'edit' : action || '',
    )
  )
    fail(403, '当前账号不能修改这个集合。');
  if (
    (scenario === 'conflict' || (scenario === 'partial' && action === 'items:batch')) &&
    consumeConflict()
  ) {
    item.revision = String(Number(item.revision) + 1);
    fail(412, '演示：版本已变化，请读取最新状态后核对。');
  }
  if (
    method === 'PATCH'
      ? options.etag !== '"' + item.revision + '"'
      : body.expectedRevision !== item.revision
  )
    fail(412, '版本已变化，请重新核对。');
  if (action === 'items:batch') {
    const chosen = (body.assetIds as string[]).map((id) => assets.find((a) => a.id === id));
    if (chosen.some((a) => !a || a.lifecycle !== 'active'))
      fail(409, '部分素材不可用，本次整批未执行。');
    for (const asset of chosen)
      if (asset)
        asset.collections =
          body.action === 'remove'
            ? (asset.collections || []).filter((c) => c.id !== item.id)
            : [
                ...new Map(
                  [...(asset.collections || []), item as Collection].map((c) => [c.id, c]),
                ).values(),
              ];
  } else if (method === 'PATCH') {
    item.name = String(body.name);
    item.description = String(body.description || '');
  } else if (action === 'archive' || action === 'restore') {
    item.state = action === 'archive' ? 'archived' : 'active';
    item.actions =
      action === 'archive' ? { restore: true } : { edit: true, manageItems: true, archive: true };
  } else if (action === 'disable' || action === 'enable')
    item.state = action === 'disable' ? 'disabled' : 'active';
  else fail(501, '此演示操作暂不可用。');
  item.revision = String(Number(item.revision) + 1);
  return isCollection ? collectionView(item as Collection) : item;
}
