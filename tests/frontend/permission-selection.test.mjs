import assert from 'node:assert/strict';
import test from 'node:test';
import { togglePermission } from '../../apps/web/src/features/administration/permission-selection.ts';
const catalog = [
  { key: 'assets.read', dependencies: [] },
  { key: 'tags.read', dependencies: [] },
  { key: 'assets.editOwn', dependencies: ['assets.read', 'tags.read'] },
  { key: 'assets.governAny', dependencies: ['assets.editOwn'] },
  { key: 'system.roles.manage', delegable: false, dependencies: [] },
];
test('授权补齐传递依赖，保留原选择且不修改输入', () => {
  const current = ['tags.read'];
  const selected = togglePermission(current, 'assets.governAny', true, catalog);
  assert.deepEqual(
    new Set(selected),
    new Set(['tags.read', 'assets.read', 'assets.editOwn', 'assets.governAny']),
  );
  assert.deepEqual(current, ['tags.read']);
});
test('移除基础能力同时移除全部依赖者，但保留独立能力', () => {
  assert.deepEqual(
    togglePermission(
      ['assets.read', 'tags.read', 'assets.editOwn', 'assets.governAny'],
      'assets.read',
      false,
      catalog,
    ),
    ['tags.read'],
  );
});
test('不可委派和未知能力不能进入角色提交数据', () => {
  assert.deepEqual(
    togglePermission(['system.roles.manage', 'unknown'], 'system.roles.manage', true, catalog),
    [],
  );
});
test('循环依赖也能结束且只保留一份能力', () => {
  const cycle = [
    { key: 'a', dependencies: ['b'] },
    { key: 'b', dependencies: ['a'] },
  ];
  assert.deepEqual(togglePermission([], 'a', true, cycle), ['a', 'b']);
  assert.deepEqual(togglePermission(['a', 'b'], 'a', false, cycle), []);
});
