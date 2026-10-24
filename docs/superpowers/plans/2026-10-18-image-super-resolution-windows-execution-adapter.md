# Windows 超分执行器接线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现正式 Windows ExecutionAdapter，接通原任务的单次启动、同步退出观察、严格日志、停止和只读恢复，并分别验证 runner/Store 接缝与真实 Windows 原生路径。

**Architecture:** 组合现有 request freezer、Windows control Host 和有界 journal launcher。单个 Adapter 保留一个原执行 entry 和一个独立恢复读取槽；只由严格日志产生 ExecutionExit，发送许可、原 Host 生命周期、通知/reader 生命周期分别管理。

**Tech Stack:** TypeScript、Vitest、现有 SQLite/Runner fixtures 和已验证 Windows 原生运行件，不新增依赖或业务状态。

## Global Constraints

- 新生产模块只在 `workers/image-enhancement/src/windows-execution-adapter.ts`；`src/execution.ts` 仅将 kind 扩为 `"test" | "windows"`。原 Host、严格 reader、runner、Store、native、schema5 和依赖不改语义。原生组合诊断另允许 journal launcher 的单个 Windows 创建属性修复及精确受影响测试，须单独验证原进程/双流和调用方退出后的清理。
- 工厂只接现有 bridge 配置与 journal limits；reader 的 executablePath、recordsRoot、environment 来自同一已冻结的 bridge.helperPath/recordsRoot/environment。没有可任意替换的工厂/clock 参数、第二个记录目录或新配置开关。
- 原 prepare/AUTH/stop 仅透传本轮原 guard；Host 在原 permit 点消费一次权限。Adapter 不提前消费，不延长已结算的发送 guard，不重算业务 deadline 或持久 S/T。
- Host/open 必须使用独立原对象生命周期；prepare/authorize 的 `stillCurrent` 结算即失效，不能用作 Host 或晚期 journal 的 current。原 deadline 到达也不是禁止读取终态的理由。
- 一个原执行一个 Host 与一个原 launcher，未知资源不删除/换实例旁路。只在 Host `stopped/closed`、reader cleanup closed 和严格终态均已证明时，才缓存/通知并允许下一 prepare 替换旧 entry。
- 自动观察的 Host `whenClosed` 为 Unknown 时保持 Unknown，即便另一个读取存在正向日志也不能暗中升级原 Host。missing-ACK 请求 Unknown 与 Host 是否正常结束分别记录，后验终态不回写请求 Promise。
- stop/deadline Exit 不带 completion own property，exit0 不推 success。Store 原 stopReason、原 producer/fence 和既有恢复资格保持；不得由缺文件、缺内存 Host、prepared-only 或 pre-AUTH 记录制造 never-authorized。
- unsubscribe 只撤本订阅，不 close/stop 原执行。读属于原执行，可完成终态缓存；通知前逐订阅核 active/原 entry/未退休，每订阅至多一次。listener 抛出或同步重入不破坏其它有效订阅。
- Adapter.close/原 runner closure 先封新发送与通知、撤订阅并取消 reader，再用原 Host.close 收集原资源；原 Host scope 在原 join 结算前仍有效，不能先 abort/置假而人为制造 Unknown。close 共享幂等 Promise，仅报告 cleanup，不构造退出。
- runner closure 的自动触发仅适用于 prepare 已绑定原 guard.signal 的 live entry。fresh recovery-only 实例没有该信号，不能假装 observe 到 runner.close；装配所有者必须显式依次 await runner.close()、adapter.close() 再关闭 Store，恢复读由 adapter.close 取消。inspect 基础签名和 runner 生产逻辑不变。
- 恢复仅从已持久原 descriptor 的 exact target/policy 冻结 context，读取同源 journal，不新建控制 Host、不 prepare/AUTH。单恢复槽并发同 context 可合并，不同 context 忙时保守 Unknown；未知原 reader owner 不换 launcher。
- 同实例仍有未核清的原 entry 时，恢复接口不能旁路它创建另一个读槽或将 Host Unknown 改判；同 context 沿原缓存/原读，冲突 context 保守拒绝。新 prepare 也不能跨过一个尚未核清的恢复 reader；干净的显式后续 inspect 可以复用同一 launcher，不自动轮询或重试。
- readInterruptionEvidence 只返回完整 strict interrupted 三记录，调用方 current 在读前/读后都成立；engine-exit/stop/deadline/unknown 返回 undefined。Store 构造时显式捕获它，不在运行中重绑，不借此越过 Store 原联合资格或建立新 attempt。
- 现有传输/读取/清理预算来自明确配置。prepare 要求 bridge sessionTimeoutMs 足以覆盖原冻结 policy 的 executionTimeoutMs + cancelGraceMs + bridge cleanupTimeoutMs，安全整数求和失败或不足即在任何 Host.open 前拒绝，不调整原 deadline。
- 公开内容不得包含实际部署地址、账号、数据库、服务器目录或业务身份。原件与环境只进私有记录；不同轮次/过滤/Unknown 和历史失败分别保留。
- 不新增手机端测试，不接 CLI/HTTP/服务安装/API/ZEB，不修改增强关闭、readiness=false 或自动 OOM 降 tile 重试暂缓。真实 GPU/图片、Windows Store 耐久和服务身份分别验收。

## Task 1: 正式 Adapter 与定向行为验证

**Files:**

- Create: `workers/image-enhancement/src/windows-execution-adapter.ts`
- Modify: `workers/image-enhancement/src/execution.ts`
- Create: `workers/image-enhancement/tests/windows-execution-adapter.test.ts`
- Optional test helper: `workers/image-enhancement/tests/windows-execution-adapter-fixtures.ts`

**Interfaces:**

```typescript
export type WindowsExecutionAdapterOptions = Readonly<{
  bridge: WindowsControlBridgeOptions;
  journalLimits: WindowsJournalReadLimits;
}>;
export type WindowsExecutionAdapter = ExecutionAdapter &
  Readonly<{
    kind: "windows";
    close(): Promise<"closed" | "unknown">;
  }>;
export function createWindowsExecutionAdapter(
  options: WindowsExecutionAdapterOptions,
): WindowsExecutionAdapter;
```

`prepare/authorize/inspect/requestStop/observeExit/readInterruptionEvidence` 使用原 ExecutionAdapter 签名；所有 Windows context/descriptor 由已有 freezer 验证。未知操作以现有脱敏 EnhancementError 拒绝，inspect 返回绑定原 target 的冻结 Unknown，不暴露底层路径或异常。

- [x] **Step 1: 先写测试和 throw-only 合同骨架。** 骨架保留上述公共方法和 kind，prepare/authorize/requestStop 只拒绝 not_ready，inspect 只返回 Unknown，observe 不通知，close 返回 unknown，reader 返回 undefined；它不进行任何原生动作。先证明最小正控失败在有效 prepare/观察的行为断言，不以缺模块、类型错误、全过滤或夹具异常当 RED。

```typescript
const adapter = createWindowsExecutionAdapter(options);
const prepared = adapter.prepare(attempt, prepareGuard);
await expect(prepared).resolves.toEqual(originalDescriptor);
preparePermission.seal();
const seen: ExecutionExit[] = [];
adapter.observeExit(attempt, originalDescriptor, (exit) => seen.push(exit));
const authorization = adapter.authorize(attempt, originalDescriptor, authGuard);
native.closeNormally();
strictReader.complete(originalExit);
await authorization;
authPermission.seal();
expect(seen).toEqual([originalExit]);
```

测试原两个工厂边界可用完整 typed doubles，测试 Adapter 的绑定/时序/缓存/通知而不是 fake 自己的行为；不加生产测试注入选项。所有真实 native 断言另由 Task 3 给原件证据。

- [x] **Step 2: Root 取得实际行为 RED 后实施最小完整组合。** entry 保存冻结 target/policy/request、原 Host/launcher、descriptor/context、Host 原结算结果、共享读 Promise、terminal cache、独立订阅和关闭事实。Host continuation 在首个 await 前注册；descriptor 固定后再次检查已经到达的关闭事实。没有 AUTH 或未知 scope 时不补造 descriptor/终态。
- [x] **Step 3: 覆盖生命周期与信任边界。** 正常启动/原 fingerprint/原 permit；发送 guard seal 后仍能读；AUTH 返回前快速退出；同步重放/回调重入/抛错/独立取消订阅；错 target/descriptor；Host-only、journal-only、reader cleanup unknown；stop/deadline 无 completion；原 missing-ACK Unknown 不升级；晚回执不污染下一 entry；未知 entry 禁止新 admission。
- [x] **Step 4: 覆盖恢复与关闭。** owned-alive 只接受原 Host running、原 descriptor/fingerprint、verified AUTH 和 succeeded resume；其余无退出正证保持 Unknown。同源恢复无 Host、原 producer 不变；不同 context 并发拒绝；interrupted reader 前后 current；null/missing/pre-AUTH 不制造 never-authorized。close/runner signal 封通知并取消读，原 Host scope 直到 close 结算仍有效，幂等资源 Unknown 原样保留；关闭后不创建 helper。
- [x] **Step 5: Root 冻结候选并验 typecheck/build 与新测试。** 用固定 Node、现有 Vitest 和直接文件 recorder；保留 spec、argv、完整 source/runtime SHA、原 child exit/close、stdout/stderr。不同轮次独立登记，只重验新增/受影响范围。

## Task 2: Runner/Store 接缝

**Files:** Create `workers/image-enhancement/tests/windows-execution-adapter-runner.test.ts`；复用现有 storage/lifecycle/recovery fixtures，不修改持久生产规则。

- [x] **Step 1: 新 Adapter 实际进入 createRunner。** 在可运行的真实 Store 测试环境验证 AUTH COMMIT 前后权限、同步订阅早于实际 AUTH、取消先 COMMIT、原 S/T 不重算、ACK 但无严格终态仍占槽、stop/deadline 沿原 reason 结束 cancelled。不能继续用旧 controlledExecutor 替代新 Adapter。
- [x] **Step 2: 完整产物与恢复分开。** success 仍经过真实图片完整解码/4×/候选与 Store 事务；普通 failure 沿原失败路径。恢复终态保原 producer/fence，Store 的 reader 显式构造注入；stop/deadline 不创建 interrupted 重算事件。Windows 路径/Store 耐久若有平台缺口按原件明确列出，不能用测试刷盘 shim 声称完整 Windows 闭环。
- [x] **Step 3: Root 按实际运行位置单独记录该组和必要旧回归。** 不重跑整个旧矩阵，不把 Linux Store seam 与 Windows native 组拼为 Windows 全链路已通过。

## Task 3: 真实 Windows Adapter 原生互通

**Files:** 最小扩展原 `tests/windows-execution-bridge.os.test.ts` 与其 test-only Node runner。真实组合证明原 fixture 无法登记新增 reader 后，限定扩展 `native/windows-session-fixture/Program.cs` 与 `ExecutionBridgeHarness.cs`：仅专用测试场景启用原 Job 通知句柄保留、具名登记、同对象复制和两层 join，原精确进程总数检查不变。原通知句柄不是 CreateProcess 创建句柄，证据必须区分。

- [x] **Step 1: 从原 carrier 重建同一测试 attempt。** 使用原 metadata/独立 expected scope，断言 `freezeWindowsPrepareRequest(attempt)` 与原 supplied carrier bytes/hash 精确相同，再实际调用新 Adapter。保持原 native registry/pin/Job/EOF/收尾证据，不改生产 payload 或 fixture engine 行为。

原 test Harness 提供的 Host sessionTimeoutMs 为 45,000，不能直接用于本片新增预算门。Adapter 专用 test-only Node runner 明确构造并记入证据 `sessionTimeoutMs = originalPolicy.executionTimeoutMs + originalPolicy.cancelGraceMs + suppliedBridge.cleanupTimeoutMs`；当前原件是 60,000 + 5,000 + 5,000 = 70,000。这是该新调用的显式传输配置，不改变原 carrier bytes/hash、firstStartedAt、executionDeadlineAt、policy、outer 60,000/15,000 或 testMs；不得把旧 45,000 配置预期拒绝记作 Adapter 行为 RED/GREEN。复用已有 Harness 场景与 runner 路径参数，产品 native 不变且不重编。

- [x] **Step 2: 实际运行自然退出与已授权 soft stop。** 自然结果经新同步 observer、被动 Host、真实 strict launcher 获取；停止保原持久 pair 和无 completion Exit。沿已有真实 original child/双 EOF/close0 与 scope 原件验收；不把 helper0/transport close 当执行退出，不重编未改产品 native。另验证 reader 输入发送前、发送后原调用方退出：先登记原对象并确认前置进程结束，只终止原调用方；读取器自然结束、原双 EOF/两层 join 与精确进程总数分别核定，不生成死亡消费者的业务成功。
- [x] **Step 3: 独立源码、实际证据与业务接缝复审。** 修改问题后只补受影响轮；保留所有 Unknown/中断/过滤和不同轮次，不重写原回执。固定源码和实际证据独立 Spec/Quality 均通过，无遗留项。

## Task 4: SOP 与开发分支本地交付

- [x] 更新 README、本计划、TODO、pending-test 和 CHANGELOG，描述实际 Adapter 覆盖和剩余安装/GPU/业务限制。
- [ ] 固定完整 worker/文稿；格式、严格 UTF-8、链接、隐私和独立最终交付审查。
- [ ] Root 核原开发分支 baseline/全部输入后唯一应用补丁、增量 CodeGraph、中文服务器本地提交，并由另一新只读连接回读原消息、HEAD/tree/唯一 parent、全部路径 SHA、clean/index。
- [ ] 更新私有恢复入口与关键记忆。没有 push、PR、merge、部署、重启或生产修改；Mem0 后台捕获不等于确认服务器入库。

## 实际进展

正式 Adapter 已实现并通过固定源码独立审查。定向类型检查、声明构建通过；Windows 单元 42/42、Linux 真实 Runner/Store 接缝 7/7、原 Runner 回归 12/12 是三组独立结果，不合并为 Windows 全链路验收。

Windows 原生补修已通过所定分轮验证：类型检查与构建 exit0，读取器单元 98 passed/1 平台跳过（1.35 秒），普通读取器正控 1 passed/14 名称过滤（2.00 秒），新 Adapter 自然、软停止与两个调用方退出场景 4 passed/18 名称过滤（35.73 秒），旧 Host 自然正控另轮 1 passed/21 名称过滤（9.35 秒）。各轮计数不累加；仅重编测试夹具，未修改或重编产品原生执行器。

首次原生轮 2 failed、后续同类诊断失败和创建选项 RED 仍保留。日志读取器的非 detached 创建分支与原调用方 stdout EOF 卡点经单变量诊断区分；最小属性修复保留原 child、三条流、取消/超时和 Unknown 所有权。新增 reader 的原 Job 通知句柄具名登记另独立补修，原精确进程总数与两层 join 保持；不把通知句柄说成 CreateProcess 创建句柄，不对具体 Windows/BCL/libuv/安全软件机制定责。

两个调用方退出点均真实覆盖：输入前 reader 自然 exit2；输入后原 C# 确认 reader 仍活再注入，reader 实际自然 exit0。后者不证明 native 已解析或处于某阶段，也不表示死亡消费者收到业务结果。正常 stdin EOF 清理不等价于永久挂起进程的内核收容保证，服务安装与进程收容仍待；类型/单元/原生控制验证不表示 GPU、Windows Store 耐久、安装服务或业务入口已就绪。固定源码和最终实际证据独立 Spec/Quality 均通过，无遗留项；文稿复审与本地交付按各自回执核定。
