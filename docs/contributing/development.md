# 工程开发指南

当前进入首期业务开发。API、worker、Web 和 preview 使用独立入口；每个业务切片要执行真实成功/失败流程，不把进程启动当作平台验收。部署配置见 [Compose 指南](../../deploy/compose/README.md)，实际验证结果见[运维索引](../operations/README.md)。

## 工具链

| 工具       | 固定版本       | 原因                                                                       |
| ---------- | -------------- | -------------------------------------------------------------------------- |
| Node       | 24.22.3        | Node 24 LTS；与类型声明主版本一致                                          |
| pnpm       | 12.21.0        | 工作区与锁文件统一管理                                                     |
| TypeScript | 6.0.3          | 与当前 typescript-eslint 的 `<6.1.0` 对等依赖范围一致；未直接使用最新 TS 7 |
| Vue / Vite | 3.5.45 / 8.3.8 | 支持当前 Node 基线；使用明确的 Vue 插件与 SFC 类型检查                     |
| Fastify    | 5.12.8         | API 和 preview 的基础进程入口                                              |

版本与 engines/peerDependencies 已对照 [npm 官方软件包仓库](https://registry.npmjs.org/)、[Node 发布索引](https://nodejs.org/dist/index.json)核验。依赖升级应同时验证运行时、编译器、Vue 类型工具与静态检查工具的兼容关系，提交新的锁文件并通过检查。当前版本是工程初始化时的选择，不是永久升级禁令。

## 命令

| 命令（均可加 `corepack` 前缀）       | 内容                                                            |
| ------------------------------------ | --------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`     | 按精确锁文件安装；只允许列入工作区白名单的依赖构建脚本          |
| `pnpm dev:web`                       | 本地 Vue/Vite 开发服务器                                        |
| `pnpm dev:api` / `pnpm dev:preview`  | API 与 preview 独立进程；从根 `.env` 可选加载设置               |
| `pnpm dev:worker`                    | 后台任务进程；只连接拾灵专用数据库与存储                        |
| `pnpm --filter @shiling/api migrate` | 使用迁移 URL 初始化/升级业务及队列结构，执行前核对数据库        |
| `pnpm format`                        | 格式化仓库文本                                                  |
| `pnpm check:project`                 | 检查包版本/依赖方向、文档链接、个人绝对路径与少量高置信秘密形态 |
| `pnpm lint`                          | JS/TS/Vue 代码质量和已配置导入边界                              |
| `pnpm typecheck`                     | 全工作区类型检查                                                |
| `pnpm build`                         | 构建 Web、Node 进程入口与共享包                                 |
| `pnpm smoke`                         | 使用构建产物执行当前工程冒烟检查，覆盖范围以脚本为准            |
| `pnpm check`                         | 顺序执行以上必要检查与构建/冒烟验证                             |

`pnpm check` 的范围以当前脚本和 CI 配置为准；需要数据库的测试只能使用隔离的 `SHILING_TEST_DATABASE_URL`，执行前确认目标名称和独立凭据。工程检查不自动意味着设计中的全部“前置条件／操作／预期结果”业务验收已通过，也不授权部署或连接未知外部服务。

## 本地运行顺序

1. 使用仓库固定的 Node/pnpm，按锁文件安装依赖。不要切换全局默认 Node 或自动改锁文件绕过依赖错误。
2. 先核对本机 PostgreSQL 身份与版本，按[专用数据库引导](../../deploy/postgres/README.md)准备 `shiling_dev` 和可选 `shiling_test`。应用不得使用 `postgres` 库、数据库超级用户或默认操作系统身份。
3. 将根 `.env.example` 复制为 `.env`，为运行、迁移、测试配置独立 URL；替换初始化令牌/CSRF 占位值。把 `SHILING_LOCAL_STORAGE_ROOT` 改为专用数据目录的绝对路径，使不同工作目录启动的 API/worker 指向同一目录。该值只写入私密 `.env`，不提交。
4. 执行 `pnpm build`，再运行 `pnpm --filter @shiling/api migrate`。迁移失败时先处理失败点，不启用运行角色的 DDL 权限。
5. 分别启动 API、worker 和 Web；如核对 preview 进程，再启动 preview，但 `SHILING_PREVIEW_EXECUTION_ENABLED=false` 始终保留。前端来源须与 `SHILING_APP_ORIGIN` 一致，不能混用 `localhost` 和 `127.0.0.1` 导致 cookie/CSRF 问题。
6. 确认 `/health/ready`，然后执行当前切片的真实登录、上传、处理或权限验收。服务重启后核对持久数据；关闭数据库或移除存储访问时，就绪和任务错误应可观察。

独立开发库里运行迁移也是写操作，只能针对已确认的专用数据库。不要为方便测试把真实素材、账号、环境文件或未知业务表导入 fixture。集成测试应拒绝非测试库，不能从生产 URL 自动推导破坏性清理目标。

## 配置与依赖边界

- `.env.example` 包含中性监听、专用库 URL 占位值、Local 配置、来源和开发预算，无可用凭据。不要将运行中的 `.env` 提交或用作公开测试样例。
- `check-project` 跳过私密运行配置；它只是有限的防误提交检查，不能替代完整发布前秘密扫描、Git 历史与许可审查。
- 可在浏览器中安全使用的包不能依赖 backend/media；应用不相互依赖；包的内部源码不能作为跨包公共接口。
- contracts 仅公开浏览器可用的数据合同；数据库、凭据和存储实现归后端包。跨包仅使用公开导出。
- PostgreSQL 与 pg-boss 的结构初始化归迁移角色，运行角色仅有必要的 schema 使用及数据权限。
- Compose 使用 Local 独立部署基线；S3 真实目标、媒体资源预算与恢复仍需单独验证。
- 普通 preview/worker 容器不构成不可信代码执行器。当前动效执行保持关闭，后续隔离验证不能由浏览器 sandbox/CSP 代替。

当前静态导入检查的覆盖范围与限制见[基础验证记录](../operations/foundation-validation.md)。它用于约束源码依赖方向，不是运行时安全隔离。
