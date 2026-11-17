# 任务进程

worker 是常驻的 pg-boss 消费进程，当前注册三个正式队列：

- `shiling-upload-verify`：读取已完成传输的原件，执行媒体类型、字节数、摘要和结构核验；核验成功后派发处理任务。
- `shiling-media-process`：生成图片预览/缩略图或 MP4 播放版/封面，并在必需产物全部接纳后使素材进入 ready。
- `shiling-storage-cleanup`：只回收保留期已到、无 Artifact/package/current brand 引用且没有有效写入或执行授权的临时对象。

业务状态迁移由 `packages/backend` 负责，图片/视频/HTML/ZIP 的探测与派生物由 `packages/media` 负责。worker 不创建 schema、不执行迁移，也不接受迁移或超级用户凭据。

## 配置

| 环境变量                              | 默认值           | 说明                                                               |
| ------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `SHILING_DATABASE_URL`                | 无               | 必须指向名称匹配 `shiling`/`shiling_*` 的专用数据库和明确角色      |
| `SHILING_LOCAL_STORAGE_ROOT`          | `./data/storage` | 必须与 API 指向同一对象根；生产部署推荐绝对路径或同一持久卷        |
| `SHILING_MEDIA_TEMP_ROOT`             | `./data/tmp`     | 媒体任务临时目录，不得与永久对象目录混用                           |
| `SHILING_VERIFY_CONCURRENCY`          | `2`              | 核验本地并发，范围 1～32                                           |
| `SHILING_PROCESS_CONCURRENCY`         | `2`              | 处理本地并发，范围 1～16                                           |
| `SHILING_TEMP_OBJECT_RETENTION_HOURS` | `24`             | 临时对象最短宽限期，范围 1～720 小时；不适用于已接纳原件或归档素材 |
| `SHILING_CLEANUP_INTERVAL_SECONDS`    | `900`            | 回收任务提交周期，范围 60～86400 秒                                |
| `SHILING_CLEANUP_BATCH_SIZE`          | `25`             | 单批最多认领对象数，范围 1～200                                    |

相对路径按 `INIT_CWD`（未设置时按进程 cwd）解析。通过工作区脚本启动时 API 与 worker 应从同一项目根运行；部署中则挂载同一对象卷。两端路径不同会导致接收成功但处理找不到原件，因此不能各自使用包目录下的隐式存储。

## 运行

```sh
pnpm --filter @shiling/worker dev
pnpm --filter @shiling/worker typecheck
pnpm --filter @shiling/worker build
pnpm --filter @shiling/worker start
```

启动前须先执行 API 迁移入口，确认 pg-boss schema 与三个队列已存在。就绪时进程输出结构化 `worker.ready` 日志；收到 `SIGINT`/`SIGTERM` 后停止接收、等待 pg-boss 优雅关闭并关闭数据库连接。

回收采用数据库短事务认领、`gc_token` 栅栏、事务外精确删除和最终状态确认。任何受保护引用都阻止认领；删除失败会释放认领并立即终止本轮，由 pg-boss 按退避策略重试，不会在同一任务内反复放大。Local 适配器同时清理超过临时对象保留期的严格 `.part-<uuid>` 暂存文件和陈旧内部锁，并以持久 tombstone 保证已经回收的 key 不会被迟到写入复活。这里的“临时对象”不包括任一版本已接纳的原件、公开历史引用或归档素材，也不提供业务素材永久删除。

## 媒体边界

- 图片：保留原件，生成 WebP 预览与缩略图。
- MP4：使用受控 ffprobe/ffmpeg 生成 H.264/AAC faststart 播放版与 PNG 封面，原视频保持不变。
- HTML/ZIP：媒体包可以离线执行自包含结构与资源检查，但当前没有服务器级网络/CPU/内存隔离和真实录制封面。正式接入策略会在创建上传项时以 `UPLOAD_TYPE_DISABLED` 拒绝新动效；即使绕过入口进入旧处理任务，worker 也会以 `MOTION_EXECUTION_UNAVAILABLE` 安全失败。不得将占位封面或浏览器 iframe 当作 ready 证据。

本地 API → pg-boss → worker → Local 的合成图片和 MP4 闭环已通过；真实素材矩阵、资源预算、失败重试压力和容器重启恢复仍需目标环境验收。
