# 本机 Docker 部署与恢复验收

HTTPS、Secure Cookie、代理限流与并发上传另见[HTTPS 与容量套件](https-capacity.md)。

使用项目固定 Node 24.22.3 / pnpm 12.21.0，先安装仓库依赖；合成 MP4 需要宿主 FFmpeg。Docker 必须是本机 Unix socket，脚本拒绝远程 context。默认 `desktop-linux`，可显式设置 `SHILING_DOCKER_CONTEXT`。不读取项目私密 `.env`，不连接宿主数据库，不复用已有部署。

## 执行顺序

脚本创建随机 `shiling-acceptance-*` 项目名、独立数据库和对象卷，两组服务仅绑定 `127.0.0.1:18080` / `18081`（另占 `18443` / `18444`）。请先确认这些端口空闲。凭据、原始报告、备份均位于新的系统临时目录，目录权限 0700，敏感文件权限 0600；不得提交该目录内容。

```sh
export SHILING_DOCKER_CONTEXT=desktop-linux
export SHILING_DOCKER_RELEASE=acceptance-local
node tests/deployment/docker-acceptance.mjs prepare
# 使用上一步输出的 statePath；不要填写其他实例的配置文件。
STATE_PATH=/path/from/statePath
node tests/deployment/docker-acceptance.mjs build "$STATE_PATH"
node tests/deployment/docker-acceptance.mjs start "$STATE_PATH"
node tests/deployment/docker-acceptance.mjs regression "$STATE_PATH"
node tests/deployment/docker-acceptance.mjs audit "$STATE_PATH"
node tests/deployment/recovery-http.mjs baseline "$STATE_PATH"
node tests/deployment/docker-acceptance.mjs restart "$STATE_PATH"
node tests/deployment/recovery-http.mjs persistence "$STATE_PATH"
node tests/deployment/docker-acceptance.mjs recovery "$STATE_PATH"
node tests/deployment/docker-acceptance.mjs database-restart "$STATE_PATH"
node tests/deployment/docker-acceptance.mjs status "$STATE_PATH"
node tests/deployment/docker-acceptance.mjs stop "$STATE_PATH"
```

每步成功后才继续。`regression` 要求未初始化实例，只执行一次；`restore` 拒绝已有目标卷，不覆盖任何已有副本。失败时保留状态排查；不要重复执行完整 `recovery` 去覆盖中途结果。`stop` 只停止本次两组容器，保留卷、备份与私密凭据供复核；它不删除数据，也不停止 Docker 引擎。临时目录不是长期或异地备份位置，检查结束后按实际保留规则处理。

## 覆盖内容

- `start`：官方 PostgreSQL 基础镜像上的首次引导、owner/migrate/app 分权、两次正式迁移，以及 API/worker/preview/Caddy 就绪。
- `regression`：复用工作台 12 组真实 HTTP 用例，经过 Caddy 同源入口，包括账号、角色、品牌、PNG/MP4、集合和公开下载。
- `audit`：非 root 应用、只读根文件系统、能力撤销、preview 不挂载秘密/对象卷、数据库不映射宿主端口、表归属 owner、运行角色不可 CREATE；静态敏感路径 404，动效上传 403。
- `restart` / `persistence`：重启数据库及应用，再 `down`（不带 `-v`）后重建；核对素材标识、元数据、全部图片/视频产物摘要、品牌和集合，新上传仍可 ready。
- `recovery`：停 worker 准备待处理上传及旧资格；停全部写入者并确认数据库无其他客户端；`pg_dump -Fc` 与 Local 卷归档、可读性和 SHA-256；原实例写入备份点后标记，再停止；向全新卷还原并执行 `restore-safety` dry-run/apply/verify，之后才启动业务。
- 恢复业务断言：备份后标记不在恢复副本；原件/派生媒体/品牌摘要一致；旧 cookie、邀请、恢复令牌和**尚未到期**的 grant 被拒绝；旧待处理上传失败，不被新 worker 继续处理；公开关闭、active 快照撤回；新上传可处理。
- 轮换恢复实例签名与初始化密钥，再次认证；管理员打开公开入口仍不复活 withdrawn 快照，管理员不能替成员发布，成员自己重新公开后游客可下载。
- `database-restart`：只重启 PostgreSQL，验证 API 自动重连、品牌/公开素材可读、新任务可由 worker 处理。

恢复负向检查在隔离网络/回环入口上暂时保留旧签名密钥，确认失效并非仅靠更换密钥；随后显式轮换。测试把 grant TTL 设置为 600 秒，检查时必须尚未过期，否则失败。`recovery` 连续执行这些步骤，避免人工停顿导致授权自然到期。

报告 `state.json` 仅记录本次进度、摘要和时间；`restore-dry-run.json` / `restore-applied.json` 是数量摘要；`backup/manifest.json` 记录备份摘要及镜像版本。`credentials.json`、`browser-fixture.json` 和 `recovery-probes.json` 包含合成凭据，不得输出或提交。业务验收通过不等于生产 HTTPS、目标架构/真机、容量、异地副本可取回、升级回滚或正式 RPO/RTO 已验证。

实际结果见[Docker 验收记录](../../docs/operations/docker-local-validation.md)。
