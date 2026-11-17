# 专用数据库与最小权限

引导脚本只用于创建新的拾灵数据库及角色，不探测业务表、不迁移历史平台、不修改未知数据库。正式业务表和队列由应用迁移负责；这里仅建立角色、schema、`pg_trgm` 与授权。

| 主体              | 权限                                                           | 使用位置                                           |
| ----------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| 数据库管理账号    | 创建专用库/角色和扩展                                          | 初始化或受控运维；不交给 API/worker                |
| `shiling_owner`   | NOLOGIN；拥有专用库及 `shiling`/`pgboss` schema                | 对象 owner，不作为运行连接账号                     |
| `shiling_migrate` | 登录、NOINHERIT；具有 owner 的 SET ROLE 资格                   | 一次性迁移、队列初始化；无超级用户/建库/建角色权限 |
| `shiling_app`     | 登录、连接专用库、schema USAGE、表 DML、序列使用、函数 EXECUTE | API/worker；无数据库/schema 所有权或 CREATE 权限   |
| `shiling_test`    | 拥有独立 `shiling_test` 库及 schema                            | 仅本地或 CI 的可重建测试库；不使用生产凭据         |

开发和 Compose 设置 `SHILING_DATABASE_OWNER_ROLE=shiling_owner`，业务迁移显式 `SET LOCAL ROLE`，创建的对象归 owner，默认权限也针对 owner 生效。pg-boss 的结构/队列初始化同样必须在已显式切换 owner 的连接中执行，不能假定业务事务的角色设置会影响另一条 pg-boss 连接。运行时设置 `migrate: false`、`createSchema: false`，仍须用受限账号验证任务领取、完成和维护路径；不要通过给 app 超级权限修补错误。

## Compose 首次初始化

官方 PostgreSQL 入口仅在空卷执行 [001-bootstrap.sh](001-bootstrap.sh) 和 [bootstrap.sql](bootstrap.sql)。这些文件由 `postgres` 构建目标固定进镜像，不再依赖宿主脚本挂载。脚本从 secret 文件读取密码，再通过 psql 引用变量传入；不把密码拼进 SQL 语句或命令行，不开启 shell 跟踪。运行实例后修改 secret 文件不会修改数据库角色密码。[healthcheck.sh](healthcheck.sh) 以运行角色通过 TCP 验证专用库和最小授权，避免首次引导未完成却通过单纯 `pg_isready` 检查。

生产数据库固定为 `shiling`，Compose 使用 PostgreSQL 18 的 `/var/lib/postgresql` 卷布局。升级主版本必须按 PostgreSQL 升级流程执行，不能直接换主版本镜像复用旧数据目录。

## 复用本机 PostgreSQL

首先只核对连接身份、版本、区域设置及预定名称是否已有用途。已有同名库/角色时停止，由操作者确认；脚本不会自动 DROP、覆盖密码或重新授权。开发库默认 `shiling_dev`，测试库独立为 `shiling_test`。以下为由数据库管理者主动执行的初始化步骤，不是启动应用时自动执行的代码：

1. 在当前终端交互式输入随机密码，设置 `SHILING_DATABASE_NAME=shiling_dev`、`SHILING_APP_DB_PASSWORD`、`SHILING_MIGRATION_DB_PASSWORD`。不要把密码写进 shell 历史或共享日志。
2. 用明确的管理连接执行脚本，`ADMIN_PG_URL` 应由本机管理者提供，不能沿用默认操作系统身份去猜测目标：

```sh
psql -X --dbname="$ADMIN_PG_URL" --file=deploy/postgres/bootstrap.sql
```

3. 将相同凭据分别写到私密根 `.env` 的 `SHILING_DATABASE_URL` 和 `SHILING_MIGRATION_DATABASE_URL`，设置 `SHILING_DATABASE_OWNER_ROLE=shiling_owner`。URL 中的密码须百分号编码，数据库必须明确为 `shiling_dev`。
4. 如需要集成测试，设置独立 `SHILING_TEST_DB_PASSWORD` 后执行测试引导；只允许在已确认的新测试库上进行重建测试：

```sh
psql -X --dbname="$ADMIN_PG_URL" --file=deploy/postgres/bootstrap-test.sql
```

5. 设置 `SHILING_TEST_DATABASE_URL`，随后清除终端中的密码变量。测试库由 `shiling_test` 自己拥有，测试迁移的 owner role 留空，不继承开发库的 `shiling_owner` 设置；运行账号与测试账号不应互换。

脚本使用 `ON_ERROR_STOP`，名称已存在会失败；创建角色和数据库并非一个原子事务，中途失败可能留下部分新建对象。先核对失败点，再由管理者决定修复，不要使用清空所有库的兜底命令。若采用自定义库名，须先审查脚本和应用允许范围，不能将脚本定向到既有业务库。

数据库采用 UTF-8 与 UTC 会话；初始区域来自模板/实例初始化。中文检索、大小写和排序行为须在目标区域设置上验证，不能由本机测试推定所有 Linux 部署相同。备份需要同时保存必要扩展与角色授权定义，但不要把包含密码的角色导出文件纳入源码。
