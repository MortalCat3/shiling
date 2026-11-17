# API 服务

Fastify API 已装配首期正式运行时。启动时连接 PostgreSQL、Local 存储和已由迁移任务初始化的 pg-boss，注册身份、上传、素材、整理、公开、设置、任务和审计路由；API 进程本身不会自动执行迁移。

## 路由范围

| 路由组                                                  | 主要职责                                               |
| ------------------------------------------------------- | ------------------------------------------------------ |
| `/api/v1/bootstrap`、`/setup/*`、`/auth/*`              | 首次初始化、登录、会话、重认证、改密、退出、邀请与恢复 |
| `/api/v1/team/upload-*`                                 | 上传批次、项目、尝试、内容传输、完成、取消与重试       |
| `/api/v1/team/assets*`                                  | 素材查询、详情、编辑、归档/恢复、文件授权、发布与撤回  |
| `/api/v1/team/tags*`、`/collections*`、`/me/favorites*` | 标签、团队集合、个人收藏和批量整理                     |
| `/api/v1/team/admin/*`                                  | 成员、角色、邀请、设置、任务、审计和运维概览           |
| `/api/v1/public/*`                                      | 游客素材列表、详情、facets、下载授权与文件交付         |

公开端使用独立 DTO，不从团队对象临时裁剪；文件通过短期、资源绑定的 grant 交付，支持受控 Range。写操作统一执行同源、CSRF、幂等和 revision/前置条件检查。日志会脱敏 Cookie、授权与 CSRF 头；请求体未知字段不会被静默移除。

## 健康与迁移

- `GET /health/live`：只证明 API 进程响应。
- `GET /health/ready`：检查数据库与队列，全部可用时返回 200，否则返回 503；它不证明媒体处理、文件持久性或业务权限验收已通过。
- `pnpm --filter @shiling/api migrate`：使用 `SHILING_MIGRATION_DATABASE_URL` 创建/升级业务 schema、pg-boss schema 与队列，并把运行权限授予 `SHILING_DATABASE_RUNTIME_ROLE`。只允许对拾灵专用数据库执行。

迁移账号、运行账号和对象 owner 应分离。API 与 worker 使用运行 URL，不能为绕过权限错误改用超级用户；运行时固定 `migrate: false`、`createSchema: false`。

## 关键配置

完整中性示例见仓库根 `.env.example`。以下 secret 没有可用默认值，且至少 32 个字符：

- `SHILING_SETUP_TOKEN`
- `SHILING_CSRF_SECRET`
- `SHILING_DELIVERY_SECRET`

还必须配置专用 `SHILING_DATABASE_URL`、正确的应用/公开/预览来源和 API/worker 共用的 `SHILING_LOCAL_STORAGE_ROOT`。当前 `SHILING_STORAGE_DRIVER` 只接受 `local`；设置为 `s3` 不会降级或伪装成功。

`SHILING_TEMP_OBJECT_RETENTION_HOURS` 默认 24 小时，用于上传与处理阶段尚未被业务引用的临时对象。API 和 worker 必须使用相同值；该配置不会让已接纳原件、归档素材或公开历史进入自动清理。

## 本地命令

```sh
pnpm --filter @shiling/api migrate:dev
pnpm --filter @shiling/api dev
pnpm --filter @shiling/api typecheck
pnpm --filter @shiling/api build
pnpm --filter @shiling/api start
```

`dev` 和 `start` 从仓库根可选加载 `.env`；已有进程环境变量优先。默认只监听 `127.0.0.1:3000`。启动前应先完成迁移并同时启动 worker，否则上传能够接收但不会完成异步核验和处理。

## 已验证与未验证

本地专用 PostgreSQL/Local 环境已经跑通身份、图片、MP4、素材整理、公开、游客下载、Range、撤回和旧 grant 失效。动效在服务器执行隔离未具备时受控失败；S3、真实 Docker 环境、代表性媒体容量和生产恢复尚未验证。详见[部署与验收记录](../../docs/operations/deployment-validation.md)。
