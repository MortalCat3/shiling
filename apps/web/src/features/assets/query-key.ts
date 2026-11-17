/** 视图只是呈现；路径和筛选变化才会使缓存列表重新查询。 */
export function libraryQueryKey(
  path: string,
  scope: string,
  collectionId: unknown,
  query: Record<string, unknown>,
): string {
  const filters = { ...query };
  delete filters.view;
  return JSON.stringify([path, scope, collectionId, filters]);
}
