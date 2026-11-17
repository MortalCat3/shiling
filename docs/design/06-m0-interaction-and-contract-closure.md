# M0 交互状态与合同收口

- 状态：M0 已冻结的实施合同；首期业务已按该合同进入实现与本地集成验收
- 日期：2026-11-16
- 范围：修复既有页面、模型、API、权限和验收之间的缺口，不新增首期功能

本文与 01～05 分册共同构成首期合同。冲突时以本文和 [ADR 0004](../adr/0004-product-defaults-recovery-and-m0-scope.md) 的 M0 决策为准；后续实现应把规则回归为可执行 schema、OpenAPI 和测试，不能长期复制两套真相。

## 1. 统一交互规则

### 1.1 结果不确定与会话变化

- 写操作超时或断线后，先以安全读取或操作标识确认服务端结果；危险写操作不得自动重放。
- 401 返回登录；429 遵循 `Retry-After`。退出全部会话、改密或账户切换后清除私有缓存、令牌和旧账号草稿。
- 只允许同一账号、同一页面保留无害的未提交输入。切换账号时清空；公开、归档、角色、设置等写操作从不自动续交。
- `FRESH_AUTH_REQUIRED` 是可恢复的密码再确认分支，不等同于永久无权限；再确认后必须重新读取权限和目标状态。用户取消再确认时不提交原操作。

### 1.2 页面状态矩阵

| 页面/流程      | 必须区分的状态                                                                   | 动作与恢复                                                                                                                                                       | API/能力                                               | 验收                                 |
| -------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------ |
| 初始化         | 未初始化、管理员已建立但后续配置未完成、已初始化、结果未知                       | `POST /setup/initialize` 只负责一次性建立管理员；成功即关闭初始化入口，随后登录并在受保护设置页继续品牌/类型/健康配置。超时先查 `GET /bootstrap`，不得重建管理员 | bootstrap、setup、auth、settings                       | PF-01、ID-04、UX-13                  |
| 登录/邀请/恢复 | fragment 已清理、令牌无效/已消费、账号已预留/未预留、提交结果未知                | 令牌只保存在内存；刷新丢失后提示重新打开原链接。已预留 `loginName` 只读，未预留时接受页填写；角色只读。未知结果引导登录确认，不重复创建身份                      | auth invitations/recovery                              | ID-10～ID-12、PF-14                  |
| 上传           | 待上传、上传中、传输中断、核验中、排队、处理中、就绪、失败、取消中、已取消、过期 | 刷新以服务端真相恢复；“取消中”仅是客户端请求状态。处理失败且原件已核验时只重试处理；取消/过期重新建 Item；ready 后取消冲突引导归档                               | uploads.create/readOwn/retryOwn/cancelOwn 或 governAny | UP-01～UP-14、PF-03～PF-05、UX-06/07 |
| 上传整理       | 元数据编辑与 ready 竞争、可选标签/集合失效                                       | 409 后读取关联 Asset，保留输入并由用户明确转到素材编辑；不得自动改投 Asset PATCH。失效的可选整理目标进入 `organizationWarnings`，不把合格媒体标成处理失败        | UploadItem metadata、Asset PATCH                       | UP-07/13/14、CF-03、UX-06/13         |
| 素材库         | 空库、无结果、首次失败、分面失败、加载更多失败、游标失效                         | 加载更多失败保留既有项；分面失败不抹掉列表；游标失效保留查询并从首批重载。刷新首批时清空不再可确认的选择；详情返回合并已确认变化                                 | assets、facets                                         | PF-06/08、UX-03/04/13                |
| 详情/编辑      | grant 到期、预览失败、访问被撤销、412、离开未保存                                | grant 到期重新授权；图片/视频预览失败不推断原件丢失；401/404 清除受限缓存；412 保留输入并展示最新值；HTML 不回退到主站同源执行                                   | Asset、delivery/motion grants                          | PF-06/09/16、FL、UX-05/10/11         |
| 标签/集合      | 已绑定停用标签、恢复重名、集合修订冲突/归档                                      | 停用标签可显示、筛选、保留和移除，不能新绑定；单集合条目批次全成或全不变，冲突后重读并确认                                                                       | tags、collections                                      | AU-03～AU-08、AU-11/13、UX-14        |
| 批量/归档      | 素材批量部分成功、集合与素材归档、恢复产物缺失                                   | 成功项更新/移出，失败项保留且只重试失败项；集合归档不影响素材。必需产物缺失时保持归档并返回受控原因                                                              | asset batch、archive/restore                           | AU-11～AU-14、PF-08/12               |
| 本人公开       | none/active/withdrawn 与实例公开开/关组合、更新结果未知                          | 实例关闭不等于 Publication withdrawn；允许有权者撤回，禁止新公开/更新。取消更新保留旧快照；结果未知先读取原操作结果                                              | publication、publishOwn/withdrawOwn/withdrawAny        | PB-01～PB-12、PF-09/15、UX-09        |
| 游客公开       | 空库、无结果、实例关闭、资源不可用、grant 到期、执行预览关闭                     | grant 到期且仍有资格时可有限重取，不要求登录；撤回后停止重试。执行关闭可保留安全静态封面和获准下载，不泄露内部原因                                               | public assets/facets/grants                            | PB-09/10、FL-01/04、PF-10/11         |
| 邀请/恢复签发  | 首次明文丢失、复制失败、需要重新交付                                             | 明文只在首次响应显示；复制失败提供手动选择；响应丢失只能显式撤销/重签并废止旧令牌，不能回放明文                                                                  | admin invitations/recovery                             | ID-10/12、PF-14                      |
| 品牌/设置/任务 | 候选上传成功但保存失败、D01 影响摘要不可用、任务结果未知                         | 品牌候选与设置生效分开；保存失败保留旧引用。影响摘要读取失败不能当作 0，禁止重开。任务重试结果未知先查原任务                                                     | branding、settings、jobs                               | CF-06/08、PF-15、UX-01/13/14         |

### 1.3 UploadItem 显示合同

数据库只保存 `transportState`、可空 `processingState` 和任务事实。`uiState` 是响应时的派生字段，不是第三套持久状态：

| 原始事实               | `uiState`    | 说明                                               |
| ---------------------- | ------------ | -------------------------------------------------- |
| 未创建有效 attempt     | `queued`     | 等待用户开始或服务端签发，不显示虚假百分比         |
| receiving/uploading    | `uploading`  | 可显示可信传输进度；本地网络中断单独标记可恢复提示 |
| verifying              | `verifying`  | 已传输不等于已入库                                 |
| verified 且任务等待    | `queued`     | 等待处理资源                                       |
| version processing     | `processing` | 未知总耗时只显示阶段                               |
| version ready          | `ready`      | 团队可用                                           |
| 任一最终失败           | `failed`     | `safeError` 只含受控 code/message/retryable        |
| 客户端正在确认取消结果 | `cancelling` | 仅客户端瞬时态，刷新后从服务端重新推导             |
| canceled / expired     | 同名         | 不可原地复活                                       |

`UploadItem` 统一返回 `safeError`，不返回含内部信息的 `error`；增加 `organizationWarnings`。处理查询返回 HTTP 200＋业务失败状态，不能伪装成接口故障。

## 2. 领域与 API 合同收口

### 2.1 邀请的稳定修订主体

增加逻辑 `invitations`：`id`、唯一 `userId`、`revision`、`state=pending|accepted|revoked` 与审计时间。邀请 token 通过 `auth_tokens.invitationId` 关联；恢复 token 不关联邀请。

- 管理 API 的 `:id` 始终是 `invitationId`，`expectedRevision` 校验 Invitation 修订。
- 重签复用 Invitation 与 invited User，撤销旧 token、创建新 token、递增 revision；不新增第二个用户。
- 接受、撤销和重签锁同一 Invitation，任意竞争顺序只有一个合法结果。
- 创建/重签只在首次结果返回明文 token；增加读取当前邀请状态与 revision 的管理接口。

### 2.2 上传元数据权限与 ready 竞争

上传项所有者且仍有 `uploads.create`，或具有 `uploads.governAny` 的治理者，可编辑尚未 ready 且未取消/过期项的标题、说明与整理意图。该规则扩充既有能力说明，不增加第 27 个权限 key。

PATCH 使用 UploadItem ETag，并与 ready 提交争用同一 item 锁。ready 先赢返回 409；治理者修改整理意图仍按上传者当前资格校验，不能把素材加入上传者无权维护的集合。ready 后的额外整理走 Asset/Collection 正常 API。

### 2.3 接收核验与版本处理分离

`complete` 的短事务只接纳不可变完成清单、把 attempt/item 置为 verifying，并通过 pg-boss 原子入队接收核验任务；返回 202 时还没有 Asset/Version。

- `upload_attempts` 保存 `completionManifest`、`completionRequestHash`、`verificationQueueJobId`、`verificationFence`、`verificationDeadlineAt`。
- 核验任务以 `uploadAttemptId + generation` 为主体，不写入必须关联 Version 的 `processing_jobs`，也不建立第二套队列。
- 重复 complete 不能改写已接纳清单或重复投递。
- 核验成功后，才在一个短事务中建立 pending Asset、首版、original Artifact、媒体 Job 并原子入队。
- 入队事务失败时 complete/核验提交不得报告成功。

### 2.4 品牌文件独立归属

增加 `branding_assets`，记录上传者、`logo|favicon` 用途、接收/核验状态和安全图片属性。它不是团队 Asset、Artifact 或 Publication。

`product_settings` 使用可空 `logoBrandingAssetId`、`faviconBrandingAssetId` 外键。品牌接收返回已核验候选 ID；设置 PATCH 原子切换引用、revision 和审计。保存失败保留旧品牌；未引用候选与被替换后无引用对象只在独立宽限期和引用复核后清理。

### 2.5 模块命名

物理模块固定为 `identity / ingestion / assets / processing / library / publication / administration`：

| API/产品词                       | 所属物理模块   |
| -------------------------------- | -------------- |
| uploads                          | ingestion      |
| taxonomy、collections、favorites | library        |
| publications                     | publication    |
| settings、audit、operations      | administration |

API、表和权限可继续使用业务资源复数名，不再创建同名重复模块。

### 2.6 公开、清理和隔离降级

- 任何角色都没有 `publishAny`。公开、更新快照和重新公开始终要求 owner＋`publications.publishOwn`；治理者只可按能力撤回。
- 对象能否清理只由“是否已接纳、是否仍有有效写入/执行授权、宽限期、受保护引用和 GC 栅栏”决定，不能因 Job 失败或取消直接删除。已被 Version 接纳的原件和归档素材不进入暂存回收。
- 预览必须使用不匹配主站 Cookie 域的独立主机；只换端口不是隔离。隔离来源或服务器网络/资源隔离缺失、`executePreview=false` 时，不启动或接纳新的执行型结果，也不使用占位封面让新动效 ready。已有 ready 素材的安全静态封面与获准源包下载可保留；恢复隔离后由用户手动重试失败版本。CSP/iframe sandbox 不能代替服务器对 iframe 自导航、DNS、云元数据、CPU、内存和磁盘的限制。

## 3. 合同字段消歧

- 素材批量请求与逐项结果统一使用 `assetId`，不再混用 `items[].id`。
- `GET /team/admin/settings` 返回当前读取时点的只读 `publicationImpact={eligibleActiveCount,evaluatedAt}`，并与 settings revision/ETag 一起展示。计算失败返回可恢复错误，不能把失败当 0；PATCH 仍使用 If-Match。摘要不锁定素材集合，提交时必须按当时有效状态重新判定。
- 品牌设置只接受已核验且用途匹配的 `brandingAssetId`，不接受 bucket/key、任意 URL 或团队素材 ID。
- 邀请创建、读取、撤销、重签均返回安全 Invitation 表示；token 永不出现在后续 GET。

## 4. M1 实施前的可追踪门槛

1. 业务 schema/OpenAPI 与本文字段一致，未知状态、权限和错误码拒绝。
2. 初始化、邀请、上传、公开、品牌和批量操作按本页矩阵形成 API/集成测试。
3. EN-07 覆盖邀请竞争、metadata/ready 竞争、核验提交回滚、品牌替换/清理竞争、无隔离新动效永不 ready。
4. UI 必须以服务端 `actions` 和状态为准；隐藏按钮不能代替后端授权。
5. 当前 M0 文档冻结不等于上述业务验收已通过。
