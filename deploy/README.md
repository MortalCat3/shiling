# 部署与运行边界

本目录提供首期 Local 存储的独立部署基线：PostgreSQL、迁移任务、API、worker、禁用执行的 preview，以及托管 Web 静态文件的 Caddy。配置和脚本的存在不代表目标机器已经通过容器、媒体、恢复或生产容量验收；实际结果见[部署验证记录](../docs/operations/deployment-validation.md)。

- [Compose 操作说明](compose/README.md)：新实例初始化、启动顺序、HTTPS、secret 与持久卷。
- [部署配置与信息交接](../docs/operations/deployment-inputs.md)：各项配置放在哪里、需要提供什么、哪些密码可自动生成。
- [镜像说明](images/README.md)：构建上下文、运行权限和镜像更新边界。
- [数据库引导](postgres/README.md)：专用角色、schema 与本地数据库。
- [备份、恢复和升级](../docs/operations/backup-restore-upgrade.md)：正常版本升级与较早备份恢复的不同语义。
- [开发指南](../docs/contributing/development.md)：本地工具链和进程启动。

运行角色不拥有数据库或 schema；只有一次性迁移任务接收迁移凭据。预览进程不获得主站密钥、数据库 URL 或原件卷，当前清单不向公网反代 preview，也不提供开启不可信 HTML/JavaScript 执行的选项。普通 Docker 容器、内网和 CSP 不能替代专用执行器隔离验收。

默认部署配置使用 Local；阿里云 OSS 可选覆盖文件、RAM 与恢复说明见 [OSS 运维](../docs/operations/oss-storage.md)。真实云目标尚待单独验收，其他 S3 后端仍未实现。没有历史平台迁移、旧凭据兼容或旧环境恢复步骤。本仓最终许可证和品牌复用许可仍须确认，对外发布不能由部署文件推导为已授权。
