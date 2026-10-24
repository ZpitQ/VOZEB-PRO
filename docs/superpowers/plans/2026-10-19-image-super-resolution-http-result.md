# HTTP 成功产物下载：独立容量、期限与资源收口

日期：2026-10-19。模式：ponytail full。

关联：[主 SOP](2026-10-10-image-super-resolution-integration-plan.md)、[已发布产物只读出口](2026-10-19-image-super-resolution-published-reader.md)、[Worker README](../../../workers/image-enhancement/README.md)。reader 的既有计划与独立历史轮次保留，不代作本片验证。

## 1. 当前阶段

| 部分                     | 已确认状态                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 独立下载容量配置         | 已实现并完成配置 GREEN，固定前置源码独审通过。                                                                |
| 旧未鉴权、未完成正文拒绝 | 已定位连接关闭与自动排空时序，窄修后原认证/bootstrap 回归通过，固定前置源码独审通过。                         |
| HTTP result 接线         | 固定 v2 已实现，最终类型/构建、三文件完整 20/20 与源码独审通过；旧 133/133 保留为 v1 对应未变路径的独立证据。 |
| 本片文稿和交付           | 所定最终技术与源码批准已确认，文稿校验/独审及本地交付待各自实际回执收口；尚无本片服务器交付。                 |

成功 result 已接通同一完整验证 PNG 的受认证交付，不重新缩放或补像素；所定最终技术验证及固定 v2 源码独审通过。receipt 继续返回 `503/not_ready`，网络下载结束不等于 ZEB 已校验并永久保存。

## 2. 已完成的配置与输入拒绝前置

`HttpTransportLimits` 新增必填正安全整数 `maxConcurrentDownloads`，下载与上传、排队额度独立配置，不增加默认值，也不在旧配置缺字段时回退到上传容量。严格精确键、全部正安全整数、请求头期限不超过请求期限及期限上界继续沿原校验；已有配置升级时必须显式提供新字段。

下载复用 `requestTimeoutMs` 为覆盖读取、收容与慢响应的总期限，不新增第三套 timeout 配置。下载并发独立于上传，运行行为由本片 HTTP 技术轮次验证；配置 13 项仍作为独立前置证据保留。

旧拒绝路径在未鉴权且 chunked 正文尚未结束时，响应 finish 后立即 destroy 请求，实际可在完整 401 到达前重置连接。仅删除 destroy 也不充分：Node 会自动排空未消费正文。窄修在 finish 再 pause，继续由原 `Connection: close` 正常关闭；保持原认证、完整固定错误响应、零正文消费与零上传资源断言，没有降低测试要求或增加重试。

| 独立原因对照                     | 观察结果                                                                |
| -------------------------------- | ----------------------------------------------------------------------- |
| 原 finish-destroy                | 同场景中客户端在完整 401 前遇到连接重置。                               |
| 删除 destroy，交由 Node 默认关闭 | 可收到完整 401，但自动排空仍消费了正文。                                |
| finish 再 pause                  | 独立真实 TCP 对照收到完整 401，已消费正文为零；随后原产品回归另轮验证。 |

这些对照解释该窄修，不构成跨 Node/平台、完整下载或远程服务验收。

## 3. 已实现的 HTTP result 合同

1. `GET /v1/enhancement-jobs/{id}/result` 先认证、检查任务归属和持久真实成功，再取独立下载槽和引用。非成功仍返回 `409/result_not_ready`，未知或其他 client 的任务仍返回 404；下载不受当前 ready 或模型配置改变旧成功资格。容量满返回 `429/download_capacity_exceeded`，不排队、不触发执行。
2. 只调用同一个 `createArtifacts(...).readPublished(...)`，复用每请求 fresh held 引用和完整验证链。发送其返回的同一份 PNG 字节，不重开路径、不建第二套 reader、不 resize/转码或从 raw 修复，不重新运行 GPU。
3. 取得下载槽的同一同步接收边界开始总期限，覆盖读取、全部已发 I/O/close/ref 收容及慢客户端响应。期限只用显式 `requestTimeoutMs`，超时响应为 `408/download_timeout`。没有固定新上限、默认、轮询或自动重试。
4. 断连或超时先封存本次请求并 abort，之后禁止成功发送。尚未返回的原 open/I/O 仍须收容，迟到句柄确认关闭后才结束原精确引用；AbortSignal、超时响应或 Promise.race 不证明文件操作已结束，也不能回滚或删除成功任务。
5. 下载槽仅在 reader promise 真正结束和 response 实际 finish/close 两个事实都成立后恰一次归还，并结束 timer。响应先结束、reader 仍 pending 时继续占槽；reader 已返回、慢响应未结束时也继续占槽。不为释放容量假称原资源已经关闭。
6. reader 返回后先检查本次封存/信号，再完成未读正文收口；收口可能同步调用 pause 等回调，因此返回后须重新检查 seal/signal、Store-open、principal、socket 和 response 状态，然后才发送 200 图片头。交付头为 `content-type: image/png`、真实 `content-length`、双引号小写 SHA256 的 ETag，以及 `cache-control: no-store`，随后发送同一验证 Buffer。
7. 图片头尚未发出时，超时可立即返回固定 JSON，不等待不可取消 I/O 结束；图片头已发出后只关闭连接，外层错误处理也不得再次写头或拼第二份 JSON。异常不泄露内部路径或原因。
8. GET 未完成正文沿同一 pause/零字节读取、`Connection: close` 与 finish 再 pause 保护，保留真实零消费验证。Store/监听关闭后禁止成功交付；只收容原资源。下载不 notify/wake、不改变业务 succeeded、不创建 receipt/410。

固定 v2 的完整 20 项验证本次最终 result 触点，源码独审 Spec compliant / Quality Approved，Critical/Important/Minor=0/0/0。旧 133 项仍是 v1 对应未变路径的有效证据，不外推为 v2 重跑、安装、服务身份或完整业务验收。

## 4. 实际轮次，分别保留

| 独立轮次                   | 已确认结果                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 配置 Stage T 类型          | exit/close 0。                                                                                                                         |
| 配置 RED-v1                | 2 failed / 11 passed / 13，1.73 秒，无跳过；失败为合法七字段被拒绝、旧六字段未拒绝。旧实现按额外键先拒绝的 11 例不代作新字段校验完成。 |
| 配置最终类型（正文窄修前） | exit/close 0；不是正文窄修后的完整最终类型/构建证据。                                                                                  |
| 配置 GREEN-v1              | 13 passed / 13，1.73 秒，无跳过；其 validator、fixture 与测试在随后正文窄修中未变。                                                    |
| 旧认证/bootstrap 回归 v1   | 1 failed / 42 passed / 43，3.59 秒；未完成正文用例 read ECONNRESET。                                                                   |
| 原失败单例 focused-v1      | 1 failed / 20 名称过滤，1.83 秒；同固定来源重现，不以自动反复重跑掩盖。                                                                |
| 正文窄修后的旧回归 v2      | 43 passed / 43，3.87 秒，无跳过。                                                                                                      |
| HTTP Stage T 类型          | exit/close 0，原日志空。                                                                                                               |
| HTTP RED-v1                | 14 failed / 3 passed / 17，5.46 秒，无跳过；六个新 HTTP 行为五失败一通过，九个资源实例缺行为失败，两例旧 DTO 通过。                    |
| HTTP v1 类型与构建         | 各自 exit/close 0，原 stdout/stderr 空。                                                                                               |
| HTTP GREEN-v1              | 三文件 17 passed / 17，7.16 秒，无跳过；三个新测试/fixture 与 RED 保持同一字节。                                                       |
| HTTP v1 旧回归             | 六文件 133 passed / 133，38.62 秒，无跳过；含当轮新 dist 的既有入口 fixture。v2 未重跑，沿用于未变上传、JSON、唤醒和 bootstrap。       |
| HTTP v1 源码独审           | Spec noncompliant / Quality ChangesRequired，Critical/Important/Minor=0/1/0；原拒绝保留，不被早期 GREEN 改判。                         |
| 同步边界 T 类型            | exit/close 0，原日志空；产品仍为 v1。                                                                                                  |
| 同步边界 RED               | 2 failed / 1 passed / 2 名称过滤（5），3.17 秒；两项真实未授权 200，timer 同步 callback 的完整 408 已通过。                            |
| HTTP 最终 v2 类型与构建    | 各自 exit/close 0，原 stdout/stderr 空。                                                                                               |
| HTTP GREEN-v2              | 三文件完整 20 passed / 20，7.24 秒，无跳过；原 17 与新增三边界在本轮同时执行，不累计旧轮。                                             |
| HTTP 固定 v2 源码独审      | Spec compliant / Quality Approved，Critical/Important/Minor=0/0/0；仅批准修复后的固定 v2。                                             |

HTTP RED 的真实成功发布前置已完成，失败来自原成功 result 占位及未进入读取资源门槛，不是类型、初始化失败或挂死。固定新测试保持，产品接线在该真实 RED 之后实施。配置/正文前置的固定源码独审为 Spec PASS / Quality Approved，Critical/Important/Minor=0/0/0；前置与 HTTP 固定 v2 的源码结论分别核定；HTTP v1 的 Important 拒绝保留，不由前置或最终批准追补。

原失败、原因对照、v1 Important 与随后通过各自保留，不把配置 13、正文 43、HTTP v1 新 17、最终 v2 的 20、旧 133 或 reader 的旧 17/80 相加。最终 20 是同轮的原 17 加新增三边界；旧 133 仅沿用 v1 未变路径，不宣称 v2 重跑。文稿门禁及本地交付按后续实际回执收口，新 dist 入口 fixture 不代表 SCM、GPU、完整安装包或 ZEB 已验收。

### 成功发送顺序的 Important 补修

v1 先完成最终权限检查，再做未读正文收口；同步 pause 回调可在此时撤销 credential 或关闭 Store，随后仍发出 200 PNG。独审先指出该问题，新增真实 HTTP 反例再确认两项失败：未完成 GET 声明一字节但不发送正文，回调各执行一次，分别应返回 401/503，却得到 200。

v2 仅调整 result 分支的顺序：reader 返回后先检查已封存/abort，再做正文收口，返回后重新检查 seal/signal、Store-open、principal 和网络状态，随后发送成功头。维护时不得把能同步调用外部回调的正文收口放回最终有效性判断之后。Store 关闭先拒绝，不再调用其身份检查；撤权使用原认证错误，不放宽原输入保护或重读图片。

独立 timer.start 立即 callback 例在边界 RED 中已经完整返回 408，timer 未改；这是原本通过的正控，不是第二个故障。新增三例与原 17 在最终 20 项同轮通过，原 Important 拒绝与真实 RED 原样保留。

## 5. 维护与后续验收方法

| 验收组         | 维护和复审须保持的合同，实际技术轮次见上节                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 成功与权限     | 真实成功发布后从真实 TCP 收同一 PNG，核字节、摘要、尺寸与响应头；重复读取、重开及当前配置变化不变更旧结果，认证/归属/未成功拒绝先于取槽。 |
| 完整性         | PNG、manifest 损坏或缺失时固定安全失败，不交付坏图、不改 succeeded、不读 raw 修复或重新执行。                                             |
| 容量与期限     | 下载并发独立于上传；已占槽读未结束时超额请求拒绝且不多取引用，总期限覆盖 pending reader 与慢响应，最终释放后新下载可用。                  |
| 断连与迟到 I/O | 断连/超时后不再读取或发送成功；原 open 迟到时关闭原句柄，reader 未真正结束前不提前归还下载槽。反向也验证慢 response 未结束时不提前释放。  |
| 响应与正文边界 | 二进制头后错误只关闭，不追加 JSON；未完成 GET 正文不被自动排空，原完整认证错误与零消费断言保持。                                          |

所定最终技术验证与固定 v2 源码独审已完成；文稿校验/独审、中文本地交付和独立回读继续依次按实际证据收口。前置或源码通过不代作后续门禁。

## 6. 后置范围

成功网络 finish 只证明本次响应结束，不等于 ZEB 已校验并永久保存。持久 receipt 须独立实现幂等接收确认和任务归属/摘要校验；保留/清理、retention/410 不能由下载完成推断。

完整离线安装包、实际 SCM/服务账户/Session 0、服务身份 Store 耐久、GPU/画质、远程 TLS 与 Worker/API/ZEB 继续分别实施与验收。当前没有完整可验收安装包；M1 已获用户验收，schema5、增强关闭、readiness=false、worker 未接及自动 OOM 降 tile 重试暂缓保持。

未重复未变的 reader、Clock、native、宿主、GPU 或浏览器矩阵；当前主要风险为尚未完成的文稿/本地交付门禁，以及持久接收确认与实际服务/GPU 接线。
