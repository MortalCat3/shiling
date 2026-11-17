---
name: 拾灵 · 创作工作台
description: 近白画布、紧凑工具条与深蓝动作，让素材浏览和精确整理保持连续。
colors:
  brand: '#244bc5'
  brand-soft: '#edf1ff'
  surface: '#fafaf8'
  surface-raised: '#fff'
  surface-muted: '#eceeea'
  surface-selected: '#e6e9e2'
  surface-preview: '#eef0eb'
  sidebar: '#f3f4f0'
  search: '#eceee8'
  nav-active: '#e6ebf9'
  text: '#202320'
  text-muted: '#646b63'
  line: '#e3e6df'
  field-line: '#d6dad2'
  danger: '#bd3434'
  success: '#257648'
  warning: '#8a5c13'
  info-surface: '#eef2fa'
  info-text: '#304b78'
  warning-surface: '#fbf4e5'
  warning-text: '#75501a'
  error-surface: '#fff1f1'
  success-surface: '#eff8f2'
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: '24px'
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: '-0.025em'
  title:
    fontSize: '17px'
    fontWeight: 630
    lineHeight: 1.45
    letterSpacing: '-0.015em'
  dialog-title:
    fontSize: '20px'
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: '-0.015em'
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.55
  button:
    fontSize: '14px'
    fontWeight: 550
    lineHeight: 1.4
  asset-title:
    fontSize: '13px'
    fontWeight: 540
    lineHeight: 1.5
  label:
    fontSize: '12px'
    fontWeight: 400
    lineHeight: 1.55
rounded:
  context: '4px'
  segment: '5px'
  chip: '6px'
  nav: '7px'
  control: '8px'
  media: '10px'
  dialog: '16px'
spacing:
  xs: '4px'
  sm: '8px'
  compact: '12px'
  md: '16px'
  section: '20px'
  lg: '24px'
  detail: '28px'
  page: '30px'
  xl: '32px'
components:
  button-primary:
    backgroundColor: '{colors.brand}'
    textColor: '{colors.surface-raised}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: '9px 14px'
  button-default:
    backgroundColor: '{colors.surface-muted}'
    textColor: '{colors.text}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: '9px 14px'
  button-quiet:
    backgroundColor: 'transparent'
    textColor: '{colors.text}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: '9px 14px'
  input-search:
    backgroundColor: '{colors.search}'
    textColor: '{colors.text}'
    rounded: '{rounded.nav}'
    padding: '0 12px'
  navigation-active:
    backgroundColor: '{colors.nav-active}'
    textColor: '{colors.brand}'
    rounded: '{rounded.nav}'
    padding: '11px 12px'
  chip-selected:
    backgroundColor: '{colors.brand-soft}'
    textColor: '{colors.brand}'
    rounded: '{rounded.chip}'
    padding: '6px 10px'
  asset-card:
    textColor: '{colors.text}'
    typography: '{typography.asset-title}'
    rounded: '{rounded.media}'
  segmented:
    backgroundColor: '{colors.surface-muted}'
    textColor: '{colors.text-muted}'
    rounded: '{rounded.nav}'
    padding: '3px'
  notice-warning:
    backgroundColor: '{colors.warning-surface}'
    textColor: '{colors.warning-text}'
    rounded: '{rounded.control}'
    padding: '12px 16px'
  upload-drop-zone:
    backgroundColor: '{colors.surface-raised}'
    textColor: '{colors.text-muted}'
    rounded: '{rounded.media}'
    padding: '28px 20px'
---

# Design System: 拾灵 · 创作工作台

## Overview

**Creative North Star: "创作工作台"**

日间办公环境里的近白画布、中性灰和深蓝动作，组成安静、精确的创作工具。系统无衬线负责中文阅读，细分隔和紧凑控件组织信息；素材本身承担视觉丰富度。按钮、输入与导航清楚可辨，界面装饰不与内容争夺注意力。

浏览与整理共享上下文：原比例缩略图便于扫视，对齐列表便于比较，详情保留大预览和明确的原件下载动作。层次主要来自底色、间距与线条；阴影用于弹层和少量状态，不把每份素材包成浮起的容器。

**Key Characteristics:**

- 近白与灰绿中性色承托内容，深蓝集中表达主动作与选择。
- 中文系统无衬线、紧凑字号和对齐数字服务持续操作。
- 原比例媒体、细分隔、控件与媒体的分级圆角形成统一节奏。
- 网格、列表和详情保持查询、选择与返回位置的连续性。
- 状态使用文字和可执行下一步；触屏操作不依赖悬停。

本文件记录 2026-11-17 已落地的 B 第一批：共用控件、团队外壳、素材库、素材详情、上传工作区和必要登录入口。[产品上下文](../../PRODUCT.md)与 [ADR 0005](../../docs/adr/0005-interface-redesign-scope.md)保留业务及授权范围；具体首屏策略在方向合同（本地 `.impeccable/surfaces/src-features-assets-librarypage-vue.md`，不随版本分发）。集合完整页面、公开页面和管理页面仍属后续批次；共用样式对它们生效不代表已完成专项重构。

Token 根据 [UI 展示变量](../../packages/ui/src/index.ts)、[基础样式](src/theme.css)与后加载的[工作台样式](src/workbench.css)提取。上方 frontmatter 记录实际颜色、字级和复用尺寸；spacing 名称是对现有重复值的文档归纳，尚无对应的 CSS 间距变量。阴影、断点、动效和组件片段见扩展文件（本地 `.impeccable/design.json`，不随版本分发）；其中八阶 OKLCH 色带仅供面板展示，由现有颜色推导，不是新增生产色板。

## Colors

灰绿倾向的浅中性色形成日间工作底色；深蓝提供少量清晰的动作与选择线索。

### Primary

- **工作深蓝**（`brand`）：上传、下载、主要提交、焦点、光标与文本选择。hover 通过亮度变化表达反馈，没有新增一套蓝色值。
- **浅蓝选择底**（`brand-soft`）与**导航浅蓝**（`nav-active`）：筛选、列表选择、批量栏和当前位置；保持与主按钮的面积、明度差异。

### Neutral

- **近白画布**（`surface`）与**白色浮层**（`surface-raised`）：工作区背景、输入、详情和桌面登录卡。
- **雾灰底**（`surface-muted`）、**灰绿选中底**（`surface-selected`）、**预览灰**（`surface-preview`）：次动作、继承控件状态与媒体底板。侧栏和搜索各有已实现的浅底，不把相近值混作同一 token。
- **墨灰正文**（`text`）与**苔灰辅助字**（`text-muted`）：正文、说明、占位文案和控件辅助信息。`line` 用于区域分隔，`field-line` 用于输入边界。

### Semantic

`danger`、`success`、`warning` 表达失败、成功与需注意状态。通知使用对应浅底和文字色；信息通知采用 `info-surface` / `info-text`，警告通知采用 `warning-surface` / `warning-text`。状态名称和下一步始终可读，颜色不单独承担意义。

**The 可读占位 Rule.** 搜索占位文案使用 `text-muted`，按实际 `search` 底色检查对比度；最终值达到 4.6957:1，不恢复评审前的较浅灰色。

## Typography

**Body Font:** 系统无衬线栈，按 frontmatter 的 `body.fontFamily`；标题继承同一字族。当前没有独立展示字体或等宽字族，也未引入第三方字体文件。

**Character:** 字形熟悉、层级紧凑；标题通过字号、字重和轻微收紧的字距建立层次。中文任务文案直接表达对象和动作，文件名、规格与状态保持易扫描。

### Hierarchy

- **Headline**：页面主标题；手机一般降为 23px，登录标题保留 24px。
- **Title**：区域标题；上传历史标题另用紧凑的 13px。
- **Dialog title**：桌面详情标题；手机降为 17px。
- **Body / Button**：正文和动作，按钮保持中等字重。
- **Asset title**：桌面素材名；手机为 12px，单行截断并保留完整可访问名称与标题提示。
- **Label**：筛选、元数据和辅助说明；11px / 10px 仅用于日期、格式等短辅助信息，不提升为长正文级别。

**The 数字对齐 Rule.** 已加载数、列表规格和详情元数据使用 `tabular-nums`，避免数字变化造成视觉跳动。

## Layout

桌面团队外壳采用固定文字侧栏（200px）和顶部搜索/动作栏（64px）。页面默认左右留白 30px；在 1280px 及以下改为 24px。761–1020px 侧栏收为 180px；760px 及以下改为可关闭抽屉，内容左右留白 16px，搜索移到顶栏第二行。手机顶栏是多行内容，不将桌面的 64px 当作其总高度。

| 已检查视口宽度 | 素材网格列数 | 空间行为                          |
| -------------- | ------------ | --------------------------------- |
| 1440px         | 5            | 原比例媒体，列间距 16px           |
| 1280px         | 4            | 工具条与列表压缩，日期列隐藏      |
| 768px          | 3            | 收窄侧栏，保持素材/工具分区       |
| 390px          | 2            | 列间距 12px，列表改为单条纵向排列 |

网格采用 CSS 多列流，保持单卡不跨列；默认封面比例来自媒体元数据，缺失时才回退 4:3。列表使用缩略图加对齐字段，窄屏省略辅助规格列。类型筛选与网格/列表分段控件留在内容工具条，团队导航不复制一组媒体类型。

桌面详情宽度上限为 `min(1180px, calc(100vw - 64px))`，主预览加 340px 信息栏，间距 28px；761–1020px 信息栏为 280px。手机弹层铺满 `100dvh`，单列内容、顶部关闭入口和底部下载动作保持可达。直接打开深链使用独立详情页；从库打开的弹层保留来源页面。

桌面上传采用 190px 批次历史和弹性任务列；1280px 及以下历史列为 170px，平板及手机改为单列。布局与历史容器必须可收缩（`min-width: 0`）；手机批次条的滚动限定在导航内部（`max-width: 100%`、`overflow-x: auto`、`overscroll-behavior-x: contain`）。不得以整页横移承载批次历史。

## Elevation & Depth

基础页面、素材卡和列表保持平面，通过底色、细线与间距分区。账号菜单及桌面登录卡使用轻阴影，详情使用更深的模态阴影与无模糊遮罩；分段选择与封面选择控件只需要小范围提升。手机登录移除卡片阴影，详情移除外轮廓圆角。

### Shadow Vocabulary

- **浮层**：`0 8px 32px #2023201c`，用于账号菜单和桌面登录卡。
- **模态详情**：`0 24px 80px #20232030`，配合 `#20282065` 遮罩。
- **选中分段**：`0 1px 3px #20232012`，只提升当前分段。
- **封面选择控件**：`0 2px 8px #20232020`，使白色选择框在素材上可辨。

**The 平面内容 Rule.** 素材卡本体不增加常驻阴影；提升属于浮层或已有状态控件。

## Shapes

控件使用 `control`，媒体使用 `media`，对话框与登录卡使用 `dialog` 的圆角。紧凑标签、导航和分段内部采用更小圆角。手机媒体收为 8px；手机详情为零圆角，筛选抽屉只保留顶部 16px 圆角。

边界多为 1px 细线；上传落点采用 1px 虚线，选中封面和键盘焦点采用 2px 轮廓。图标来自 [UiIcon](src/components/ui/UiIcon.vue) 的内联 SVG 路径，按 `currentColor` 绘制，不依赖图标字体。

## Components

### Buttons

简洁、明确的短动作。[UiButton](src/components/ui/UiButton.vue) 提供 `default`、`primary`、`quiet`，默认最小高度 38px；紧凑变体为 34px。手机工作区、分段控件及弹层主要操作扩大到至少 44px，下载另有 44px / 46px 的桌面/手机高度。

主按钮 hover 使用 `brightness(0.92)`；普通按钮使用轻微明度反馈，quiet 与图标按钮使用浅灰底。按下不缩放。忙碌态同时禁用重复操作、设置 `aria-busy` 并显示旋转指示；禁用按钮使用 0.6 透明度。`focus-visible` 使用 2px 深蓝外轮廓、3px 偏移。旋转为 0.8s 线性循环；`prefers-reduced-motion` 下停止并改为点状边框，不新增页面入场动效。

### Inputs / Fields

白底、细边框、控件圆角，普通输入最小高度 42px。搜索嵌在浅底容器中，内部输入透明无边框、桌面 13px；手机搜索最小高度 44px。保留显式 label 或可访问名称，placeholder 只提供提示。搜索有清除动作，输入合成期间延后触发查询；这描述已实现机制，不等同完整中文 IME 验收。

### Chips / Segmented

标签紧凑、矩形小圆角；选择态浅蓝底与深蓝字，并通过 `aria-pressed` 或真实 checkbox 表达状态。分段选择使用灰色轨道、白色当前项和轻阴影；类型和视图各有独立组名。图标视图切换仍有可访问文字，不只依赖图形或颜色。

### Navigation

文字侧栏按团队范围组织，当前位置使用浅蓝底、深蓝字和字重；管理入口按能力折叠。手机导航打开后将背景设为 inert，支持 Escape、Tab 边界和关闭后回到菜单按钮；路由切换关闭抽屉。权限由应用能力决定，不由视觉状态授予。

### Cards / Lists

素材卡由原比例预览、单行标题、格式及收藏组成，不另加装饰外框。缩略图懒加载，失败时保留媒体区域并显示“预览暂不可用”。收藏和选择有独立按钮/checkbox，触屏无需 hover 才能发现。进入选择后操作栏持续可见，批量失败保留具体项目与重试信息；切换网格/列表保留查询和当前选择。

### Detail / Preview

预览与信息并列，下载原件为明确主动作，收藏、加入集合、编辑居次；公开设置另行展开。`UiDialog` 使用原生 modal dialog、关闭入口和焦点恢复；详情返回还恢复来源路由、原卡焦点及滚动位置。图片支持适配和受限放大；MP4 先显示封面，用户操作后取得播放地址，无 autoplay，页面隐藏或销毁时暂停。归档素材只保留允许的静态预览。动效执行仍关闭，浏览器 iframe 属性不能代替服务器隔离。

### Upload / Feedback / Login

上传落点在已有任务时收为紧凑行，任务以文字区分等待上传、上传中、核验中、等待处理、处理中、团队可用、失败、取消和过期。传输进度不等于业务完成；按服务器能力提供“重试处理”或“重选文件重试”，失败通知保留下一步。手机文件名允许换行，批次只在自己的导航内横向滚动。

`UiState` 区分初始加载、空结果和不可访问；`UiNotice` 对错误使用 `alert`、其他反馈使用 `status`。登录页保留密码显隐、提交忙碌态、会话失效后果与重新登录动作；错误后清空密码，不自动重放未提交操作。

### Data / Evidence Boundaries

默认 `/app/library` 连接真实 API。仅 `import.meta.env.DEV` 且路径显式以 `/demo/` 开头时启用演示；演示条持续说明合成数据与页面内存操作，刷新重置，未支持动作明确失败，不向正式 API 回退。生产构建排除演示接口、媒体与场景切换器。24 张原创合成 PNG 与合成 MP4 的来源见[演示素材说明](src/demo/assets/README.md)；PNG 来源扫描为 24 张、0 缺失。演示内容的文字排版和色彩不是平台的新增品牌 token。

本轮[验收记录](../../docs/operations/interface-workbench-validation.md)包含 Web 类型检查与生产构建、UI 构建、目标 ESLint、3 项前端行为测试；浏览器尺寸覆盖桌面、平板与手机，验证演示流程及真实 API 只读入口。独立收尾评审（本地 `.impeccable/review/finish-review.md`，不随版本分发）最终为 `ship`，复审仅覆盖搜索占位符和手机上传横向溢出两项修复；不将该 verdict 扩大为全站签收。

此次未重新验证真实服务器上传/下载/worker 全链路、数据库集成或部署恢复；真实设备 Safari/Android、完整键盘矩阵、中文 IME、200% 缩放、规模性能与断网恢复仍待专项验收。

## Do's and Don'ts

### Do:

- **Do** 让素材保持原比例，用紧凑文字、对齐字段和细分隔帮助浏览与整理。
- **Do** 复用语义文字色检查实际底色上的可读性，保留可见键盘焦点和触屏操作入口。
- **Do** 保留查询、视图、选择和详情返回位置的连续性，并明确逐项失败与下一步。
- **Do** 将横向批次滚动限制在其导航容器内，保持手机正文与动作在视口内。
- **Do** 根据真实能力展示动作，持续区分开发演示、团队可用、公开和归档状态。

### Don't:

- **Don't** 把传输完成画成团队可用，或把预览失败画成原件已丢失。
- **Don't** 用悬停或颜色作为选择、收藏、错误和下一步的唯一入口。
- **Don't** 为普通素材卡添加常驻提升阴影，或把合成素材内部的展示样式升格为应用品牌规则。
- **Don't** 把共用样式覆盖、演示通过或两项修复的 ship 结论写成后续页面、真实设备和完整业务链路均已验收。
