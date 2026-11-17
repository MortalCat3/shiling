import type { Publication } from '../../app/models';
export interface PublicDraft {
  title: string;
  description: string;
  publicTags: string[];
}
export function changedPublicFields(
  snapshot: Publication['snapshot'],
  draft: PublicDraft,
): string[] {
  if (!snapshot) return ['标题', '说明', '标签'];
  const changed: string[] = [];
  if ((snapshot.title || '') !== draft.title.trim()) changed.push('标题');
  if ((snapshot.description || '') !== draft.description) changed.push('说明');
  if (
    JSON.stringify([...(snapshot.publicTags || [])].sort()) !==
    JSON.stringify([...draft.publicTags].sort())
  )
    changed.push('标签');
  return changed;
}
