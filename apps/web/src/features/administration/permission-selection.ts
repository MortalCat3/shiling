import type { Permission } from '../../app/models';
/** 勾选补齐依赖；取消基础能力时同时移除依赖它的能力。 */
export function togglePermission(
  current: string[],
  key: string,
  enabled: boolean,
  catalog: Permission[],
): string[] {
  const allowed = new Map(
    catalog
      .filter((p) => p.delegable !== false && !p.key.startsWith('system.'))
      .map((p) => [p.key, p]),
  );
  const selected = new Set(current.filter((k) => allowed.has(k)));
  if (enabled) {
    function include(k: string): void {
      if (!allowed.has(k) || selected.has(k)) return;
      selected.add(k);
      for (const dependency of allowed.get(k)?.dependencies ?? []) include(dependency);
    }
    include(key);
  } else {
    selected.delete(key);
    let changed = true;
    while (changed) {
      changed = false;
      for (const k of selected)
        if ((allowed.get(k)?.dependencies ?? []).some((d) => !selected.has(d))) {
          selected.delete(k);
          changed = true;
        }
    }
  }
  return [...selected];
}
