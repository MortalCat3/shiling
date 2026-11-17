import assert from 'node:assert/strict';
import test from 'node:test';
import { changedPublicFields } from '../../apps/web/src/features/assets/publication-draft.ts';

test('公开前后比较忽略标签顺序，同时准确标出标题、说明和标签变化', () => {
  const snapshot = { title: '蓝色秩序', description: '公开说明', publicTags: ['几何', '海报'] };
  assert.deepEqual(
    changedPublicFields(snapshot, {
      title: ' 蓝色秩序 ',
      description: '公开说明',
      publicTags: ['海报', '几何'],
    }),
    [],
  );
  assert.deepEqual(
    changedPublicFields(snapshot, { title: '新标题', description: '新说明', publicTags: ['几何'] }),
    ['标题', '说明', '标签'],
  );
});
test('草稿比较不会改写既有公开快照或标签数组', () => {
  const snapshot = Object.freeze({
    title: '旧标题',
    description: '旧说明',
    publicTags: Object.freeze(['b', 'a']),
  });
  const draft = Object.freeze({
    title: '新标题',
    description: '新说明',
    publicTags: Object.freeze(['c']),
  });
  changedPublicFields(snapshot, draft);
  assert.equal(snapshot.title, '旧标题');
  assert.deepEqual(snapshot.publicTags, ['b', 'a']);
});
