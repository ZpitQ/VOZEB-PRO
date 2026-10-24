# 高清增强：Windows 原生执行会话实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 让实际原生入口贯通准备、持久授权、单次恢复、停止与真实收尾，保证同一尝试不会重复执行。

**Architecture:** 每个 helper 仅拥有一个冻结尝试、原安装租约、持久记录 writer、原 Job 与两路输出 drain。小型状态门只决定授权与封存，文件 I/O 和收尾在门外执行。事实不完整时保留 Unknown，不用关闭句柄制造成功证据。

**Tech Stack:** .NET 10、Windows Job Objects、本机命名管道、TypeScript/Vitest、既有 PreparePayload、TrustedInstallation 与 ProtectedJournal。

**当前状态：** B4-B2-4 实际原生执行会话已实现，最终完整 Windows 35/35，固定源码与运行证据独立 Spec Approved / Quality Approved、C/I/M=0/0/0。B4-B2-5 独立只读 reader 与 B4-B2-6 内部有界 launcher 的分轮与边界见本计划末尾；下列任务1～6的 runtime 勾选仍仅代表 B4-B2-4 有界技术证据。[B4-B2-7 受限原生控制桥](2026-10-16-image-super-resolution-native-control-bridge.md)核心控制及所选输出闭包的技术验证、对应固定源/actual独立Spec/Quality复审已完成；完整v2/更广矩阵未完成。最终文稿校验/独立批准与中文本地提交及fresh readback，分别按最终固定回执和实际Git回读核定。随后有界TS stdio host，再冻结真实prepare/AUTH与Windows execution Adapter合同和接线；用户/部署验收、图片/安装服务/GPU/worker/API/ZEB继续后续分片。

## 全局约束

- 本片属于 B4-B2-4 原生会话，不表示 M2、GPU、Windows 安装服务、远程 API 或 ZEB 接入完成。
- 保持 schema5、增强默认关闭、readiness=false；自动降 tile 重试暂缓。
- 一次原始请求、一个原 Job、一次 resume；不因超时、断流、ACK 丢失或 Unknown 创建替代执行。
- 原请求 SHA 绑定原 UTF-8 字节；不得用重新序列化结果替代。
- 普通发行包不含故障注入入口；普通成功证据与测试构建的故障证据分别记录。
- 只按实际差异复验受影响测试，不新增手机端或无关业务回归。
- 公开交付不包含真实环境、账号、凭据、用户会话或私有证据位置。

## 精确执行协议

旧控制模式保留四参数。执行模式只接受以下五个唯一参数对，顺序不限；根目录必须为完整本机 Windows 路径，摘要为 64 位小写十六进制。不得从 cwd、环境或当前配置补默认值。

```text
--pipe <zeb-control-32lowerhex>
--controller-pid <positiveUInt32>
--records-root <fullyQualifiedLocalWindowsPath>
--installation-root <fullyQualifiedLocalWindowsPath>
--expected-manifest-sha256 <64lowerhex>
```

所有帧与嵌套对象均为精确字段集合，拒绝额外、重复或缺失字段。claim、inspect、watch、stop 沿用四键帧；仅执行模式新增：

```typescript
{ v: 1, requestId, op: "prepare", executionId, requestUtf8Base64, requestFingerprint }
{ v: 1, requestId, op: "authorize", executionId, target, descriptor, requestFingerprint }
```

prepare 恰六键，authorize 恰七键；原两个请求字符串逐字保持。完整 target、descriptor、scope 与 fingerprint 必须绑定原 owner/原 helper，不接受仅 ticket 或 executionId 相等。旧四键 authorize 仍拒绝。成功响应精确为 `{v,kind:"response",requestId,op,executionId,role,state}`，role 仅 owner/observer；错误为 `{v,kind:"error",requestId,code}`，状态事件为 `{v,kind:"event",event:"state",executionId,state}`；v 均为 1，不得回传异常文本或路径。

执行模式的 state 精确为以下八键；这是原生内部协议，本片不新增 TS 公共 Inspection/ExecutionExit 映射。

```typescript
type NativeExecutionSnapshot = {
  phase:
    | "unclaimed"
    | "claimed"
    | "preparing"
    | "prepared"
    | "authorizing"
    | "running"
    | "sealed"
    | "terminal"
    | "unknown";
  sealReason:
    | null
    | "controller_eof"
    | "controller_exit"
    | "control_write_failure"
    | "stop"
    | "deadline"
    | "launch-failure"
    | "engine-exit"
    | "evidence-unknown";
  requestFingerprint: string | null;
  descriptor: OwnerDescriptor | null;
  authorizationVerified: boolean;
  resumeState: "not-attempted" | "succeeded" | "uncertain";
  evidenceOutcome: "pending" | "verified" | "unknown";
  completion:
    | null
    | "engine-exit"
    | "stop"
    | "deadline"
    | "launch-failure"
    | "unauthorized-cleanup"
    | "interrupted";
};
```

新模式错误码限定为 invalid_request、scope_mismatch、controller_mismatch、owner_already_claimed、not_owner、sealed、payload_conflict、not_prepared、authorization_mismatch、deadline_exceeded、unknown、prepare_failed、resume_failed。执行模式完整 LF 帧的 JSON/形状错误返回 invalid_request 后继续读取；真实原 owner EOF、不可恢复 UTF-8/读取失败与本机正常关闭分别归因。控制专用模式不接受扩展帧，保留旧行为：错误入队后立即取消 writer，不承诺该错误帧已交付；不得修改生产控制路径迁就基线诊断。

## 任务 1：独立夹具与真实行为 RED

**Files:** 新增 `workers/image-enhancement/native/windows-session-fixture/WindowsSessionFixture.csproj`、同目录 `Program.cs`、`workers/image-enhancement/tests/windows-session.os.test.ts`。

- [x] 发布实际无害 EXE，完整声明并核验 self-contained 依赖；改名 apphost 后保留原 managed DLL、deps、runtimeconfig 名称。
- [x] 用固定 recipe 直接运行已安装无害 EXE，验证真实 first-action marker、原进程退出、严格 UTF-8 与两路真实 EOF。
- [x] 运行普通原生入口的旧控制 bootstrap，经实际 controller peer 完成 ready、claim、inspect。
- [x] 同原 owner 提交六键 prepare，以实际收到完整 invalid_request 帧或下述严格 owner 关闭联合证据证明不支持 prepare；仅错误入队、装载、超时或清理失败不能充当 RED。
- [x] 先记录已证拒绝，再进行基线控制 helper 的明确强制收容，标记 subjectCleanupMode=legacy-explicit-containment、subjectForced=true；不得把它记成新执行模式的自然退出。
- [x] 原 guard 累计进程总数与登记的原 process 身份逐项闭合，未知额外身份使 RED 无效；保留原 pins，outer/host/controller/直接引擎均须 actual close0、真实双 EOF 且无 fallback。

严格 owner 关闭分支要求原 reader 已真正 join，actualEof=true、readerError=null、localClose=false，保留本次精确已发送 prepare 与原 pipe 身份；已绑定 observer 对同一原 helper 实际收到 sealed/owner_eof 状态事件并完成 inspect，原 pinned helper 仍活。其它 reader 失败、partial frame 或取消均为 fixture 失败；联合观察只保留为实际私有证据，不伪造错误协议帧。拒绝证据必须先于计划的 legacy containment，不能由强制清理倒推。

夹具使用既有 runnerLimits 的执行与收尾保护；不以 sleep 同步阶段。每个创建的原对象独立登记，故障时只回收自己的原句柄与 Job。

## 任务 2：实际入口与单尝试状态

**Files:** 修改 `native/windows-supervisor/Program.cs`，新增 `native/windows-supervisor/NativeExecutionSession.cs`；启动 alias 绑定定点涉及 `TrustedInstallation.cs` 与 `JournalNativeMethods.cs`。

- [x] 保留旧四参数控制模式；新增精确五对参数的执行模式：pipe、controller-pid、records-root、installation-root、expected-manifest-sha256，无默认来源。
- [x] prepare 恰六键，authorize 恰七键；原 owner、完整 scope、descriptor 与原请求 fingerprint 必须一致。
- [x] 复用既有解析、安装租约和固定 recipe，不接受任意 executable、argv 或 shell。
- [x] request 发布核验后才准备原挂起树；prepared 发布核验后才暴露完整 descriptor。
- [x] 相同请求重放只返回已证原事实；冲突拒绝，Existing reservation 不接管、不修复、不执行。
- [x] 长操作独立分派并保留任务；原 owner 断连观察不能被 AUTH 文件 I/O 阻塞。
- [x] 完整错误帧返回明确错误后可继续操作；本机正常关闭或不可恢复的协议错误不伪装用户断连。

实际启动 alias 绑定原安装的 GUID、FileId、长度与安全事实，纳入原安装租约的 pins 寿命；没有更换 executable 或放宽 trust，不据此宣称 >MAX_PATH 覆盖。

普通成功响应沿用 response/requestId/op/executionId/role/state；新模式 state 区分 phase、sealReason、原 fingerprint/descriptor、authorizationVerified、resumeState、evidenceOutcome 与 completion。内部执行细节不进入产品用户流程。

## 任务 3：单次恢复与失败资源寿命

**Files:** 定点修改 `native/windows-supervisor/JobProcess.cs`。

内部接缝：

```csharp
internal bool TryResumeOnceRetainingResources(out Exception? failure);
```

- [x] 原 ResumeThread 返回 1 才确认成功；其它计数或原生错误封存，保留原资源，不在此接口 Force、join 或 Dispose。
- [x] session 在调用前登记已尝试，任何异常不重试；原 public AuthorizeOnce 保留既有失败自动清理行为。
- [x] AUTH verified 只表示持久许可；成功授权 ACK 还要求实际单次 resume 成功。
- [x] 授权后、恢复前已观察 owner loss 时禁止 resume；真实收尾后才允许公共 interrupted 三记录。
- [x] 真实异常 suspend count、Force 拒绝与观察失效分别验收，不伪造原生返回值。

## 任务 4：真实树、双流与 helper 完整收尾

**Files:** `NativeExecutionSession.cs`、`Program.cs`，定点扩展 `ControlNativeMethods.cs`。

原 controller 接缝：

```csharp
internal Task WaitForExitAsync(CancellationToken cancellationToken);
```

- [x] 在同一个原 pinned process handle 上可取消等待并真正 join；不按 PID 重开，不保留永久阻塞的后台线程。
- [x] Prepare 返回后立即启动原 stdout/stderr 两个真实 drain，避免输出回压；Read 返回 EOF 才算 EOF。
- [x] 使用原绝对 UTC 毫秒 deadline，`now <= deadline` 可运行，单次计时到 `deadline-now+1`；超出 BCL Timer 公开最大域 `UInt32.MaxValue-1` 毫秒时分段重新计算，不轮询或重置预算。
- [x] 第一个停止原因赢门时立即记录单调 grace 起点；setup/publication 等待也消费原 cancelGraceMs，保留完整正 safe long，不截为 Int32，不增加新上限。
- [x] 第一个合格停止原因固定；owner loss、stop、deadline 和 native failure 不混淆。
- [x] 只有原 engine signal、exitCode、原 Job active0、双 EOF、封存和前置持久记录都已核验，才能发布完整 terminal。
- [x] 树未证实的 Unknown 保留原资源与安装 pins，Completion 不完成；树已证但 drain 失败可安全释放，仍无完整 terminal。
- [x] Prepare 调用抛错但无原对象/失败 receipt 时，不推断无树或 EOF。
- [x] 健康完成依次 join 收尾和 publication，关闭原 Job/writer/安装租约，停止接入并 join 全部连接与观察任务。

从未调用 Prepare 且无已核 request 时，无树控制收尾只报告 sealed、completion=null、evidenceOutcome=pending，不造 durable terminal。Existing/Unknown reservation 不创建新树，可在安全释放尚未转交的租约后退出；Prepare 已调用但树未证实时，helper/Completion 与原资源保持，不以 helper 自然退出为由释放 pins。已有 monitor fault 不重试同一故障任务来伪装恢复观察。

## 任务 5：精确持久记录与独立读回

| 用途           | recordId                           |
| -------------- | ---------------------------------- |
| request        | `00000000000000000000000000000001` |
| prepared       | `00000000000000000000000000000002` |
| authorization  | `00000000000000000000000000000003` |
| 保留不用       | `00000000000000000000000000000004` |
| controllerLoss | `00000000000000000000000000000005` |
| terminal       | `00000000000000000000000000000006` |

descriptor 顶层固定为 `{adapterId,launchTicket,executionId,details}`，adapterId 为 `windows-supervisor-v1`；details 恰为 `{v,target,executionPolicyFingerprint,requestFingerprint,requestRecordId,preparedRecordId,recipeId,installationManifestSha256,supervisor,engine,jobName}`，recipeId 为 `upscayl-4x-png-v1`。ProcessFact 恰为 `{pid,creationFileTime}`，FILETIME 用规范 UInt64 十进制字符串，不经过 JS number；所有事实来自原保留句柄。JournalScope 恰为 `{target,executionPolicyFingerprint}`，InterruptionScope 恰为 `{target,descriptor}`，不得互换。

| 记录                    | 精确字段集合                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| request                 | `{v,kind:"windows-request",recordId,requestFingerprint,requestUtf8Base64,resolvedLaunch}`；resolvedLaunch 恰为 `{recipeId,installationManifestSha256,executablePath,argv}`，仅来自原租约固定 recipe               |
| prepared                | `{v,kind:"windows-prepared",recordId,requestRecordId,requestFingerprint,scope}`；scope 为原 InterruptionScope                                                                                                     |
| authorization           | `{v,recordId,scope,kind:"authorized"}`                                                                                                                                                                            |
| controllerLoss          | `{v,recordId,scope,kind:"controller-lost",authorizationRecordId}`；无 reason                                                                                                                                      |
| interrupted terminal    | `{v,recordId,scope,kind:"terminal",completion:"interrupted",authorizationRecordId,controllerLossRecordId,treeExited:true,authorizationsSealed:true}`                                                              |
| native-private terminal | `{v,kind:"windows-terminal",recordId,scope,requestRecordId,requestFingerprint,preparedRecordId,descriptor,authorizationRecordId,resumeState,completion,proof,authorizationsSealed:true}`；scope 为原 JournalScope |

所有 v 均为 1，recordId 与各自原 envelope/固定 slot 一致。私有 completion 闭合为 `{kind:"engine-exit"}`、`{kind:"stop"}`、`{kind:"deadline"}`、`{kind:"launch-failure",stage:"prepared-state"|"resume"}` 或 `{kind:"unauthorized-cleanup",cause:"controller_eof"|"controller_exit"|"control_write_failure"}`。proof 闭合为 `{kind:"prepare-not-called"}` 或 `{kind:"engine-tree",engine,jobName,exitCode,treeExited:true,activeProcesses:0,stdoutEof:true,stderrEof:true}`。

私有 terminal 要求 request 已 verified；preparedRecordId/descriptor 只能同时为原已核值或同时为 null，null 仅表示 prepared publication 明确未开始。authorizationRecordId 为 null 只允许 AUTH 明确未开始且 resumeState=not-attempted；为原值要求 prepared/AUTH verified。uncertain resume 只用于 launch-failure/resume，不重试；prepare-not-called 只用于 stop/deadline/unauthorized-cleanup 且 prepared/descriptor/AUTH 均 null。engine-exit 要求原 engine-tree proof、prepared/AUTH verified 与 resume succeeded，exitCode 为真实 UInt32；exitCode=0 不代表图片验收或质量通过。任一前置 publication 不确定时不发布 terminal，不以 null 抹去未知历史。

- [x] 公共 AuthorizationRecord、ControllerLossRecord、InterruptedTerminalRecord 严格复用 `src/execution.ts` 的精确形状；ControllerLossRecord 不新增 reason。
- [x] stop、deadline、正常退出和可证 native failure 使用私有 terminal union，不伪装公共 controller loss。
- [x] terminal 公私互斥，只发布一次；publication Unknown 不重试或补写。
- [x] 活 writer 以原 Publish 的 Snapshot 核验；writer 关闭后由独立进程严格重开并核对原 bytes/FileId、scope、descriptor 和三链引用。
- [x] crash 后缺完整 terminal 保持 Unknown；不从 ACK、marker 或文件缺失推断从未执行。

## 已验场景分组

以下分组已取得本片有界技术证据。实际计数见下方独立轮次；普通发行成功与测试构建故障的判定分别保留，分组数量不等同于用例数。

| 分组               | 必须取得的因果证据                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 独立健康与行为 RED | 已安装无害引擎直接运行健康；旧普通入口 ready/claim/inspect 健康后，以实际错误帧或严格 reader EOF/observer/原 pin 联合证据证明拒绝六键 prepare；拒绝先记录，旧控制收容另记，原 guard 总数/身份与双 EOF 均闭合 |
| 准备与权限         | 原 freezer/安装租约/descriptor 全链、payload/scope/owner 冲突、完整错误帧后可继续操作、prepared 前不执行                                                                                                     |
| 普通完整执行       | 持久 AUTH 后恰一次 resume、原请求重放、自然 terminal；普通 helper 自然退出，所有原 child/树与双流独立收尾                                                                                                    |
| publication 故障   | request/prepared/AUTH 的真实写、刷与 rename 失败；不确定记录禁止 resume/terminal/补写，测试句柄证据与普通生产接口隔离                                                                                        |
| 授权竞争与断连     | verified AUTH 恢复前 owner EOF/原 controller signal；恢复后原 owner loss；observer EOF 不产生 loss；本机关闭不伪装断连                                                                                       |
| 停止与期限         | stop/deadline 第一原因、等于 deadline 允许、原 grace 起点与完整长预算、无准备控制收尾及取消等待真实 join                                                                                                     |
| 原树与双流         | 父先退出、后代持有写端、按实际 pipe 容量生成并发输出；必须原 active0、双真实 Read EOF，不用 Dispose 代证                                                                                                     |
| 资源不确定         | 真实额外 SuspendThread/count2；原 public wrapper 独立回归；Force 拒绝与原 Job 观察失效区分；注入 drain 错误和 Prepare 无 receipt 时的 Unknown/pins 寿命                                                      |
| crash 与独立读回   | AUTH 后恢复前及恢复后 ACK 前 crash；Existing 拒绝接管；writer 退出后独立严格重开原 bytes/FileId/完整引用链                                                                                                   |

## 实际技术记录

最终完整 `windows-session.os.test.ts` 的原命令 filters=[]；35 个唯一场景逐项核验，离线复核 35/35 verified、coverage=true、errors=[]。普通实际加载的程序集与固定发行 DLL 一致，无测试 hooks；最终源码/运行证据独立 Spec Approved / Quality Approved、C/I/M=0/0/0。

| 独立轮次                            | 实际结果                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 实施前独立健康 C0                   | 1/1 pass、6.56 秒；已安装无害引擎、host/outer 自然退出与真实双 EOF，无 force/fallback                 |
| 旧入口 unsupported-prepare 行为 RED | 1 个预期失败、另 1 个 C0 因过滤未执行，5.63 秒；不称完整新文件运行                                    |
| focused controller-exit             | 1 passed / 34 filtered，7.80 秒总耗时/6.26 秒测试耗时，exit 0、stderr 空                              |
| 最终完整 session 文件               | **35/35，212.45 秒总耗时/210.91 秒测试耗时，无过滤/跳过、exit 0、stderr 空**                          |
| 受影响 control 完整文件             | 14/14、32.49 秒、stderr 空                                                                            |
| 受影响 Job selected                 | prepared suspended 与 authorize-once 两项，2 passed / 10 filtered、3.78 秒、stderr 空；不称完整 Job12 |
| 安装绑定完整回归                    | 8/8、28.82 秒、stderr 空；原租约与 cleanup 释放成立                                                   |

行为 RED 的实际分支是原 owner reader 已 join、actualEof=true/localClose=false/readerError=null，并有同原 helper 的 observer sealed/owner_eof 事件及 inspect；原 helper 当时仍活、原 pipe 身份与六键请求保留。拒绝证据先于计划 legacy containment，原 subject forced exit1 单列；其他原对象自然退出、真实双 EOF，guard census 闭合，故该轮是有效行为 RED。

此前完整 34/35 保留为历史失败。最终只更正 fixture 的 controller-exit 顺序：原 controller signal → 实际 controller_exit → 原 bridge release → 原 child/双流完整 join，失败先沿原 containment 再 join。生产 first-cause 未改，不声称证明了标准流写端的持有者或继承根因。离线汇总格式核对更正没有重跑 native、改写原日志或放宽 runtime 门；原运行无过滤另由原命令确认。

35/35 表示各场景门通过：普通 AUTH/once/replay/自然完成与九个 publication 故障、Unknown 保留及 crash 分支不互代。Force-denied/closed-original-job/prepare-no-receipt 在精确外部收容前仍为 Unknown、helper live、Completion pending、无 terminal、pins held；Prepare 无 receipt 不证明没有原引擎或树。注入 drain 错误的安全 failure exit2 不冒充 engine 双 EOF；两次 crash 的原 helper forced exit1 与第二 helper Existing 拒绝 exit2 分列，不追加成功 ACK/terminal。

control、Job selected、installation 各原轮的六生产源与 ordinary DLL 均和最终候选一致，最终 fixture 排序更正不使这些生产回归失效。安装 independent wrong-SID、remote filesystem、non-NTFS、other-volume 仍 conditional-unexecuted。所有轮次独立，不与旧 payload24/Job12/journal9/installation8 或 86 项业务/24 项 Worker 规格累加；用户与实际部署验收仍待。

## 任务 6：固定验收、复审与本地提交

- [x] 普通发行包验证完整成功路径、相同请求重放、权限/范围冲突、stop/deadline、后代与双流、helper 自然退出。
- [x] 测试构建验证 request/prepared/AUTH 写/刷/rename 失败、授权竞争、真实 count2、资源 Unknown、crash 和 Existing 拒绝；故障注入与精确强制收容单独登记，不代作普通健康退出。
- [x] 共享入口的完整 control 文件与 Job prepared/authorize 两项定向回归分别取得实际证据；public-wrapper count2 在新 session 文件独立覆盖，安装绑定回归另列。
- [x] 固定源码与实际运行证据独立 Spec/Quality 复审通过，C/I/M=0/0/0。

收口以主执行者实际工具/Git 回执为准：候选摘要/CodeGraph、八份公开稿的隐私、strict UTF-8、格式、文档类型与相对链接检查须核定；只有独立文稿复审通过后，才能确认中文服务器本地提交及 exact commit/tree/路径/工作区/索引的 fresh readback。源码/运行批准不代作这些文稿或提交结果。

本计划的复选框仅在真实验证后勾选。独立只读 reader 与有界 launcher 进展见下两节，受限原生控制桥另见末节；有界 TS host/Windows Adapter、产物图片校验、GPU/worker/API/ZEB 接入仍按原 SOP 分片推进。

## B4-B2-5：独立只读 reader 后续切片

本片已实现并取得固定六源码/测试与实际证据独立 Spec Approved / Quality Approved、C/I/M=0/0/0；不改写上面的任务勾选、session35/35 或历史34/35。native 精确 `--read-records <fully-qualified-local-Windows-root>` 先于旧 bootstrap/controller/pipe，到真实 stdin EOF 严格解析一个完整 UTF-8 JSON，独立 inspect reservation 和读01/02/03/05/06；04 不读写，无 writer/repair/新 reservation 或进程控制。合法 Unknown 也输出唯一 LF JSON/exit0；非法 CLI/input/transport 为 exit2、固定诊断、无替代 stdout 协议。existing 只为物理 envelope，独立读取不是事务快照，前后 bytes 不变不代作全程访问审计。

纯同步 `interpretWindowsJournalSnapshot(snapshot, expectedScope, originalDescriptor)` 核原 producer scope/descriptor/executionId、跨读 root/reservation 身份、固定槽/完整引用、canonical Base64/fatal UTF-8 与 opaque 原 bytes SHA；结果独立复制并深冻结。native 核原数字 token，TS 只核已解析值的 safe integer/范围/非负零，不能辨原 `1.0`/`1e0` 拼写；UInt64/FILETIME 字符串仍严格。qualified private engine-exit 允许 loss Unknown，existing 矛盾 loss 则 Unknown；public interrupted 须完整公共链，其他 private/partial/uncertain 事实仍 Unknown。Unknown 不证明缺失、未授权、无树、完成或可重试；AUTH/resume/实际 ACK/原树退出/engine EOF/helper transport EOF 不互代，非零不推 OOM、exit0 不推图片成功。

| 独立实际轮次                | 结果与统计范围                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 纯 TS 新文件                | 265/265，768ms 总耗时/237ms 测试耗时、exit0、测试 stderr 空；Worker typecheck/build 各 exit0                                   |
| 完整 reader 组              | 53 passed / 1 组外 C0 filtered（共生成54），302.23 秒总耗时/300.66 秒测试耗时、exit0、stderr 空；没有遗漏 reader 场景          |
| 实际 native stdout→built TS | 7/7、exit0；healthy→engine-exit、public interrupted→interrupted，partial-auth/live/wrong-scope/wrong-id/raw-bad-record→unknown |
| 受影响旧 ordinary           | C0、ordinary-once、conflicts：3 passed / 85 filtered（共生成88），23.43 秒总耗时/21.23 秒测试耗时、exit0、stderr 空            |
| 受影响旧 control            | 同一普通 Core 和独立旧 WinExe fixture：14/14，27.74 秒总耗时/26.06 秒测试耗时、exit0、stderr 空                                |

53份原 reader 回执逐项核自然 join/真实双 transport EOF/noForce、exact census/active0、原 bytes/FileIds/目录不变及真实清理；旧 ordinary guard2/2、7/7、7/7 与 observer stop/join/清理闭合。互操作七份输入确为同一原53场景的实际 stdout、scope/descriptor 与摘要，广泛 malformed/非零映射仍是 TS265 的层内证据。focused healthy/reservation2 已被最终53覆盖，不加计；reservation 行为 RED、原 healthy/其他失败轮保留，不追补旧失败对象、parentage 或严格 ACK 顺序。被动 console 诊断只证明其自身轮次，fixture 仅补 assignment 前 Job IOCP、原句柄严格资格和 observer stop/join，原 enumeration/exact census 未放宽；无 basename 白名单、`+1`、猜预算或 poll/retry/sleep，通知不保证完整。详情见[主 SOP §10](2026-10-10-image-super-resolution-integration-plan.md)，旧 session35/payload24、业务86/Worker24 不合并为新总数。

B4-B2-5 当时未接 launcher、ExecutionAdapter/runner/store/`readInterruptionEvidence`/HTTP/UI 或实际恢复启动。独立有界 launcher 的后续合同见下节；原 reader 轮的 fixture 预算不代表生产能力，stdout 写失败、stop-post 失败和 close-to-wake 未故障注入，portWrapperClosed 不等于独立 native CloseHandle 回执。文稿检查/独立文稿批准/中文本地提交及 fresh readback 仍由主执行者完成；用户/部署、图片/GPU/安装服务身份/Worker/API/ZEB/M2 验收仍待。M1 已验收、schema5、增强关闭/readiness=false、worker 未部署与自动 OOM 降 tile 重试暂缓保持。

## B4-B2-6：内部独立有界只读 journal launcher

本片已实现，固定九源码/测试/依赖与实际证据独立 Spec Approved / Quality Approved、C/I/M=0/0/0。它是 Windows-only 内部 factory，只调用现有 `--read-records <root>`，固定 helper dirname cwd、正常 argv escaping、shell=false、hidden、non-detached、三路新 pipes。不改 Adapter/runner/store/session/engine，不注入 `readInterruptionEvidence` 或恢复/新增 attempt；任务1～6及 B4-B2-5 的证据不因此扩张。

完整 Node/JS/helper apphost/managed libraries/runtime/loader/环境的可信稳定部署为显式 TCB 前提；path、brand 和 pre-spawn hash 不认证部署。trusted bootstrap 必须显式提供 request/stdout/stderr 字节与 read/cleanup deadline，不设生产默认额度。原 context 同步无损复制/深冻结并复用 reader validators；原解释规则未改。JSON+LF 输入需完整 delivery/finish/close；响应 fatal UTF-8、单 LF frame 与固定 `jsonc-parser@3.3.1` 的严格语法/各层 decoded duplicate-key 拒绝兼容合法 .NET Unicode，不要求 stringify 字节等同。

一 factory 单 owner，无 queue/retry。transport 成功分别要求原 stdin 完整输入与 close、原 child 自然 exit0/no signal、真实双输出 end、三 stdio close、child close，无 error/stderr/cancel/deadline/stale；合法解释 Unknown 与失败 transport 的 Unknown 区分。kill 只使用保留的原 ChildProcess，不按 PID/名字重开；killed=true、本地 destroy 和 close 不能代作 exit/EOF。

失败可有界返回 Unknown，但未证清理保留 owner/listeners/drains 并阻止 admission；无创建/通道错误时，迟到完整原事实仅可释放 owner，不升级已返回结果。spawn 已尝试后的 throw/error-before-spawn/pid undefined 不证明 OS 未创建进程；unresolved creation、child/stream error 当前永久 poison 清理门与 admission，不能自动重试。`close()` 永久封存，复用首次 promise/deadline，不延长或事后升级 Unknown。经核验 Node runtime 负责最终 native handle 回收，未声称独立 CloseHandle 回执；字节/观察预算不证明 native reader 内存、深度、CPU 或硬实时有界。

| 本片独立轮次              | 实际结果                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 完整新 launcher unit      | 96 passed / 1 non-Windows 平台 case skipped（97生成），1.48 秒总耗时/180ms 测试耗时、exit0、测试 stderr 空                   |
| 受影响 reader 回归        | 265/265，1.79 秒总耗时/260ms 测试耗时、exit0、测试 stderr 空；不与 B4-B2-5 的原265轮合计                                     |
| 完整真实 Windows launcher | 15/15，无跳过，26.72 秒总耗时/25.52 秒测试耗时、exit0、stderr 空；Node22.23.3/libuv1.51.0，普通 helper 与故障 child 分别核验 |

OS15 覆盖普通 transport/合成 qualified 历史、response-live/EOF-live、abort/deadline/close 与独立 sentinel、单路/并发 flood、early stdin failure、stderr/nonzero、Unicode/空格/单引号 argv 及实际 ENOENT/poison。15份 case 回执包含18次观察：17个已创建原 child 完整 join、1个 unresolved creation；3个 sentinel 自然 exit0/未 kill；断言失败、清理失败与 fallback test cleanup kill 均0。实际 early stdin error=EOF/finish=false 即使后续由 launcher kill 后原 child 实际退出（SIGTERM）及双 end/三 close/child close 仍为 Unknown/poison；ENOENT 不证明 never-created。普通 helper 未用 root 正控只证 transport 与合法 Unknown；qualified engine-exit 是合成历史，无新 engine/GPU 运行，helper transport EOF 不证明原 engine EOF。

Worker typecheck/build、格式/UTF-8/新增隐私/diff 检查和索引同步已通过；文稿检查/独立文稿批准/中文本地提交与 fresh readback 仍按后续实际回执确认。RED、设置失败及未变化 reader53/nativeInterop7/ordinary3/control14/session35 保留历史语义，不重跑或累加；不增加业务86/Worker24 整项通过数。当前推进受限原生控制桥，随后实现有界 TS stdio host，再冻结真实 prepare/AUTH 与 Windows execution Adapter 权限和接线合同；当前不得注入恢复 hook。完整部署/安装服务身份、图片/GPU/Worker/API/ZEB/M2 及用户验收仍待；M1 accepted、schema5、增强 off/readiness=false、worker 未接/未部署、OOM 自动降 tile 重试暂缓保持。本片无 push/PR/部署/重启或生产修改，完整合同与分轮见[主 SOP §10](2026-10-10-image-super-resolution-integration-plan.md)。

## B4-B2-7：受限 Windows 原生控制桥

本片核心控制及所选输出闭包的技术验证、对应固定源/actual独立Spec/Quality复审已完成，只核已实施和已执行范围；独立[切片计划](2026-10-16-image-super-resolution-native-control-bridge.md)规定恰一次启动原ordinary helper、原self/helper pins和两条原pipe peer核验，对外inspect/close、对内claim/watch/inspect/stop。没有prepare/authorize或engine，既有任务1～6、reader与launcher的合同和历史测试范围不变；桥CLI不等于TS production host/ExecutionAdapter。

仅 ordinary helper stdout ready 允许末尾单个 CRLF，桥 stdio/native pipe 仍严格 LF。完整合法 close 后的真实 stdin EOF 只 join 输入；Gate H 先证明原 helper 实际退出/双 EOF、native I/O settled 与真实桥 stdin EOF，再提交唯一 terminal；Gate B 之后 join 实际 write/flush、queue/唯一 writer 与全部任务，Main 才可返回。未知创建、清理或阻塞输出保留 owner/barrier，迟到 closed 不升级 Unknown；本片 no-engine 原 pin 的一次强制清理不推广为以后引擎策略。

实际分轮分别为focused v3 3pass/32skip、lifecycle v3 5pass/1fail/29skip、protocol v3 18pass/17skip（17OS+1oracle-only）、limits v3 6pass/29skip、旧默认C0 1pass/53skip、one-sided v4 3pass/32skip。新v5 high2/38 filtered-skip、low2/38、held-close1/39、受影响旧回归6/34四轮各生成40、exit0/空stderr；健康/有效RED/首轮focused另列，十三轮表见切片计划。不合计、不把旧单路EOF超时/fallback追认为成功；v4窄修只证明accepted-close期间的单路EOF。输出serializer仅depth2→3支持合法CLR bound，CLI配置parser depth2不变。v4 fixture发布曾有1条CS8602，v5复用原query pin的非空local窄修后fixture/fault发布均exit0、无warning/error；实际Process.dll匹配已审字节，旧诊断仍保留。

新五场景已先high两控各交付64条合法事件并自然0/stopped；low在caller stdin仍开、仅inspect且零close/native stop/本地cancel或disposal时，先独立见原owner zero-read，helper settled/query0/真实barrier EOF后才caller EOF，bridge自然2/真实双EOF。低控部分native109写失败保留，不称发完64；session stdout1279B低于S1536，queue累计stdout5553B不违反队列Q1024。held-close的真pause/合法close/EOF、native stop、helper任务/query0/barrier EOF、sentinel响应和原bridge紧邻resume未signal先于同一reader一次resume，之后自然0/唯一closed stopped/双EOF且无fixture force/outer fallback。ordinary回归1个qualified console独立完整join，新五例为0；原bridge facts、helper陈述与test-only Job/query分账，不是独立helper创建pin/ordinary helper双EOF权威。exact kernel IRP/private queue counter、ambiguous create/Terminate失败/peer spoof和完整v2/更广矩阵仍未证，不靠late cleanup升级Unknown。Worker type/build、格式/UTF8/隐私/diff/index与runtime已核；最终文稿校验/独立批准与中文本地提交及fresh readback，分别按最终固定回执和实际Git回读核定，不预勾未来commit，实际immutable Git回执为准。完整部署可信稳定仍为TCB，预算不证明native内存/CPU或硬实时，不重跑或累加旧session35/reader/launcher。下一有界TS stdio host，再真实prepare/AUTH/Adapter，最后各自图片/安装服务身份/GPU/Worker/API/ZEB；不得注入恢复hook、恢复或新增attempt，M1/schema5/增强关闭/readiness=false/worker未接/OOM自动重试暂缓保持。
