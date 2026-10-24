# 图像增强持久结果接收确认计划

本片 parser、Store、配置和 HTTP receipt 已实现；所定分轮技术验证及最终14路径源码独审已完成，Spec compliant / Quality Approved，Critical/Important/Minor=0/0/0。公开文稿门禁与服务器本地交付按各自实际回执收口，本稿不预填文稿批准或提交。

## 1. 当前实际与分轮证据

本片承接已发布成功产物读取与 HTTP PNG 下载，新增服务端持久收据。认证客户端完成自己的验证与永久保存后提交严格 JSON；worker 将该声明绑定原真实成功 candidate/attempt，真正顶层 COMMIT 后才交付成功。有效 JSON 返回 200，空 POST 返回 400，原 401/404/非成功409保持。

Store v1 的两项 Important 已完成真实反例、最小补修、v2 GREEN 和 Store 源码复审。旧回归、原失败与后续通过各自保留，不相加，不将旧轮重命名为新轮。

| 独立轮次                           | 实际结果                                                                                 | 解释与边界                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Store 初始 Stage T                 | 16 failed / 4 passed / 20，6.00 秒                                                       | 缺行为 RED；四个 parser 负例仅由同码 throw-only 桩拒绝，后置 clock/fault 边界当时未越过前置 ack |
| Store v1 技术检查                  | types/build 各 exit0；两文件 20 passed / 20，6.93 秒                                     | 首版技术 GREEN，不代替随后两项 Important 的审查与补修                                           |
| Store v1 独审                      | Spec/Quality 均 NeedsChanges，0 Critical / 2 Important / 0 Minor                         | 最后 signal getter 后身份顺序、外层事务 clock 重入                                              |
| Store 两项边界 Stage T             | types0；2 failed / 15 名称过滤（17），2.69 秒                                            | B1 撤权后仍 applied=true/receipt1；B2 内层成功后外层回滚，receipt0；有效行为 RED                |
| Store v2 最终检查                  | types/build 各 exit0，164 inputs 不变；两文件 22 passed / 22，10.25 秒，无跳过           | 最小修复外层事务两处 guard 及最终身份顺序                                                       |
| Store v2 独审                      | Spec compliant / Quality Approved，0/0/0                                                 | 对应 Store/parser 及配置增量固定范围，原 v1 拒绝不回填                                          |
| 整片最终源码独审                   | 最终14路径 Spec compliant / Quality Approved，0 Critical / 0 Important / 0 Minor         | Root已读核固定报告；最终173/163来源此后未改                                                     |
| receipt 配置新旧回归               | 19 passed / 19，2.07 秒                                                                  | 新配置6例与原13例同轮；只验证配置                                                               |
| HTTP 初始 Stage T                  | types0，165 inputs 不变；15 failed / 1 passed / 16，6.90 秒                              | 原 receipt 未接线的缺行为 RED，原失败保留                                                       |
| HTTP 追加 timer.start 两例 Stage T | types0；2 failed / 16 名称过滤（18），2.80 秒                                            | timer.start 不触发 timeout，但同步撤权或关闭 Store；原失败为旧503错码，不称产品 guard 故障复现  |
| HTTP 最终检查                      | types/build 各 exit0，165 inputs 不变、完整两日志无错误；18 passed / 18，9.90 秒，无跳过 | 追加后的18个测试不变后合入产品；Root 已读完整 stdout 与空 stderr                                |
| 旧 HTTP 影响回归                   | 八文件 144 passed / 144，40.05 秒，无跳过；exit0，225 inputs 含最终 dist 不变            | 原 session 收尾后读取完整 stdout 与空 stderr，没有重跑                                          |
| 旧 Store 回归                      | 五文件 142 passed / 142，10.70 秒                                                        | 沿 Store v1 未变原路径的独立历史证据，不称 Store v2 重跑                                        |

整片固定14路径源码终审已完成，Spec compliant / Quality Approved，Critical/Important/Minor=0/0/0；公开文稿门禁与本地交付仍按各自实际回执核定。本文不预填文稿批准、commit 或安装结果。schema6 为代码契约，不表示服务器数据库已升级；增强关闭、readiness=false、worker 未接、自动 OOM 降 tile 重试暂缓保持。

## 2. 收据的含义与响应丢失

网络 response finish 表示该次响应的网络发送收尾，不能说明客户端验证并永久保存了结果。receipt 持久保存的是认证客户端“已验证并永久保存”的声明，不构成 worker 对远程 ZEB 存储的独立证明；网络 finish 不自动创建收据。

只有 SQLite 真正顶层 COMMIT 成功后才能交付成功。客户端在 COMMIT 后丢失响应，可用同一 receiptId 重放，取得 applied=false 与原 receivedAt。服务器不自动重放未知写入，也不因响应丢失回滚已提交事实。

## 3. 纯数据与公开合同

请求为 `ResultReceiptRequest={serviceId,receiptId,result:ArtifactResult}`。外层及 result 都是严格 plain object、精确键，不接受未知、缺失、符号或自报权限字段。result 恰含 `format/width/height/sha256/byteLength`：format 只能 png，尺寸和字节数为正安全整数，sha256 为64位十六进制。serviceId 与 receiptId 为标准 UUID 文本，hex 大小写允许，解析后 UUID/SHA 规范小写。复用原 record、exactKeys、positiveInteger，ArtifactResult 仅 type import，避免 contracts/execution 运行时循环。

HTTP 使用成熟 JSON.parse 语义，再调用同一个 `parseReceiptRequest(value:unknown)`；不另造 JSON parser，也不承诺检测 JSON 同名属性。jobId 只取原路由，client 只取当前认证 principal；请求不接收 client、candidate、路径、票据或 incarnation。

`acknowledgeResult(principal, jobId, value:unknown, signal?:AbortSignal)` 同步返回 `ResultReceiptOutcome={receipt,applied}`。receipt 公开键恰为 serviceId/jobId/clientId/receiptId/result/receivedAt，result 与 receipt 深冻结；首次 applied=true，精确重放 applied=false，原 receivedAt 保持。JobDto 与原执行合同不新增 receipt 字段。

非法结构为400/invalid_request；合法结构而 serviceId、任一结果字段或收据绑定不符为409/receipt_conflict。未知任务或其他 client 为404，非真实 succeeded 为409/result_not_ready，已撤权为401，closed 或存储故障为脱敏503/internal_error，已 abort 为400/invalid_request。响应不泄露凭据、内部来源或文件路径。

## 4. Store、真正 COMMIT 与 schema6

Store 在入口拒绝 closed、已 abort 及已有外层事务，完成解析/复制、合法 clock 与同步回调后重新核可用性；开始自身 immediate 事务前再次拒绝已有外层事务。事务内复用 getOwned 与原 qualified published candidate 资格链，只确认真实 succeeded，联合检查原 job/client/candidate/attempt 和五字段摘要。最终 signal 可用性检查发生在当前 principal 的最后身份检查之前，避免 getter 的同步副作用越过权限裁决。

同 job 只能绑定原 candidate/attempt 与一个 receiptId；同 client 同 receiptId 只能绑定一个 job，冲突为409且不覆盖。不同 client 可使用相同 receiptId；重开后的 fresh principal、同 client 有效凭据轮换均可精确重放。收据不绑定旧 credential、incarnation 或是否曾下载。

`result_receipts` 只新增六列：

| 列或约束                 | 已实现的合同                                     |
| ------------------------ | ------------------------------------------------ |
| job_id                   | 主键，外键指 jobs                                |
| client_id                | 外键指 clients                                   |
| receipt_id               | 稳定 UUID；UNIQUE(client_id, receipt_id)         |
| candidate_id、attempt_no | 与 job_id 组成复合外键，指原 artifact_candidates |
| received_at              | 第一次成功持久登记时间，重放不变                 |
| immutable UPDATE trigger | 保护首次记录                                     |

原 jobs 没有 (job_id, client_id) 唯一键，不建立无效复合外键。所选 candidate 与 client 真实归属仍由 Store 同事务校验；result 从不可变 candidate 解释，不另存 result_json，不复制图片。

显式新鲜初始化与普通 open 精确要求 user_version=6；旧5与未知版本均拒绝，缺 result_receipts 表或必要列的伪6也拒绝。拒绝时不登记新 incarnation，不迁移、补表、删除或覆盖既有数据与版本。旧 schema5 或更早文稿及回执保留各自固定历史；代码 schema6 不表示服务器数据库已升级。

INSERT 或真实 COMMIT 错误经原 safe 边界脱敏503，不自动重放写入。receipt 不重新读图、不取 artifact ref、不 wake，不修改 job、attempt、slot、candidate、引用或观察，不清理或产生410。

原 v1 的两个真实错误成功保留为已修历史：最后一次 signal getter 撤权后仍 applied=true；既有事务 clock 重入先拿到内层成功，随后外层 rollback 删除收据。v2 最小修复最后身份顺序和外层事务两处 guard，真实 SQLite 的22/22及固定 Store 源码复审完成对应验证。后续回执不将原失败改判，也不把 SAVEPOINT/RELEASE 当顶层 COMMIT。

## 5. HTTP 与配置

原 `POST /v1/enhancement-jobs/:jobId/receipt` 已接线。认证、归属及真实成功检查先于正文和100Continue。有效 JSON 首次与精确重放均返回200 `{code:"ok",data:{receipt,applied},msg}`；空 POST 或非法正文400，原非成功409、未知/异 client404、认证401与 DTO 断言保留。仅更新原三个成功 receipt503断言，历史块仍记录当时未接线的状态。

transport 精确接受九个显式必填正安全整数：

| 字段                      | 用途                                    |
| ------------------------- | --------------------------------------- |
| maxPlanBytes              | 原 plan JSON 上限                       |
| maxMultipartOverheadBytes | 原 multipart 开销上限                   |
| maxConcurrentUploads      | 上传并发                                |
| maxConcurrentDownloads    | 下载并发                                |
| maxReceiptBytes           | receipt JSON 字节上限                   |
| maxConcurrentReceipts     | receipt 并发                            |
| headersTimeoutMs          | 原请求头期限                            |
| requestTimeoutMs          | 上传、下载与 receipt 各自沿用的总期限值 |
| maxHeaderBytes            | 原 HTTP 头字节上限                      |

缺失、未知字段或非正安全整数均拒绝，原 headersTimeoutMs≤requestTimeoutMs 及 Node timer 范围不放宽。receipt 大小与并发不补默认值，不借用上传、下载或等待队列预算；沿用 requestTimeoutMs，不新增独立期限字段、任意时间常数或调度器。

Content-Type 必须恰一个 application/json，可带 charset=utf-8，大小写不敏感；其他参数和重复头拒绝。缺失或重复 Content-Type400，非法媒体类型415。Content-Encoding 仅允许缺省或 identity，拒绝压缩编码。Content-Length 预检及实际 chunk 累计均受 maxReceiptBytes 限制，超限413；完整 UTF-8 采用 fatal 解码，非法 UTF-8、JSON 或字段400。全部预检通过之后才发送100Continue。

receipt 满额429/receipt_capacity_exceeded，期限到408/receipt_timeout，不排队。私有有界 JSON receiver 位于原 http.ts，复用原认证、响应、输入收口和 timer 形状，不引入新依赖或上传 spool；可选 receiptTimer 沿现有 UploadTimer 接缝，生产用标准计时器。

槽按真实 receiver 收尾与 response finish/close 收口。超时、断线、未完成体不落库；所有同步 pause/timer 回调之后最终检查 signal、网络、Store 和当前 principal，再调用无 await 的同步事务。timer.start 同步 callback、未触 timeout 但同步撤权/关闭、pause 内撤权/关闭与迟到 chunk 等已在所定18例范围验证。COMMIT 后丢响应保留原收据，同 receiptId 可查回原事实；网络 finish 不代表远端永久保存。

## 6. 实施与测试路径

所有路径相对仓库根；只描述本片职责。

| 路径                                                                                  | 职责与范围                                                           |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| workers/image-enhancement/src/contracts.ts                                            | 请求纯类型、严格 parser、规范化                                      |
| workers/image-enhancement/src/store.ts                                                | schema6、result_receipts、同步 acknowledgeResult、事务与最终身份边界 |
| workers/image-enhancement/src/http-config.ts                                          | 九字段 transport 严格配置                                            |
| workers/image-enhancement/src/http.ts                                                 | 既有 receipt 路由、有界 JSON receiver、独立容量/期限、最终授权收口   |
| workers/image-enhancement/tests/receipt-contracts.test.ts                             | parser 正反例、复制和深冻结                                          |
| workers/image-enhancement/tests/receipt-store.test.ts                                 | 真实 SQLite、成功 candidate、幂等、权限、COMMIT、schema与两项补修    |
| workers/image-enhancement/tests/http-receipt-limits.test.ts                           | 仅配置6例；与原配置13例同轮19/19，不承担HTTP大小/容量/超时行为       |
| workers/image-enhancement/tests/http-receipt.test.ts                                  | receipt HTTP18例，包含正文大小、独立容量、超时与网络/同步回调行为    |
| 原 runner-store、stop-send-permission 测试                                            | schema6 期待仅机械更新                                               |
| 原 HTTP/auth/submit/lifecycle/wake/artifacts/result/bootstrap/main 相关测试与 fixture | 两必填字段及原receipt断言所需改动，保留旧断言；八文件144/144另轮     |
| CHANGELOG、pending-test、TODO、主SOP、数据库文档、worker README与本计划               | 当前行为、分轮证据、schema6、已修历史和后续验收                      |

配置19/19不代替HTTP行为18/18，各文件职责保持明确。Root独占format、types/build/test、哈希、Git、SSH与CodeGraph；作者仅独立文稿和报告。

## 7. 各层测试点与证据边界

测试先固定并以真实RED证明缺行为，再实施产品。编译、加载、缺表或fixture失败不冒充行为RED。测试与固定来源保持，失败、过滤、平台跳过和后续GREEN分开记录。

| 层                | 所定验证点                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| parser            | 严格plain object/键、UUID/SHA规范化、png、正安全整数、未知/缺失/额外字段、非法类型、复制和深冻结；JSON.parse语义边界明确                                                                             |
| Store正常持久化   | 真实SQLite与合格PNG发布fixture；首次/重放、六字段DTO、原receivedAt、fresh principal重开、有效凭据轮换、不同client同receiptId                                                                         |
| Store身份与冲突   | 双向唯一冲突、serviceId和五字段逐项不符、未知/异client、非成功、撤权、closed、abort、输入getter/clock；原执行、引用、磁盘事实不变                                                                    |
| 两项Important补修 | signal getter最后同步撤权；既有Store事务clock重入并回滚；内层不交付成功，普通顶层调用仍经过真正COMMIT                                                                                                |
| SQLite与schema    | INSERT故障、真实deferred-FK COMMIT失败、移除故障后同receipt重试；schema6新鲜/重开，旧5/未知/缺表缺列伪6拒绝，不补表或改旧数据/版本                                                                   |
| config            | 九字段正控、两字段缺失/非法、未知字段、正安全整数、原期限关系与范围；旧fixture显式传字段，无默认                                                                                                     |
| HTTP正常与重放    | 认证/归属/成功先于正文或100；首次200、精确重放false、COMMIT后失响应再查回；原401/404/409与DTO                                                                                                        |
| HTTP正文          | 唯一Content-Type/charset、缺失/重复/非法参数与编码、fatal UTF-8、非法/不完整JSON、长度预检/分块超额、100Continue预检、被拒正文保护                                                                   |
| HTTP生命周期      | 独立receipt容量不挤上传/下载、满额429、超时408、断连/未完成体不落库、receiver/response双收尾归槽；同步timer callback、timer.start不触timeout但撤权/关闭、pause内撤权/关闭、迟到chunk与COMMIT后失响应 |
| 影响回归          | Store、凭据、发送许可、artifact Store/download原未变路径142历史；本片旧HTTP八文件144新轮，均不删除或削弱断言                                                                                         |

每轮保留固定来源、精确命令、exit/close、计数、过滤/跳过、耗时、完整原日志和输入未变事实。名称过滤不是通过；不把相互重叠的新旧轮累计成总验收数，也不把原503错码RED扩大为未观察到的产品guard故障。

## 8. 收口门禁与后续

所定新技术检查、对应旧回归和最终14路径源码独审已按上表完成；公开文稿门禁与服务器本地交付仍待各自实际回执。最终文稿应与最终代码和实际证据一致，不预填文稿批准或提交；隐私门禁不得新增真实域名、IP、服务器目录、数据库实例名、账号、凭据或业务身份。本文示例仅用通用协议字段与仓库相对路径。

本片仅建立服务端持久收据边界。客户端实际永久保存及独立验证、retention/清理/410、完整离线安装包、SCM/Session0、实际服务账户与Windows Store耐久、GPU/画质、TLS、Worker/API/ZEB、用户及实际部署继续各自后置。局部技术通过不改变增强关闭、readiness=false、worker未接或OOM自动降tile重试暂缓。

公开文稿批准、服务器中文本地交付与fresh readback依后续真实回执填写，本稿不预填commit或安装。无push/PR/merge/部署/重启/SCM/GPU/生产变更。私有记录或后台记忆捕获不代表服务端记忆入库。
