# 构建与运行镜像

首个本地候选版本使用[固定基础镜像清单](../releases/base-images.json)，通过[发布脚本和回退流程](../../docs/releases/README.md)从已提交源码构建、记录内容摘要并保存离线镜像。该流程不推送注册表或部署服务。

[Dockerfile](Dockerfile) 使用固定 Node 与 pnpm 版本安装锁文件依赖、按工作区依赖顺序构建。`runtime` 用于 API、worker 和执行关闭的 preview；`web` 将 Web 构建结果交给 Caddy；`postgres` 基于固定 PostgreSQL 官方镜像，把数据库引导和健康检查复制为明确权限的文件，父目录保留遍历权限，避免宿主挂载脚本的权限/noexec 差异。构建参数允许实例升级镜像，但应保持项目要求的 Node 主版本，并记录 digest，不使用 `latest` 发布。

[Dockerfile.dockerignore](Dockerfile.dockerignore) 是该 Dockerfile 的专用允许清单。只传入工程配置、源码和必要部署入口，排除宿主依赖、构建产物、运行环境文件、素材、备份、Git 历史和评审资料。执行构建前仍需检查源码和测试 fixture 是否包含不应公开的内容。

运行镜像以 `node` 用户运行；Compose 进一步设置只读根目录、临时卷、能力撤销与禁止提权。为保持 pnpm workspace 链接完整，首个基线保留构建工作区及其依赖，没有声称已完成最小镜像裁剪。后续裁剪必须验证各 workspace 导出和原生 Sharp 依赖。

镜像安装 Debian 的 `ffmpeg`/`ffprobe` 供可信媒体处理代码调用，不安装浏览器、不执行上传包中的安装/构建命令。操作系统包受镜像和软件源影响，发布时需保存组件清单、审查 FFmpeg 构建选项及其许可证，不能仅以 npm 锁文件宣称镜像完全可重现。需要按实例资源预算增加 CPU、内存、进程和任务超时限制。

普通应用镜像不是不可信代码沙箱。worker 拥有数据库和存储能力，不得在该进程执行上传的 HTML/JavaScript；未来隔离执行器应使用独立镜像、无主站秘密、受限输入输出和经验证的出站限制。当前 Compose 的 preview 执行固定关闭。

版本参考：[Node 官方镜像清单](https://github.com/docker-library/official-images/blob/master/library/node)、[PostgreSQL 官方镜像说明](https://hub.docker.com/_/postgres)、[Caddy 官方镜像清单](https://github.com/docker-library/official-images/blob/master/library/caddy)。标签可用性与镜像构建/拉取验证是不同检查；本次结果见[部署验证记录](../../docs/operations/deployment-validation.md)。
