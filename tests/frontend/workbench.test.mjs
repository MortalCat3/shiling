import assert from 'node:assert/strict';
import test from 'node:test';
import { retainBatchFailures } from '../../apps/web/src/features/assets/batch-results.ts';
import { libraryQueryKey } from '../../apps/web/src/features/assets/query-key.ts';
import { revisionHeader } from '../../apps/web/src/app/revision-header.ts';

test('分页后失败项仍保留实体和修订，供下一次请求使用', () => {
  const firstPage = [{ id: 'a', title: '首批素材', revision: '2' }];
  const secondPage = [{ id: 'b', title: '后页素材', revision: '7' }];
  const failed = retainBatchFailures(
    [...firstPage, ...secondPage],
    [{ assetId: 'b', code: 'FORBIDDEN' }],
  );
  const candidates = new Map([...failed.assets, ...firstPage].map((item) => [item.id, item]));
  assert.equal(candidates.get('b').revision, '7');
  assert.deepEqual(failed.results, [{ assetId: 'b', title: '后页素材', code: '没有操作权限' }]);
});

test('新 DTO 修订优先于旧 GET 的 ETag', () => {
  assert.equal(revisionHeader('9', '"8"'), '"9"');
  assert.equal(revisionHeader('', '"8"'), '"8"');
});

test('网格切列表不清空选择；从其他页面返回会重新查询', () => {
  const key = libraryQueryKey('/app/library', 'library', undefined, { q: '蓝色', view: 'grid' });
  assert.equal(
    key,
    libraryQueryKey('/app/library', 'library', undefined, { q: '蓝色', view: 'list' }),
  );
  assert.notEqual(key, libraryQueryKey('/app/uploads', 'library', undefined, { q: '蓝色' }));
  assert.notEqual(key, libraryQueryKey('/app/library', 'library', undefined, { q: '绿色' }));
});
