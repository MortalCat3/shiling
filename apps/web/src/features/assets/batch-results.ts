import type { Asset } from '../../app/models';
const reasons: Record<string, string> = {
  FORBIDDEN: '没有操作权限',
  REVISION_CONFLICT: '内容已更新，请重新核对',
  PRECONDITION_FAILED: '内容已更新，请重新核对',
  NOT_FOUND: '素材已不可用',
  INVALID_STATE: '素材状态已变化',
};
/** 保留跨页失败实体；重试不能只从刷新后的第一页拼装请求。 */
export function retainBatchFailures(
  assets: Asset[],
  failures: { assetId: string; code?: string }[],
) {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return {
    assets: failures.flatMap((failure) => {
      const asset = byId.get(failure.assetId);
      return asset ? [asset] : [];
    }),
    results: failures.map((failure) => ({
      assetId: failure.assetId,
      title: byId.get(failure.assetId)?.title ?? '不可用素材',
      code: reasons[failure.code ?? ''] ?? '未完成，请核对状态后重试',
    })),
  };
}
