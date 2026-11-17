# 集成检查

本目录使用 Node 24 内置 `node:test` 对真实 PostgreSQL 与 Local 文件存储执行首期后端闭环验证。测试文件按顺序运行，因为每个文件都会先核验目标并重建专用测试 schema：

- `phase1-backend.test.mjs`：身份、上传处理、整理、公开、下载、撤回与临时对象引用保护，以及管理记录倒序分页的微秒边界、ID 平局和筛选游标约束；
- `restore-safety.test.mjs`：灾备 dry-run/应用/验证、同库其他客户端连接拒绝、应用后不安全退出码、旧会话与令牌失效、系统撤回、grant 拒绝及 worker 栅栏。

运行前提：

- 已构建 `@shiling/contracts`、`@shiling/backend`、`@shiling/media` 与 `@shiling/api`；灾备测试会启动编译后的 CLI；
- 本机存在独立的 `shiling_test` 数据库和同名非超级用户角色；
- 测试角色拥有该测试库与 `shiling` schema，不得指向开发、生产或其他项目数据库。

运行命令：

```bash
node --test --test-concurrency=1 tests/integration/*.test.mjs
```

如需覆盖连接地址，只允许使用数据库名和用户名均为 `shiling_test` 的 URL：

```bash
SHILING_TEST_DATABASE_URL=postgresql://shiling_test@127.0.0.1:5432/shiling_test \
  node --test --test-concurrency=1 tests/integration/*.test.mjs
```

测试开始时会先核验目标数据库、角色和超级用户状态，然后仅重建 `shiling_test` 中的 `shiling` schema。测试数据、文件和账号均为中性合成内容；Local 文件位于系统临时目录并在结束时清理。
