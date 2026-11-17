# 本地候选版本与回退

首版为 `0.1.0-rc.1`，仅在本机形成 Git 版本、Linux ARM64 镜像和离线归档。没有推送仓库、镜像注册表或部署线上；包保持 private / UNLICENSED。权限规则不变，Local 存储可用，S3 不可用，HTML/ZIP 动效上传及执行关闭。生产条件仍见[部署验收](../operations/deployment-validation.md)。

## 版本追溯

发布分两次提交：先提交经过检查的源码，再提交镜像构建和验收产生的脱敏清单。注释标签 `v0.1.0-rc.1` 指向第二次提交；镜像 OCI revision 指向第一次源码提交。这样避免让源码提交哈希和包含该哈希的清单互相依赖。两次提交之间只能新增发布记录，不能修改应用、依赖、构建文件或运行配置。

本版实际结果见 [0.1.0-rc.1 验收记录](0.1.0-rc.1/README.md)。

每版保留以下信息：

- `manifest.json`：源码 commit/tree、锁文件 SHA-256、基础镜像 digest、平台、三类镜像的 manifest 摘要、本地 Image ID、离线包大小和 SHA-256。
- `components.json`：本版从离线包读取的 OCI config 摘要及各镜像的操作系统包版本；Buildx 未返回的 config 摘要不从本地 Image ID 猜测。这是组件清单，不是漏洞扫描或许可证审查结论。
- `compose.images.json`：将六个服务绑定到上述三类镜像的内容摘要，禁止自动拉取；运行时使用 `--no-build --pull never`。
- 本地 `release-artifacts/<版本>/`：完整镜像 tar、SHA256SUMS、构建元数据及清单，被 Git 忽略。构建元数据可能含本机路径，不随源码分发。
- `docs/releases/<版本>/`：只保存脱敏清单和实际验收结果，不包含密钥、Cookie、原始日志、截图或备份。

构建的内容摘要不等于“已上传镜像仓库”。本版引用仅在已导入这些镜像的本地 Docker 中可用。标签易被覆盖，所以以清单里的 digest 和校验值为准。基础镜像已锁定；APT 软件源仍可能变化，因此重新构建不保证逐字节得到相同结果，回退应使用保存的原始镜像包。

## 准备与检查

使用仓库固定 Node 与 pnpm。不得读取或提交私密 `.env`、`secrets.local`、数据/备份目录、本地评审缓存和工作记录。合成测试固定值仅用于测试，不可用作部署凭据。暂存前核对文件来源，暂存后以 Gitleaks 8.30.1（官方二进制校验和验证）扫描索引，并复核本机路径、私有域名和二进制素材来源。

```sh
corepack pnpm install --frozen-lockfile
SHILING_DOCKER_CONTEXT=desktop-linux corepack pnpm check:isolated
gitleaks git --pre-commit --staged --redact --no-banner .
git diff --cached --check
```

`check:isolated` 创建随机命名、只绑定回环地址的临时 PostgreSQL，用非超级用户 `shiling_test` 运行完整 `pnpm check`，结束后仅清理自己的测试容器和临时凭据。它不复用宿主或其他实例的库。Linux 默认 context 可改为 `default`，不改变全局 Docker 配置。CI 使用同一入口，但本机通过不代表远端 CI 已执行。

从暂存区导出干净目录再安装/检查，确认不依赖被忽略文件。提交源码后，必须保持工作区干净，再构建：

```sh
SHILING_DOCKER_CONTEXT=desktop-linux node scripts/release-local.mjs build
SHILING_DOCKER_CONTEXT=desktop-linux node scripts/release-local.mjs verify \
  release-artifacts/0.1.0-rc.1/manifest.json
```

脚本只接受本机 Docker Unix socket，使用 `git archive HEAD` 的源码，拒绝覆盖已有版本目录或标签；只构建/导出，不启动业务服务，不推送。检查失败后保留证据，不重写已确认版本；修复后使用新的候选版本号。

使用精确镜像在隔离实例执行[业务回归与恢复](../../tests/deployment/README.md)或[HTTPS 核心回归](../../tests/deployment/https-capacity.md)，把安全的清单和结果加入第二次提交，再创建注释标签。发布前后检查无业务文件差异，并对最终 Git 历史再次扫描。实际执行记录放在对应版本目录中；不能把此流程当成已执行证据。

## 离线导入和运行

先取得受控保存的 tar、SHA256SUMS 和对应源码标签，在归档目录验证后导入：

```sh
shasum -a 256 -c SHA256SUMS
docker --context desktop-linux image load --input shiling-0.1.0-rc.1-linux-arm64.docker.tar
```

导入后运行上述 `verify`，核对镜像内容引用和 OCI 标签。若 Docker 存储后端不保留 digest 引用，检查加载结果并在匹配清单内容前停止，不能回退成可变标签绕过验证。Linux AMD64 需要独立构建、记录和验收，不把 ARM64 包当作跨架构发行。

实际部署另按 [Compose 指南](../../deploy/compose/README.md)准备私密 env、随机 secrets 和空的专用卷；本次没有执行。后续使用精确镜像时，在每条 Compose 命令末尾叠加发布覆盖文件，例如：

```sh
docker compose --env-file "$INSTANCE_ENV_FILE" \
  -f deploy/compose/compose.yaml -f "$RELEASE_DIRECTORY/compose.images.json" \
  up -d --wait --no-build --pull never postgres
```

仍须按 PostgreSQL → 一次性迁移 → API/worker/preview/web 的顺序启动，迁移使用相同覆盖文件并设置 `run --rm --no-build --pull never migrate`。不要把本地验收凭据用于真实部署，也不要执行 `down -v`。

## 首版和后续版本回退

首版没有“上一个已发布版本”。初始化/迁移/业务验证失败时，关闭本次入口和写入者，保留专用卷与日志，在隔离环境修复；不得使用 `0.0.0`、旧验收镜像或未知卷伪装成可回退版本。当前版本可以从同一归档重新导入并重建容器，不能据此声称已经演练跨版本数据库回滚。

后续升级前保存前版源码标签、镜像包/摘要、私密实例配置和同一时间点的数据库/对象备份，并在副本上验证迁移。回退分两种：

1. **仅回退应用**：必须已有 schema 和新写入数据兼容前版的证据；停止新写入者，切换到前版清单中的 digest，启动并验证核心业务。不要盲目执行 down migration。
2. **回退数据**：恢复升级前备份到新卷，按[恢复手册](../operations/backup-restore-upgrade.md)在任何入口/worker 启动前执行 `restore-safety --apply` 与 `--verify`。公开关闭、旧会话/令牌/grant/worker 代次失效，active 快照撤回，由所有者核对后重新公开；管理员不得代发。明确备份点后的数据缺口。

不覆盖唯一数据副本，不永久删除素材，不放宽角色权限，不开启动效来绕过验收。
