# 拾灵 Shiling

拾灵是一个面向个人与团队、可独立部署的素材管理平台。首期业务代码已经落地，当前处于 **本地集成与内部试用验收阶段**：可在专用 PostgreSQL 与 Local 文件存储上运行完整的账户、图片/MP4、素材整理、公开访问和管理流程，但尚未达到生产发布或开源发行门槛。

## 首期能力与当前状态

| 能力                                                   | 当前状态                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 首次初始化、登录、会话、邀请、成员、角色与权限         | 已实现；真实 PostgreSQL 集成验证通过                                                                     |
| 图片上传、核验、派生预览、素材库、编辑与归档           | 已实现；API → pg-boss → worker → Local 全链路验证通过                                                    |
| MP4 探测、H.264/AAC 播放版、封面、Range 播放和原件下载 | 已实现；合成 MP4 全链路验证通过，代表性真实媒体矩阵仍待验证                                              |
| 标签、集合、个人收藏、批量整理                         | 已实现；领域集成验证通过                                                                                 |
| 公开快照、游客浏览/下载、撤回与旧授权失效              | 已实现；公开 DTO 不含成员身份，HTTP 闭环验证通过                                                         |
| HTML/ZIP 动效                                          | 已实现离线结构与安全检查；服务器执行隔离未具备，因此上传入口与不可信执行均保持关闭，不会误进入 ready     |
| 系统设置、任务、审计和运维概览                         | 已实现首期管理入口；品牌文本、类型限额、静态 Logo/favicon 上传、预览、应用和清除均可管理                 |
| 临时对象治理                                           | 已实现保留期、引用复核、GC 栅栏、迟到写 tombstone、崩溃残留清扫、周期回收与队列退避                      |
| 独立部署                                               | 本机 Docker/HTTPS、业务回归、持久化、重启恢复及 1/4/8 并发基线通过；生产域名、真实容量与目标环境仍待验收 |
| S3                                                     | 保留存储适配边界，当前版本只接受 `local`；未提供实际目标，不属于已验证能力                               |

这里的“通过”只指对应的本地合成样例与专用测试环境，不代表任意媒体、生产容量、S3 或灾备均已验证。完整证据和限制见[部署与验收记录](docs/operations/deployment-validation.md)。

首个本地候选版本为 `0.1.0-rc.1`，构建、源码追溯、摘要校验和回退步骤见[发布说明](docs/releases/README.md)。

## 本地运行

需要 Node **24.22.3**（或更新的 Node 24 补丁）、Corepack、PostgreSQL 18，以及用于 MP4 处理的 FFmpeg/ffprobe。仓库固定 pnpm **12.21.0**。

1. 按锁文件安装并构建：

   ```sh
   corepack pnpm install --frozen-lockfile
   corepack pnpm build
   ```

2. 按[专用数据库引导](deploy/postgres/README.md)创建拾灵自己的数据库与最小权限角色。不要连接未知数据库，也不要让 API/worker 使用超级用户。
3. 将 `.env.example` 复制为不纳入 Git 的 `.env`，替换数据库 URL 和三项随机 secret。API 与 worker 必须指向同一 `SHILING_LOCAL_STORAGE_ROOT`。
4. 执行迁移：

   ```sh
   corepack pnpm --filter @shiling/api migrate
   ```

5. 分别启动 API、worker 与 Web：

   ```sh
   corepack pnpm dev:api
   corepack pnpm dev:worker
   corepack pnpm dev:web
   ```

Web 默认监听 `http://127.0.0.1:5173`，API 默认监听 `http://127.0.0.1:3000`。`GET /health/live` 只表示进程存活；`GET /health/ready` 还会检查数据库和队列，但仍不能代替实际登录、上传和下载验收。完整本地准备与安全边界见[工程开发指南](docs/contributing/development.md)。

## 验证

```sh
corepack pnpm check:isolated
# 已明确准备专用测试库时，也可直接执行：
corepack pnpm check
```

`check:isolated` 使用本机 Docker 临时创建 PostgreSQL 和受限测试角色，结束后只移除本次测试容器；不读取私密 `.env`、不连接宿主数据库。Docker Desktop 可通过 `SHILING_DOCKER_CONTEXT=desktop-linux` 指定现有 context。

集成测试会重建 `shiling_test` 中的 `shiling` schema，只允许数据库名与用户名均为 `shiling_test` 的非超级用户目标。详见[测试说明](tests/README.md)。

启动 API 与 worker 后，还可用中性内存 PNG 运行可重复 HTTP 闭环；密码只通过当前进程环境传入：

```sh
corepack pnpm test:e2e:http
```

前置条件与安全清理行为见[端到端验证说明](tests/e2e/README.md)。

## 项目结构

| 目录                 | 职责                                       |
| -------------------- | ------------------------------------------ |
| `apps/web`           | Vue 团队端与公开端页面                     |
| `apps/api`           | Fastify API、鉴权、安全适配和文件交付      |
| `apps/worker`        | pg-boss 核验与媒体处理任务进程             |
| `apps/preview`       | 独立预览入口；当前明确关闭不可信动效执行   |
| `packages/contracts` | 浏览器与服务端共享的公开合同               |
| `packages/backend`   | 领域服务、数据库迁移、任务和存储适配       |
| `packages/media`     | 图片/MP4 探测与派生、HTML/ZIP 结构安全检查 |
| `packages/ui`        | 浏览器端共享样式、组件与格式工具           |
| `extensions`         | 可信扩展边界                               |
| `deploy`             | Local-first 独立部署、镜像和数据库引导     |
| `tests`              | 合同、真实 PostgreSQL 集成和后续端到端验证 |

从[文档索引](docs/README.md)继续阅读架构、详细设计、权限、部署和验收说明。

## 许可与发布状态

最终开源许可证尚待确认。当前包均为 `private`，标记 `UNLICENSED`，尚未授予开源许可，也未发布 npm 包、镜像或站点。对外发布前仍需完成许可证与第三方归属审查、真实部署/恢复演练、安全检查及发行内容确认。
