# 部署配置总表与信息交接单

适用于当前单团队实例、Docker Compose、阿里云 OSS、动效执行关闭的方案。本文集中说明配置放在哪里、需要部署者提供什么、哪些内容可自动生成；不表示已经部署或通过真实云验收。所有域名、路径和 Bucket 均为中性示例。

本轮已知条件：目标服务器已有 Docker 部署的 PostgreSQL，后续按复用现有容器准备，不默认再启动 Compose 内置数据库。版本、容器名、网络名和端口暂不清楚，可按[只读查询说明](../../deploy/compose/postgres-external.md)取得；专用库/角色也仍需核对。尚未连接或修改目标数据库，内置数据库的首次初始化步骤不适用于这个已有服务。

## 1. 需要提供的信息

可以先填写已有信息，尚未准备的填“待定”。密码、AccessKey Secret、SSH 私钥和完整带密码的数据库 URL 不粘贴到聊天或本文，只提供受控文件路径。

| 项目                     | 请提供                                                                                                                | 用于配置                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 服务器                   | 已有/待准备；云厂商与地域；公网 IP；Linux 发行版、CPU 架构、核数、内存、可用磁盘；Docker/Compose 是否安装             | 选择匹配架构的镜像、实例目录、资源预算和网络             |
| 服务器连接               | 后续需要协助操作时提供 SSH host/端口/用户名、已有 SSH 配置别名或私钥文件路径、是否有 sudo；无需提供云平台主账号密码   | 受控服务器操作；收集信息不代表授权上线                   |
| 主站域名                 | 计划使用的完整主机名，例如 `assets.example.org`；DNS 服务商及是否能修改解析                                           | Web 入口、HTTPS、Cookie 与 API 来源                      |
| 现有入口                 | 是否已有 Nginx/Caddy、负载均衡或 CDN；80/443 是否占用；是否只能内网访问                                               | 决定由谁终止 TLS、转发到哪里及信任哪个代理               |
| 公开页面                 | 默认与主站同域；若必须另用域名，给出该域名                                                                            | 默认清单支持同域；独立公开域名需要补反代配置和验收       |
| 数据库选择               | 随应用部署专用 PostgreSQL，或使用已有 PostgreSQL/RDS                                                                  | 现有 Compose 内置 PostgreSQL；外部库需按下文补适配       |
| 外部数据库（仅选外部时） | 供应商、PostgreSQL 版本、内网 host/端口、专用库名、运行/迁移用户名、连接凭据文件路径、TLS/CA 要求、网络白名单或安全组 | 运行连接、迁移连接、数据库引导和网络/TLS                 |
| OSS                      | Bucket、region、HTTPS endpoint、测试前缀、生产前缀、凭据 JSON 文件路径；Bucket 私有与版本控制状态                     | 远程对象存储；测试与生产使用独立范围及凭据               |
| 现有拾灵数据             | 全新空实例，还是需要保留本机/旧部署中的新拾灵数据                                                                     | 决定初始化还是执行成套迁移；不迁移历史平台数据           |
| 使用规模                 | 成员数、峰值同时上传人数、单文件上限、视频大小/时长、当前总容量与月增长估计                                           | 冻结上传、队列、临时空间、内存与备份预算                 |
| 备份                     | 保存位置、保留天数、可接受数据损失时长/恢复时长、可安排的维护窗口、负责人员                                           | 制定并验收备份与恢复；OSS 本身不等于应用备份             |
| 团队与管理员             | 团队显示名称、首位管理员登录名/显示名；Logo 可后补                                                                    | 初始化后在产品页面配置；管理员密码由本人在初始化页面设置 |

当前不需要额外提供 Redis、独立消息队列或 SMTP。任务使用 PostgreSQL/pg-boss，邀请与恢复链接由管理员通过可信渠道交付。OSS 访问地址也不是网站域名，页面、API 和授权下载仍由主站提供。

## 2. 配置放在哪里

下面所有路径相对仓库根目录。Docker 使用明确的 `--env-file`，不要把本地开发 `.env` 当成服务器部署配置。

| 文件或位置                                                                                                    | 内容                                                                             | 谁填写                                                                     |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `deploy/compose/.env`                                                                                         | 服务器监听、主站来源、域名、OSS 非秘密参数、secret 文件路径、容量/并发、版本选择 | 根据本交接单生成；模板是 [.env.example](../../deploy/compose/.env.example) |
| `deploy/compose/secrets.local/database-url`                                                                   | 含运行账号密码的单行 PostgreSQL URL                                              | 内置数据库由脚本生成；外部数据库由部署者受控提供                           |
| `deploy/compose/secrets.local/migration-database-url`                                                         | 含迁移账号密码的单行 PostgreSQL URL                                              | 同上；仅迁移任务挂载                                                       |
| `deploy/compose/secrets.local/postgres-password`、`app-password`、`migration-password`                        | 内置数据库初始化使用的随机密码                                                   | 由脚本生成，不需要人为编写                                                 |
| `deploy/compose/secrets.local/setup-token`、`csrf-secret`、`delivery-secret`                                  | 初始化凭据、CSRF 密钥、下载 grant 签名密钥                                       | 由脚本生成                                                                 |
| `deploy/compose/secrets.local/oss-credentials.json`                                                           | OSS `accessKeyId`、`accessKeySecret`，使用 STS 时再加 `stsToken`                 | 部署者填写；文件位置也可在仓库外，通过 env 指定                            |
| [compose.yaml](../../deploy/compose/compose.yaml) + [compose.oss.yaml](../../deploy/compose/compose.oss.yaml) | 服务、网络、挂载、固定关闭的动效执行、OSS 驱动                                   | 随源码提供，常规参数从 env 传入                                            |
| DNS 控制台与服务器安全组/防火墙                                                                               | 域名解析、网络可达性                                                             | 部署者操作，不是修改 `.env` 就会自动生效                                   |
| 产品的初始化/管理页面                                                                                         | 管理员账号、团队品牌、成员、角色和产品设置                                       | 实例启动后配置，保留既有权限规则                                           |
| 根目录 `.env`                                                                                                 | 直接运行 Node 服务时的开发配置                                                   | 仅用于本机开发/验收；模板是[根配置示例](../../.env.example)                |

不要改前端代码来设置数据库或 OSS 密钥，前端始终使用主站 API。secret 文件不打包进镜像、不提交 Git；基础脚本通过私有目录和文件挂载处理容器读取。新增 OSS 文件须让 API/worker 的容器 UID 1000 可读，不能只把文件设成 root 独占而使应用无法读取。

## 3. 数据库如何选择和配置

### 使用现有 Compose 内置 PostgreSQL

不需要提前购买另一套数据库，也不需要提供数据库密码。清单会创建专用 `shiling` 数据库与持久卷，内部地址为 `postgres:5432`，数据库端口不暴露到公网。应用使用 `shiling_app`，迁移使用 `shiling_migrate`，对象 owner 为不可登录的 `shiling_owner`。这些账号与网页管理员账号无关。

只在准备**新的实例凭据目录**时，从仓库根运行以下脚本；本信息整理过程不会执行它：

```sh
node deploy/compose/create-secrets.mjs
```

脚本生成上述 8 个基础 secret 文件，数据库 URL 内的密码与初始化密码保持一致，不输出值。然后再把 OSS JSON 放入这个目录。如果目录已经存在，脚本会拒绝覆盖；如需另建实例可使用 `--output` 指向新目录，再同步 env 中的文件路径。不要为添加 OSS 而重新生成既有数据库密码；修改 secret 文件不会自动修改数据库里的密码。

基础路径映射如下，默认相对于 Compose 文件所在目录：

```dotenv
SHILING_POSTGRES_PASSWORD_FILE=./secrets.local/postgres-password
SHILING_APP_PASSWORD_FILE=./secrets.local/app-password
SHILING_MIGRATION_PASSWORD_FILE=./secrets.local/migration-password
SHILING_DATABASE_URL_FILE=./secrets.local/database-url
SHILING_MIGRATION_DATABASE_URL_FILE=./secrets.local/migration-database-url
SHILING_SETUP_TOKEN_FILE=./secrets.local/setup-token
SHILING_CSRF_SECRET_FILE=./secrets.local/csrf-secret
SHILING_DELIVERY_SECRET_FILE=./secrets.local/delivery-secret
```

### 使用已有 PostgreSQL / 云数据库

目前应用使用 PostgreSQL，不能填写 MySQL 地址。要创建拾灵专用库和独立角色，不能接入未知业务库或使用超级用户作为 API/worker 运行账号。部署基线在 PostgreSQL 18 上验收，其他版本和托管服务须先验证兼容性。

运行和迁移连接分别放在 `database-url`、`migration-database-url` 文件中，每个文件一行 URL，格式如下；真实密码只保存在文件里，并按 URL 规则编码：

```text
postgresql://shiling_app:URL_ENCODED_PASSWORD@db.example.org:5432/shiling
postgresql://shiling_migrate:URL_ENCODED_PASSWORD@db.example.org:5432/shiling
```

这两个示例未包含目标服务的 TLS 参数，不可直接作为云数据库生产连接。需要根据供应商要求设置证书验证、CA 挂载及网络许可，并验证 `pg_trgm`、角色切换、业务 schema 和 pg-boss 的迁移/运行权限，见[数据库引导](../../deploy/postgres/README.md)。

**基础 Compose 是内置数据库方案，不能只改 URL 就宣布外部数据库接好。** 同机已有 PostgreSQL 容器现提供[外部数据库覆盖说明](../../deploy/compose/postgres-external.md)，处理默认关闭内置数据库、移除相关启动依赖和 API/worker/迁移加入指定已有网络；目标连通性尚未验证。宿主机直装或云数据库仍需按其网络、TLS/证书挂载和健康检查准备适配。OSS 覆盖本身不能替代迁移进程的数据库网络配置。

## 4. 域名、HTTPS、OSS 和容量参数

从 `deploy/compose/.env.example` 准备实例 `.env` 后，按实际信息修改以下字段；保留上一节的基础 secret 路径。此示例只是填写说明，包含占位域名和 Bucket，不是可以直接上线的完整实例配置。

```dotenv
COMPOSE_PROJECT_NAME=shiling

# 主站入口。SITE_ADDRESS 填主机名；两个 ORIGIN 填完整 HTTPS 来源。
SHILING_BIND_ADDRESS=0.0.0.0
SHILING_HTTP_PORT=80
SHILING_HTTPS_PORT=443
SHILING_SITE_ADDRESS=assets.example.org
SHILING_APP_ORIGIN=https://assets.example.org
SHILING_PUBLIC_ORIGIN=https://assets.example.org
SHILING_COOKIE_SECURE=true

# 保留独立预览来源；动效关闭，本轮不需要部署该预览域名的服务或 DNS。
SHILING_PREVIEW_ORIGIN=https://preview.example.org

# OSS 驱动由 compose.oss.yaml 固定启用；私密值放在 JSON 文件。
SHILING_OSS_REGION=oss-cn-hangzhou
SHILING_OSS_BUCKET=example-shiling
SHILING_OSS_PREFIX=shiling-prod/
SHILING_OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
SHILING_OSS_CREDENTIALS_FILE=./secrets.local/oss-credentials.json

# 初始验收预算，不是生产容量承诺。
SHILING_UPLOAD_MAX_BYTES=104857600
SHILING_OSS_MAX_OBJECT_BYTES=104857600
SHILING_VERIFY_CONCURRENCY=1
SHILING_PROCESS_CONCURRENCY=1
SHILING_SESSION_TTL_HOURS=24
SHILING_LOG_LEVEL=info
```

DNS 需要将主站的 A/AAAA 记录指向可达入口；只有实际提供 IPv6 服务时才配置对应 AAAA。直连本方案时，80/443 必须能够到达 Caddy，主站域名写入配置，证书目录保持持久化；Caddy 负责证书申请与续期。[Caddy 官方条件](https://caddyserver.com/docs/automatic-https)说明了这些要求。若已有反代、CDN 或负载均衡，先提供拓扑；TLS 终止位置、来源与信任代理要一起配置，不能直接照抄直连示例。

当前同域方案只需要一个主站域名，不需要单独购买 API、下载或 OSS 域名。预览来源只保留隔离边界，执行开关在 Compose 内固定关闭。若独立公开站点另用域名，不能仅填写 `SHILING_PUBLIC_ORIGIN`，还要配置真实路由和验收。

OSS 的 Bucket 必须满足当前适配器的私有、从未开启版本控制条件。测试前缀和生产前缀分开，凭据采用对应范围的 RAM 权限。JSON 格式、权限策略及内网 endpoint 选择见 [OSS 运维说明](oss-storage.md)。已有 Local 素材需要成套迁移，修改驱动不会搬运文件。

## 5. 自动生成、版本和上线边界

- 部署者提供服务器、域名/DNS、数据库方案、OSS 范围/凭据、容量与备份要求；基础随机密钥和内置数据库连接可由脚本生成。
- Web 管理员密码在初始化页面设置，不需要提供给助手；`setup-token` 只是首次初始化凭据，不是管理员密码。
- 运行镜像版本及摘要由验收后的发布记录提供。现有 `v0.1.0-rc.1` 不含后续 OSS 增量，且已留存镜像为 Linux ARM64；不能假定能直接用于 AMD64 服务器。需按目标架构准备新的可追溯版本。
- 备份目标、频率和保留策略属于运维配置，目前没有一个 `.env` 开关能自动完成异地备份；按[备份恢复手册](backup-restore-upgrade.md)与 [OSS 恢复流程](oss-storage.md)配置并实际演练。
- 本轮仅整理资料，不连接服务器、不改 DNS、不生成真实凭据、不推送或部署线上。提供信息后先完成具体配置和剩余验收，保持现有权限规则与动效执行关闭。

配置准备好后，可以只做语法/合并检查，不启动服务：

```sh
docker compose --env-file deploy/compose/.env \
  -f deploy/compose/compose.yaml -f deploy/compose/compose.oss.yaml config --quiet
```

实际发布还应叠加对应新版本的镜像摘要覆盖文件；启动顺序与验收见 [Compose 指南](../../deploy/compose/README.md)和[发布说明](../releases/README.md)。

## 6. 可一次填写的回复模板

```text
服务器：已有 / 待准备
云厂商与地域：
公网 IP：
系统 / CPU 架构 / 核数 / 内存 / 可用磁盘：
Docker / Compose 是否安装：
SSH 别名或 host / 端口 / 用户名 / 私钥文件路径 / sudo 情况（后续需代操作时填写）：

主站域名：
DNS 服务商 / 是否能改解析：
现有反代、CDN、负载均衡或 80/443 占用情况：
公开页面：与主站同域 / 单独域名：

数据库：使用内置 PostgreSQL / 已有 PostgreSQL：
若已有：供应商 / 版本 / host / 端口 / 拾灵专用库名：
运行账号 / 迁移账号 / 凭据文件路径：
网络限制及 TLS / CA 要求：

OSS Bucket：
Region / HTTPS Endpoint：
测试前缀 / 生产前缀：
Bucket 私有、版本控制状态：
OSS 凭据 JSON 文件路径：

拾灵数据：全新空实例 / 需要保留当前新系统数据：
人数 / 峰值同时上传人数：
单文件上限 / 视频最大大小和时长：
预计存储量 / 月增长：
备份位置 / 保留天数 / 可接受损失与恢复时长 / 维护窗口 / 负责人：
团队名称 / 首位管理员登录名与显示名（可后补）：
```

如果选择内置 PostgreSQL，后面的外部数据库字段可留空。其他暂时不知道的填“待定”；AccessKey、密码、私钥和带密码 URL 始终保存在受控文件中。
