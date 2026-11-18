# 接口合同检查

`pnpm test:storage` 验证 OSS 适配器的提交、大小、摘要、范围读取、GC 和错误清理合同。`tests/integration/oss-workflow.test.mjs` 使用官方 SDK、本地 HTTP 协议服务、真实 PostgreSQL 与 API/worker 验证业务及恢复。两者都不能证明与真实阿里云配置兼容；真实目标使用 `pnpm test:oss`，配置和权限见 [OSS 运维](../../docs/operations/oss-storage.md)。
