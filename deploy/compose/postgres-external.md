# 连接已有 PostgreSQL Docker 容器

适用于拾灵和现有 PostgreSQL 运行在同一 Docker 主机的情况。保留已有数据库容器及持久卷，由数据库管理者为拾灵准备专用库和角色；不重新部署 PostgreSQL，不迁移其他系统数据。目标实例的版本、网络和权限仍需实际核对。

## 先查询现有容器信息

在服务器执行以下只读命令，找到 PostgreSQL 对应的一行。输出只包含容器名、镜像和网络名，不读取环境变量或数据库内容：

```sh
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Networks}}'
```

再将下面 `YOUR_POSTGRES_CONTAINER` 替换为实际容器名，查看安装的 PostgreSQL 版本；该命令不连接数据库、不需要数据库密码：

```sh
docker exec YOUR_POSTGRES_CONTAINER postgres --version
```

只需回传 PostgreSQL 那一行和版本结果。若命令找不到可执行文件，可先提供镜像名称，由此确认对应镜像的查询方式。不要发送完整 `docker inspect`，其中可能包含数据库密码。若只有 `bridge`、`host`、`none` 网络，或数据库与拾灵不在同一 Docker 主机，需要另行准备网络，不能直接套用本覆盖文件。

## 配置方式

使用 [compose.postgres-external.yaml](compose.postgres-external.yaml) 叠加基础清单。该覆盖文件：

- 将基线自带 postgres 放入未默认启用的 `embedded-database` profile，并移除 API/迁移对它的启动依赖。
- 让 API、worker 和迁移任务加入指定的已有 Docker 网络，worker 继续等待 API 就绪。
- 保持 preview 和 Web 不加入数据库外部网络，preview 仍无数据库凭据、执行关闭。
- 将该网络声明为 `external`，由数据库部署方管理；不会自动创建这个网络或启动、重启已有数据库容器。

上述网络和 profile 行为见 [Docker 网络说明](https://docs.docker.com/compose/how-tos/networking/)及 [profiles 说明](https://docs.docker.com/compose/how-tos/profiles/)。配置使用 [Compose 合并重置](https://docs.docker.com/reference/compose-file/merge/)清除基线依赖，要求当前项目统一使用的 Compose >= 2.24.4。

在实例 `.env` 中增加：

```dotenv
# 填真实网络名称，不是 PostgreSQL 容器名。
SHILING_DATABASE_NETWORK=database_private
```

将运行和迁移连接分别放入私密 `database-url` 和 `migration-database-url` 文件，继续由 `SHILING_DATABASE_URL_FILE` / `SHILING_MIGRATION_DATABASE_URL_FILE` 引用。连接的 host 使用这个网络上 PostgreSQL 的容器名或明确的网络别名，端口使用容器内监听端口，通常为 5432。不要使用拾灵容器自己的 `localhost`，也不要照抄宿主机端口映射。中性格式示例：

```text
postgresql://shiling_app:URL_ENCODED_PASSWORD@existing-postgres:5432/shiling
postgresql://shiling_migrate:URL_ENCODED_PASSWORD@existing-postgres:5432/shiling
```

密码只放在文件中。TLS 参数按现有服务要求配置；此示例不代表已验证目标服务的 TLS。建议使用只包含现有数据库及拾灵所需服务的用户自定义网络；选择已有共享网络前需核对接入范围。如需给数据库增加专用网络，应在核对现有部署定义后明确操作，并保留在其后续容器重建配置中。

在现有 PostgreSQL 内先核对 `shiling` 库与 `shiling_owner`、`shiling_app`、`shiling_migrate` 角色名称是否已使用，再由数据库管理者创建或确认专用库/角色、`pg_trgm` 和最小授权。使用[数据库引导说明](../postgres/README.md)准备受控步骤，不能把脚本直接指向用途未知的数据库。已有实例的密码不会由拾灵自动生成脚本修改；要先确保库内密码与连接文件一致。

为拾灵使用独立的 Compose 项目名。此方案不使用基线自带 PostgreSQL 的首次初始化流程，不执行 `up postgres`，不启用 `embedded-database` 或全部 profiles，也不使用 `--remove-orphans` 清理已有部署。数据库服务健康由其原有部署负责；拾灵仍需验证迁移成功、API 数据库/队列就绪，以及实际 worker 任务完成。

## 与 OSS 一起检查

实例参数与 secret 文件路径准备好后，从仓库根目录检查合并配置：

```sh
docker compose --env-file deploy/compose/.env \
  -f deploy/compose/compose.yaml \
  -f deploy/compose/compose.oss.yaml \
  -f deploy/compose/compose.postgres-external.yaml config --quiet
```

该命令不启动服务，也不证明网络或数据库可连接。实际迁移、启动与运维命令须使用相同的覆盖组合及已核对的新发布镜像摘要。Local 存储可以省略 OSS 覆盖；外部数据库覆盖仍保留。

本覆盖目前仅验证 Compose 合并：默认不启动内置数据库、迁移/API 无内置数据库依赖、运行服务网络与凭据范围保持正确。尚未连接目标服务器，未创建数据库/角色、未修改网络或现有容器；目标版本、连接、TLS、迁移权限和真实业务验收仍待完成。
