# Compose 独立部署

这里默认提供 Local 存储基线，不连接宿主现有 PostgreSQL。可选阿里云 OSS 使用 [compose.oss.yaml](compose.oss.yaml)，按 [OSS 运维](../../docs/operations/oss-storage.md)配置与验收。示例只监听 `127.0.0.1:8080`；执行以下命令会创建一个新实例的数据卷，只有准备实际运行新实例时才执行。尚未完成的验收见[部署验证记录](../../docs/operations/deployment-validation.md)。

## 新实例顺序

如果复用同一服务器上已有的 PostgreSQL Docker 容器，请先使用[已有容器接入说明](postgres-external.md)及对应覆盖文件；下文启动内置 postgres 和首次初始化的步骤不适用于已有数据库。

从仓库根目录执行，先使用项目固定的 Node 24.22.3。`create-secrets.mjs` 只生成本机随机凭据，不输出值，不覆盖已有 `secrets.local` 目录；中途失败须检查目录后再处理，不应用于轮换密码。

隔离验收或自定义配置可使用 `node deploy/compose/create-secrets.mjs --output /path/to/new-directory`，目标目录必须尚不存在，再将对应 secret 文件位置写入该实例的私密 Compose env 文件。

```sh
cp deploy/compose/.env.example deploy/compose/.env
node deploy/compose/create-secrets.mjs
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yaml config --quiet
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yaml build
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yaml up -d --wait postgres
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yaml run --rm migrate
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yaml up -d --wait api worker preview web
```

必须确认迁移成功后才启动 API 和 worker。迁移命令对应 `pnpm --filter @shiling/api migrate` 的构建入口；它负责业务迁移及 pg-boss schema/队列初始化。运行进程应使用 `migrate: false`、`createSchema: false`，不得为绕过权限错误改成数据库管理员。

访问主站前，检查 `GET /health/ready`，随后执行真实的管理员初始化、登录、图片上传、处理、列表、下载和归档闭环。初始化令牌保存在 `secrets.local/setup-token`，应通过受控本地方式取得并用于首次设置，不能粘贴到公开日志；不提供默认管理员账号或密码。就绪响应不等于上述业务验收完成。

## 配置与凭据

Compose 的 `.env` 只存非秘密参数及 secret 文件位置，运行 URL、迁移 URL、初始化令牌和 CSRF 密钥由只读文件提供。容器入口读取 `*_FILE`，转换为同名业务配置变量；同一变量不能同时设置明文与文件。`secrets.local/` 被 Git 忽略，但本地 Compose secret 不是加密秘密库，宿主管理员和 Docker 管理员仍可读取，应由受控主机和备份加密保护。

数据库名为 `shiling`，连接角色为 `shiling_app` 和 `shiling_migrate`，对象由 NOLOGIN 的 `shiling_owner` 持有。迁移任务设置 `SHILING_DATABASE_OWNER_ROLE=shiling_owner` 并显式切换角色；迁移账号为 NOINHERIT。生成的 URL 指向 Compose 内部的 `postgres` 服务。凭据目录与现有数据卷必须成套保管：数据库已有数据时重新生成文件不会修改库内密码，反而会导致无法连接。不要用 `down -v` 处理认证失败。

`SHILING_UPLOAD_MAX_BYTES=104857600` 和会话 24 小时只是开发预算。代理限制整个 HTTP 请求体，若上传协议带 multipart 封装，单项字节上限应为封装留出预算；最终媒体样例和预算验收前不能把该数值称为生产承诺。grant TTL 与撤回窗口按 API 最终合同单独验证，不能借会话 TTL 推导。

## HTTPS 与网络

对外部署前设置正确的 DNS 和防火墙，在私密 `.env` 中同步修改：

```dotenv
SHILING_BIND_ADDRESS=0.0.0.0
SHILING_HTTP_PORT=80
SHILING_HTTPS_PORT=443
SHILING_SITE_ADDRESS=assets.example.org
SHILING_APP_ORIGIN=https://assets.example.org
SHILING_PUBLIC_ORIGIN=https://assets.example.org
SHILING_PREVIEW_ORIGIN=https://preview.example.org
SHILING_COOKIE_SECURE=true
```

使用域名而非 `http://` 站点地址时，Caddy 按其[自动 HTTPS 规则](https://caddyserver.com/docs/automatic-https)申请证书；需要可用的域名验证、80/443 和出站访问。只把 `SHILING_SITE_ADDRESS` 改为 HTTPS 而保留错误来源或不安全 cookie 配置是不完整部署。首期推荐公开页面与主站同源；独立公开来源需额外配置真实反代和验收。

Local 基线中 API、worker、PostgreSQL 和 preview 只接入内部网络，不发布宿主端口。Web 接入边缘及内部网络；主站 `/api`、`/api/*` 和 `/health/*` 原样转发 API，其他前端页面使用 SPA 兜底，原件/动效路径不会映射为静态目录。Caddy 不配置访问日志，避免把含 grant 的 URL 写入日志；如需添加，先实现查询参数与凭据脱敏。

`preview` 仅为独立进程，其执行开关固定为 false，没有公网路由。今后启用必须使用独立主机名、独立授权交付和资源/网络隔离；主站 cookie 必须为 host-only。只更换端口不隔离 cookie，也不能通过更改环境变量就宣布安全验收通过。

API 的 `SHILING_TRUSTED_PROXY_HOST` 在 Compose 中固定为受控服务名 `web`：只信任该名称解析出的直接相邻地址，短期缓存并随重建更新；解析失败时清除信任。Caddy 默认不信任外部传入的 X-Forwarded-For/Proto/Host，不要改成信任所有来源。直连开发默认不信任转发头；自定义反代只能填写受控代理的单个主机名/IP，不能填 `true`、跳数或全网 CIDR。未配置受信任代理时，API 会使用直接相邻地址，使该代理后的客户端共用按 IP 限流额度。

本机 TLS 与并发结果见[HTTPS/容量验收](../../docs/operations/https-capacity-validation.md)。测试只使用局部信任的本地 CA；生产仍需真实域名、证书签发/续期、网络与浏览器验收。

## 数据卷与健康

| 卷              | 内容                                          | 处理规则                                                                   |
| --------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| `postgres_data` | PostgreSQL 18 数据、WAL、库内角色与业务记录   | 挂载 `/var/lib/postgresql`；不用旧版镜像的 `/var/lib/postgresql/data` 布局 |
| `objects`       | API/worker 共享的原件、派生产物及内部存储文件 | `/var/lib/shiling/objects`；非公开静态目录，须和数据库取得一致备份         |
| `caddy_data`    | 证书、ACME 账户资料                           | 包含秘密，持久保存并限制备份访问                                           |
| `caddy_config`  | Caddy 运行配置状态                            | 与对应版本和非秘密实例配置一起记录                                         |

应用容器以非 root 用户运行、根文件系统只读，`/tmp` 是有大小上限的临时卷；临时卷预算不是媒体任务的完整资源预算。Local 使用命名卷自动继承镜像目录权限，改成宿主 bind mount 后须为容器 UID 1000 设置最小访问权限，不能全目录 `chmod 777`。

Compose 给 API/worker/preview 分别设置 512 MiB/1 GiB/256 MiB 内存及有限 CPU/进程数，属于待媒体样例验证的初始保护值，不是生产规格或服务器沙箱验收。数据库、Caddy、操作系统缓存也占资源，不能把应用限制的总和当成整机最低配置。目标部署须据代表性媒体、并发、磁盘和备份预算调整并验证超限失败路径。

worker 的 `SHILING_VERIFY_CONCURRENCY` 与 `SHILING_PROCESS_CONCURRENCY` 默认各为 2，Compose 显式传入，可按部署预算配置。上传并发数与处理并发数不同，更多上传由持久队列吸收。本机 1/4/8 并发样例通过，worker 曾接近 2 核限制、内存采样峰值约 826 MiB；不据此增加默认处理并发。调整并发须同时验证 CPU、内存、临时空间、数据库连接预算及较大媒体。

`postgres` 健康检查通过 TCP 使用 `shiling_app` 登录专用库，确认角色没有超级用户/建库/建角色权限、所需 schema 可访问但不能 CREATE，并检查 `pg_trgm`。首次引导失败即使 PostgreSQL 进程仍运行也不会被视为就绪；半初始化卷须先核查，不能以重启或清空未知卷修复。API 的 `/health/ready` 验证连接及业务迁移/必要依赖；preview 的 `/health/live` 只证明进程存活。worker 必须进一步验证真实任务完成、重试和代次防护，不能用 PID 存在代替。`depends_on` 只处理启动依赖，不替代运行中故障恢复。

worker 明确使用 `/tmp/shiling-media` 处理临时媒体，避免默认相对目录落入只读根文件系统。临时文件不是备份来源，持久素材仍在 `objects` 卷。

## 运维边界

版本发布使用不可变 `SHILING_RELEASE` 标签，生产记录镜像 digest、源码版本、锁文件和系统组件清单。这里不提供自动发布，也不运行数据库升级或删除已有卷。备份、恢复、升级、回滚按[运维手册](../../docs/operations/backup-restore-upgrade.md)进行；服务器执行隔离、真实对象存储目标和目标环境恢复未通过时，对应能力不能开放。
