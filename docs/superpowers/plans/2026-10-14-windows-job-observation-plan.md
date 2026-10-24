# Windows Job 保护与原句柄观察 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建时原子保护原 Job，并通过保留的原 process/Job 句柄提供可信只读观察，为下一片引擎授权接线提供事实。

**Architecture:** 复用既有 `JobProcess` 的挂起创建、一次授权、整树等待和关闭控制；使用 BCL 安全描述符与原句柄回读，不新增启动框架。观察是多次真实原生读取，调用方分别判断准备、中间态与终态。

**Tech Stack:** C#/.NET 10、Windows Job/security API、BCL 安全描述符、TypeScript/Vitest、既有独立 Windows fixture。

## Global Constraints

- 本片为 B4-B2-2，继承[主 SOP](2026-10-10-image-super-resolution-integration-plan.md)，位于[安装绑定](2026-10-14-windows-engine-installation-plan.md)之后。四源码实现、实际 RED→GREEN、最终完整十二项及独立源码/证据复审已完成；文稿写入已同步，文稿检查/独立复审和本地提交回读仍为单独收口门。
- 仅修改下表四个既有源码，不变更项目、依赖、数据库/schema、control/journal/installation、业务 TypeScript 或界面。
- Job 权限只针对创建时实际 Windows User SID，单 SID ACL 不提供敌对同 SID 隔离。不更改服务账号、进程/线程 token、主机安全策略或安装目录权限。
- 使用既有 60 秒执行、5 秒清理配置，不增加固定延时、重试或资源上限。不以超时包装声称原生调用已结束。
- M1 已验收、schema5、增强关闭、readiness=false、worker 未接入、自动 OOM tile 重试暂缓保持。不把本片当成安装器、服务身份、引擎授权、wire 或 GPU/API/ZEB 验收。
- 主执行者独占上传、构建、实际 Windows 验证、索引同步和本地中文提交；子代理只编辑分配路径。不得推送、创建 PR 或部署；公开交付不含真实环境身份或私有证据。

| 路径                                                                   | 职责                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------ |
| `workers/image-enhancement/native/windows-supervisor/JobProcess.cs`    | 原子 Job ACL、固定创建 SID、只读 Inspect               |
| `workers/image-enhancement/native/windows-supervisor/NativeMethods.cs` | 明确 SecurityAttributes 与 kernel-object security 绑定 |
| `workers/image-enhancement/native/windows-fixture/Program.cs`          | 独立实际权限/成员/句柄观察、实进程屏障及真实清理       |
| `workers/image-enhancement/tests/windows-job-object.os.test.ts`        | 既有 11 项扩展、一项安全正控与原 child 生命周期        |

## 冻结接口与方法

命名空间为 `Zeb.WindowsSupervisor`，只增加以下不可变类型与 `JobProcess.Inspect()`。以下 throw-only 方法是建立实际 RED 前的历史脚手架；最终生产方法已按下文合同实现，不再抛该占位错误。

```csharp
public sealed record JobProcessObservation(
    ProcessIdentity EngineIdentity, bool ProcessSignaled, bool InOriginalJob,
    uint ActiveProcesses, uint TotalProcesses,
    uint JobHandleFlags, uint ProcessHandleFlags, bool Authorized, bool Sealed);

// 历史 RED 阶段脚手架；当前生产实现已替换它：
public JobProcessObservation Inspect()
    => throw new InvalidOperationException("job_observation_not_implemented");
```

创建时捕获非空当前 User SID，并在对象内私有固定。使用成熟 BCL 建立 owner 相同、present/protected DACL、恰好一条当前 SID plain Allow ACE；无继承/callback/opaque 数据，mask 精确为 Job allaccess `0x001F003F`。首次 `CreateJobObjectW` 就传入已固定字节的 `SecurityAttributes`，inherit=false；立即捕获返回错误，同名已存在拒绝。在设置 limits、association 或创建进程前，原 handle 回读实际安全与非继承事实；禁止创建后补设权限或回退默认 ACL。

回读使用 `GetSecurityInfo(SE_KERNEL_OBJECT=6, OWNER|DACL=5)`，返回 DWORD 为错误来源；以真实长度和 BCL 解析 descriptor，严格核对 owner、DACL 与唯一 ACE，最后用对应 `LocalFree` 释放整块 descriptor。不能复用 file/pipe 权限 mask 或 file object type。仅借鉴既有 BCL 形状，不改动旧安全模块。

`Inspect` 持有现有 `sync`，先拒绝 disposed；只读保留的原 handles，依次重核 identity、读取 membership 和 active/total、校验原 handle flags 与 ACL，最后读取原 process 的零时等待。返回 actual flags，校验 inherit 位而非假定 flags 全零；任何 API 失败抛出，不伪造正常值。不按 PID/name 重绑、不公开原 SID/descriptor/handles、不新增等待或状态修改。多项读取不是内核原子快照。

| 状态                 | 调用方必须判断的真实事实                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| 可准备授权           | 未授权未封存、原进程未 signal、属于原 Job、active=total=1，身份/安全/非继承核验成功             |
| 已封存仍活           | Sealed=true 可与进程未 signal/active>0 并存；Seal 不是 terminate                                |
| 原进程退出而后代仍活 | ProcessSignaled=true、active>0 是合法中间态，不能判成整树终态                                   |
| 原生整树终态         | 既有树等待已完成，Dispose 前 signal=true/active=0；membership 保留原生实际 bool，不猜测固定结果 |
| Dispose 后           | 抛 ObjectDisposedException，不重新打开对象补观察                                                |

一次授权 false 不等于幂等成功；native 树退出不等于 stdout/stderr EOF，也不代表图片结果可接受。既有原生异常清理中的无限等待不在本片中改写。

## Task 1：独立安全正控与行为 RED

- [x] 主执行者保存此计划并添加上述 throw-only record/method；既有 Job 创建行为保持。
- [x] Fixture 独立创建无进程的安全 Job，以实际 query-only `0x00020004` handle 验 owner/DACL/唯一 ACE；direct 过程关闭所有 creator/query handles。`beforeAll` 先验证正控，再消费同一回执新增一项安全正控测试。
- [x] 扩展既有 fixture：准备响应先返回独立安全事实；`inspect-native` 先调用生产 Inspect，再用独立 process pin/Job query 核对事实。FILETIME 以规范十进制字符串交给 TS。
- [x] 仅在 fixture 中通过 reflection 只读借用原 job/process SafeHandle，独立读取继承 flags；不得关闭、复制或更改这些借用 handles。所有独立 Job query handle 在响应前关闭，尤其不得跨最后 owner close。
- [x] 扩展既有准备、封存仍活、授权三进程、父退出后两后代仍活、整树终态和 Dispose 拒绝断言。在健康 terminal 观察后，仅对该已空临时 Job 增加一条 World query ACE，独立证实变体，再验证生产 Inspect 拒绝实际安全变化；普通清理销毁该 Job，不修改任何主机策略。
- [x] TS 记录实际 original child close、真实双 EOF、严格 UTF-8 与 native guard cleanup。仅完整证明后精确删除本次 temp 一次；失败或未知时保留，场景失败与清理事实分开。不得由 Dispose 伪造引擎 EOF。
- [x] 主执行者冻结摘要、格式/UTF-8/隐私/差异检查和增量索引，运行受影响 TS 检查，发布 ordinary/test fixture。先运行新安全正控，再运行旧 prepared case 建立真实 RED；环境/编译/清理失败不算 RED。实际 RED 是默认 DACL protected=false/count3/首 ACE SID 不匹配，在调用 Inspect 前失败。

```sh
pnpm --dir workers/image-enhancement typecheck
pnpm --dir workers/image-enhancement build
pnpm --dir workers/image-enhancement exec vitest run tests/windows-job-object.os.test.ts -t "B4-B2 independent protected Job security control" --reporter=verbose --silent=false
pnpm --dir workers/image-enhancement exec vitest run tests/windows-job-object.os.test.ts -t "B4-1A prepared suspended engine" --reporter=verbose --silent=false
```

以上 Windows 命令使用候选专用明确发布路径的 fixture 环境变量，普通 DLL 与测试 DLL 区分。真实路径只留私有执行记录，不依赖默认目录发现产物。

## Task 2：生产实现与最终 GREEN

- [x] 主执行者核健康正控和真实 RED 后，原生作者仅在两条生产路径实现冻结合同；不修改测试、项目或其他模块。
- [x] 主执行者核最终源码/程序集摘要，重新执行受影响类型检查/构建/ordinary 与 fixture publish，先验 prepared GREEN，再运行完整 Job 文件。
- [x] 最终分母为旧 11 项扩展加新 1 项，共 12 项，实际整份顺序运行，无筛选/跳过；各 focused/RED/最终轮分开记录，不加到既有业务或 Worker/部署规格分母。
- [x] 使用既有 inspect-core 验证普通程序集没有 PrepareForTest/枚举测试 hooks；固定代码及真实回执的独立 Spec/Quality 复审通过，C/I/M=0/0/0。

```sh
pnpm --dir workers/image-enhancement exec vitest run tests/windows-job-object.os.test.ts --reporter=verbose --silent=false
```

稳定屏障下可用如下完整断言核验准备事实；原生身份/security/flags 的独立比较同样必需，不以这些布尔量取代独立 oracle：

```typescript
import { expect } from "vitest";

export function assertPrepared(value: {
  authorized: boolean;
  sealed: boolean;
  processSignaled: boolean;
  inOriginalJob: boolean;
  activeProcesses: number;
  totalProcesses: number;
}) {
  expect(value).toMatchObject({
    authorized: false,
    sealed: false,
    processSignaled: false,
    inOriginalJob: true,
    activeProcesses: 1,
    totalProcesses: 1,
  });
}
```

## Task 3：SOP 同步与本地里程碑

- [x] 按实际结果最小同步主 SOP、测试索引、Worker/安装规格、TODO/pending-test、README 与 CHANGELOG；不改 DDL，不把原语实测标成业务/部署验收。
- [x] 完成文稿格式、严格 UTF-8、隐私、链接/类型检查及八稿初轮独立复审；末次计划文本修正须在本地提交前通过增量复审。
- 中文本地提交由最终批准树产生，HEAD/tree/clean/source hashes/CodeGraph 回读由主执行者执行；结果以 Git 历史和实际回读为准，保留分支与工作树，不推送/PR/部署。

## 实际技术结果与批准边界

固定四源码候选 Tree 为 `40bb7336b748a0ef852765d48051793cb93e6316`，ordinary/test fixture 产物分开；Worker typecheck/build 和两次 publish 均 exit 0、无诊断，前两者 stderr 仅正常 package 命令。ordinary DLL 经既有 `inspect-core` 证实 failure method/enum hooks 缺席。固定源码与完整实际证据的独立整体复审为 Spec Compliant / Quality Approved、C/I/M=0/0/0，未变 fixture 的既有全文批准与新核摘要被明确复用；不代作文稿批准。

| 分开执行的轮次        | 实际结果                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| 独立无进程安全正控    | 1 passed / 11 filtered，2.49 秒、exit 0、stderr 空                                                         |
| prepared 安全行为 RED | 1 failed / 11 filtered，2.86 秒、exit 1；默认 DACL 不符合新合同，未调用 throw-only Inspect，setup/清理健康 |
| prepared GREEN        | 1 passed / 11 filtered，2.64 秒、exit 0、stderr 空                                                         |
| 最终完整 Job 文件     | **12/12 passed，14.95 秒，无 skip/filter、exit 0、stderr 空**                                              |

最终日志有二十四个成功 action、七次九字段 observation、两次按预期拒绝和十一份 original-child lifetime（一 direct/十 subject harness）；十二项共用一份 independent security control，tamper 不另增分母。prepared1/1、sealed-live1/1、authorized3/3、父 signal/后代 live2/3、终态0/1或0/3均与独立事实一致，本轮 terminal raw membership 为 true。健康空 Job 的第二 ACE 变体与 Dispose 后观察按各自原因拒绝。

十一份 lifetime 的实际原 child close code0/null signal、严格 UTF-8/双流真实 EOF、无流错误或强制 fallback 与精确 temp 各一次删除均已核；十个 subject native guard 均健康。只有五次显式 normal engine join 有 engine 双 EOF，其余 null 不补造，close-only 不当正常 drain。双 EOF 不代作 SR-M2-10 高输出/有界日志完整验收；各轮不与旧 11/14/9/8 或 86/24 规格计数相加。完整技术合同与分轮记录见[主 SOP §10](2026-10-10-image-super-resolution-integration-plan.md)。

后续是将安装租约、原 Job 准备与一次授权接入因果记录/session/wire/reader/TS adapter，再验证实际服务身份、完整 GPU Worker/API/ZEB。文稿初轮检查与独立复审已执行；末次计划增量、本地提交及回读各按实际证据闭合，本地提交以 Git 历史为证，不预填未产生的提交。本片技术结果不代表整个 M2、用户或实际部署验收；M1/schema5/增强关闭/readiness=false/worker 未部署/OOM 自动重试暂缓保持。
