# Windows 原生执行桥：prepare、单次 AUTH 与自然收尾

日期：2026-10-17。状态：**内部技术验证与独审通过，文稿/本地交付待收口**。原 host 全互操作、自然收尾、调用方失联、四项原生交错与诊断清理后覆盖已取得完整的所定分轮结果，最终固定 source/runtime v10 的源码与 v11 两轮实际证据独审均通过；文稿与本地交付仍待，不表示 M2 完成或部署验收。下文测试轮 v11 使用固定源码 v10，两者版本不混用。

## 1. 目标与范围

复用[有界 TS 控制 host](2026-10-16-image-super-resolution-ts-control-host.md)、[受限原生控制桥](2026-10-16-image-super-resolution-native-control-bridge.md)和[原生执行会话](2026-10-15-image-super-resolution-native-session.md)，让同一个原 helper 完成 prepare、一次 AUTH 和真实自然收尾；不另建 helper、Job、请求队列或 journal 解释器。

最小生产范围为 TS 的 `windows-control-bridge-protocol.ts`、`windows-control-bridge-host.ts`，以及 native 的 `BridgeProtocol.cs`、`OriginalControlSession.cs`；必要时仅增加对既有 supervisor 项目的直接引用。测试复用既有受保护 Bundle、EngineHub、Engine 与 RunContext，并补新 host/OS 场景。原 Program 继续 await 原 session，不能为按期返回而强制退出保留所有权的会话。

本片不改 ExecutionAdapter、runner/store、HTTP、恢复消费者、安装或服务配置，不启动 GPU 或接入 ZEB。M1 已获用户验收、schema5、增强关闭/readiness=false、worker 未接和 OOM 自动降 tile 重试暂缓均为沿用边界，本轮未据此声称重新读回现场配置。

## 2. 执行与身份合同

原 host 增加内部 `prepare(request, expected, guard)` 和 `authorize(target, descriptor, requestFingerprint, guard)`；guard 必须显式传入。请求使用既有冻结 Base64/原字节摘要两字符串 carrier，expected 来自同一原构造；回调前冻结独立副本，不重建请求 bytes，不复制完整 payload parser。

每个原 host 最多接纳一次 prepare 和一次 authorize，拒绝、异常、超时或结果不明均消费该次准入。AUTH 必须匹配同 host 的成功 prepare 及完整原 target/descriptor/fingerprint；adapter、execution、ticket、policy、installation、helper、engine 和 Job 事实逐项绑定，通用 descriptor freezer 不能替代 Windows 精确校验。执行中沿既有单请求槽工作，inspect 返回 busy；原会话寿命与阶段业务 guard 分开，prepare guard 不作为整个 host 的开存活条件。

所有外帧和解码请求仍严格校字段、UTF-8、重复键、JSON 深度及既有字节/队列/期限预算。执行准入要求 `maxJsonDepth >= 6`，旧 control 的 depth 2 行为保留。native 输出保持有限 serializer 深度，真实 raw v2 已输出包含 target.identity 的完整 descriptor；该正控不代作更广协议矩阵通过。原 helper 请求沿用同一阶段 requestId，仅移除桥的 kind。

## 3. 最后发送许可与不确定结果

native 同步接纳命令后另行运行操作，继续读取 stdin。它取得原 owner channel Writer 并准备好原 bytes 后，才请求对应 prepare/AUTH 的一次 permit；等待外进程期间不持 gate。permit 严格关联 requestId、op、executionId 与 requestFingerprint，allow 必须为 JSON boolean。

Node 在调用 `takeSendPermission` 前先消费许可。所有外部 guard/current 回调及其前后 signal、期限、pending 身份和未封存检查完成，且许可为 true，才构成最终 Node admission；随后只有内部同步记账和一次原 stdin.write，没有 await、排队或外部回调。false、throw 或重入 close 不能发送 allow=true。native 收到匹配 permit 后仍持原 Writer，重核本地封存、期限和原 owner/request，再向原 pipe 最多写一次。

最终 Node admission 后仍可发生跨进程取消竞态，不宣称 DB COMMIT、许可、native AUTH、resume 或 ACK 原子。重复、孤立、错配或迟到 permit 不再次调用 guard，不重启阶段；seal、timeout、EOF 和 close 唤醒原 waiter，并沿 finally 释放原 Writer。任何已调用 WriteAsync 的不确定副作用保留 Unknown，丢 ACK 不再 AUTH。

只有匹配原 id/op/owner role/execution 的 owner response 可结算操作；observer state 不能结算命令。native 在同 gate 清除已完成的原命令槽后才发布 ACK，避免合法紧接的 AUTH 被旧槽误拒；finally 只清同一原请求。prepare 成功还须完整合法 descriptor 且当前仍合格；authorized 还须匹配回应、native AUTH verified 和 resume succeeded。owner/observer 两流没有全局交付顺序：合法旧观察可晚到并排空，不擦除成功 owner ACK 已绑定的不可变事实，不用跨流 phase 单调比较误拒；非空身份事实仍必须匹配。迟到 ACK 不能复活已 Unknown 的原请求。

## 4. 自然资源收尾与业务证据

在任何 prepare 被接纳、排队或发送之前，同 gate 单调设置 prepareAccepted/mayHaveEngine；此后永久禁止 helper-only force，包括许可拒绝、ACK 丢失和清理超时。旧从未 prepare 的控制关闭路径保持。原 NativeExecutionSession 继续负责 Job seal、既有 grace/一次 force、原树退出与 engine 双 EOF，不另写清理状态机。

原 host 的一次 spawn 使用 `detached: true`，保留原 child 引用与三条 pipe，不加 unref、替代进程或新清理预算。调用方失联由原 Node EOF→bridge seal→owner channel 关闭→原 helper 清理原 engine Job 接管；never-prepare、prepared 和 running 分别取证。这依赖原生会话仍能响应，不能等同于原生进程永久挂死时的 kernel kill 保证。

执行路径的 helper 输出 EOF、exit 或原 channel EOF只触发封存和自然 joining，一个观察不证明完成，也不要求 terminal watch 或 AUTH ACK 先到。取消待许可操作后，原有界 writer 先发送一次 ending；host 关联原 admitted execution、封存阶段并将 pending 结算 Unknown，仅对原 stdin 执行 endInput，不反发 close/stop。ending 只是收尾通知，不能冒充终态。

Gate H 要求可信原 helper 自然 exit0、真实 helper stdout/stderr EOF、原 owner/observer readers、writes/operation/startup/input joins 和真实 caller stdin EOF；缺一项、helper2 或来源不明均保留原 pins/准入屏障。helper0 只在原身份、可信源码/运行时及完整 joins 前提下证明物理清理，不能把非零 engine 改成成功。Gate B 再写入并 flush Closed，完成原 writer/timer joins 后桥自然退出；host 另核原 bridge exit、真实双 transport EOF、stream close 与原 write/end 回调，才可报告 cleanup=closed。

natural ending 与 caller close 交叉时，只在原 stdin drain 内记录首个严格合法同 execution closeId 供最终 Closed 关联；不重新准入、不发 stop、不重开期限。host 已接 ending 后的 close 复用原 closure promise。natural Closed 仅在 accepted ending 且无 closeId 时使用 null requestId；重复 ending 或 close 仍严格拒绝。

资源 closed/stopped 仅表示物理清理；原阶段 Unknown 不升级，持久槽不因此释放、回滚 AUTH 或新增 attempt。state、ACK、helper0 和 Closed 均不能产生 ExecutionExit。独立严格 journal reader 继续解释原 01/02/03/05/06、完整绑定和真实 UInt32 engine exit，分别判定 engine-exit 或 interrupted；未映射或证据不全的分支保持 Unknown。

## 5. 最小用例组与当前证据

以下按冻结合同标记所定技术证据；最终源码独审与各轮实际证据分账，不能扩大为更广矩阵或业务交付：

| 案例                   | 必须证明的行为                                                                                                                                             | 当前证据与剩余项                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| EB-01 原 host 全互操作 | 实际 Node production host→原 product bridge→唯一 helper→受控 engine；完整 prepare/一次 AUTH/恢复后首个 marker、原 carrier 与绑定一致。                     | natural v6、fast v7 和最终 cover v11 的 natural 分别合格。                                                              |
| EB-02 严格协议         | 合法 execution snapshot/ending 和完整 descriptor 输出成功；错误绑定、重复键、过深和超预算仍拒绝，旧 control 深度行为不变。                                 | unit v6 与 raw v2 完整 descriptor 正控分别有证据，不扩作更广 OS 矩阵。                                                  |
| EB-03 最后许可         | prepare/AUTH 各一次；拒绝、throw、重入 close、重复/孤立/错配/迟到 permit 不产生第二次许可或发送；等待中 close/EOF 唤醒操作、释放原 Writer。                | unit 分轮通过；raw v11 的等待 AUTH permit 时 close、EOF 及消费后 permit 重放通过，三个无 AUTH 分支保持 Unknown。        |
| EB-04 挂起后拒 AUTH    | 原 prepare 已创建 suspended tree，再拒 AUTH/owner close；不得 resume，原资源真实收尾，未知业务槽不释放，prepare 后不再 helper force。                      | deny-auth v7、prepared caller-death v7 与最终 cover v11 对应场景合格，strict reader 保留 Unknown。                      |
| EB-05 自然快退出       | 不依赖 terminal watch/ACK 排序，ending→真实 caller EOF→Gate H→Closed/Gate B→原 bridge joins；两种 ending/close 先后不反发 stop，合法旧 observer 不抹绑定。 | natural v6、fast v7、最终 cover natural 及 raw v11 的 natural ending 后有效 closeId 分别通过。                          |
| EB-06 ACK 与业务分离   | ACK 缺失维持 Unknown，独立 reader 校原完整记录链与 UInt32 exit；helper0/closed 不把非零 engine 变成功，不重复 AUTH 或创建 attempt。                        | nonzero 与 missing-ack v7、最终 cover missing-ack 分别合格；授权/cleanup Unknown 不被后来的真实退出或 reader 成功回写。 |
| EB-07 不完整 join      | 临时缺原 tree/drain join 时保持原 owner/pins且不 force helper；测试控制释放后只接受原 joins，before/after 与测试 teardown 分账。                           | held-drain v7 与最终 cover 对应场景合格，释放前不完整、释放后原 joins 且无 fallback。                                   |

调用方失联三态分开判断：never-prepare v6 合格且不补造 descriptor/业务解释；prepared v7 与最终 cover 无 AUTH/marker，strict reader 必须 Unknown；running v7 与最终 cover 已有真实 AUTH 与首个动作，strict reader 必须 interrupted，Unknown 在该运行态属于失败。故障只终止原 Node，不借 guardian fallback 清树；原 Hub/peer 保持，额外 fixture Job query handles 在故障前释放。

先由 Root 认证行为 RED，再释放同一作者实施；受影响覆盖限新 host/OS、旧 host/protocol 与 never-prepare closure，另做 worker types/build/native publish。纯 TS 可独立 Linux 运行，Windows OS 轮另记。原 Store/artifact/reader/GPU/UI/mobile 矩阵不因新增内部接口自动重跑；共享源变化或新失败另按实际影响补验。

## 6. 已发生的独立轮次

下表保留最初行为 RED；不将负控通过升级为功能验收。使用 Node 22.23.3/libuv 1.51.0，Phase A 仅改测试/夹具，既有生产源码摘要核对未变。

| 轮次                                 | 真实结果                                                   | 结论与边界                                                                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 合同 v2 独立审查                     | Spec PASS / Quality Approved，未解决 C/I/M=0/0/0；已被接受 | 仅批准实现合同，不是源码或运行结果批准。                                                                                                                                                       |
| decoder 行为 RED                     | 2 failed / 6 passed，共 8，1.14s；child exit1              | 合法 prepared 与 ending 均被旧 decoder 拒绝。六个负控在旧 decoder 全拒 execution state 的前提下通过，不证明未来绑定或深度校验正确。                                                            |
| Phase A 类型检查                     | child exit0，stdout/stderr 空                              | 仅验证该阶段测试/夹具类型，不代表实现完整。                                                                                                                                                    |
| 基线 ordinary/bridge/fixture publish | 三轮 child exit0，stderr 空，无 warnings                   | 为后续 RED 固定真实普通/桥/夹具二进制，不能代作执行功能通过。                                                                                                                                  |
| 真实原生桥行为 RED                   | 1 failed，共 1，无 skip，7.62s；child exit1                | 首个 prepare 回应为 unknown，预期 permit-request。原 carrier 一致、外层 true dual EOF/exit/close0、原 helper joined 与清理控制正常后才出现该断言失败；原 product bridge 自然 exit2、未 force。 |

最后一轮实际帧为 bound、unknown、closed。没有把 marker 缺失说成“未创建 suspended tree”；未到达 native 完整输出 Frame3，不能据此声称已复现 serializer 深度失败。普通程序集、桥、测试夹具及故障 hook 的来源与运行事实按各自发布清单分账，测试清理不代作运行时干净退出。

Phase B 后续按各轮实际结果记录，不合计为一次完整全绿，不把过滤或平台跳过算通过：

| 独立轮次                      | 实际结果                                                                  | 结论与边界                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 首轮 native v1                | 7 failed / 7，347.66s，exit1                                              | 原 raw 夹具漏注册 suspended engine；其余包含真实超时、fallback 和不正确的物理关闭断言。该轮失败保持，不以最终 Job 清空追认成功。                 |
| raw + natural v2              | 1 passed / 1 failed / 5 名称过滤，70.41s，exit1                           | raw 完整 carrier/descriptor、原引擎注册和真实收尾合格；natural 原 Node/bridge 部分闭合不足以通过完整 fixture，仍为失败。                         |
| natural v3                    | 1 failed / 6 名称过滤，62.78s，exit1                                      | 等待位于 node-result 后原 child join，尚未取得完整 reader 业务结果。                                                                             |
| natural v4                    | 1 failed / 6 名称过滤，62.97s，exit1                                      | 原 Node 自然 exit0、stderr 真 EOF，原 stdout capture 未完成；测试 teardown 不代作完整 join。                                                     |
| natural v5                    | 1 failed / 6 名称过滤，62.98s，exit1                                      | 原 stdout 同步回调已返回，原 managed read-await 仍未返回；没有独立证明内核管道或安全软件根因。                                                   |
| detached options 行为 RED     | 1 failed / 115 名称过滤，2.31s，exit1                                     | 仅原完整 spawn options 断言要求 true、实际 false；随后才实施最小产品改动。                                                                       |
| types/build v6                | 两轮各 exit0                                                              | 对应 v6 Node 源；后续仅 fixture 修复不使其失效，未重复无关检查。                                                                                 |
| unit v6                       | 123 passed / 1 平台 skip，共 124，3.75s，exit0                            | 新 execution 与旧 host 的对应内部单元范围。                                                                                                      |
| natural v6                    | 1 passed / 9 名称过滤，共 10，13.50s，exit0                               | 原 Node/bridge/helper 自然 exit0、真实双 EOF/fullJoin、AUTH authorized、原 write/end 回调及独立 reader engine-exit success0，无 force/fallback。 |
| 旧 host OS v6                 | 2/2，3.92s，exit0                                                         | 原 bind/inspect/close 与 preempt 两项，分轮保留。                                                                                                |
| caller-death v6               | never-prepare 1 passed；prepared/running 2 failed，33.02s                 | 前者有效，后两项为失败证据，不能整体记通过。                                                                                                     |
| 其余 native v6                | 5 failed，59.70s                                                          | 与上述两失败共同暴露夹具长路径打开及尾部错误遮蔽，后续修复不改写本轮。                                                                           |
| 七项 affected native v7       | 7 passed / 3 名称过滤，共 10，96.41s，exit0                               | fast、nonzero、deny-auth、missing-ack、held-drain、prepared/running caller-death；原始身份/真实双 EOF/完整 joins 与无 fallback 均已核。          |
| 旧 control v7                 | 15 passed / 25 名称过滤，共 40，30.37s，exit0                             | 最小受影响旧 raw control 回归，不能替代四项新原生交错。                                                                                          |
| 格式后 types/build 与 unit v8 | types/build 各 exit0；unit 123 passed / 1 平台 skip，共 124，3.55s，exit0 | 格式化后的独立编译/单元轮，不与 v6 累加；后续仅 OS 断言修正未改变其生产源码范围。                                                                |
| partial freeze v8             | 来源摘要校验拒绝，未生成 runtime inventory                                | 格式化改变 emitted protocol 字节；此为工具来源校验失败，未据该不完整冻结启动 OS，不冒充业务失败或成功冻结。                                      |
| type v10 与正式 freeze v10    | 类型补验 exit0；独立 source/runtime 冻结 exit0                            | source 132、native 778、tracked Node 5、immutable Node 52；明确绑定格式化前后来源与语义证明，保留 v8 部分产物，不作通用忽略摘要。                |
| 旧 raw v10，整轮未合格        | Vitest summary 4 passed，36.42s；外层无 child.close/整体 receipt          | 四份原生个例事实保留，但输出摘要不代作整个驱动闭合；cover v10 未启动，不填通过。                                                                 |
| 最终 raw v11，固定源码 v10    | 4 passed / 10 名称过滤，共 14，34.33s，exit0/signal null                  | 四项原生交错的完整新驱动回执；三个无 AUTH 分支为 Unknown，natural closeId 分支为独立 engine-exit success0。                                      |
| 最终 cover v11，固定源码 v10  | 5 passed / 9 名称过滤，共 14，70.08s，exit0/signal null                   | natural、missing-ack、held-drain 与 prepared/running caller-death，覆盖诊断清理后的原完整链路；与 raw 轮分别统计。                               |

v7 只修夹具共享 OpenFile 的 Windows extended namespace，并把 ReaderFiles 尾部次级异常纳入原失败列表；不缩短 Unicode 路径、扩大期限、放宽 reader/断言或增加产品重试。同一现存长路径原生对照在其他参数不变时，普通 CreateFileW error3、extended namespace error0，定位的是夹具打开边界，不能外推为产品或 GPU 根因。副异常仍保留并使案例失败，不遮蔽原 primary。

七项 v7 的业务结果分别保留：fast/held-drain 为 engine-exit success0；nonzero 为 UInt32 exit2147483649/failure，即使 helper0 也不成功；deny-auth 和 prepared caller-death 为 Unknown；running caller-death 为 interrupted；missing-ack 的独立 reader 可得 engine-exit success0，但原授权 Unknown 与原 close/cleanup Unknown 保持 sticky。物理闭合、权限确认和业务结论不能互相替换。

易错点：原 owner ACK 只按关联 requestId 核对；requestId=null 的合法 observer 准备态可独立晚到，不能假设两流有全局顺序。最终 OS 断言修正允许这些 observer，但仍逐帧要求未授权/未 resume，并保留 AUTH/marker 缺失、完整原身份、真实 EOF/joins 和 strict Unknown；这是实现测试规则修正，没有新的 OS 实际行为 RED。

v6 源码、v7 两项夹具增量及最终固定 source v10 的源码独审分别为 Spec PASS / Quality Approved，未解决 C/I/M=0/0/0；v7 七项实际证据与 v11 两轮实际证据亦分别获对应独立批准。最终 raw/cover 两轮之后，5 个实际 Node 文件及 778 个 native 文件摘要复核均一致；v11 独审核完整外层 child.close/双输出结束/最终 receipt、九份原个例、严格记录与原身份链，仍只批准该两轮范围。快照副本是来源证据，不等于独立可安装包；文稿复审与本地交付仍待，86 项业务与 24 项 worker/部署规格通过数不变。

## 7. 收口与下一片

四项 raw native 交错及临时诊断移除后的所定覆盖已完成技术验证，最终固定源码与实际证据独审通过；原失败源码、旧未闭合驱动及部分冻结证据保留。当前继续文稿校验与独立批准，再按实际权限完成本地交付，不提前填提交或回读结果。

作者停写后固定最终源码和实际回执；Root 核格式、UTF-8、隐私及索引，再做独立 Spec/Quality 审查。发现问题仅修所需范围并复验覆盖检查，随后定点更新本计划与六个入口。文稿校验、独立批准、中文服务器本地提交及新连接回读分别需要回执；不因合同审查、窄范围源码批准或局部 GREEN 提前标完成。

本片不 push、PR、合并、部署、重启或修改生产。后续仍须独立完成 Windows ExecutionAdapter 与原 runner/store 接线、图片校验、可信安装/服务身份、成功传输和完整 GPU/Worker/API/ZEB 验收；原有平台、原件、真实尺寸、认证及归属要求保持。
