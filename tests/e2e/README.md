# 真实 HTTP 与工作台验收

固定 Node 24.22.3 / pnpm 12.21.0。先执行 `pnpm -r build`；MP4 合成及处理需要本机 FFmpeg。Web 使用正式 `/app/`、`/public/` 路由，不进入 `/demo/`。

## 隔离实例

仅用于本机 `shiling_test` 数据库及同名非超级用户角色。启动器会确认端口 3000 未占用、测试库没有其他客户端、已有 `shiling` / `pgboss` schema 均属于测试角色，才重建这两个 schema。不能与集成测试同时运行。不会读取项目 `.env` 或触碰 `shiling_dev`。

```bash
SHILING_E2E_RESET_TEST_DATABASE=1 pnpm test:e2e:instance
```

启动器创建随机凭据、系统临时目录以及独立 API/worker 子进程，输出 `credentialsPath`。在另一终端运行：

```bash
pnpm test:e2e:workbench /path/from/credentialsPath
```

首次执行要求全新未初始化实例。12 组断言通过后，在同一临时目录产生：

- `report.json`：已通过的流程名称；不含凭据。
- `browser-fixture.json`：仅本次合成账号和素材的浏览器验收数据，权限 0600。不要提交或输出内容。
- 合成 PNG/MP4 和 API/worker 日志，供本机排错。

Web 的开发代理仍指向 API 3000，可使用 `pnpm dev:web` 后在正式路由复核。验收后向启动器发送 Ctrl+C/SIGTERM；它会结束 API/worker，并删除两个凭据文件。临时报告、日志、合成文件保留供排错，可删除该次启动器创建的目录。测试库仍是可重建的合成数据，下次测试重建，不作为持久工作空间。

该实例用测试角色引导真实 pg-boss 队列，不验证部署环境中 owner/migrate/runtime 三角色的授权配置。生产迁移仍使用正式迁移入口。

## 已有实例回归

`http-regression.mjs` 使用显式提供的 `SHILING_E2E_PASSWORD` 登录 `admin`，可选 `SHILING_E2E_BASE_URL`。它创建中性图片和测试标签，验证真实处理、分面、公开快照、下载/Range、撤回和审计，结束时撤回并归档测试素材、停用标签、恢复公开入口设置并退出会话。只在明确授权的实例上运行，不将密码写入命令或仓库。

覆盖范围与浏览器证据见[真实 API 验收记录](../../docs/operations/real-api-workbench-validation.md)。
