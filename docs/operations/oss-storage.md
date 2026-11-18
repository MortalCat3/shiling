# 阿里云 OSS 配置、迁移与恢复

本实现保留 `local`，新增 `oss`。每个实例只使用一个驱动和存储位置；不自动混用 Local 与 OSS。SDK 固定为 `ali-oss@6.23.0`，服务端使用 V4 签名。当前验证结果见[OSS 验收记录](oss-validation.md)，本地协议测试不能代替真实阿里云验收。

## 文件如何流转

浏览器 → 现有 API 权限校验 → OSS 私有对象 → worker 下载到私有临时目录 → 媒体处理 → OSS 派生产物。PostgreSQL 保存位置、长度、SHA-256、状态和引用，不保存文件内容。API 和 worker 必须配置同一 region、Bucket、prefix。

浏览器仍通过 API 上传，不持有 AccessKey，也不直传 OSS；服务端以 8 MiB 分片传输，不代表浏览器具有断点续传能力。大文件传输在数据库事务外进行，最后的不可覆盖提交才进入台账锁，提交请求超时为 15 秒。失败会尝试中止分片；进程崩溃的分片由 Bucket 的中止分片生命周期规则兜底。

授权下载继续使用原有短期 API grant。每次请求检查当前成员资格、素材/公开状态和恢复代次，支持 Range。不会返回 OSS 预签名地址，不需要公开 Bucket、配置浏览器 CORS 或静态映射存储目录。撤回后旧 grant 的新请求立即失败；已经开始传输或下载到本地的副本不能撤回。公开 DTO 继续隐藏成员身份，管理员不能代替所有者发布。HTML/ZIP 上传与动效执行继续关闭。

## Bucket 与 RAM

准备新的专用 Bucket，使用标准存储、私有 ACL，并启用阻止公共访问；不要设置允许匿名读取的 Bucket Policy，不要共享给其他系统写入。Bucket 必须**从未开启版本控制**：`Enabled` 和 `Suspended` 均拒绝启动，因为 OSS 的 `x-oss-forbid-overwrite` 在这两种状态下不提供本实现所需的保护。代码检查 ACL 与版本状态，不会自动修改 Bucket。依据：[CompleteMultipartUpload](https://www.alibabacloud.com/help/en/oss/developer-reference/completemultipartupload)、[GetBucketVersioning](https://www.alibabacloud.com/help/en/oss/developer-reference/getbucketversioning)。

运行期间不要在控制台改变上述安全配置。ACL 检查不能替代对 Bucket Policy、匿名访问和网络限制的目标环境验收。不要对运行前缀配置对象自动删除、归档存储转换、WORM 或全局禁止覆盖策略；它们可能破坏读取或 GC。允许仅对未完成分片设置中止规则，例如 7 天；该周期应大于最大传输时间。

运行 RAM 身份只授予指定 Bucket 的状态读取，以及指定前缀的对象读写/中止分片权限。示例中的 Bucket 和 prefix 必须替换；API、worker、备份与恢复身份可进一步分别缩小范围。不要使用主账号密钥或 `AliyunOSSFullAccess`。

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["oss:GetBucketAcl", "oss:GetBucketVersioning"],
      "Resource": ["acs:oss:*:*:example-shiling"]
    },
    {
      "Effect": "Allow",
      "Action": ["oss:GetObject", "oss:PutObject", "oss:PutObjectAcl", "oss:AbortMultipartUpload"],
      "Resource": ["acs:oss:*:*:example-shiling/team-one/primary/*"]
    }
  ]
}
```

这些动作覆盖 HEAD/GET、初始化/上传/完成分片、私有 ACL 与中止分片；不需要列出所有 Bucket 或全桶扫描。恢复到新前缀时，单独授权该目标前缀。动作对应关系见[OSS 权限参考](https://www.alibabacloud.com/help/en/oss/user-guide/authorization-syntax-and-elements)和[对象 ACL](https://www.alibabacloud.com/help/en/oss/user-guide/object-acl)。

GC 只处理数据库确认到期且无引用的对象。OSS 适配器将该键原子替换为零字节私有 tombstone，阻止清理后迟到的上传重新建立同一键；因此运行身份不需要 `DeleteObject`。这些标记应保留，不可用生命周期删除。它们占用对象数量和请求费用；这不是面向用户的素材永久删除功能。Local 仍使用原来的本地 tombstone。

## 环境变量与凭据

```dotenv
SHILING_STORAGE_DRIVER=oss
SHILING_OSS_REGION=oss-cn-hangzhou
SHILING_OSS_BUCKET=example-shiling
SHILING_OSS_PREFIX=team-one/primary/
SHILING_OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
SHILING_OSS_CREDENTIALS_FILE=./secrets.local/oss-credentials.json
SHILING_OSS_TEMP_ROOT=./data/oss-tmp
SHILING_OSS_MAX_OBJECT_BYTES=104857600
SHILING_UPLOAD_MAX_BYTES=104857600
```

| 参数                           | 规则                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `SHILING_STORAGE_DRIVER`       | 默认 `local`；OSS 必须显式设为 `oss`                                                                                 |
| `SHILING_OSS_REGION`           | SDK region，例如 `oss-cn-hangzhou`                                                                                   |
| `SHILING_OSS_BUCKET`           | 专用私有 Bucket 名                                                                                                   |
| `SHILING_OSS_PREFIX`           | 必填，非根路径且以 `/` 结尾；每段仅字母、数字、`_`、`-`                                                              |
| `SHILING_OSS_ENDPOINT`         | 可省略，默认 region 的公网 HTTPS endpoint；只接受对应地域的公网或 `-internal` endpoint，不接受 HTTP、CDN、自定义域名 |
| `SHILING_OSS_CREDENTIALS_FILE` | 私密 JSON 文件路径；相对路径从项目根/`INIT_CWD` 解析                                                                 |
| `SHILING_OSS_TEMP_ROOT`        | worker 下载文件的临时目录；使用后清除，崩溃遗留目录由定期清扫回收；容器可用 tmpfs                                    |
| `SHILING_OSS_MAX_OBJECT_BYTES` | 每个远程对象的读取/写入上限；默认 2 GiB，允许 1 KiB～10 GiB；不得小于 API 上传上限                                   |

凭据文件只存以下结构，示例不可直接使用。凭据不写在 `.env`、源码、命令行参数或日志中。文件权限设为仅运行账户可读，容器需让 UID 1000 可读，避免全员可读或 `chmod 777`。

```json
{
  "accessKeyId": "REPLACE_WITH_SCOPED_ACCESS_KEY_ID",
  "accessKeySecret": "REPLACE_WITH_SCOPED_ACCESS_KEY_SECRET"
}
```

STS 可另加 `stsToken`。初始配置为 STS 时，SDK 每分钟重新读取文件；运维需在到期前原子替换整份 JSON，本程序不自行申请 STS。长期密钥轮换后重启 API/worker。不要开启 SDK 的 `DEBUG=ali-oss` 调试输出。鉴权、网络和流错误会转换为不含签名头或密钥的应用错误。

只切换公网/内网 endpoint 不改变存储位置。更换 region、Bucket、prefix 或驱动会改变位置；已有数据库与配置不一致时，API/worker 拒绝启动，上传与读取也检查记录归属。切换环境变量不是迁移。

## Docker 使用

默认 [compose.yaml](../../deploy/compose/compose.yaml) 保持 Local。选择 OSS 时叠加 [compose.oss.yaml](../../deploy/compose/compose.oss.yaml)，需要 Docker Compose >= 2.24.4：

```sh
docker compose --env-file deploy/compose/.env \
  -f deploy/compose/compose.yaml -f deploy/compose/compose.oss.yaml config --quiet
```

准备实例时，迁移、构建、启动、备份命令都使用同一组 `-f` 参数。OSS JSON 的宿主路径配置在 Compose `.env`，容器路径固定为 `/run/secrets/oss_credentials`。只有 API/worker 挂载此 secret 并加入 `storage_egress` 出网网络，数据库与 preview 继续留在内部网络。内网 endpoint 需要服务器本身具备对应阿里云网络可达性。此覆盖文件不向宿主新增服务端口。

worker 覆盖文件提供 2 GiB 内存、1 GiB `/tmp` 初始预算；建议首次验收把验证和处理并发均设为 1。下载原件、转码输入/输出与并行任务共用临时空间，tmpfs 也消耗内存；上调文件上限必须同时重新验收空间、内存和并发。原 Local `objects` 卷保留挂载但 OSS 不将其作为文件后备位置。

## 成套备份和恢复

备份必须包含 PostgreSQL dump、对象快照、对应代码/镜像版本、非秘密配置和独立保管的密钥。仅复制 Bucket 或仅保存数据库均不完整。对象工具会读取台账，不扫描整个 Bucket；按 UUID 保存所有 `stored` 原件、派生产物和品牌文件，核对长度与 SHA-256，最后才写入完成清单。备份文件含私有素材，应离机加密保存。

以下命令在构建后、明确配置目标数据库与存储的受控终端运行。不要让 shell 开启命令追踪，不要把数据库密码写进命令参数。`pg_dump`/`pg_restore` 的连接可使用受控 `PG*` 环境或 service 文件；示例的对象目录必须尚不存在，父目录由运维先建立。

1. 阻断入口，停止 API、worker、preview、定时任务和其他数据库客户端。保持整个备份窗口停写；工具会拒绝发现其他连接或未完成 GC 的数据库。
2. 保存专用数据库的完整逻辑 dump。对象工具与 `pg_dump` 顺序执行，期间不恢复任何写入。
3. 使用源存储配置导出对象：

```sh
pnpm storage:backup export ./backups/checkpoint/objects --services-stopped
```

4. 校验 dump 可读、清单存在，记录数据库 dump 与 `manifest.json` 的 SHA-256，连同版本与配置记录一起离机保存。完成后再恢复原实例服务。
5. 灾备时先准备新数据库，按[恢复手册](backup-restore-upgrade.md)恢复角色/扩展、匹配 dump 和必要迁移。使用独立的新 OSS 前缀，授予该前缀权限；保持入口及所有服务停止。
6. 配置恢复实例的数据库、新 OSS 前缀及凭据，运行：

```sh
pnpm storage:backup restore ./backups/checkpoint/objects --services-stopped
pnpm restore:safety --verify
```

恢复工具首先比较数据库台账与完整清单，检查每个本地文件的长度和 SHA-256；通过后执行恢复安全动作，再不可覆盖地上传到新前缀、逐个下载复核，最后在事务中重绑定数据库存储位置。它会关闭公开入口、撤回 active 快照、使旧会话/邀请/恢复令牌/grant/worker 代次失效，恢复失败时禁止启动服务。不会自动公开任何素材。

源数据库与对象清单不匹配、文件损坏、同一 OSS 位置、已有目标键、权限不足都会失败。中断后保留原备份，重新恢复配对数据库并选择另一个全新前缀重做；工具不提供覆盖式重试，也不删除旧前缀。确认完整验收及保留期后，再由运维按新系统策略处置旧位置。既有 Local 原位/新卷恢复仍按原手册执行；本工具可将完整 Local 备份恢复到新的 OSS 位置，不能靠改环境变量搬迁文件。

7. 轮换需要轮换的实例密钥，启动恢复实例；验证品牌和全部媒体摘要、旧授权失效、新上传/worker、所有者重新公开与游客下载。公开重开不得自动复活已撤回快照，管理员不得代发。

## 执行验收

`pnpm check:isolated` 覆盖 Local 回归和官方 SDK + 本地 OSS 协议服务的 API/worker/备份恢复；新增恢复测试需要 PostgreSQL 18 的 `pg_dump` 和 `pg_restore` 在 PATH 中。该服务不实现阿里云 RAM、地域网络、TLS 或计费，不能宣称真实云验收通过。

真实 OSS 验收需提前授权专用测试 Bucket、测试前缀与凭据文件，配置 `SHILING_TEST_DATABASE_URL` 指向本机 `shiling_test` 非超级用户专用库（会重置该测试库的拾灵 schema），设置 OSS 变量及 `SHILING_OSS_ACCEPTANCE=1`，构建后运行 `pnpm test:oss`。脚本在指定前缀下创建随机 `acceptance-…/source/` 和 `restored/`，不会使用已有生产键；合成对象保留供复核，测试结束后由运维仅清理该随机测试前缀。真实验收不得以 mock 成功代替，当前实测边界见[验收记录](oss-validation.md)。
