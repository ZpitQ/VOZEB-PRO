# 图像增强 worker 基础模块

Windows 首次部署优先使用[简化安装入口](deployment/windows/INSTALL-WINDOWS-EASY.md)：解压整合包后双击 `Install-ZEB.cmd`，确认 IP／端口即可自动准备目录、引擎清单、配置与 Token。配套入口和运行包版本绑定，重复运行保留现有安装；原参数式脚本继续用于维护。

M3 Windows 内网部署已完成本期功能、实机与最终安装／来源材料交付，采用 HTTP＋Token 和普通自动启动服务，不要求证书或额外启动证明握手。真实后台 GPU、任务跨服务重启恢复、升级／显式恢复／回退、忙时保留卸载、原身份重装和隔离副本删数据已有分轮验证。安装与逐项边界见[安装指南](../../docs/superpowers/plans/2026-10-23-image-super-resolution-windows-install-guide.md)和[M3 交付清单](../../docs/superpowers/plans/2026-10-23-image-super-resolution-m3-delivery.md)。最终交付复用已测 v13 运行字节，历史候选与来源 Unknown 保留；用户确认及 M4 后台接线单独推进。下方早期“尚未实机”描述保留历史，不重新作为当前门槛。

内网安装支持显式 `host` 的 HTTP，保留原 Token 认证；无需 PFX 或证书信任配置。原 `tls: { host, pfxPath }` HTTPS 路径继续兼容，`host` 与 `tls` 互斥，不自动切换协议。安装记录在 HTTP 下明确保存 `tlsSha256: null`，维护、保留重装及完整备份/回退保持同一配置。实施和验收边界见[内网 HTTP 计划](../../docs/superpowers/plans/2026-10-20-image-super-resolution-internal-http.md)；代码测试不代替真实 SCM、Session0/GPU 或整个 M3 验收。下文旧阶段强制 TLS、HTTP 仅回环的描述属于历史记录；当前 HTTP listener 可传具体数值 IP，未传仍为 127.0.0.1。

M3 服务启动权限检查已改为由真实 Host 在 `session.Start()`、创建服务工作 Node 之前执行，安装器先授予最小自有 ACL，不修改外部目录 ACL，也不再用 SID 推导上下文代替实际服务令牌。Host 完整 14 项与真实 NTFS 安装器权限两项已分别通过；后者使用受限 caller，不是 SCM 身份验收。阶段合同及权限测试易错点见[启动前访问检查计划](../../docs/superpowers/plans/2026-10-20-image-super-resolution-service-startup-access.md)。最终包、实际固定服务/Session0/GPU与整体 M3 尚待各自验收。

当前[成功结果退役与精确清理切片](../../docs/superpowers/plans/2026-10-19-image-super-resolution-cleanup.md)已实现认证单 job 的持久退役围栏、仅原 final PNG/manifest 的清理及既有下载路由 410。schema7 新增不可撤销的 `result_retirements`；只有首次正常顶层退役 COMMIT 返回者持有当前 Store 的真实一次 work，才可删除两个 final、同步并关闭原候选目录，保留空目录、原件、其他产物和全部历史元数据。只读资格本身仍不授删除权。

已获 work 后的中断、异常或清理确认丢失保留 pending；已有 pending、并发第二调用或重开不补发 work、不重放 unlink/complete。目录 guard 的一次瞬时错误也不能被吞为 false 后追认 sync；complete 真实提交后丢确认，当次仍 pending，后续调用只读原行可知 complete。新下载仅凭真实持久退役返回 `410/result_gone`，文案为“增强结果已按保留规则停止提供，无法再次下载。”普通缺文件、坏图或未知失败仍为 503；已捕获完整 Buffer 且关闭句柄、释放引用的旧响应可完成 200，下载槽仍等待 reader 与 response 双完成。

本片实现、所定技术验证和两个固定源码门禁均已完成，Spec compliant / Quality Approved，Critical/Important/Minor=0/0/0；各测试轮及反例单列于切片计划。文稿、隐私、联合审、固定交付、服务器中文本地提交及独立回读各门禁分别按最终实际回执核定，源码批准不代替这些门禁。没有迁移或实际数据库升级，没有默认保留时长、扫描、调度或远程清理路由；pending 恢复治理、实际永久保存客户端、完整安装包/SCM/Session 0/服务身份、GPU/TLS/WorkerAPI/ZEB 继续后置。增强关闭/readiness=false、worker 未接和 OOM 自动降 tile 暂缓保持。以下前片记录保留各自历史状态，后面的当前 Store/HTTP 合同按本片更新。

前一切片[成功结果保留资格切片](../../docs/superpowers/plans/2026-10-19-image-super-resolution-retention.md)已实现认证单job的同步只读一致事务快照，显式retentionMs从真实completedAt起算。新17/17（总9.45秒、测试7.01秒）与旧receipt-store/artifact-download两文件34/34（总9.78秒）独立通过，最终types/build各0、166 inputs不变；原17项15失败/2通过RED另轮保留。本片实现、所定技术验证与固定源码独审已完成，Spec compliant / Quality Approved，Critical/Important/Minor=0/0/0。公开文稿/隐私门禁与服务器本地交付仍待各自实际回执，不预填这些后续成功。 schema6与既有HTTP九字段配置保持，不增表、字段、HTTP路由、扫描或调度。

返回恰serviceId/jobId/state/checkedAt/retentionMs/retainUntil/receivedAt/heldReferences八字段冻结primitive快照；状态依次核无receipt、时间、全部未释放引用，最后eligible。等于retainUntil满足期限，clock早于receivedAt仍retention_pending；同job/attempt全部旧incarnation、run/recovery、NULL或另一candidate保护引用均计数。快照不是删除许可或资源持有，后续清理必须独立写事务围栏重核并阻止新下载。非法received_at构造被schema阻止，错绑定可合法构造；snapshot从DB文件副本读取，不重开活Store，controlled reopen不称实际崩溃。

TC1成功后60秒仅测试，无生产默认；元数据120秒不在本片。receipt不证明远端永久保存，实际客户端、物理清理/退役/410、完整离线包/SCM/Session0/服务账户、GPU/TLS/API/ZEB继续后置；增强关闭/readiness=false、worker未接、OOM自动降tile暂缓保持。以下保留前置片当时记录，现有Store/HTTP合同继续适用。

前一切片[持久结果接收确认切片](../../docs/superpowers/plans/2026-10-19-image-super-resolution-receipt.md)已实现严格请求parser、schema6收据Store与既有POST receipt JSON接线：有效JSON200，空POST400，原401/404/非成功409保持。Store v2两文件22/22（10.25秒）、配置新旧19/19（2.07秒）、HTTP18/18（9.90秒）与旧HTTP八文件144/144（40.05秒）分轮通过；Store v2和HTTP最终types/build各exit0。旧Store142/142（10.70秒）沿v1未变路径证据，不称v2重跑。本片实现、所定技术验证与总源码审查已完成，Spec compliant / Quality Approved，Critical/Important/Minor=0/0/0。公开文稿门禁与服务器本地交付按各自实际回执收口；本稿不预填文稿批准或提交。

Store v1两Important已由真实RED、最小补修、v2检查和Store源码复审收口；原失败与各轮GREEN分别保留。schema6是代码契约，普通open拒绝旧5/未知版本与缺收据表/列的伪6，不迁移、补表、删除或覆盖，不表示服务器数据库已升级。receipt只持久保存认证客户端已验证并永久保存的声明；网络finish不证明远端存储。retention/410、完整离线安装包、实际SCM/Session0/服务账户、GPU、TLS/API/ZEB后置；增强关闭/readiness=false、worker未接、自动OOM降tile重试暂缓保持。以下前置切片记录保留各自历史状态；后面的当前Store与HTTP接口说明按本片实际实现描述。

前一切片[HTTP 成功产物下载切片](../../docs/superpowers/plans/2026-10-19-image-super-resolution-http-result.md)固定 v2 已实现并通过最终类型、构建、新三文件完整 20/20 和源码独审；文稿与本地交付待各自收口。原 v1 的 17/17 和旧六文件 133/133 保留，133 沿用于本次未变的上传、JSON、唤醒和 bootstrap 路径，不称 v2 重跑。配置 13/13、正文窄修 43/43 及原 RED/Important 拒绝分别保留，不相加。

`maxConcurrentDownloads` 是显式必填正安全整数，与上传并发和排队容量独立，不提供默认值或上传容量回退。成功 result 复用原 `readPublished` 和同一验证 PNG，不插值或补像素；正文收口后才最终重核 seal/signal、Store/principal 与网络状态，随后发送成功头。容量满返回 `429/download_capacity_exceeded`，`requestTimeoutMs` 为下载总期限，超时返回 `408/download_timeout`。下载槽须等 reader 真正结束及响应 finish/close 同时成立才释放；超时/断连后继续收容已发 I/O 与迟到句柄，二进制头发出后只关闭、不拼 JSON。未鉴权且正文未完成的拒绝路径在响应 finish 再 pause，由 `Connection: close` 正常关闭，保留完整 401/零消费验证。

receipt 仍未接线，下载 finish 不表示 ZEB 已验收并永久保存；持久接收确认、保留/清理/410、完整安装包、实际服务/GPU 与 Worker/API/ZEB 后置。schema5、增强关闭/readiness=false、worker 未接和自动 OOM 降 tile 重试暂缓保持。以下 reader 等记录保留各自历史状态。

当前[已发布成功产物只读出口](../../docs/superpowers/plans/2026-10-19-image-super-resolution-published-reader.md)已完成库内实现、类型检查、构建及固定源码独审。新行为单文件 17/17 与受影响旧六文件 80/80 分轮通过，均无跳过；原缺行为 RED 保留，各轮不相加。文稿与本地交付按各自回执核定，新 dist 尚未完成本片独立进程交付验收。

`createArtifacts({ store, files? }).readPublished(principal, jobId, signal)` 只读取已认证、归属正确且具备真实成功证据的 published 产物，返回原验证链得到的 `ValidatedAiArtifact`。每次请求独立取得新的 held recovery 引用，在异步边界前后重核 Store、身份、信号和精确引用；查询到 published 事实本身不构成读取许可。取消或撤权后禁止新读与交付，仅收容已发 I/O 和原句柄，确认关闭且引用事实明确时才清理本次精确引用；Store 关闭后不再访问数据库。首次 close 不明保留引用，release 最多尝试一次，异常后仅读回同 key 状态，不重放。接口不重开路径发送、不 resize、不从 raw 修复或重新执行。

该库出口尚未接入 HTTP result；下一继续独立下载容量、总期限和真实 TCP 生命周期，再单列持久 receipt、保留/清理及 410。完整安装包、实际 SCM/服务账户/Session 0、GPU/图片和 Worker/API/ZEB 仍待，schema5、增强关闭/readiness=false、worker 未接及自动 OOM 降 tile 重试暂缓保持。以下保留各前置切片当时的记录。

当前[正式 Windows Worker 入口装配](../../docs/superpowers/plans/2026-10-18-image-super-resolution-worker-bootstrap.md)已完成固定相邻配置、`main.mjs → dist/bootstrap.js`、同一 Clock/Store/Windows Adapter/Runner、持久提交与取消唤醒及关闭封存，类型/构建和固定源码独审通过。入口两文件 40/40，旧 launcher 98 passed / 1 平台门控 skipped；Clock 24/24、HTTP 新行为 7/7 与旧 HTTP 65/65 沿各自独立轮次，不合计。文稿与本地交付依各自回执核定。内部 EXE 与该入口不是完整离线安装包，实际 SCM/Session 0、服务账户 Store 耐久、GPU/图片、result/receipt 及 Worker/API/ZEB 继续另验；增强关闭/readiness=false、自动 OOM 降 tile 重试暂缓保持。以下保留前置切片当时的记录。

当前[Windows 原根退出观察](../../docs/superpowers/plans/2026-10-18-image-super-resolution-windows-root-exit.md)已在现有 JobProcess 中实现，独立于整树与业务退出；最终四个原生场景和旧 Job 回归分轮通过，最终源码/实际证据独审、文稿及本地交付按各自回执核定。它是服务宿主的前置接口，正式宿主尚未实施或消费，没有完整 Worker 安装包；实际 SCM、GPU/图片、服务账户 Store 与 Worker/API/ZEB 继续另验，增强关闭/readiness=false 保持。以下保留前置切片记录。

当前[正式 Windows ExecutionAdapter](../../docs/superpowers/plans/2026-10-18-image-super-resolution-windows-execution-adapter.md)已组合原 Host、严格日志读取和现有 Runner/Store，并完成所定分轮单元、接缝、原生自然退出/停止及调用方退出后的读取器清理验证，固定源码与实际证据独审通过。文稿及本地交付按实际回执核定；GPU/图片、Windows Store 耐久、安装服务和业务入口继续另验，增强关闭/readiness=false 保持。以下保留各前置切片记录。

内部[原生执行桥切片](../../docs/superpowers/plans/2026-10-17-image-super-resolution-execution-bridge.md)已完成所定分轮技术验证，包含原 helper prepare、单次 AUTH、自然收尾、调用方失联及四项原生交错；临时诊断已移除，最终固定源码、实际证据及文稿独审通过，中文本地提交与独立回读完成。物理清理不能代作业务成功，ExecutionAdapter、实际 GPU、服务身份及 Worker/API/ZEB 保持待验；详细分轮只记在切片计划。

[Adapter 被动闭合前置片](../../docs/superpowers/plans/2026-10-18-image-super-resolution-adapter-passive-closure.md)为原 host 增加 `whenClosed()`，直接观察同一个原闭合 Promise；调用不发送 close/stop、不提前关闭 stdin，主动 `close()` 保留原行为。完整 joins 与已结算 Unknown 语义不变，物理闭合仍不能生成业务终态；停止权限、持久停止期限、严格停止记录消费及完整 Adapter 接线继续后续实施。实际验证与独审状态见该计划，不代表增强链路就绪。

[停止发送许可前置片](../../docs/superpowers/plans/2026-10-18-image-super-resolution-stop-send-permission.md)为普通与恢复停止传递原持久期限，并在最后发送处核单次权限；具体实现和验收状态见计划。该片仅覆盖 runner/store 与 test Adapter，原生业务停止、严格终结证据及完整增强接线继续分别验收。

[原生业务停止切片](../../docs/superpowers/plans/2026-10-18-image-super-resolution-native-stop.md)规定独立 `request-stop`：原 AUTH 成功后，soft/force 复用原 owner、Writer、permit 与固定持久期限，各自保留一次性请求及回执关联；业务请求不触发 `close()` 或结束 stdin，重复不续期，ACK 不构成 ExecutionExit。具体实现与分轮验收状态见该计划；严格停止记录消费、正式 Adapter 与 GPU/Worker/API/ZEB 接线继续独立推进。

[停止终态读取切片](../../docs/superpowers/plans/2026-10-18-image-super-resolution-stop-terminal-reader.md)约束同源 request/prepared/AUTH、成功恢复执行、原 engine/Job、整树退出与双 EOF 等完整证据。stop/deadline 只提供原退出证据，业务取消原因继续使用原持久记录；具体实现和实际验收状态见计划，正式 Adapter 与完整增强接线仍按后续阶段推进。

本包是独立的 TypeScript/Node.js 模块，包含冻结增强计划、受控模型配置、图片校验、稳定身份、本地 credential 管理、SQLite 持久幂等提交和受认证 HTTP。M2-B3-4 已实现 completion、普通终态、持久产物候选与同源重验、安全成功摘要，以及联合资格下的运行后中断恢复和 runner 接线；本批实现、技术检查及代码/文稿独立复审已完成。

Windows 普通产物文件刷盘修复已实现：先完整只读预检，关闭该轮句柄并重核当前完整、active、intent、success 资格后，才用 `r+` 重新验证全部候选内容并刷盘该轮同一批句柄；初次半候选、已发布/耐久候选、非成功尝试及 engine/raw 读取保持 `r`。分轮技术验证已完成，独立复审与本地交付待收口；机制、真实分轮及限制统一见[主 SOP](../../docs/superpowers/plans/2026-10-10-image-super-resolution-integration-plan.md)，不代表服务或完整增强链路就绪。

[执行发送许可切片](../../docs/superpowers/plans/2026-10-16-image-super-resolution-execution-send-permission.md)已完成内部实现、所定技术验证与固定源码/实际证据独立复审；Windows 耐久 Store、原生接线、完整 GPU/Worker/API/ZEB 及用户/部署验收仍待，文稿与本地交付按独立回执核定。

M1 普通插值放大移除已获用户验收，测试站仍运行 M1，worker 未部署、生产 ready=false、增强默认关闭。按用户最新选择，自动降 tile OOM 重试暂缓；B4-0 普通原件 1254²→5016² 的真实 SSH CLI 4× 诊断已通过，该次 CLI 未经过 Job Object 控制。B4-1A Windows Job/process、B4-1B1a 本地 named pipe 控制入口及 B4-1B1b 可信文件记录原语已分别通过有界技术验证。旧控制模式的 `ready` 仅监听、`stop` 仅封存 claim；文件原语绑定完整身份，只有首次 Created 返回唯一原 Owner，完整记录可在原进程退出后严格只读重开，不完整历史 Unknown 且不修复。reservation/Existing 不授引擎权限或业务 terminal；这些早期原语本身不含 B2 业务因果与引擎授权接线，当前原生会话、独立只读 reader、有界 launcher 与受限控制桥进展见下文 B4-B2-4/5/6/7。后续顺序为原生控制桥 → 有界 TS stdio host → 真实 prepare/AUTH 与 execution Adapter；安装/数据目录配置与清单部署、服务身份及实际部署验收仍待。补成功传输与其余必要持久接缝后再接完整 GPU worker、测试环境后台和 ZEB 普通完整图。5016² 是待按交付预算等比下采样的 AI 中间产物，不称已交付或原生 4K；API 与 ZEB 未接。远程 TLS、运行中管理、安装、receipt/清理等未完成项继续独立交付，原件、真实尺寸、认证与平台归属要求保持。详细契约、实际分轮与条件未执行项见[主 SOP](../../docs/superpowers/plans/2026-10-10-image-super-resolution-integration-plan.md)。

[B4-B2-1 安装绑定](../../docs/superpowers/plans/2026-10-14-windows-engine-installation-plan.md)已验证外部批准原始清单、声明 CLI/所选模型对、严格只读租约与固定参数数组；store/runner 尚未消费租约，安装器/ACL 配置、loader/helper 完整性、服务身份及真实引擎/GPU/业务接线仍待。

[B4-B2-2 Job 保护与原句柄观察](../../docs/superpowers/plans/2026-10-14-windows-job-observation-plan.md)已实现创建时 protected Job ACL 与原 process/Job handles 的只读九字段观察，并通过有界 Windows 技术验证和固定源码独立复审。封存、原进程退出、整树终局、引擎 EOF 与实际 child 清理分别判断；分轮证据见[主 SOP §10](../../docs/superpowers/plans/2026-10-10-image-super-resolution-integration-plan.md)。该观察原语本身不含安装租约、引擎授权或原生会话；当前 native 接线、只读 reader/launcher 见 B4-B2-4/5/6，TS adapter 仍待，worker 未部署，增强关闭/readiness=false 保持。

[B4-B2-3 引擎准备请求合同](../../docs/superpowers/plans/2026-10-14-windows-prepare-payload-plan.md)已实现 stored 任务快照到冻结 Base64/原字节 SHA256 两字符串，以及普通 .NET 程序集的严格解析和只读结果；独立传输正控、两份完整合同测试及固定源码/实际证据独立复审通过。该数据合同无路径 I/O、无引擎启动，fixture EOF 不代表 engine EOF，本身不包含原会话/安装租约/授权/因果记录。当前 native 接线与只读 reader/launcher 见 B4-B2-4/5/6；TS adapter、服务身份与完整 GPU/API/ZEB 仍待。分轮统计见[主 SOP §10](../../docs/superpowers/plans/2026-10-10-image-super-resolution-integration-plan.md)，M1/schema5/增强关闭/readiness=false/worker 未部署/自动 OOM 重试暂缓保持。

[B4-B2-4 原生执行会话](../../docs/superpowers/plans/2026-10-15-image-super-resolution-native-session.md)已贯通实际 Program、唯一 session、原安装租约/记录 writer/Job/双流与单次授权执行的真实收尾；完整 Windows 技术验证及固定源码/运行证据独立 Spec/Quality 复审通过。AUTH verified、实际 resume 成功与收到 ACK 分别证明；Unknown 不补写或重建执行，树未证时保留 pins/helper。普通自然完成与故障强制收容分账，独立只读 reader/launcher 见下文；当前推进受限原生控制桥，随后有界 TS stdio host 与真实 prepare/AUTH/Adapter 接缝，再分别推进图片校验、安装/服务身份及 GPU/worker/API/ZEB；用户与实际部署验收仍待，schema5、增强关闭/readiness=false、worker 未部署与自动 OOM 重试暂缓保持。

B4-B2-5 已实现独立严格只读 `--read-records` 入口与纯同步 TS 快照解释器，并通过分轮技术验证及固定源码/实际证据独立 Spec/Quality 复审。`existing` 仅是物理证据，完整原身份/字节/引用链才可解释 engine-exit 或 interrupted；Unknown 不证明缺失、完成或可重试。后续独立 launcher 见下段，Adapter/runner/store、`readInterruptionEvidence` 或实际恢复启动仍未接。完整合同、分轮与限制见[主 SOP §10](../../docs/superpowers/plans/2026-10-10-image-super-resolution-integration-plan.md)和[原生计划后续切片](../../docs/superpowers/plans/2026-10-15-image-super-resolution-native-session.md)，不表示 M2、GPU、安装服务或 Worker/API/ZEB 已验收。

B4-B2-6 内部独立 Windows 有界只读 journal launcher 已实现并通过固定源码/实际证据独立 Spec/Quality 复审。新 unit 96 passed/1 non-Windows 平台 case skipped（97生成）、受影响 reader265/265 与真实 Windows OS15/15 无跳过分轮通过，不合计。显式输入/双输出字节和读/清理期限、冻结原 context、严格 JSON 与原 child 自然退出/真实双 EOF/完整 close 分别核验；未证清理保留 owner，创建/通道错误当前永久 poison admission，迟到事实不升级 Unknown，无 queue/retry。完整可信稳定部署仍为 TCB 前提，预算不证明 native reader 内存/CPU 或硬实时有界；普通 helper transport 与合成 qualified 历史不代作原 engine/GPU 运行。未接 Adapter/恢复消费者，增强与就绪仍关闭。详细合同、分轮与下一片见[原生计划 B4-B2-6](../../docs/superpowers/plans/2026-10-15-image-super-resolution-native-session.md)。

[B4-B2-7 受限原生控制桥](../../docs/superpowers/plans/2026-10-16-image-super-resolution-native-control-bridge.md)的核心控制与所选输出闭包已完成技术验证、对应固定源/actual独立Spec/Quality复审；完整v2/更广矩阵仍有未证边界。最终文稿校验/独立批准与中文本地提交及fresh readback，分别按最终固定回执和实际Git回读核定。独立CLI用原创建pins/原pipe peer绑定唯一ordinary helper，helper侧NamedPipe只有claim/watch/inspect/stop、桥stdin只有inspect/close；ready唯一CRLF、严格LF与Gate H→terminal→Gate B保持。新输出high2/38skip、low2/38skip、held-close1/39skip与受影响旧回归6/34skip分四轮通过，不合计旧轮或追补v3单路EOF超时/fallback失败。低控自主原owner zero-read先于caller EOF，held-close的native stop/helper settled/barrier EOF/sentinel/原bridge未signal先于同一reader resume，之后自然0/stopped；队列上限不是累计stdout上限，低控部分写失败不称发完64事件。ordinary回归1个qualified console完整join，新五例为0。v4发布曾有1条CS8602，v5保留原query pin的非空local窄修后fixture/fault无warning/error；runtime实际字节已核，不认证完整部署。exact kernel IRP/private queue counter、独立helper创建pin/ordinary helper双EOF权威与ambiguous create/Terminate失败/peer spoof仍未证。没有prepare/authorize、engine/GPU、TS production host或Adapter，不表示worker可增强；下一先有界TS stdio host，再真实授权/Adapter。详细十三轮与限制见切片计划，完整部署可信稳定为TCB，增强/readiness仍关闭。

B3-5 G1 固定历史仅增加独立 `oom` completion 与严格分类入口，同轮四文件90/90、34.90秒，typecheck/build各exit0、test.stderr0，固定增量独立review-v1的Spec/Quality均Approved、C/I/M=0/0/0，未部署，不代作本次文稿批准。schema仍为5；`oom_retry_used`、`oom_retries`、`settleOom`、自动降tile及G2/G3均未实现并暂缓。24GB及单次无OOM不代作容量验收或永不OOM的证明；既有小样不代作业务4K/服务身份验收。

B4 已实现无重试 OOM 终态：`finishFailed` 与 runner 在原权限、lease、deadline、取消和恢复控制约束下，将可信 `oom` 提交为 `failed/execution_failed`，只释放原 job/attempt/fence 槽；保留 producer、原退出、tile、ticket 和输出字节，残留完整 PNG 不发布成功。重开/恢复使用合法当前 publisher，不重启原任务，后续排队任务恰一次推进。本轮四文件82/82、34.84秒，无跳过，typecheck/build各exit0、测试stderr空；固定代码独立 Spec PASS / Quality Approved、C/I/M=0/0/0，与 G1 旧轮分开，不代作本次文稿批准或 Windows/GPU/API/ZEB 验收。

内部[有界 TS 控制 host](../../docs/superpowers/plans/2026-10-16-image-super-resolution-ts-control-host.md)已实现 `open/inspect/close` 并通过对应独立技术复审。prepare/AUTH、Adapter及GPU/业务接线仍待，增强与readiness保持关闭。

运行环境为 Node.js 22、pnpm 11.9.0。Sharp 与 TypeScript 使用锁文件固定版本。于本目录执行：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
```

`createWorkerConfig` 只接受受控模型、版本摘要、原生 4 倍率、tile 和三层资源预算；`normalizePlan` 只接受 `image-enhancement.v1` 的完整不透明图片策略，分别冻结策略与原件身份。请求不能指定路径、URL、命令或解除商品/蒙版保护。

`prepareEngineInput` 校验真实 PNG/JPEG、完整像素、EXIF 展示尺寸与摘要，一次归一方向和 sRGB，保留原件副本并预判原生 4× 预算。`validateAiOutput` 要求真实不透明 PNG 的每条边恰为输入的 4 倍，校验独立字节/像素预算和产物身份；不缩放或补造不合格产物。

`initializeStore` 只用于显式首次初始化；它返回一次性专用 key。`openStore` 只打开既有身份，不生成或回显 key。SQLite 使用 FULL 同步、DELETE journal 与启动时取得的 EXCLUSIVE 锁；另一个实例无法访问同一数据库。磁盘仅保存 key 摘要、client/credential 稳定身份、版本和吊销时间。`createClient`、`rotateCredential`、`revokeCredential` 是同一受控 store 上的本地管理函数，运行中的管理通道尚未提供。初始化缺失、重复初始化和数据被其他实例独占分别返回 `store_not_initialized`、`store_already_initialized`、`store_locked`；错误响应只包含固定脱敏信息。

前片 schema5 已有的产物结构保留：在既有 incarnation、恢复控制、冻结策略及退出证据上增加 `artifact_candidates`、`artifact_references`、`artifact_observations`。候选持久绑定不可变 producer/ticket/目录/manifest，intent→durable 与 durable_at 联合约束，同物理 attempt 最多一个 durable 候选；jobs 的 `result_candidate_id` 与 succeeded 等价，并以复合外键绑定该 job/active attempt 的候选。run/recovery 引用绑定真实 publisher/incarnation 和精确候选；有限诊断按精确 reference 保存，不产生跨 ref 的终态权限。attempts 的 completion 沿既有 exit_json/exit_observed_at 保存，触发器继续禁止改写 producer、票据、目录与 tile；publisher 可按恢复合同转移，单槽复合外键使用 `ON UPDATE CASCADE`。`recovery_events.kind/evidence_json` 区分 never-authorized 的合法封存与 authorized-interruption 的 v=1 联合证据，按原 job/ticket 唯一去重；后者不得伪造未授权 seal。前片 schema6 新增 result_receipts：job_id 主键/FK jobs、client_id/FK clients、receipt_id、candidate_id、attempt_no、received_at；UNIQUE(client_id, receipt_id) 与 candidate/job/attempt 复合外键保护绑定，immutable UPDATE trigger 保护首次记录，不另存 result_json。当前 schema7 另加不可撤销的 result_retirements，绑定原 receipt 与 candidate/job/attempt，只有 cleaned_at 可从 NULL 单次前进。新鲜初始化和普通打开均精确要求版本 7；普通打开探测两表全部必要列，旧6/未知版本及缺表/列的伪7均拒绝，不迁移、补表、删除或覆盖，也不表示实际数据库已升级。候选归属与当前成功结果仍须 Store 同事务校验。

`ResultReceiptRequest={serviceId,receiptId,result}` 与result的format/width/height/sha256/byteLength均为精确键plain object。serviceId/receiptId为标准UUID文本，SHA为64位十六进制，允许hex大小写并规范小写；format仅png，尺寸与字节数为正安全整数。`acknowledgeResult(principal, jobId, value, signal?)`只确认真实succeeded的所选candidate/attempt，不读图、不取artifact ref、不wake或改变执行事实。六字段深冻结receipt为serviceId/jobId/clientId/receiptId/result/receivedAt；首次applied=true，精确重放applied=false、receivedAt不变。同job换receipt、同client同receipt换job或合法摘要/服务不符返回409/receipt_conflict；不同client可复用receiptId，fresh principal与有效凭据轮换可重放。外层事务重入在解析/clock前及开始自身事务前拒绝；所有同步回调收口后，最后signal可用性检查先于当前principal终核。只有真正顶层COMMIT成功后才返回成功，INSERT/COMMIT错误脱敏503，不自动重放写入；原v1两Important已通过v2修复与所定验证关闭。

只读资格合同：`inspectResultRetention(principal, jobId, retentionMs, signal?)`位于现store.ts。retentionMs每次显式正安全整数，非法值及completedAt+retentionMs溢出为400/invalid_request。先拒closed/已有外层事务/abort并校验参数，只取一次合法Store clock；所有clock/signal同步回调收口后重核可用性与当前principal，自身事务前再拒外层事务，事务内不新增clock/外部回调。复用getOwned与原qualified published candidate链核真实成功，在同一只读事务内核原receipt的client/candidate/attempt/time及selected job/attempt全部released_at IS NULL引用；内部错误绑定/时间拒绝503，不判eligible。各态返回真实heldReferences、retainUntil、receivedAt/null；状态按awaiting_receipt、retention_pending、reference_held、eligible优先级。方法不读图、不创建/释放ref、不wake或改写执行/收据事实，也不授删除许可；当前 schema7 的独立退役写事务须重新裁决这些事实。

退役与清理合同：认证单 job 每次显式传入 retentionMs，在 immediate 事务重核原真实成功、选中 candidate、原 receipt、期限及同 job/attempt 全部未释放引用；共享持久围栏在新 published-read 引用 INSERT 前阻止下载，最后外部 clock 返回后仍重核围栏。首次正常顶层退役 COMMIT 后才登记当前 Store 绑定原 principal 的一次 work；复制、跨 Store、重开、撤权、关闭或 abort 均不能补发许可。既有退役只读原行，pending 不重放，已 complete 只返回原事实。物理清理仅依原 work 顺序 unlink 原 final PNG、manifest，再同步/关闭原候选目录并标记完成；保留空目录和全部其他文件、历史元数据。任何不确定性停止后续并留 pending，退役事务本身异常直接拒绝；完整顺序与丢确认语义见[清理计划](../../docs/superpowers/plans/2026-10-19-image-super-resolution-cleanup.md)。

首次初始化可创建缺失的数据目录；返回 Store 和一次性 key 前，先刷盘数据目录，再逐层刷盘本次新建目录的父目录，直到首个既有父目录。任一目录刷盘失败都关闭已取得的数据库连接并返回脱敏错误，不返回 Store 或 key。

`createSubmissionLimits` 显式校验等待容量、排队期限与幂等键长度；`createRunnerLimits` 显式校验执行期限、取消宽限、lease 与 heartbeat 预算，均不提供隐含默认值。`createJobService` 与 HTTP options 必须传入 runnerLimits；接受新任务时，从同一次受控配置快照冻结图片计划及独立 executionPolicy，后者保存 runner limits、该模型 allowedTiles 和摘要，不改变原 requestFingerprint 的请求身份语义。对新的不透明 PNG/JPEG 提交保存独立原件和归一 PNG，刷盘并原子 rename 后才以 SQLite 事务检查幂等、就绪与等待容量，COMMIT 后返回。`UNIQUE(client_id, idempotency_key)` 保证同 client 同请求只登记一份任务；严格语法与真实原件摘要校验后，合法重放先于当前就绪/容量，复用原冻结计划、输入和 executionPolicy，不受后续配置变化影响。合法策略冲突返回 409；错误类型、未知字段或不支持的 scope 仍按非法请求/计划处理。

`submit` 可接收可选的 `AbortSignal`。HTTP 断连会传递该信号；提交开始及同步登记紧前检查已观测到的取消，后者在就绪回调求值之后进行，到事务 COMMIT 之间不增加异步等待。该接缝无法预知尚未投递的系统断连事件。已 COMMIT 后丢失响应不会回滚或删除登记输入，调用方通过原幂等键找回任务。

新提交仍先创建 `queued`。`claimNext(ownerInstanceId)` 在同一 immediate 事务中先收敛真正超过原排队截止的任务为 `failed/queue_timeout`，再检查单活动槽，按 createdAt 与稳定唯一 queueSequence 领取，登记 `running`、首次全局执行截止、attempt/fence/lease/launchTicket 并占槽。等于排队截止仍允许领取，超过才超期，超期任务启动数为零；接受新键的容量检查也收敛排队超期，running 不计等待容量。活动槽由数据库约束保证唯一，不是进程内计数。公开 DTO 只输出已持久的安全状态，不含内部 policy、descriptor、文件路径、启动票据或认证摘要。

`createRunner({ store, clock, executor, ownerInstanceId })` 提供 `wake()`、`recover()`、`readiness()` 与 `close()`，Clock 与 store 使用同一时钟来源。调用方显式唤醒或恢复；HTTP 不自动唤醒，也不等待执行器。`recover()` 在外部 inspect 前建立共享在途 Promise/同步重入 guard，微任务进入恢复前重查 closed。领取、prepared 与授权事实分别 COMMIT 后才进入下一启动步骤；同步安装退出订阅后才真正 authorize。单个下一事件调度推进 heartbeat、执行期限与 force，等于截止仍允许，严格超过事件安排在安全整数 deadline+1。心跳不延长首次执行预算；悬挂的 prepare/authorize 或停止确认不阻塞生命周期。close 取消定时器与订阅、不等待挂起调用，停止回调内同步 close 后不再发后续命令；迟到结果不再写库、停止、转移或启动，不释放未知槽或伪造退出。

`CancelOutcome={job,status:200|202,applied}`，HTTP 返回 `data={job,applied}`。排队首次取消 200/true，已有终态 200/false；运行首次请求 202/true、重复 202/false，此时仍为 running、reason=null、cancelRequested=true。用户可在 lease 过期后持久请求取消，但过期 owner 的普通续租、停止、退出登记与清槽仍拒绝。停止事实先 COMMIT，最早原因与原宽限不延长；soft/force 各自在同一 runner 对原身份/票据的生命周期内最多一次，返回、抛错或挂起均不是退出证明。取消终态需要匹配原 producer identity/descriptor/launchTicket 的终局全树退出及悬挂授权封存；取消与合格成功由终态事务 COMMIT 先后裁决，取消请求不单独抢赢完整成功资格，取消存在时禁止恢复或 OOM 新计算。原 lease/fence、首次 deadline 与已持久 execution_timeout 继续强制。

completion 分类与 treeExited 分开，后来的 controllerLoss 不改写原 success/failure。合格 failure 或 oom 可提交 `failed/execution_failed`；当前 producer 的确定性坏输出须有当前精确 ref 诊断才可提交 `failed/invalid_output`。成功同时要求原持久授权、匹配 producer/descriptor/ticket、success completion、exitCode=0/signal=null、终局全树退出及冻结输入/预算内的 durable 合格候选。输入、accepted engine 和产物按同句柄有界读取、完整解码与真实摘要核验；产物和 manifest 经 write/file-sync/close/rename/目录及必要祖先 sync 后才登记候选和 result。排他新根与单在途 writer 保证无覆盖；I/O、已接受 engine 或完整候选损坏保守保留事实及引用，同源重验，不当作普通坏输出或新计算。全部已发出 I/O、解码及 close drain 后才可合法结束自己的精确 ref；未知旧 ref 不按 TTL 擦除。

恢复由同一 SQLite 排他重开后的 store 内部 incarnation 判定跨实例关系，换 owner 字符串或 lease 过期不产生启动中断资格。`beginRecovery` 发放持久控制即撤销旧普通写权限，不续旧 lease；携带 `expectedControl` 的刷新只接受仍有效的原控制。`inspect` 的 owned-alive、tree-exited、never-authorized、unknown 均使用不可变 producer/ticket；停止和退出观察也指向原来源。owned-alive、unknown、检查异常或挂起保槽且不就绪，队列与全局期限沿既有未来事件推进，无固定轮询。恢复 soft/force 每次先重核控制、原归属、最早停止事实和当前时间，等于宽限不 force、超过才允许；新恢复实例可重核后重发。

合法终局或未持久授权票据的合法原子封存，才允许同事务消费控制并转移 publisher；接管保留原 attemptNo、producer、票据、目录和 tile，未授权封存不能伪造成 ExecutionExit。never-authorized 路径沿既有持久事件恢复。已授权终局按 completion 与候选真实重验裁决普通失败或成功；未知事实继续保槽，不能凭文件存在或缺失取得终态或重算资格。

运行后中断新计算须联合 store 内部跨 incarnation/排他重开、原授权、可信 reader 实际读取的 authorization/controllerLoss/terminal 因果三记录、当前精确 ref/control、本 ref 的 no-qualified、无取消/stop、原 lease 与首次 deadline。store 才可自产并消费 authorized-interruption event，将原槽、新 attempt/票据/目录和精确 ref 结束同事务转移，不回 queued。runner 仅对 transferred 的 awaitingArtifacts holder 且 completion=interrupted 调用 additive recover，缓存包括 resolved 结果分流的完整 chain；live success 与旧 success 恢复仍走 settle。只有 `created` 才交接，并在交接及实际 prepare 前重核完整当前权限；`already-applied` 不附接，close、holder 退役或 active recovery control 均不得迟到启动。RR3/4 仅证明 COMMIT 后未 prepare replacement 安全保留，可信未准备 ticket 封存及原样 reopen 留 B4。已 COMMIT success 只由 GET/同键 replay 查询，不承诺自动扫描历史成功。`readiness()` 始终返回 ready=false。

`createEnhancementHandler`可组合到Node HTTP/HTTPS server；`listenEnhancementServer`要求显式端口并只绑定回环，保留原生头部期限与字节保护。七个端点统一检查唯一原始Authorization头，再访问路由、正文和存储；未认证的Expect:100-continue不会获邀发送正文。`healthz`只表明存活；`capabilities`输出服务身份、受控模型与预算白名单，生产就绪来源默认false，测试adapter不使生产自动就绪。未就绪新提交返回503/not_ready，已登记任务的合法同键重放仍返回202。succeeded的GET、同键replay及重复取消读取持久安全摘要format/width/height/sha256/byteLength；成功result返回200及image/png、真实content-length、摘要ETag和no-store。`POST /v1/enhancement-jobs/:jobId/receipt`在认证、归属与真实成功预检后接收严格JSON；有效请求返回200与`{code:"ok",data:{receipt,applied},msg}`，空POST或非法正文返回400/invalid_request。非成功result/receipt仍409/result_not_ready，未知或其他client任务404，认证失效401；running取消仍为202受理。原 result 下载仅在真实持久退役后返回410/result_gone，pending亦然，普通缺文件/坏图/未知失败仍503；GET job、同键submit与receipt不受退役改写。库内清理没有新增HTTP路由；response finish不自动创建收据，也不是客户端永久保存证明。

receipt JSON接收合同：`POST /v1/enhancement-jobs/:jobId/receipt`先认证、检查归属与真实成功，才处理正文或100Continue。请求仅包含serviceId/receiptId/result，jobId取路由、client取当前principal，不接受自报client、candidate、路径、票据或incarnation。首次与精确重放均返回200，data含receipt/applied；空体或非法结构400。正文使用成熟JSON.parse语义，不承诺检测同名JSON属性。Content-Type须唯一且为application/json，可带唯一charset=utf-8，大小写不敏感；不接受其他参数或重复头。Content-Encoding仅允许缺省/identity，压缩编码拒绝。缺失或重复Content-Type为400，非法媒体类型415；完整字节以fatal UTF-8解码后走同一parser，非法UTF-8/JSON/字段400。只有全部预检通过后发送100Continue。

receipt 容量与大小独立：maxConcurrentReceipts 满返回 429/receipt_capacity_exceeded，requestTimeoutMs 到期返回 408/receipt_timeout，Content-Length 预检与实际 chunk 累计均受 maxReceiptBytes 限制，超限返回 413。槽按真实 receiver 收尾及 response finish/close 收口，不排队、不借用上传/下载槽。超时、断连及未完成体不落库；完整解析和所有同步 pause/timer 收口回调后，最终核 signal、网络、Store 和当前 principal，再调用同步 Store 事务。COMMIT 后丢响应不回滚，客户端使用同 receiptId 重放查回原收据；response finish 不自动创建收据，也不是远程永久存储证明。

`createHttpTransportLimits`恰含九个显式必填正安全整数：`maxPlanBytes`、`maxMultipartOverheadBytes`、`maxConcurrentUploads`、`maxConcurrentDownloads`、`maxReceiptBytes`、`maxConcurrentReceipts`、`headersTimeoutMs`、`requestTimeoutMs`、`maxHeaderBytes`。缺失、未知字段或非法值均拒绝；headersTimeoutMs≤requestTimeoutMs，requestTimeoutMs仍受Node timer原范围限制。receipt字节与容量独立于上传/下载；上传、下载、receipt与等待队列容量各自独立，不补默认值或借用预算。配置19/19与HTTP18/18为独立轮，不累计。提交继续要求唯一Idempotency-Key、一个UTF-8 JSON plan字段及一个PNG/JPEG image文件，part顺序任意；成熟multipart解析器按真实字节计数与背压写本请求独占随机目录，filename不拼路径。完整接收后按冻结图片上限读取原件Buffer交既有提交服务，归一和持久登记仍由该服务负责，不承诺全链路零拷贝或单Buffer总内存。旧键重放沿原任务图片上限，仍核完整请求、策略和真实原件摘要。

上传超额返回 `429/upload_capacity_exceeded`，上传期限到期返回 `408/upload_timeout`，字节超限返回 413；错误使用固定脱敏响应。解析、断流、写盘和超时错误只清理本次未登记的上传目录。接口层不制造成功图，不提供远程 serve CLI，也不把回环 HTTP 运行等同于远程 HTTPS 或 GPU 服务已部署。

`requestTimeoutMs` 是已认证 receiver 的显式上传期限，从进入 receiver 起计时，由应用 timer 统一返回 JSON 超时响应并清理上传。server 工厂关闭重复的 Node 整请求期限（`requestTimeout: 0`），避免把头部阶段累计在内的原生408先关闭连接；`headersTimeoutMs`、`maxHeaderBytes`和原生431保持。将 handler 组合到自己的 server 时，宿主也应避免更早的原生整请求期限抢先关闭已认证上传，继续保留头部保护和应用上传期限。成功 result 复用同一显式值作下载总期限，覆盖 reader、已发 I/O/close/ref 收容和慢响应；receipt 也沿用该值作为 receiver 总期限，不新增独立期限字段。上传、下载、receipt 各自计数；下载槽按 reader 与响应双完成事实归还，receipt 槽按真实 receiver 与响应 finish/close 收口。

M2-B3-3 v1/r2 固定历史验证：首轮 typecheck exit 2，尚未进入 build/行为回归；已通过具名函数在同步退出订阅回调后重读最新所有权，未使用 any 或强转。第二轮 r2 类型检查、声明构建与同轮 13 文件 351/351 通过，无跳过、测试 stderr 空，墙钟 63.90 秒；新 recovery 两文件 103 项＋该轮重新验证的既有 11 文件 248 项＝351。该首版记录不直接代作补修候选通过。

M2-B3-3 v2/r3 固定历史验证：同步 inspect 重入 recover 新增用例已真实 RED→GREEN；补修仅调整 runner 的共享 Promise/guard 顺序及微任务前 closed 复核。类型检查、声明构建与受影响 recovery-runner31、lifecycle-runner26、runner12 共 3 文件 69/69 通过，墙钟 25.12 秒、无跳过、测试 stderr 空。未变 10 文件 283 项沿用 v1/r2，13 文件 352 个唯一用例按 69 本轮＋283 沿用分轮覆盖；不称同轮 352，不累计 351＋69、RED 或基础 96 项。补修与受影响回归通过，代码 v2 与公开文稿独立复审通过。当时的产物/普通终态限制由上文 B3-4 当前范围补充；B3-4 本批实现、技术检查及代码/文稿独立复审已完成，不表示页面或完整 M2 通过。

M2-B3-2 固定历史验证：先行生命周期 RED 后完成最小实现；同步 soft 内 close 多发 force 已有单项 RED→GREEN。复审前候选同轮 11 文件 244/244，包含真实双 Node 进程锁及自然慢头部 TCP；复审发现 soft 返回后旧时间/租约可能导致越权 force 或过去事件调度，再取得 4 项真实 RED 并补修。每次停止命令前及返回后的调度都重读原身份、票据、槽、有效 lease 与持久停止事实，补做已到 heartbeat，force 使用当前宽限。补修后 lifecycle-store18、lifecycle-runner26、runner-store48、runner12，共 4 文件 104/104、无跳过、测试 stderr 空；类型检查与声明构建通过。未受影响的 7 文件 144 项沿用前候选证据，11 文件 248 个唯一用例分轮覆盖，独立规范与质量复审通过、无遗留项；不累加历史轮次数字。确定性 adapter 只证明受控生命周期合同，不能证明真实 Windows 全树退出、GPU、性能或完整部署。

B3-1 固定历史快照：测试使用小型真实图片、临时 SQLite/文件、随机回环 TCP 端口和真实两个 Node 进程，覆盖损坏像素、原件保留、预算、认证、幂等、容量及写入/提交故障。B3-1 用例以同源可控时钟和确定性 adapter 验证领取、排队超期、冻结策略、descriptor 的持久 JSON 边界、COMMIT 启动屏障及 wake/close，不使用真实引擎。本次共享 schema/fixture 变化后的受影响九文件已同轮通过 204 项；历史首轮 58 项、基础层 96 项及旧 HTTP 分轮 86 项不与本轮数字累加。`pnpm test` 先构建，确保锁子进程使用本次生产编译产物；`pnpm build` 也可单独生成模块。本批文件刷盘与锁需要在目标系统实测；Linux 的结果不代替 Windows 验收。这些测试不运行 GPU，也不证明真实推理画质、性能或完整服务部署。业务接线及完整交付边界见[主 SOP](../../docs/superpowers/plans/2026-10-10-image-super-resolution-integration-plan.md)。
