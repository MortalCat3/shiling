/** 当前 DTO 的修订比先前 GET 缓存更可靠，尤其在动作响应之后。 */
export function revisionHeader(revision: string, cached?: string): string {
  return revision ? `"${revision}"` : (cached ?? '');
}
