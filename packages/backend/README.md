# 后端领域与应用用例（@shiling/backend）

后端领域与应用用例通过单一公开入口提供给 API 和 worker。已实现 PostgreSQL 数据库端口/适配器、显式迁移 runner、统一错误与修订检查、幂等记录、事务审计，以及本地账号、会话、邀请、密码恢复、成员与角色服务。

`createDatabase` 只接受显式的 `shiling` 或 `shiling_*` 数据库，拒绝超级用户连接。`runMigrations(database, {ownerRole?})` 必须由受控命令显式调用，应用启动不自动迁移；指定 ownerRole 时只在迁移事务内切换角色。运行角色与迁移角色的授权由部署入口负责。`checkDatabaseReady` 校验迁移编号与校验和，不替代存储、队列或媒体就绪检查。

`createIdentityService(database, options)` 的写操作包含审计。初始化和接受邀请不创建会话；登录才签发随机会话 token，数据库只存 hash。一次性邀请和恢复 token 仅首次响应交付，幂等重放不重复交付明文。当前会话读取最新账号状态、角色能力和授权代次；业务事务可调用 `authorize` 锁定当前身份状态后提交。传输 Cookie、CSRF 校验、Origin 校验、限流与 HTTP 状态映射由 API 入口承担。

前端和 contracts 不依赖本包。跨包使用必须在 `package.json` 中声明工作区依赖，不能深层导入另一个包的 src 文件。

模块职责见 [src/modules/README.md](src/modules/README.md)。业务服务按纵向切片逐步实现，目录和迁移存在不代表完整业务已验收。TypeScript 构建输出 `dist` 目录及类型声明。
