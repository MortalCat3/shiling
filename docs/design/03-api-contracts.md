**拾灵详细设计 03｜API 合同草案 v0.1**

> 公开归档状态：P00/P01/P03 与 D01/D02 已确认；当前只推进 M0，业务未实现。跨分册消歧见 [M0 交互与合同收口](06-m0-interaction-and-contract-closure.md)。

状态：M0 详细设计归档；不是已实现的接口。本文只定义业务合同，不包含业务实现或可执行业务数据库脚本。

基础：承接《拾灵重构方案 v1.0》。已确认 HTML/ZIP 自包含动效、素材仅归档/恢复、公开页不展示成员身份。团队集合＋个人收藏、ready 后团队可用、独立显式公开、无首期原文件替换按已认可方案展开。本稿新增具体路径、字段、状态码与默认参数均为详细设计建议。

**1．合同原则与通用约定**

- 路径前缀：/api/v1；auth 管身份，team 管成员业务，public 仅返回公开投影。管理员管理路由放在 /team/admin，访问由 capability 决定，不能因知道路径而获权。
- JSON 使用 camelCase；主键为不含业务意义的 UUID 字符串；时间为 UTC ISO 8601；数据库 revision、超出 JavaScript 安全整数范围的大小/计数按十进制字符串表达。文件大小在验证后的安全数值范围内可用 number，但合同只保留一种表示，本稿统一 bytes/revision 为字符串。
- 成功单对象返回对象；分页返回 items、pageInfo(nextCursor, hasMore)；不包一层恒为 true 的 success。资源 ETag 与 revision 可同时返回，前者供 PATCH 条件请求使用。
- 可见资源返回 actions，例如 editMetadata、archive、restore、publish、withdraw、download；由服务端当前权限和状态计算。前端不按角色名字硬编码按钮，也不把 actions 当服务端授权凭据。
- 首期 API 为同源 Web 服务，不提供通用第三方 API key 或开发者令牌产品。浏览器直传/交付能力按明确合同发放，不暴露存储长期凭证。
- 内部 DTO 不直接序列化数据库记录；公开 DTO 不通过“删几个字段”的方式由内部 DTO 派生。

**1.1 会话和请求安全**

本地登录采用服务端可撤销的 opaque session；生产 cookie 为 Secure、HttpOnly、host-only、SameSite=Lax，不共享给动效预览来源。带会话的写请求验证 Origin 与 CSRF token。登录、邀请、恢复及初始化同时校验来源、限流和一次性令牌；不把长效凭证放在 localStorage。会话与跨站请求边界参考 [OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)和 [CSRF 指南](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。

角色修改、账号停用、会话撤销后，新的请求重新读取或可靠核验有效授权版本；不能让旧会话中的权限副本继续生效。系统管理的敏感写操作要求最近完成的密码确认；建议 fresh-auth 窗口 10 分钟，最终安全参数在实施配置中固定，不要求用户为每个工程参数单独决策。

**1.2 并发与幂等**

| 场景                                     | 请求要求                                           | 冲突行为                                                                  |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| PATCH 素材、标签、集合、角色、设置       | If-Match 为该 URI 对应资源最近返回的强 ETag        | 缺失 428；不匹配 412；不得静默覆盖                                        |
| POST 归档/恢复、撤回、成员角色与状态变更 | body.expectedRevision                              | 缺失 428；不匹配 409 REVISION_CONFLICT                                    |
| POST 公开/更新公开快照                   | expectedAssetRevision＋expectedPublicationRevision | 首次 publication revision 用 "0"；任何一项变化返回 409，要求重新核对      |
| POST 创建批次、上传项、邀请、集合等      | Idempotency-Key                                    | 同键同请求关联同一业务结果；同键不同规范化请求 409 IDEMPOTENCY_KEY_REUSED |
| POST 取消/失败重试                       | Idempotency-Key；不要求过期的页面 revision         | 服务端锁定并判断当前状态；ready 后取消固定 409，引导归档                  |
| PUT/DELETE 我的收藏                      | 关系自身幂等                                       | 重复操作成功，不产生重复关系                                              |
| 短期交付/预览/上传授权                   | 每次按当前授权重新签发                             | 不从幂等记录重放已过期或已撤回的 URL                                      |

If-Match 针对目标资源的表示，不能拿 Asset 的 ETag 当成 Publication URI 的 ETag。动作接口使用显式业务 revision，区分 412 的 HTTP 前置条件失败和 409 的业务状态冲突。依据：[HTTP 条件请求](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match)、[428 状态码](https://www.rfc-editor.org/rfc/rfc6585.html#section-3)。

幂等键作用域为 actor＋operation＋key，保存 requestHash 与业务资源引用，不存明文令牌或签名 URL。重放先验证当前登录、权限与资源范围，再形成响应。建议幂等记录至少保留 24 小时；令牌仅首次展示的创建操作重放只返回已创建的邀请/恢复记录标识，不重复展示令牌，需走明确的重新签发动作。

**1.3 错误合同**

统一使用 application/problem+json：type、title、status、detail、instance，并扩展 code、requestId、fieldErrors、retryable。instance 使用不含 token 的问题实例标识，不直接回显完整请求 URL。字段错误只含公开字段路径和校验原因；不含 SQL、调用栈、对象存储路径或上游原始响应。依据：[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)。

| HTTP        | 典型 code                                                                        | 客户端行为                                         |
| ----------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| 400         | INVALID_REQUEST、CURSOR_INVALID                                                  | 修正请求；失效游标提示刷新                         |
| 401         | AUTH_REQUIRED、SESSION_EXPIRED                                                   | 登录后返回原路径；不自动重放公开/管理写操作        |
| 403         | ACTION_FORBIDDEN、INSTANCE_POLICY_DENIED                                         | 无相应动作资格；刷新能力，不能用再次确认密码绕过   |
| 403         | FRESH_AUTH_REQUIRED                                                              | 业务尚未修改；密码确认后重新鉴权，由用户明确继续   |
| 404         | RESOURCE_NOT_FOUND                                                               | 不存在或无权得知资源；public 未公开/已撤回一律此类 |
| 409         | REVISION_CONFLICT、ASSET_NOT_READY、UPLOAD_ALREADY_READY、IDEMPOTENCY_KEY_REUSED | 拉取最新状态并由用户决定，不自动覆盖               |
| 412/428     | PRECONDITION_FAILED / PRECONDITION_REQUIRED                                      | 重读 ETag 或补齐前置条件                           |
| 413/415/422 | FILE_TOO_LARGE / UNSUPPORTED_MEDIA_TYPE / MEDIA_VALIDATION_FAILED                | 指出超限、格式或包结构问题，不盲目重试             |
| 429         | RATE_LIMITED                                                                     | 按 Retry-After 等待                                |
| 503         | STORAGE_UNAVAILABLE、PROCESSOR_UNAVAILABLE                                       | 展示可重试状态；不创建虚假的成功发布               |

身份有效但不能访问对象时优先 404；对象已对其可见、只是缺少某个动作权限时返回 403。已进入任务的处理失败通过 UploadItem/Job 状态查询返回 200＋明确 `safeError`，不让轮询接口持续伪装成 HTTP 500。

**2．对象表示与查询规则**

| DTO              | 主要字段                                                                                                                                                            | 明确排除                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| TeamAssetSummary | id、typeId、title、owner 摘要、lifecycle、currentVersionId、tags、collection 摘要、favorite、publicationState、revision、actions、封面 descriptor                   | 密钥、原始存储 key、执行器内部信息                                                                 |
| TeamAssetDetail  | Summary＋description、版本格式属性、artifact 描述、团队创建/更新时间、公开快照状态                                                                                  | 原始日志、凭证；未就绪资源只通过上传工作区返回                                                     |
| PublicAsset      | id、typeId、公开 title/description/publicTags 快照（publicTags 为字符串数组）、format、dimensions/duration、publicationRevision、publishedAt、允许的产物 descriptor | ownerId/name/avatar、成员邮箱、内部备注/标签、原始文件名、集合、上传批次、任务、内部修改时间与审计 |
| UploadItem       | id、batchId、clientItemId、attemptId、transportState、processingState、uiState、assetId(可空)、safeError、organizationWarnings、progress、actions                   | 明文长期授权、任意供应商 SDK 对象                                                                  |
| Collection       | id、name、description、owner、state、revision、visibleItemCount、actions                                                                                            | 自动继承访问权；公开集合投影首期不提供                                                             |
| Job              | id、kind、state、attemptCount、safeError、retryAfter、assetId/uploadItemId                                                                                          | SQL、服务端文件路径、捕获的页面内容、凭证                                                          |

公开下载文件名由公开标题与服务端验证的扩展名生成，不回传原始上传文件名。这里只保证平台 DTO 不展示成员身份；原文件、EXIF、视频元数据和动效包自身内容不承诺自动脱敏。公开表单必须明确说明“游客可下载原文件，文件内信息会随文件公开”。

首期不开放任意文件替换 API。API 中的 versionId 用于不可变内容识别及以后扩展，不能据此推断已有多版本产品功能。

`safeError` 为 null 或 `{code,message,retryable,requestId?}`，只含受控信息；`organizationWarnings` 为 `{code,message}` 数组，默认空。批次摘要与单项详情使用同一语义；整理警告不改变 `uiState=ready`，不得输出 SQL、内部路径或原始异常。

**2.1 素材列表参数**

GET /team/assets 与 GET /public/assets 使用相似查询语义，但 public 不接受内部所有者、集合或归档条件。

| 参数           | 语义                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| q              | 标题/描述/允许标签文本；空白规整；无条件时省略；不接收 SQL/引擎 DSL                                                |
| typeId         | 可重复；多个类型为 OR                                                                                              |
| tagId / tag    | team 用 tagId；public 用 tag 公开文本值；均可重复并默认 AND；public 不接受团队标签 ID                              |
| collectionId   | 仅 team；一个团队集合，不改变素材权限                                                                              |
| favorite       | 仅 team；true 表示当前用户收藏，不能指定其他用户                                                                   |
| owner          | 仅 team；me 或受控用户 ID，仅过滤可见素材                                                                          |
| state          | 默认 active；archived 只查询本人或具治理能力者的可见归档                                                           |
| sort           | createdAtDesc、updatedAtDesc、titleAsc；public 改用 publishedAtDesc、titleAsc；relevance 仅 q 非空且实现验证后启用 |
| cursor / limit | 首期推荐默认 40、最大 100；游标绑定排序、筛选和访问范围，不能变成裸 offset                                         |

排序必须有稳定 id 次序作为平局处理。游标分页不承诺多次请求跨越内容变化时具有数据库快照一致性；变更后可刷新。筛选计数、搜索建议和分页均从同一授权范围产生，不能通过 facet 泄漏内部标题或标签。候选的每页/字段限制由 schema 和能力接口暴露，可在硬上限内配置。

**3．接口清单：初始化、身份与能力**

以下均以 /api/v1 为前缀。

| 方法与路径                     | 请求/返回要点                                                          | 授权与结果                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GET /bootstrap                 | 品牌、安全的公开开关、`initialized`、登录方式显示项                    | 匿名；initialized 只表示首管理员事务完成，不表示依赖健康；无基础设施连接参数                                            |
| POST /setup/initialize         | 一次性部署初始化凭据＋loginName/password/displayName                   | 同事务创建首个 sysadmin、安全默认设置并置 initialized；201 不签 session；消费凭据；再次初始化 409；结果未知查 bootstrap |
| POST /auth/login               | loginName/password                                                     | 限流；成功建立 session，返回 csrfToken 与当前身份；错误统一防账号枚举                                                   |
| GET /auth/session              | user、role、permissionKeys、authzVersion、csrfToken                    | 当前会话；无有效会话 401                                                                                                |
| POST /auth/reauthenticate      | 当前密码                                                               | 只刷新当前 session 的 reauthenticatedAt；不提升权限、延长资源 revision 或自动重放原请求                                 |
| POST /auth/logout              | 无业务 body                                                            | 撤销当前 session；204                                                                                                   |
| POST /auth/logout-all          | 密码确认或 recent-auth                                                 | 撤销本人所有 session；204                                                                                               |
| PATCH /auth/change-password    | currentPassword/newPassword                                            | 本人；修改后撤销所有旧会话并要求重新登录                                                                                |
| POST /auth/invitations/inspect | token                                                                  | 有效时返回 reservedLoginName(可空)、角色安全摘要、expiresAt；不消费 token，不返回成员列表                               |
| POST /auth/invitations/accept  | token、loginName、displayName、password                                | 原子一次性消费并激活邀请预建的 invited 用户，补全/核对登录身份；201；随后独立登录                                       |
| POST /auth/recovery/inspect    | token                                                                  | 仅展示安全恢复摘要；统一失效提示                                                                                        |
| POST /auth/recovery/complete   | token、newPassword                                                     | 原子消费，撤销旧会话；不自动恢复 disabled 用户，不自动登录                                                              |
| GET /team/capabilities         | 当前用户 permissionKeys、动作、类型和格式、有效上传/处理限制、批次上限 | 成员；只公开必要能力，不含 Secret                                                                                       |

本地 loginName 推荐限制为 3–64 位 ASCII 字母、数字、点、短横线和下划线，trim 后按 ASCII 小写规范化；内部 displayName 可用中文，不作为登录唯一键。邀请预留 loginName 时，接受请求必须规范化后匹配；未预留时，在同一激活事务校验并创建唯一身份。该命名限制是设计建议，与无邮箱依赖一致。

首期不依赖邮件：管理员创建邀请/恢复令牌后通过可信渠道交付；唯一管理员无法登录时依赖部署者的受控本地恢复流程，后续实现，不提供匿名网站任意重置管理员的接口。邀请/恢复令牌仅保存摘要、短期有效、一次性消费。浏览器令牌链接使用 fragment，读取后清理地址，通过 POST body 提交，禁止落入访问日志或第三方分析。依据：[OWASP 账户恢复](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)。

**4．接口清单：上传与处理**

| 方法与路径                                     | 关键合同                                                                                                | 权限/返回                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| POST /team/upload-batches                      | clientBatchId；只建立批次，不复制文件                                                                   | uploads.create；201                                                                                                     |
| POST /team/upload-batches/:batchId/items       | clientItemId、fileName、declaredBytes、declaredMediaType、可选 typeHint/expectedSha256、initialMetadata | 批次所有者且 uploads.create；201；clientItemId 在批次内唯一                                                             |
| GET /team/upload-batches                       | 当前用户批次游标列表；管理员有显式 all 范围                                                             | uploads.readOwn / uploads.governAny                                                                                     |
| GET /team/upload-batches/:batchId              | 批次统计和 items 摘要                                                                                   | 所有者或 uploads.governAny；统计推导，不维护第二套冲突状态                                                              |
| GET /team/upload-items/:itemId                 | 原始传输/处理状态、uiState、progress、actions、safeError、organizationWarnings                          | 所有者＋readOwn 或 governAny                                                                                            |
| PATCH /team/upload-items/:itemId/metadata      | 标题、说明、tagIds、目标 collectionIds；If-Match                                                        | owner＋uploads.create 或 uploads.governAny；ready/canceled/expired 禁止；整理意图仍按上传者资格校验；ready 先赢返回 409 |
| POST /team/upload-items/:itemId/attempts       | 请求新的传输尝试；返回 attemptId、transport 模式及 transfer descriptor                                  | 所有者＋create/retryOwn 或 governAny；首次 201；失败重传用新 attempt                                                    |
| PUT /team/upload-attempts/:attemptId/content   | 本地模式流式字节，Content-Length 受限制；不走 JSON parser                                               | 当前有效上传授权；禁止从客户端指定磁盘路径                                                                              |
| POST /team/upload-attempts/:attemptId/parts    | S3 分片的 partNumbers                                                                                   | 为允许分片短期签发 URL；provider 模式才提供                                                                             |
| GET /team/upload-attempts/:attemptId/progress  | 已接收字节/已完成分片和可恢复性                                                                         | 用于刷新恢复；不声称关页后浏览器仍在传输                                                                                |
| POST /team/upload-attempts/:attemptId/complete | 不可变完成清单；首次接纳后重复请求必须同摘要                                                            | 短事务置 verifying 并原子投递 attempt 核验任务后 202；此时无 Asset/Version；核验通过才创建版本与媒体 Job                |
| POST /team/upload-items/:itemId/retry          | scope=transfer 或 processing；不允许指定任意 worker 命令                                                | retryOwn 或 governAny；202；verified 原件不重新上传；ready 无需重试返回 409                                             |
| POST /team/upload-items/:itemId/cancel         | Idempotency-Key                                                                                         | cancelOwn 或 governAny；取消先赢则迟到处理不得提交；ready 先赢 409 UPLOAD_ALREADY_READY                                 |

transfer descriptor 仅含模式、允许方法、有限期 URL/headers、partSize/并发等客户端必需字段，不能返回整个云 SDK 凭证对象。直传完成信号不是入库成功，取消也不能假设立即撤销仍在有效期内的所有云端上传 URL；已取消 attempt 永不接纳为 ready，清理在授权失效和安全宽限后处理。

`complete` 的 202 只表示不可变完成清单、verifying 状态和核验任务已经在同一 PostgreSQL 事务提交；核验任务以 uploadAttemptId＋generation 为主体。队列写入回滚时不得返回 202。核验成功后才原子创建 pending Asset/Version/original Artifact 与媒体处理 Job；重复 complete 不改变清单、不重复入队。

**4.1 状态在 API 中的表达**

- transportState：pending / uploading / verifying / verified / failed / canceled / expired。
- processingState：不存在版本时 null；否则 processing / ready / failed / canceled。
- uiState：由当前有效 attempt、version 和 job 按优先级推导，不作新的数据库状态真相：ready 最高；当前终态为 failed/canceled/expired；pending=`queued`（待上传）；uploading=`uploading`；verifying=`verifying`；verified 且尚未执行=`queued`（等待处理）；当前处理执行中=`processing`。
- transport verified 之后取消处理，不倒改“文件已验证”事实；version 进入 canceled，UI 显示 canceled。
- failed 传输可创建新 attempt；verified＋failed 处理可对同一 versionNo=1 重试并提升执行代次；canceled/expired 终态重新上传须新 Item。
- 进度分阶段表示；未知转码总耗时时显示处理中，不制造虚假的 99% 卡住进度。

传输中断、取消请求待返回和“正在确认结果”是客户端覆盖提示，不进入服务端 `uiState`；刷新后以服务端状态为准。历史 attempt 的失败不能覆盖当前 attempt。ready 项即使有 `organizationWarnings` 仍返回 ready。

重复内容只作提示：核验发现相同摘要时，返回当前用户有权读取的 duplicateCandidates，不增加等待用户去重决定的阻塞状态。允许独立逻辑素材，所有者不变更、不覆盖他人素材，首期不做全局物理去重。上传未就绪可以取消，已就绪可归档本次新素材；不向用户披露不可见上传工作区中的重复项。

上传者被停用或失去 uploads.create 时，未就绪内容在提交前再次校验，处理进入 failed，错误为 AUTHORIZATION_REVOKED；恢复资格后需手动重试。管理员重试不绕过素材所有者的有效资格，已入库内容不因此自动消失。

类型 acceptUploads 关闭只阻止新上传项和新传输尝试；已接纳的当前 attempt、已 verified 内容可按原接收策略继续，但仍满足当前安全硬上限、所有者资格和执行策略。重新传输属于新接收；只重试已验证输入的处理不因接收开关关闭而禁止。executePreview 收紧可阻止动效执行所需步骤/交互，已 ready 的安全静态预览保留；已接纳内容的普通业务限额不因后续调低而追溯失败。

核验成功后的业务写入与入队在同一 PG 事务内完成，使用经过验证的 pg-boss 事务适配；不另做第二套投递引擎，也不接受“先写库再发任务”的无保障双写。媒体 I/O 不在长事务中执行。[pg-boss 事务接口](https://pgboss.io/api/adapters)

**5．接口清单：素材、整理和批量操作**

标签字典按已确认 D02 设计：默认 member 不创建字典项，管理员或受委派治理角色维护。字段/API 采用该规则，但接口实现与验收尚未完成。

| 方法与路径                                     | 关键合同                                                                     | 权限与前置条件                                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET /team/assets                               | 第 2.1 节查询；只列可用范围                                                  | assets.read；默认 active/ready                                                                                                                                     |
| GET /team/assets/facets                        | 与列表同授权条件下的计数和筛选项                                             | assets.read；不含他人上传工作区                                                                                                                                    |
| GET /team/assets/:assetId                      | TeamAssetDetail、ETag、actions                                               | active＋read；archived 仅所有者或 governAny；pending 只经 upload API                                                                                               |
| PATCH /team/assets/:assetId                    | title、description、tagIds；If-Match                                         | active 状态且 editOwn＋owner 或 governAny；不接受 owner/type/currentVersionId/public 字段                                                                          |
| POST /team/assets/:assetId/archive             | expectedRevision、Idempotency-Key                                            | archiveOwn＋owner 或 governAny；原子撤回公开；200 新状态                                                                                                           |
| POST /team/assets/:assetId/restore             | expectedRevision、Idempotency-Key                                            | 同 archive；恢复团队可见，不恢复公开                                                                                                                               |
| POST /team/asset-batch-operations              | action=addTags/removeTags/archive/restore，items 含 assetId/expectedRevision | 每项独立鉴权和短事务；部分成功 HTTP 200，逐项结果也以 assetId 对应输入                                                                                             |
| GET /team/tags                                 | 名称、active/disabled、引用计数可选                                          | tags.read；选择器只展示可新增关联的标签                                                                                                                            |
| POST /team/tags                                | name、可选 description                                                       | tags.manage；规范化名称唯一；201                                                                                                                                   |
| PATCH /team/tags/:tagId                        | name、description；If-Match                                                  | tags.manage；改名不更新已公开快照                                                                                                                                  |
| POST /team/tags/:tagId/disable                 | expectedRevision                                                             | tags.manage；停用字典项，不删除既有素材关系                                                                                                                        |
| POST /team/tags/:tagId/enable                  | expectedRevision                                                             | tags.manage；名称冲突需解决                                                                                                                                        |
| GET /team/collections                          | 团队集合列表                                                                 | collections.read；归档只对 owner/governAny 可见                                                                                                                    |
| POST /team/collections                         | name、description                                                            | collections.create；创建者为 owner；201                                                                                                                            |
| GET /team/collections/:id                      | 集合与可见素材列表，可独立分页                                               | collections.read＋assets.read；不放大素材可见范围                                                                                                                  |
| PATCH /team/collections/:id                    | name、description；If-Match                                                  | active 集合且 manageOwn＋owner 或 governAny                                                                                                                        |
| POST /team/collections/:id/items:batch         | action=add/remove、assetIds、expectedRevision                                | active 集合且 owner/governAny；add 目标须 active/ready 且当前可读；remove 仅移除该集合既有关系，不回传不可见素材信息；整批原子修改，失败不部分提交，不改变素材标签 |
| POST /team/collections/:id/archive 或 /restore | expectedRevision                                                             | 同集合管理；保留条目，不归档其中素材                                                                                                                               |
| PUT /team/me/favorites/:assetId                | 无 body                                                                      | favorites.manageOwn＋可读 active 素材                                                                                                                              |
| DELETE /team/me/favorites/:assetId             | 无 body                                                                      | 仅本人关系；不删除素材                                                                                                                                             |
| GET /team/me/favorites                         | 素材筛选及分页                                                               | 仅本人；归档素材默认隐藏，恢复后关系仍存在                                                                                                                         |

首期批量操作推荐上限 100 项；同一请求只执行一种明确动作。无权限项不能让成功项回滚，也不能泄漏不可见项细节。响应 items 各含 id、outcome、code、revision；overall 为 succeeded/partial/failed。全部请求结构无效返回 400，不把结构错误拆成逐项失败。首期不提供批量公开、批量永久删除或批量下载打包。

可选整理意图在 ready 提交时再次校验：标签已失效、集合已归档或维护权已撤销时跳过对应关联，记录 organizationWarnings 并在任务完成页提示，不使合格媒体入库失败。

标签停用后，已有资产仍显示其标签及停用标记，允许移除和按历史标签过滤；不允许新增关联。完整 PATCH 可以原样保留已有停用标签，不能利用它为新素材分配。首期不提供标签合并，后续另行设计关系更新和冲突行为。集合成员变更只提升 collection revision，不应让所有关联 Asset 的内容 revision 无故递增。

**6．接口清单：公开快照与文件交付**

| 方法与路径                                    | 关键合同                                                                         | 权限与结果                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| GET /team/assets/:id/publication              | state、revision、当前快照、与内部信息差异；从未公开返回 state=none, revision="0" | 资产所有者或治理者；前端由 actions 决定能否编辑                                                  |
| POST /team/assets/:id/publish                 | expectedAssetRevision、expectedPublicationRevision、versionId、publicMetadata    | publications.publishOwn 且 owner；active＋ready＋实例公开允许；写不可变公开修订；201首次/200更新 |
| POST /team/assets/:id/withdraw                | expectedRevision 为 publication revision；reason 可选                            | withdrawOwn＋owner 或 withdrawAny；保留历史，提升 revision；200                                  |
| GET /public/assets                            | 只查当前 active publication，公开开关关闭时 404                                  | 匿名；不复用 team 查询结果                                                                       |
| GET /public/assets/facets                     | 仅公开标签/类型等允许维度                                                        | 匿名；不得泄漏内部字典全集                                                                       |
| GET /public/assets/:id                        | PublicAsset                                                                      | 未公开、撤回、归档、全局关闭均 404                                                               |
| POST /team/assets/:id/delivery-grants         | artifactId、purpose=preview/download                                             | 预览需 assets.read；原件下载还需 assets.download；状态/所有权范围复核                            |
| POST /public/assets/:id/delivery-grants       | artifactId、purpose                                                              | 当前公开版本且 artifact 角色允许；匿名但限流；无有效公开返回 404                                 |
| POST /team/assets/:id/motion-preview-grants   | 约定预览入口，无用户可选任意路径                                                 | assets.read＋可执行类型；只返回隔离来源 grant                                                    |
| POST /public/assets/:id/motion-preview-grants | 当前 publication revision 所指版本                                               | 公开允许且动效执行启用；匿名限流                                                                 |

发布请求的 publicMetadata 首期只含 title、description、tagIds；tagIds 必须是素材当前关联标签的子集。服务端读取对应展示文本，写入快照中的 publicTags 字符串数组；公开输出不含团队 tag ID、成员和集合。公开时展示实际结果，不能靠前端隐藏字段。更新内部信息后已公开内容保持不变，作者需再次进入公开表单提交快照。

公开写入须同时锁定 Asset/Publication、核对 revision、有效 owner、active/ready、原件与必需产物完整性、类型和实例规则。资产归档与公开并发时只有满足当前约束的一方提交；归档提交后不能由迟到公开产生 active publication。任何角色都不能通过本接口公开他人的内容；治理者只能撤回。

**6.1 交付合同与撤回边界**

归档素材仅向有权查看归档的所有者/治理者提供必要静态封面，不开放原件下载、视频播放或主动动效执行；需先恢复素材。集合归档与素材归档互不联动。

delivery-grants 返回 url、method、expiresAt、contentType、downloadName、rangeSupported，不返回 bucket/key 或可枚举存储清单。Local 可以返回受鉴权的流式内容路径，S3 可以返回短期签名地址；前端无需理解厂商对象结构。

团队内容路径每次检查会话和权限。隔离预览 grant 绑定发起会话引用，由预览服务在服务端验证该会话和权限仍有效；iframe 不携带或共享主站 cookie。公共 grant 至少绑定 assetId、versionId、artifactId、publicationRevision、purpose、过期时间；独立预览还必须限制包内路径范围与资源类型。HTML 原件下载使用 attachment；主站永不把上传 HTML/SVG 当普通同源页面直接执行。Range 请求在授权后处理，返回标准 206/416；供应商重定向方案必须实测目标浏览器。[HTTP Range 语义](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests)

初期团队动态响应、令牌和 grant 均 no-store；公开目录/详情先使用 no-store，避免未经验证的缓存扩大撤回窗口。静态站点壳与不可变产物可以采用明确分离的缓存策略。

撤回停止新的 grant；本地受控内容入口和动效 grant 每次复核当前资格。已经签发的对象存储 URL 可能持续至 TTL 到期，已在进行的下载也不承诺即时中断；不能把签名 URL 有效期描述为可立即撤销。建议 TTL 从短窗口开始压测并在上线前确认；本稿不将具体秒数伪装成用户已接受的 SLA。

公开关闭后不丢弃 Publication 历史。已确认 D01：重新开启只恢复仍 active、素材仍 active/ready 的既有快照，不公开从未公开、已撤回或已归档内容，也不使用内部最新字段替代快照。设置页使用管理读取的 `publicationImpact` 展示读取时点的恢复数量；摘要失败不能伪造 0，settings 发生 412 后重新读取并确认。摘要不锁定素材集合，提交仍按当时有效状态复核。公开关闭或预览执行开关收紧时提升相应 accessEpoch；再次开启只能发放新 grant，不能复活旧授权。

**7．接口清单：成员、角色、设置与运维**

| 方法与路径                                                    | 合同                                                                                                                                                    | 权限                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| GET /team/admin/members                                       | 成员分页、角色、状态                                                                                                                                    | system.members.manage                                                                             |
| POST /team/admin/invitations                                  | 目标本地 loginName 可选、roleId、到期策略；一次性令牌只首次返回                                                                                         | system.members.manage＋fresh-auth；禁止通过普通邀请暗中授予 sysadmin                              |
| GET /team/admin/invitations/:invitationId                     | Invitation 状态、userId、revision、expiresAt；永不返回 token                                                                                            | system.members.manage                                                                             |
| POST /team/admin/invitations/:invitationId/revoke 或 /reissue | expectedRevision 对应 Invitation；重签复用邀请/用户、递增 revision 并使旧 token 失效                                                                    | system.members.manage＋fresh-auth；明文只在重签首次响应返回                                       |
| POST /team/admin/members/:id/change-role                      | roleId、expectedRevision                                                                                                                                | system.roles.manage＋fresh-auth；至少保留一名 active sysadmin                                     |
| POST /team/admin/members/:id/disable 或 /enable               | expectedRevision                                                                                                                                        | system.members.manage＋fresh-auth；不自动撤回其素材                                               |
| POST /team/admin/members/:id/recovery-tokens                  | 一次性恢复 token，不显示或设置他人的最终密码                                                                                                            | system.members.manage＋fresh-auth；高风险管理员目标单独审计                                       |
| GET /team/admin/permission-catalog                            | 固定 key、说明、可委派标记                                                                                                                              | system.roles.manage；不是可编辑能力脚本                                                           |
| GET/POST /team/admin/roles                                    | 角色列表/创建 name＋permissionKeys                                                                                                                      | system.roles.manage；自定义角色仅可选可委派业务能力                                               |
| PATCH /team/admin/roles/:id                                   | name/permissionKeys＋If-Match                                                                                                                           | system.roles.manage；系统 sysadmin 不可修改                                                       |
| POST /team/admin/roles/:id/retire                             | expectedRevision；仍被成员/有效邀请引用时 409，先显式重新分配/撤销                                                                                      | system.roles.manage；不隐式重新分配角色；不能归档系统角色                                         |
| GET/PATCH /team/admin/settings                                | 品牌、类型业务开关、限额、公开策略；GET 含 revision/ETag 与只读 publicationImpact={eligibleActiveCount,evaluatedAt}；PATCH 不接受 impact，使用 If-Match | system.settings.manage；摘要失败返回可恢复错误，不能进入 bootstrap/public DTO；提交按当前资格复核 |
| POST /team/admin/branding-assets                              | 专用接收并核验 Logo/favicon，返回 verified brandingAssetId 候选                                                                                         | system.settings.manage；不产生团队 Asset/Artifact/Publication；设置 PATCH 才切换引用              |
| GET /team/admin/operations                                    | 脱敏健康、存储/任务状态、容量统计                                                                                                                       | system.operations.read；不公开账号/endpoint/凭证                                                  |
| GET /team/admin/jobs                                          | 任务列表和安全详情                                                                                                                                      | system.operations.read                                                                            |
| POST /team/admin/jobs/:id/retry                               | 仅注册的处理步骤；Idempotency-Key                                                                                                                       | system.jobs.manage；ready 后仅补缺失的可选产物角色，不覆盖已有 Artifact、原件或公开引用           |
| GET /team/admin/audit-events                                  | 操作者、动作、对象和结果筛选                                                                                                                            | system.audit.read；输出不含秘密和签名 URL                                                         |

健康探针与内部 worker 协议不作为公开业务 API。worker 使用专门服务身份和限定输入输出，不拥有 sysadmin session；前端不能指定系统命令、任意 URL 或任意对象存储路径来驱动处理器。

任务列表与审计列表按创建时间倒序、ID 倒序处理平局。游标绑定访问范围和筛选，保留数据库时间微秒精度；筛选变化或旧排序游标返回 `400 INVALID_CURSOR`，客户端应刷新列表。

品牌设置字段只接受已核验且用途匹配的 `logoBrandingAssetId` / `faviconBrandingAssetId`，不接受 bucket/key、任意 URL 或团队 Asset ID。切换引用、settings revision 和审计同事务提交；失败保留旧品牌。

**8．关键请求示例（合同示意，非业务代码）**

发布命令：POST /api/v1/team/assets/{assetId}/publish，带 session/CSRF 和 Idempotency-Key。请求字段：

| 字段                        | 示例                          | 规则                                                    |
| --------------------------- | ----------------------------- | ------------------------------------------------------- |
| expectedAssetRevision       | "12"                          | 对应用户审阅的内部素材修订                              |
| expectedPublicationRevision | "0"                           | 从未公开；撤回后再次公开必须使用真实递增修订            |
| versionId                   | 一个 ready 版本 ID            | 必须属于该素材且首期为当前版本                          |
| publicMetadata.title        | 柔和粒子背景                  | 显式确认的公开标题                                      |
| publicMetadata.description  | 可交互背景示例                | 纯文本/受限富文本方案首期建议纯文本                     |
| publicMetadata.tagIds       | 素材已关联标签中用户选定的 ID | 服务端核对来源后保存 publicTags 文本快照；不公开这些 ID |

成功返回 assetId、state=active、publicationRevision、assetRevision、publicUrl、publishedAt。不返回内部作者身份。并发编辑返回 409 REVISION_CONFLICT；前端展示差异后重新提交，不自动覆盖。

批量归档：POST /api/v1/team/asset-batch-operations，action=archive，items 每项含 assetId、expectedRevision。成功项包含新 revision；越权/已变化项包含 RESOURCE_NOT_FOUND/REVISION_CONFLICT。用户可仅重试失败项；所有成功项均完成公开撤回，不出现“界面已归档、下载仍无限期可发放”的中间业务状态。

**9．合同验收与尚待固定参数**

- 每个写接口至少覆盖：成功、无身份、缺能力、非本人、状态不符、过期 revision、重复请求和角色变更后重放。
- 上传覆盖中断、重复 complete、取消与 ready 竞争、重复任务、旧 attempt 迟到、S3 授权未过期但业务已取消、重新登录恢复。
- 公开覆盖内部编辑不泄漏、归档竞争、撤回后旧 revision grant、全局开关、公开类型开关、不同文件角色与路径越权、原始文件名不暴露。
- 集合和标签覆盖他人素材加入集合不获得编辑权、停用标签保留、改名不修改公开快照、关系修改不无谓增加所有资产 revision。
- 邀请/恢复覆盖一次性消费竞争、过期、撤销、账号停用、最后管理员保护、令牌不会进入日志和 Referer。
- 公开文件身份/EXIF 不自动脱敏、签名 URL 的撤回时限、转码输入编码和上传上限需要在上线前写入可执行验收参数；不是本轮已验证结果。

字段长度推荐：标题 1–200 字符、说明最多 5,000 字符、标签名 1–40 字符、每素材标签默认上限 20；具体 schema 以一次统一合同审查定稿。容量/时长/像素和动效解压限制依赖样例与部署条件，不照搬旧系统数字。首期不生成可执行 OpenAPI/SDK 或路由代码，后续开发应从本合同生成并以合同测试防止漂移。
