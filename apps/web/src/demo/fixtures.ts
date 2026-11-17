import type { Asset, UploadItem, Session, Collection, Tag } from '../app/models';
import manifest from './assets/manifest.json';
import videoMetadata from './assets/video.json';
const pictures = import.meta.glob('./assets/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
export const videoUrl = new URL('./assets/form-study.mp4', import.meta.url).href;
export const ownerId = '10000000-0000-4000-8000-000000000001';
const names = [
  '林间留白 · 图形海报',
  '蓝色秩序 · 视觉探索',
  '留一点空间',
  '缓慢靠近 · 动态构成',
  '柔软的形状',
  '日常的温度',
  '向内生长',
  '在网格之外',
  '暖橙色的星期日',
  '夜航 · 深色构成',
  '低饱和的练习',
  '一张纸的可能',
  '绿色的片刻',
  '偏离中心',
  '未完成的对话',
  '光经过的地方',
  '关于圆的想象',
  '慢一点，也很好',
  '森林坐标',
  '留白之间的秩序与节奏——横竖比例的视觉练习',
  '好奇心的形状',
  '黄昏之后',
  '柔软边界',
  '把日常重新排列',
];
export const tags: (Tag & { state: 'active' | 'disabled' })[] = [
  '平面设计',
  '几何构成',
  '品牌灵感',
  '色彩研究',
  '海报',
  '动态设计',
].map((name, i) => ({
  id: `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  name,
  description: [
    '版式、字体与平面表达',
    '形状与空间关系的探索',
    '面向品牌项目的视觉参考',
    '色彩搭配与情绪研究',
    '具有完整构图的海报作品',
    '节奏、运动与时间的表达',
  ][i]!,
  state: 'active' as const,
  revision: '1',
}));
export const collections: Collection[] = [
  {
    id: '30000000-0000-4000-8000-000000000001',
    name: '色彩与构成',
    description: '图形、比例和色彩的日常研究。',
    revision: '1',
    actions: Object.fromEntries(['manageItems'].map((key) => [key, true])),
    ownerId,
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    name: '下一次创作',
    description: '留给下一份作品的灵感。',
    revision: '1',
    actions: Object.fromEntries(['manageItems'].map((key) => [key, true])),
    ownerId,
  },
];
collections.push(
  ...[
    ['几何的另一面', '从日常形状出发，寻找新的组合方式。'],
    ['品牌视觉参考', '为正在进行的创作收集方向。'],
    ['留白与节奏——关于空间、比例和视觉呼吸的练习', '团队共享的版式参考，持续收集。'],
    ['秋日视觉提案', '上一轮项目的创作记录。'],
  ].map(([name, description], i) => ({
    id: '30000000-0000-4000-8000-' + String(i + 3).padStart(12, '0'),
    name: name!,
    description: description || '',
    revision: '1',
    ownerId: i === 2 ? '10000000-0000-4000-8000-000000000002' : ownerId,
  })),
);
for (const [i, collection] of collections.entries()) {
  collection.state = i === 5 ? 'archived' : 'active';
  collection.actions =
    i === 4 ? {} : i === 5 ? { restore: true } : { edit: true, manageItems: true, archive: true };
}
export const assetUrls = new Map<string, string>();
export const assets: Asset[] = manifest.map((item, i) => {
  const id = `40000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
  const image = pictures[`./assets/${item.name}.png`]!;
  const video = i === 3;
  assetUrls.set(`${id}:thumbnail`, image);
  assetUrls.set(`${id}:original`, video ? videoUrl : image);
  assetUrls.set(`${id}:playback`, videoUrl);
  const dimensions = { width: item.width, height: item.height };
  const artifact = (role: string, suffix: string) => ({
    id: `${id}:${suffix}`,
    role,
    mediaType: video && role !== 'thumbnail' ? 'video/mp4' : 'image/png',
    bytes: String(video && role !== 'thumbnail' ? videoMetadata.bytes : item.bytes),
    ...dimensions,
  });
  return {
    id,
    typeId: video ? 'video' : 'image',
    title: names[i]!,
    description:
      '一组关于形状、比例与留白的原创视觉练习。可作为版式与配色参考。\n此素材为拾灵界面演示生成，不包含真实团队内容。',
    owner: {
      id: i % 4 === 0 ? '10000000-0000-4000-8000-000000000002' : ownerId,
      displayName: i % 4 === 0 ? '演示成员' : '演示创作者',
    },
    ownerId: i % 4 === 0 ? '10000000-0000-4000-8000-000000000002' : ownerId,
    lifecycle: i >= 22 ? 'archived' : 'active',
    currentVersionId: id,
    revision: '1',
    favorite: [1, 4, 8, 12].includes(i),
    publicationState: 'none',
    tags: [tags[i % 5]!, tags[1]!].filter(
      (tag, index, list) => list.findIndex((t) => t.id === tag.id) === index,
    ),
    collections: collections.filter(
      (_, index) => index !== 1 && (index === 0 ? i % 2 === 0 : i % 4 === index - 2),
    ),
    createdAt: new Date(Date.UTC(2026, 10, 16, 8) - i * 3600000).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 10, 16, 8) - i * 3600000).toISOString(),
    artifacts: [
      artifact('thumbnail', 'thumbnail'),
      artifact('original', 'original'),
      ...(video ? [artifact('playback_video', 'playback')] : []),
    ],
    actions: Object.fromEntries(
      (i % 4 === 0 ? ['download'] : ['edit', 'download', 'archive', 'publish']).map((key) => [
        key,
        true,
      ]),
    ),
    width: item.width,
    height: item.height,
  };
});
export const demoSession: Session = {
  user: {
    id: ownerId,
    displayName: '演示创作者',
    status: 'active',
    roleId: ownerId,
    revision: '1',
  },
  role: {
    id: ownerId,
    key: 'contributor',
    name: '创作者 · 标签治理',
    kind: 'custom',
    revision: '1',
  },
  permissionKeys: [
    'assets.read',
    'assets.editOwn',
    'assets.archiveOwn',
    'assets.download',
    'favorites.manageOwn',
    'collections.read',
    'collections.manageOwn',
    'collections.create',
    'tags.manage',
    'publications.publishOwn',
    'publications.withdrawOwn',
    'publications.withdrawAny',
    'uploads.create',
    'uploads.readOwn',
    'uploads.cancelOwn',
    'uploads.retryOwn',
  ],
  authzVersion: '1',
  csrfToken: 'demo-not-a-credential',
  expiresAt: '2099-01-01T00:00:00.000Z',
};
export const batchId = '50000000-0000-4000-8000-000000000001';
export const uploads: UploadItem[] = ['ready', 'processing', 'failed', 'canceled'].map(
  (state, i) => ({
    id: `60000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    batchId,
    clientItemId: `demo-${i}`,
    fileName: ['蓝色秩序.png', '缓慢靠近.mp4', '留一点空间.png', '旧版构成.png'][i]!,
    attemptId: null,
    transportState: 'verified',
    processingState: state as 'ready' | 'processing' | 'failed' | 'canceled',
    uiState: state as 'ready' | 'processing' | 'failed' | 'canceled',
    assetId: state === 'ready' ? assets[1]!.id : null,
    revision: '1',
    metadata: {
      title: ['蓝色秩序 · 视觉探索', '缓慢靠近 · 动态构成', '留一点空间', '旧版构成'][i]!,
      description: '',
      tagIds: [],
      collectionIds: [],
    },
    safeError:
      state === 'failed'
        ? {
            code: 'PREVIEW_FAILED',
            message: '预览生成失败，原件已接收。可直接重试处理。',
            retryable: true,
          }
        : null,
    organizationWarnings: [],
    progress: { receivedBytes: '480000', totalBytes: '480000' },
    actions:
      state === 'failed'
        ? { retry: true, editMetadata: true }
        : state === 'processing'
          ? { cancel: true, editMetadata: true }
          : { editMetadata: true },
    typeId: i === 1 ? 'video' : 'image',
  }),
);
