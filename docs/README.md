# 拾灵文档

首期业务实现已经进入 **本地集成与内部试用验收阶段**。账户与权限、Local 上传、图片/MP4 处理、素材库整理、公开快照、游客下载和首期管理入口已有正式代码；真实 PostgreSQL 领域集成与本地 API/worker 闭环已有验证证据。当前状态仍不等于生产就绪或开源发行完成。

## 建议阅读顺序

| 文档                                                                            | 用途与状态                                               |
| ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [项目 README](../README.md)                                                     | 当前能力、运行入口和明确限制                             |
| [重构方案](product/refactor-proposal.md)                                        | 历史功能、产品方向、架构选择和阶段规划；背景与目标文档   |
| [详细设计索引](design/README.md)                                                | 页面、数据、API、权限和交互合同                          |
| [首期业务开发计划](plans/phase-1-implementation.md)                             | T00～T13 任务依赖和验收口径；计划项不等于全部已经通过    |
| [工程开发指南](contributing/development.md)                                     | 固定工具链、专用数据库、本地运行与工程检查               |
| [部署与运行边界](../deploy/README.md)                                           | Local-first Compose、镜像、网络、secret 与持久卷         |
| [部署与验收记录](operations/deployment-validation.md)                           | 当前实际通过、部分通过、未执行和上线阻断项               |
| [本地候选版本与回退](releases/README.md)                                        | 源码提交、固定镜像、离线归档与首版回退边界               |
| [整理与公开界面验收](operations/interface-organization-public-validation.md)    | B 第二批集合、标签与公开页面的浏览器检查及验证边界       |
| [账号与管理界面验收](operations/interface-account-administration-validation.md) | B 第三批账号、成员权限、设置与运行页面的检查及验证边界   |
| [本机 HTTPS 与容量验收](operations/https-capacity-validation.md)                | TLS、Secure Cookie、代理限流、1/4/8 并发及字节上限       |
| [本机 Docker 验收](operations/docker-local-validation.md)                       | 镜像、受限运行权限、持久化、重启与全新卷安全恢复         |
| [三批真实 API 验收](operations/real-api-workbench-validation.md)                | 正式路由、真实 API/worker、账号权限、品牌与公开链路      |
| [备份、恢复、升级与回滚](operations/backup-restore-upgrade.md)                  | 新系统运维顺序与灾备安全门槛；本机 Docker 恢复演练已通过 |
| [待提供媒体与部署信息](operations/m0-required-inputs.md)                        | 代表性媒体、规模、S3、生产域名和恢复目标的集中清单       |

## 已确认设计

- 每个部署实例服务一个团队，不迁移历史数据。
- 成员可以显式公开本人已就绪的素材；游客无需登录即可下载已公开素材。
- 公开 DTO 不展示成员身份，内部修改不会悄悄改写公开快照。
- 首期只归档/恢复，不提供永久删除。
- 标签字典由管理员或明确获委派的角色治理；个人收藏保持私有。
- HTML/ZIP 只接受自包含静态内容，不运行安装或构建脚本；服务器执行隔离未通过前禁止新动效进入 ready。
- 界面已确认 B「创作工作台」，按[重构评审](design/07-interface-redesign-proposal.md)三批前端已实现并检查桌面/手机，账号与管理证据见[第三批验收](operations/interface-account-administration-validation.md)，见 [ADR 0005](adr/0005-interface-redesign-scope.md)。[产品上下文](../PRODUCT.md)记录已确认产品事实。
- D01 公开重开和 P03 较早备份恢复采用不同语义，见 [ADR 0002](adr/0002-public-reopen-and-tag-governance.md) 与 [ADR 0004](adr/0004-product-defaults-recovery-and-m0-scope.md)。

## 实现与验证边界

| 范围                         | 当前结论                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Local + PostgreSQL + pg-boss | 已有正式实现；图片与 MP4 合成样例完成真实 HTTP/worker 闭环                                                                                     |
| 身份、素材整理、公开与撤回   | 正式代码和真实 PostgreSQL 集成测试已覆盖主要首期路径                                                                                           |
| Web 页面                     | 正式入口使用真实 API；B 三批另有隔离的开发演示入口，见[界面验收](operations/interface-workbench-validation.md)；真实设备与完整异常矩阵仍待扩展 |
| 动效                         | HTML/ZIP 结构检查已实现；执行器隔离与真实录制封面未具备，因此上传与执行保持关闭，不属于可用素材类型                                            |
| S3                           | 只有适配边界和验收矩阵；当前配置只接受 `local`                                                                                                 |
| Docker/生产环境              | 本机 Docker/HTTPS、重启恢复及短时并发基线已通过；生产域名、真实负载和目标环境未验收                                                            |
| 品牌                         | 文本配置与静态 PNG/JPEG/WebP 品牌文件接收已实现；Logo/favicon 可上传、预览、应用、读取与清除                                                   |
| 临时对象治理                 | 到期无引用对象的定时回收与 GC 栅栏已实现并通过 PostgreSQL/Local 集成测试；全量对象对账和长期压力仍待验证                                       |

所有验证都要说明输入、环境和限制。合成样例通过不能推导为任意真实媒体都受支持；进程存活或 `/health/ready` 也不能替代登录、上传、处理、公开和下载的业务验收。

## 历史设计与记录

[工程基础范围](adr/0001-foundation-scope.md)、[基础验证记录](operations/foundation-validation.md)和 [M0 技术风险验证](operations/m0-risk-validation.md)保留当时的边界与证据。其中“尚未实现”只描述记录生成时点，不应覆盖当前代码状态；当前结论以代码、迁移、测试和[部署与验收记录](operations/deployment-validation.md)为准。

原型 [v0.1](prototypes/v0.1/README.md) 是已被替代的探索记录；v0.2 是当前实现的历史视觉基线，固定沿用限制已由 ADR 0005 替代。新方向已确认为 B「创作工作台」，原型图本身不是运行页面验收证据。

## 归档与隐私边界

仓库只保存新系统设计、代码和中性合成验证。不得写入旧项目源码、历史业务数据、真实成员或素材、凭据、私有域名、个人绝对路径或内部基础设施信息。修改规则后应同步更新模型、API、权限、页面、ADR 与验收记录，不得把计划或架构说明当作功能已经实现的证据。
