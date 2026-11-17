# 备份、恢复、升级与回滚

本手册面向新拾灵实例，不迁移历史平台。当前提供操作顺序和安全门槛；目标环境恢复演练、RPO/RTO 和灾备安全动作的实现状态见[部署验证记录](deployment-validation.md)。没有实际演练时，不能声称备份可恢复或把停机时间作为承诺。

## 一致备份

备份集合应包含同一时间点的 PostgreSQL 逻辑备份、Local 对象目录、数据库角色/扩展/授权定义、运行配置版本和镜像 digest。密钥、Caddy 证书资料单独加密保存，不能提交到 Git。不要只备份数据库，也不要在应用持续写入时随意复制 Local 文件后称为一致备份。

首个可靠基线采用维护窗口：关闭入口、停止所有 API/worker/preview 写入者，保留 PostgreSQL；等待进程退出并核实没有仍在提交的处理任务，然后取数据库和对象备份。以下示例从仓库根执行，`BACKUP_ID`、`SHILING_RELEASE`、`COMPOSE_PROJECT_NAME` 由操作者明确设置，不读取或输出 secret：

```sh
umask 077
mkdir -p "backups/$BACKUP_ID"
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yaml stop web api worker preview
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yaml exec -T postgres pg_dump -U postgres -d shiling -Fc > "backups/$BACKUP_ID/database.dump"
docker run --rm --network none --user 0:0 --entrypoint tar \
  --mount "type=volume,src=${COMPOSE_PROJECT_NAME}_objects,dst=/source,readonly" \
  --mount "type=bind,src=$PWD/backups/$BACKUP_ID,dst=/backup" \
  "shiling-runtime:$SHILING_RELEASE" -C /source -czf /backup/objects.tar.gz .
```

每条命令成功后再执行下一步；失败时保留维护状态并核查，不能因备份文件存在就判断成功。使用部署时实际的 Compose 项目名，先核对卷名；不要自动选择机器上的第一个卷。`pg_dump` 文件不含完整集群角色，角色重建采用已审查的引导定义及独立保存的凭据，恢复时需维持 owner 与默认权限。

核对 dump 可读取、归档可列目录，生成校验和，记录备份时间、schema 版本、组件版本、对象数量/字节数和操作结果；随后按既定加密流程存入独立故障域，并验证可取回。只有完成备份完整性检查才恢复原实例服务。备份保留周期、异地副本、容量告警阈值与 RPO/RTO 由实例实际规模确定。

## 从较早备份恢复

这是数据回退，不是普通重启，也不同于 D01 的公开开关重开。按已确认的 [ADR 0004](../adr/0004-product-defaults-recovery-and-m0-scope.md)，恢复后必须先关闭公开入口，使会话、一次性令牌、grant 和旧 worker 代次失效，将恢复出的 active 公开记录转为 withdrawn；保留公开历史，由所有者核对后重新公开。管理员不能代替所有者重新发布。

1. 隔离恢复环境与公网入口，停止旧 API、worker、preview 和自动重启/调度；确认旧写入者无法重新连接恢复后的数据库及对象存储。保留旧卷作调查证据，不就地覆盖唯一副本。
2. 创建新的空 PostgreSQL 和对象卷，核对恢复目标，采用备份对应版本的扩展、角色及 schema owner。在隔离环境还原数据库和同一备份集合的对象，记录异常；禁止把备份导入未知库。
3. **在任何业务入口或 worker 启动之前执行并验证灾备安全动作**：public off、全部旧会话/一次性令牌失效、grant 安全代次更新、worker generation 更新、恢复 active 记录撤回、旧异步任务被 fence 拒绝。恢复操作生成的代次必须新于任何曾使用代次，不能简单回滚到备份中的值。先完成数据库迁移和应用构建，再使用恢复后的运行数据库 URL 执行：

   ```sh
   # 默认 dry-run，只输出将受影响的数量，不修改数据库
   corepack pnpm --filter @shiling/api restore-safety

   # 核对 dry-run 后显式执行；会取得维护锁，拒绝同库其他客户端连接，并在单个事务中完成安全动作
   corepack pnpm --filter @shiling/api restore-safety -- --apply

   # 返回 safe=true 才能继续；apply 或 verify 结果不安全时退出码为 2
   corepack pnpm --filter @shiling/api restore-safety -- --verify
   ```

   Docker 部署可使用恢复实例对应的 env 文件与项目名，在 PostgreSQL 运行、其他服务停止时执行临时应用容器；入口会读取该实例的 secret 文件，无需把数据库 URL 放入命令行。以下 `RESTORE_ENV_FILE` 必须指向已核对的新恢复实例，不能使用源实例配置：

   ```sh
   docker compose --env-file "$RESTORE_ENV_FILE" -f deploy/compose/compose.yaml run --rm --no-deps api node apps/api/dist/restore-safety.js
   docker compose --env-file "$RESTORE_ENV_FILE" -f deploy/compose/compose.yaml run --rm --no-deps api node apps/api/dist/restore-safety.js --apply
   docker compose --env-file "$RESTORE_ENV_FILE" -f deploy/compose/compose.yaml run --rm --no-deps api node apps/api/dist/restore-safety.js --verify
   ```

   命令只从 `SHILING_DATABASE_URL` 读取目标，拒绝非 `shiling` / `shiling_*` 专用数据库和超级用户。`--apply` 在写入前通过 `pg_stat_activity` 检查同库其他 `client backend`；发现 API、worker、preview、迁移或人工数据库会话仍连接时拒绝写入。该检查只使用非超级用户可读取的连接元数据；若实例撤销了相应查询权限，命令会失败关闭而不是跳过检查。它只是执行时点的防误操作门槛，不能阻止检查后建立的新连接，因此仍须先停止入口、任务进程和自动重启。

   `--apply` 会轮换运行、公开与预览代次，撤销旧会话和未消费令牌，终止恢复出的活动上传/处理尝试，将 active 公开记录追加系统撤回修订并记录系统审计；不会删除素材、产物或公开历史。动作完成后会再次检查安全姿态；若仍存在活动资格、任务、公开记录或其他客户端连接，已完成的安全动作保持提交，但命令以退出码 2 明确失败，必须排除并重复执行。重复执行不会新增重复撤回修订，但会再次轮换代次并留下新的恢复审计。

4. 轮换必要签名/初始化秘密并使旧进程无法取得新配置；轮换密钥不能代替数据库中的会话、代次和状态处理。若 `restore-safety` 未成功执行并通过 `--verify`，就保持入口与 worker 关闭，不能用猜测的 SQL 或环境变量跳过步骤 3。
5. 在维护环境以管理员重新认证，核对素材元数据、原件哈希、派生产物、标签/集合、授权和恢复记录。验证旧 cookie、邀请链接、grant、签名 URL 和旧 worker 均不能继续生效；外部存储已签发 URL 的最大残留窗口也须纳入验证。
6. 验证就绪及任务处理后开放内部成员访问；公开仍保持关闭，先由所有者核对撤回素材。准备恢复公开服务时，由管理员显式打开公开入口；此时全部旧快照仍为 withdrawn，不会自动复活。随后由各所有者逐项重新发布，管理员不得代发布。当前 API 要求公开入口开启后才能发布，不能把“重新发布”安排在开启入口之前。记录恢复点、数据缺口、实际恢复时长与负责人。

恢复安全 CLI 已有真实 PostgreSQL 集成测试，覆盖 dry-run、显式应用、重复执行、同库其他客户端连接拒绝、应用后仍不安全时退出码 2、会话/令牌失效、公开系统撤回、旧 grant 拒绝和 worker 栅栏。[本机 Docker 恢复演练](docker-local-validation.md)进一步通过真实 dump/对象还原、摘要核对和恢复后业务验证。它不替代异地备份可取回、目标生产环境恢复与 RPO/RTO 演练；目标环境没有完成步骤 3～5 时，首次生产上线仍保持阻断。

## 正常版本升级

1. 审阅发行说明、schema 兼容性和运行配置差异；验证当前与目标 Node、PostgreSQL、扩展和存储格式，记录旧/新镜像 digest。
2. 在独立环境使用代表性数据及恢复副本演练迁移、应用检查与备份回退，不能把生产库当测试库。未确认许可证/品牌授权时不对外发布镜像或源码。
3. 进入维护窗口，停止旧写入者并完成一致备份。构建或取得已验证的不可变镜像；迁移使用 `SHILING_MIGRATION_DATABASE_URL`，API/worker 永远使用运行 URL。
4. 单次执行迁移，确认业务和 pg-boss 队列结构版本正确、运行角色 DML 足够。迁移失败保留维护状态，不让旧进程与新 schema 混跑。
5. 启动 API，确认 `/health/ready`；再启动 worker、禁用执行的 preview 和 Web，执行登录、上传、处理、原件校验、下载、归档与公开权限冒烟验证。核对错误率、队列积压、磁盘与内存后完成升级记录。

公开总开关正常关闭后重新打开，按 D01 恢复仍有效的 active 快照，旧 grant 不复活；不要把正常开关操作误用成灾备恢复流程。现有签名链接和撤回窗口应单独验收。

## 版本回滚

仅当已证明新 schema 和数据写入与旧镜像兼容时，才可停止新写入者并切回旧镜像。没有兼容证据时，不提供自动 down migration，也不尝试让旧程序强行读取新数据。

需要恢复升级前数据时，走“从较早备份恢复”全流程：会丢失备份点后的写入，需先确认实际数据缺口；public off、会话/grant/worker 代次更新和所有者重新公开仍然必要。回滚镜像不会自动撤销新签发令牌或恢复旧配置。

PostgreSQL 主版本升级另行使用受支持的逻辑恢复或 `pg_upgrade` 方案，在副本演练并保留旧卷；不能把更高主版本写过的数据目录直接挂回旧镜像。Local 卷、S3 bucket 和数据库清理也不属于版本回滚，不执行永久删除操作。
