# 前端工程入口

Vue 3、TypeScript 与 Vite 应用，按已确认的 v0.2 方向实现团队与公开页面。页面通过同源 `/api/v1` 访问真实 API，不提供演示素材或假登录。

当前前端包含初始化、登录、邀请与恢复、素材库、上传工作区、详情、收藏、集合、标签、公开快照及管理表单。接口不可用会显示失败与重试状态；服务端未返回的设置能力保持不可编辑。前端编译通过不代表对应后端、存储、媒体执行或完整业务验收已通过。

## 边界与结构

- `src/app`：路由、会话、同源请求、页面 DTO 与返回来源状态。认证凭据由 HttpOnly Cookie 承载，前端仅保留当前会话与 CSRF 值；退出或切换账号清空团队缓存。
- `src/features`：按身份、素材、上传、整理和管理划分页面与请求编排。公开详情使用独立公开 DTO，不从团队对象裁剪成员字段。
- `src/components`、`src/layouts`：基础展示组件与团队/公开布局；语义设计 token 和格式工具来自 `@shiling/ui`。
- 上传进度使用 XHR 实际传输字节；服务端确认核验、处理与入库状态。刷新后恢复任务记录，需要重传时重新选择本地文件。浏览器不会在后台模拟成功或自动重放结果未知的操作。
- 详情使用原生模态焦点约束，保留列表查询、已加载记录和返回位置；编辑冲突保留输入并要求重新确认。图片、MP4 与主动动效分别请求授权，动效不允许回退到主站执行。

## 本地命令

先按[项目文档入口](../../docs/README.md)准备固定版本的运行环境并在仓库根目录安装依赖，再从仓库根目录执行：

```sh
pnpm --filter @shiling/web dev
pnpm --filter @shiling/web typecheck
pnpm --filter @shiling/web build
pnpm --filter @shiling/web preview
```

开发服务仅监听 `127.0.0.1:5173`，将 `/api/v1` 代理到本地 `127.0.0.1:3000`。构建预览仅监听 `127.0.0.1:4173`，不提供 API 代理。端口占用时直接失败，不自动换端口。`preview` 需要先完成 `build`，仅用于本地检查构建产物，不作为生产服务；完整运行需由部署反向代理统一页面与 API 来源。

`tsconfig.json` 继承仓库的严格检查规则，并使用适合浏览器打包的模块解析方式。`vue-tsc` 同时检查 Vue 单文件组件、应用 TypeScript 与 Vite 配置。该包不依赖后端或媒体执行包。

## 依赖基线

直接依赖均固定精确版本；完整依赖树由仓库根目录的锁文件维护。运行环境遵循根目录约定的 Node.js 24。

| 依赖                 | 固定版本 | 核验依据                                                                      |
| -------------------- | -------- | ----------------------------------------------------------------------------- |
| Vue                  | 3.5.45   | [官方 npm 软件包仓库](https://registry.npmjs.org/vue/3.5.45)                  |
| Vue Router           | 4.5.1    | 固定成熟版本，与仓库严格 TypeScript 检查保持兼容                              |
| Vite                 | 8.3.8    | [官方发布记录](https://github.com/vitejs/vite/releases/tag/v8.3.8)            |
| `@vitejs/plugin-vue` | 6.0.11   | [官方 npm 软件包仓库](https://registry.npmjs.org/@vitejs%2fplugin-vue/6.0.11) |
| `vue-tsc`            | 3.3.14   | [官方发布记录](https://github.com/vuejs/language-tools/releases/tag/v3.3.14)  |
| TypeScript           | 6.0.3    | 与仓库检查工具统一，由根目录维护版本基线                                      |
| `@types/node`        | 24.19.2  | 与仓库 Node.js 24 基线统一                                                    |

Vite 与 Vue 官方插件的 Node.js 要求覆盖 Node.js 24；Vue 的单文件组件类型检查采用官方推荐的 `vue-tsc`。参见 [Vite 环境要求](https://vite.dev/guide/)和 [Vue TypeScript 工具说明](https://vuejs.org/guide/typescript/overview.html)。实际可用性以仓库检查结果为准，版本范围本身不替代构建验证。
