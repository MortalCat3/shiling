# 独立预览技术入口

目前不读取文件、不返回素材、不启动浏览器或执行上传内容，也未连接存储或数据库。只有 `GET /health/live`，返回 `executionEnabled=false`、`businessReady=false`；这仅是 HTTP 进程存活检查，不能作为动效沙箱、隔离或媒体能力验收通过的证据。

其他路径返回 `404 PREVIEW_EXECUTION_DISABLED`。没有静态目录、单页应用（SPA）回退页面或将 URL 映射到任意文件的代码。预览授权、独立来源部署、内容安全策略及隔离执行器属于后续批准的实施工作，不能通过添加静态目录临时启用。

| 环境变量             | 默认      | 校验                                     |
| -------------------- | --------- | ---------------------------------------- |
| SHILING_PREVIEW_HOST | 127.0.0.1 | IP 地址或主机名，不接受 URL/端口         |
| SHILING_PREVIEW_PORT | 3001      | 1–65535 整数                             |
| SHILING_LOG_LEVEL    | info      | fatal/error/warn/info/debug/trace/silent |

配置在监听前校验；收到 `SIGINT` 或 `SIGTERM` 信号时关闭监听，超出 10 秒失败退出。与主 API 分开启动并使用不同端口，但本地两个端口本身不代表生产环境安全隔离已完成。

从工作区运行 `pnpm --filter @shiling/preview dev`、`build`、`typecheck` 或 `start`。脚本在本包目录执行，`dev` 和 `start` 通过 Node 的 `--env-file-if-exists=../../.env` 读取可选根配置；未提供时使用默认值，已有进程环境变量优先。`dev` 使用 Node 的文件监听模式与 tsx 加载器，`start` 使用 `dist/index.js`；构建前需要在根工作区安装工具链。Fastify 固定 5.12.8，Node.js 使用 24。
