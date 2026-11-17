# 本机 HTTPS 与并发容量验收

此套件仅创建新的 `shiling-https-*` Compose 项目、网络、命名卷和系统临时目录。不连接宿主数据库、已有部署或外部存储，不修改系统证书信任、hosts 或默认 Docker context。

## 前提与执行

使用项目固定 Node 24.22.3 / pnpm 12.21.0，先安装仓库依赖；宿主需 FFmpeg、curl，以及本机 Unix socket Docker 引擎。默认 context 为 `desktop-linux`，可显式设置 `SHILING_DOCKER_CONTEXT`。服务仅绑定 `127.0.0.1:19080` / `19443`，请确保端口空闲。

```sh
export SHILING_DOCKER_CONTEXT=desktop-linux
export SHILING_DOCKER_RELEASE=https-acceptance
node tests/deployment/https-instance.mjs prepare
# 使用输出的 statePath，不填写已有部署配置。
STATE_PATH=/path/from/statePath
node tests/deployment/https-instance.mjs build "$STATE_PATH"
node tests/deployment/https-instance.mjs start "$STATE_PATH"
node tests/deployment/https-capacity.mjs seed "$STATE_PATH"
node tests/deployment/https-instance.mjs clients "$STATE_PATH"
node tests/deployment/https-capacity.mjs https "$STATE_PATH"
node tests/deployment/https-capacity.mjs proxy "$STATE_PATH"
node tests/deployment/https-instance.mjs capacity "$STATE_PATH"
node tests/deployment/https-capacity.mjs backlog "$STATE_PATH"
node tests/deployment/https-instance.mjs limits "$STATE_PATH"
node tests/deployment/https-instance.mjs stop "$STATE_PATH"
```

每步成功才继续。`seed` 只用于未初始化的新实例；`clients` 只创建一次。失败保留现场排查，不重复初始化数据库。`refresh` 用于修复并重新构建镜像后重建本次服务；`proxy-probe` 是排错入口，只记录两客户端状态，不作为通过断言。

`stop` 停止本次业务容器，移除两个带本次标签的临时客户端；保留专用卷、凭据和报告，不删除其他实例、卷或镜像。私密目录不是长期或异地备份位置。

## HTTPS 与客户端边界

套件从正式 Caddyfile 生成临时副本，仅增加本地 CA 签发及一个返回 404 的兄弟域名探针。主站反代、SPA、请求体上限和私有路径阻断均沿用正式配置。`preview.shiling.test` 探针不连接 preview 进程，也不执行任何上传内容。

逻辑来源是 `https://shiling.test`；客户端将标准 80/443 连接映射到上述回环端口，容器客户端通过隔离网络 DNS 访问。只导出 CA **公钥证书**给验收客户端，Node/curl 显式校验证书链与主机名，不使用 `-k` 或关闭 TLS 校验。证书不安装到宿主系统，因此本套件不是浏览器/真机的证书信任验收。

验证 HTTP 308 保留路径/查询参数、未知 CA/错误主机名拒绝、`__Host-`/Secure/HttpOnly/SameSite/Path 属性、无 Domain、Cookie 引擎在明文 HTTP/兄弟域名不发送会话、退出清除、CSRF/Origin 和私有路径拒绝。两个真实不同网络地址的客户端验证限流独立性，客户端 A 每次更换伪造 X-Forwarded-For 仍在第 11 次被限流，B 不受 A 影响。

## 负载与报告

- 主测试：1536×1024 的确定性噪声 PNG/JPEG/WebP，以及 1280×720、24 fps、6 秒、H.264/AAC MP4；依次以 1/4/8 个上传工作流并发提交 4/12/24 个文件。
- 每轮等待全部任务终态，检查原件 SHA-256、必需派生产物及 Range；持续检查 readiness。请求和上传延迟不含所有下游验证的总时间，记录的是本机样例基线，没有生产 SLO 断言。
- 处理失败与恢复：超限声明、禁用动效、损坏文件、摘要不符、中断上传及传输重试；结束后再检查成员治理限制、仅所有者公开、游客 HTTPS 下载。
- backlog：暂停 worker，4 并发提交 6 项，确认仍在 verifying；启动 worker 后全部 ready 且产物正确。
- limits：带合法私有 ancillary chunk 的 16×16 PNG，精确达到 100 MiB；验证上传、处理与原件摘要。超限声明/Content-Length 和实际超过 2 MiB 的品牌文件均返回 413。这是字节边界测试，不代表高像素大图或长视频性能。
- 容量与边界测试期间约每 2.5 秒采样 `docker stats`，另检查 OOM、重启次数及配置资源限制。采样峰值可能漏过瞬时尖峰，不能直接当作机器最低配置。

临时目录内：`capacity-report.json`、`resources.json`、`limits-report.json`、`limits-resources.json`、`backlog-report.json` 是本轮测量；`state.json` 是步骤记录；`proxy.json` 是限流结果。`credentials.json`、`member.json`、Cookie jar 和退出请求头文件含随机合成凭据，均不得输出、提交或对外分享。目录为 0700，敏感文件为 0600。

实际结果与限制见[HTTPS/容量验收记录](../../docs/operations/https-capacity-validation.md)。
