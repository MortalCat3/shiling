# 配置示例

此处只能使用中性示例值。根目录 `.env.example` 覆盖当前 Local-first API、worker、数据库、来源、上传与授权配置；Compose 的非秘密参数见 `deploy/compose/.env.example`。两者都不包含可用凭据，也不代表生产域名、容量、S3 或恢复已经通过验证。

实例 secret 必须在部署目标上生成并保持在 Git 之外。不要把本地 `.env`、真实数据库 URL、内部域名、账号或对象存储密钥复制为公开示例。
