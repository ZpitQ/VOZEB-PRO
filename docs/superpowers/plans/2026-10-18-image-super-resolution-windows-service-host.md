# Windows 薄服务宿主：单代进程收容

目标：原 Node 根退出但 detached 后代仍永久挂起时，由宿主及时收容同一代；宿主自己硬死时，由最后非继承 Job handle 关闭提供内核收容。它是完整 Worker 安装前置，不是安装包或 GPU/业务就绪声明。

当前状态：产品收容 core 已实现，正式依赖与实际发布/类型检查通过；测试取证修正、最小产品 core、完整成员核验源码与最终实际证据独审均通过。四活跃场景、两负例与 H4 业务嵌套按各自独立有效轮完成技术验证，原 RED、部分失败及诊断失败保持原判。联合交付独审和服务器本地提交仍待各自回执，不预填服务器应用或部署完成。

主路线见[高清增强 SOP](2026-10-10-image-super-resolution-integration-plan.md)；已完成的[原根退出前置](2026-10-18-image-super-resolution-windows-root-exit.md)和[Windows ExecutionAdapter](2026-10-18-image-super-resolution-windows-execution-adapter.md)保持各自固定历史，不重复运行未变矩阵。

## 1. 固定产品范围

产品为单个薄 `WindowsServiceHost.exe`，官方 ServiceBase 与 `--console` 共用一个具体 `ContainedWorkerSession`，不用第二个进程守护框架或手写 SCM 状态机。服务名固定为 `ZebImageEnhancement`，包内布局固定为 `runtime/node.exe` 与 `app/main.mjs`，工作目录为 `app`。

产品只接受服务/console 模式选择，不提供可配置 executable、argv、cwd 或远程命令入口。不搜索系统 Node，不查用户 Upscayl 安装，不启动 shell；缺固定 payload 必须在 Prepare 前脱敏失败，不能运行一个空 Worker 冒充已交付服务。文件存在只证明路径可用，完整包来源、摘要、受保护目录、loader 环境和 ACL 仍须安装切片实现。

项目沿现有 `net10.0`、`win-x64`、self-contained 与 runtime `10.0.12`。正式 NuGet `System.ServiceProcess.ServiceController` 精确锁定为 `10.0.12`，包含真实 lock 和正式发布依赖；其 EventLog 传递依赖同为 `10.0.12`。不使用 SDK 内附同名 DLL 充作产品依赖，不默建 EventLog source，ServiceBase 保持 `AutoLog=false`。

## 2. 收容核心合同

同一具体核心只需 `Start()`、共享 `Completion`、幂等 `StopAsync()` 和必要 Dispose。可信程序集内可传冻结 launch 与两个字节 sink，产品入口只从上述固定布局构造；测试的窄 internal Inspect、JobName、原 StandardInput 和 CleanupObservation 不增加产品命令配置、第二个 Job owner 或 mutable gate。

实现及验收必须保持以下顺序：

1. 复用原 `JobProcess.Prepare`，创建时挂起并原子归入本代外层 Job。
2. 挂接原根退出、整树观察与双输出持续 drain，随后唯一授权；不先运行再补 Job admission。
3. 原根任何真实退出、host Stop 或真实读取/sink 故障，封存本代并进入共享的唯一清理路径，不循环重启或授权第二代。
4. 正常可证明收尾须保留 Dispose 前的原 root/tree 结果，原 tree active0 和双输出真实 EOF，完成相应 joins 后再 Dispose；Force 返回、Dispose、取消或超时不能补造这些事实。

Stop 先到必须阻止之后 Prepare/authorize，重复 Stop 返回同一个清理任务；Start 只能一次。同步锁保护本代所有权，但不能持锁等待异步清理或 native monitor join。准备、授权、观察或清理出错时，保留原错误并仅收容精确当前 owner，不按 PID 重开、扫全机或换 owner 旁路未知资源。

输出按固定大小 buffer 持续读取，不全量累积。sink 首次真实失败应记录并触发失败收容，之后继续 discard 读取，避免日志反压卡住退出。`ReadAsync==0` 才是真实 EOF；读取错误与 sink 错误分别保存，停止或流销毁不等于 EOF。

本片 host Stop 立即 Force，仅是物理收容；它不是业务 soft-stop，不替代原 request-stop、stopId、首次宽限或业务 ExecutionExit。Stop 与自然退出竞态只保实际观察到的退出码和事实，不声称能够精确归因哪次动作杀死原根。即使原根 exit0，仍须收容可能活着的后代；物理清理或 reader exit0 不授予业务成功，不升级已结算 Unknown。

正式 ServiceBase 的 OnStart、OnStop、OnShutdown 与 console 使用同一核心；实际 core 完成应结束相应服务生命周期，不能根已死还空留 SCM Running。具体实现、console 取消及真实 SCM 生命周期分别按对应证据核定，当前未进行 SCM 安装、启动或 Session 0 运行。

## 3. 测试取证与原对象等级

H1/H2 使用真实 Node 直接根及一个 `detached:true` 永久挂起 WinExe 后代。后代只是 hung reader 替身，不等于已向真实 NativeRecoveryReader 内部注入永久挂起。READY 必须位于永久 gate 已建立、所有 Console 输出完成之后；READY 后不再通过 stdin、输出管道或自动期限自行退出。

host/Node 的 pin 如实登记为 `qualified-post-open-query-pin`：一次后开 retained HANDLE 与原 PID/creation time、SID、真实 image 和原 Job membership 交叉核定，之后注入和 join 复用该原对象，不冒称 CreateProcess 创建 handle。hung 后代由自身原 process object DuplicateHandle 转移，单列来源，不能与 Node pin 等级混写。

完整成员核验同时覆盖系统 conhost：创建前冻结系统 image 文件身份，所有额外成员逐一核 PID/creation time、同 SID、非继承、image 文件身份、原 Job 和实际 Alive，再保留同一 query pin 到真实 join。初始/最终成员 ID 与历史 active/total 必须精确对应主体及全部已核系统成员；未知成员仍失败，不是把预期数量从2改成3。最终活跃轮核得 inner 三对象、独立安全边界四对象，不把后开系统查询 pin 写成原创建 handle，也不唯一归因更深系统创建调用或安全软件。

H2 注入前关闭所有宿主原 Job 的 observer/query handle，query-only 也不能跨注入保留。宿主硬死后不重新打开原 Job，因此 `postCrashOriginalJobActiveProcesses=null`、core Completion/tree 未观察；不能补成 active0 或完成。该例依据注入前精确 census、固定测试 app 在 READY 后不再 spawn、全部 retained 原 process pins 真实 join 和无 guardian 共同核定。安全边界 Job 的 active0 属于不同 owner，不能替代宿主原 Job 事实。

| 场景                       | 必须实证的条件                                                                                                                                   | 当前状态                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| H1 `root-exit`             | Node、永久 hung 后代与已核系统成员都活着后，仅令 Node 自然退出；原根观察触发 host 收容，原 tree active0、双 EOF 和所有原 pins join               | 最终四活跃场景轮通过：原根0、hung 真实退出，无 guardian                 |
| H2 `host-death`            | 主体及已核系统成员活着且 query Job handles 全关闭后，仅终止 retained 原 host；不 Force 安全边界，原成员实际退出且无救援，宿主原 active 保持 null | 最终四活跃场景轮通过：仅 host 137，所有原 pins join，Completion 未观察  |
| H3 `stop-race`             | 原活代拒绝第二次 Start，原根退出与两次 Stop 交错，共享一个清理 task；只一个 Node 启动、原 tree/EOF/pins 收尾                                     | 最终四活跃场景轮通过：同一 stop Task、单代，无 guardian                 |
| H3 `stop-before-start`     | 先 Stop 后 Start 拒绝；独立安全 Job 历史 total1/active0、原子 fixture 收尾证明没有历史 Prepare 后又清理的隐藏后代                                | 沿首轮部分失败中的本例有效通过；后续对应方法未变                        |
| `sink-failure`             | 真实 sink IOException 只抛一次，Completion 失败；之后持续 discard，真实读取无错、双 EOF、原 tree active0 与 pins join                            | 最终四活跃场景轮通过：一次 IOException、双 ReadAsync 返回0，无 guardian |
| 缺固定 payload             | 真实产品在 Prepare 前脱敏退出，安全 Job 历史 total1/active0、原产品 pin join、双 EOF，证明没有 Node 后代                                         | 沿首轮部分失败中的本例有效通过：exit2，后续产品/分支未变                |
| H4 `natural` / `stop-soft` | 原完整业务 validator 原样通过，额外宿主 sidecar 分别证明外层原 root/tree、真实双 EOF 和输入 relay 结果                                           | 独立 H4 轮两例通过；业务自然成功与软停止分别核定                        |

stop-before-start 没有创建 core 输出流时，core EOF 仍为 false；安全边界收尾的 EOF 是另一组事实，不能相互填充。任何 guardian 或安全边界救援一旦介入，该轮失败，不自动重试、扩大预算或放宽精确成员数取得通过。

测试通过显式 `ZEB_WINDOWS_SERVICE_HOST_OS_TESTS=1` 选择，并提供 fixture、无 payload 产品运行件和独立证据目录。未选择时不运行；已选择后缺 Windows、运行件或配置直接失败，不降为跳过。每轮使用独立、不可覆盖证据目录并保存调用方原 exit/close、真实输出 EOF 与错误；不把缺 DLL、编译错误、超时或 guardian 算有效行为 RED。

## 4. H4 只增加外层宿主维度

新 test-only `bridge-outer` 分支使用同一收容核心包住旧固定 `WindowsSessionFixture`，完整传递原 argv 与原始 stdin/stdout/stderr。这里外层直接根是旧 fixture；H1/H2 才是真 Node 直接根，不能混称。

沿既有 Windows execution bridge OS 测试只选 Adapter 的 `natural` 与 `stop-soft` 两例，不复制原 Harness、不重建 carrier、不改 AUTH、stopId、journal、原业务 deadline 或首次宽限。原完整 validator 继续核真实 engine/reader 身份、原授权、inner tree、双 EOF 和可信终态；旧 fixture 能合法返回 Unknown/exit0，因此只看 wrapper exit0 或外层 accounting 不足。

新诊断只写独立 `windows-service-host-h4.json` sidecar，不混入原协议 stdout。sidecar 分别记录同一 core 的原 root/tree、双 EOF，以及 stdin relay 的真实 EOF、关闭、错误/取消与 join；只有原 stdin ReadAsync==0 才能记自然 EOF。输入取消或 wrapper close 不能冒充内层流尾。新旧发布件须在同一隔离运行目录核完整 inventory 与共有 DLL 字节；若重新 publish，如实记新运行件，不称旧二进制完全未变。

## 5. 分轮实际结果与待核事实

不同源码阶段和执行轮次独立保存，不累加通过数、不改写 RED。

1. **官方依赖与 StageT 基础构建通过。** 两新项目正式 lock 已产生，两份发布构建、TypeScript 与模块构建均实际 exit0。首份 throw-only 编译的四条未用字段 CS0414 警告保留，只归属该阶段，不能写成零警告。
2. **首个真实 RED：1 failed / 5 名称过滤，2.87 秒。** 真实 core Start 抛 NotImplementedException，workerStarts=0、Completion pending；失败是首条“Start 应成功”行为断言，不是加载或配置失败。内部原 host 自然退出0、唯一 pin join、安全 Job active0/total1、双真实 EOF、无 guardian；外层测试仍失败，不能改记为 GREEN，也没有覆盖下游 READY/注入。
3. **两项测试取证修正完成独审。** hung 的 READY 原先早于后续 Console 写与永久 gate，可能把断管自行退出误作收容；stop-before-start 原 marker0/最终空状态不能排除历史 suspended Prepare。修正 READY 顺序和独立安全 Job 历史 accounting 后，Spec/Quality 独审通过、Critical/Important/Minor=0/0/0。这些是静态可达取证缺口，不是实测产品收容失败的根因。
4. **最小产品 core 完成源码独审，首轮 OS 为 4 failed / 2 passed，9.34 秒。** 产品 Spec/Quality Approved、Critical/Important/Minor=0/0/0，发布与类型检查实际 exit0、无 warning/error。四活跃场景在预期成员2漏计系统成员处失败，没有发生计划中的场景注入，安全 guardian 已介入，不能宣称产品收容成功。两例有效通过分别是 Stop-before-Start 的安全 Job 历史 total1/active0，及缺 payload 的 total1/exit2；其完整方法、分支和产品字节未受后续修正影响，保留这两例原有效证据，不重跑或称新一轮六项全绿。
5. **独立诊断：1 failed / 5 名称过滤，3.44 秒。** 原完整成员为 Node、系统 conhost 和 hung；各 retained query pins 的 identity、SID、非继承、image 文件身份、原 Job/Alive 及同对象 join 逐一核定。仍未发生场景注入，guardian 介入且该轮失败，原判不变。只证明该轮完整拓扑，不归因安全软件或唯一系统创建调用；临时大诊断类不交付。
6. **完整成员核验最终源码独审与四活跃场景通过。** 仅 fixture/TS 增加所有额外成员的完整资格和精确 ID/accounting 核验，未知成员仍失败；产品及其他未改文件保持原字节，Spec/Quality Approved、Critical/Important/Minor=0/0/0。新发布与类型检查 exit0、无 warning，四个共有 DLL 与前轮产品一致。唯一最终活跃轮为 **4 passed / 2 名称过滤，8.62 秒**，原 exit/close0、输入未变、stderr 空；H1 根0且 hung 真实退出，H2 仅 host137 后所有主体/系统成员原 pins join、宿主原 active=null/Completion 未观察，活跃 H3 同 stop Task/单代，sink 一次真实 IOException 后双 ReadAsync 返回0且 Completion failed。四例均真实执行对应注入、无 guardian，inner 三对象/安全边界四对象分别逐身份资格与原 pin join 核定。
7. **H4 独立轮：2 passed / 20 名称过滤，24.33 秒。** 原未改完整 Adapter validator 保留，原 exit/close0、输入未变、stderr 空。AUTH、terminal、reader 通知 pin/adoption、原 Guard 八个完整对象及首次宽限证据闭合；natural 成功与 soft-stop 分账。外层真实根为旧 fixture，root0/tree active0、双 ReadAsync 返回0，原 stdin 真 EOF 后关闭并 join，无 relay 错误/取消或 guardian。H4 实际证据独审 Spec/Quality Approved、Critical/Important/Minor=0/0/0；后续完整成员核验未改此分支、relay 或产品字节，沿用该独立有效轮，不重跑。

上述最终四活跃场景不与旧两负例或 H4 相加，不称“本轮八例全绿”。原失败、过滤、guardian 与不同发布件各留来源。最终实际证据独审 Spec/Quality Approved、Critical/Important/Minor=0/0/0；联合交付独审、文稿和服务器本地提交仍待各自回执，不预填提交身份、fresh readback 或服务器源码已应用。

## 6. 后续里程碑与安装边界

本片宿主技术验证完成后，再装配真实 bootstrap、Clock 和提交/取消唤醒；接成功 result/receipt，固定离线安装包、完整 payload/依赖和 ACL，再验实际 SCM、最小权限服务账户、Session 0、Windows Store 耐久、GPU/图片与 M3。既有 Store 目录刷盘实现和历史技术证据保留，不重复开发目录刷盘桥；实际服务账户权限与耐久仍另验。

没有完整 Worker 安装包，内部 host EXE 或测试 app 不提供给用户作为安装产物。SCM Running、console exit0、kernel API 接受、原进程物理退出及 reader exit0 均不代表 GPU/业务可用；安装、升级/卸载、真实后台运行和 Worker/API/ZEB 继续分别取证。

当前保持 M1 已验收、schema5、enhancement off/readiness=false、worker 未接及自动 OOM 降 tile 重试暂缓。未 push、创建 PR、部署、重启或修改生产；没有真实 SCM 安装/启动、服务账户或 GPU 操作。
