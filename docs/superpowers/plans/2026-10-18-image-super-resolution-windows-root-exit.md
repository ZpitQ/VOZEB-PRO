# Windows 原根退出观察：服务宿主前置切片

目标：使后续服务宿主能在原根进程退出时立即取得原对象的退出结果，即使同一 Job 中仍有活后代；保持原整树、输出和业务证据契约。

状态：内部实现和所定 Windows 技术验证已完成。最终源码/实际证据独审、文稿及服务器本地交付依各自实际回执核定，不预填批准、提交或部署完成。本片没有正式服务宿主、SCM 安装或完整 Worker 安装包。

主路线见[高清增强 SOP](2026-10-10-image-super-resolution-integration-plan.md)，前一片见[正式 Windows ExecutionAdapter](2026-10-18-image-super-resolution-windows-execution-adapter.md)。

## 1. 最小生产变更

仅修改现有 [JobProcess.cs](../../../workers/image-enhancement/native/windows-supervisor/JobProcess.cs)，新增：

```csharp
public sealed record ProcessRootExit(ProcessIdentity Identity, uint ExitCode);
public Task<ProcessRootExit> WaitForProcessExitAsync(
    CancellationToken cancellationToken = default);
```

同一 JobProcess 从 Prepare 生命周期起持有一个共享完成源，观察创建时保留的原根 process/identity；每个调用方通过 `WaitAsync` 等待它。不按 PID 重新打开原根，不增加轮询、定时器、观察线程、Job owner 或第二套原生生命周期。原创建时挂起归入 Job、protected ACL、一次授权、原生期限、整树等待和清理规则保持。

原 monitor 看到最初 root pin 已 signal 时，先以原 process 句柄核实 signal 并读取退出码，再发布原 identity/code，最后才注销该 member 的等待注册并释放它。只在循环顶部检查不足以保证唤醒：原根可能在检查后退出，若先注销它，留下的永久活后代不会再唤醒监视器。退出码来自已 signal 的原对象，不把数值 259 单独当作仍存活。

## 2. 四种事实分别判断

| 事实                    | 本片含义                                                               |
| ----------------------- | ---------------------------------------------------------------------- |
| 原根退出                | 原根 process 已 signal，返回原 identity 和真实 native exit code        |
| 原整树退出              | 仍按原 Job 规则证明所有成员结束，不因原根退出而提前完成                |
| stdout/stderr EOF       | 分别读取到真实 EOF；Dispose 引起的流错误不是 EOF                       |
| 业务 ExecutionExit/成功 | 继续由现有严格业务证据判定；root、物理清理或 reader exit0 均不产生成功 |

单调用方取消只结束自己的等待，不取消共享完成源、不终止进程，也不影响另一个调用方。重复等待返回同一原结果；已正向观察后，即使 JobProcess 已 Dispose，仍可读取缓存成功结果。

若 Dispose 先于正向观察，仍 pending 的共享观察以 `ObjectDisposedException` 失败；随后最后 Job handle 关闭导致的物理退出不能将其升级为成功。监视器、原退出码读取或 member 清理出现错误时，仍 pending 的根观察与原树观察走失败路径；已结算结果不被后续错误改写。这些错误转发路径由源码约束，四个 OS 场景不等同于逐项故障注入覆盖。

## 3. 新增测试文件与选择条件

三个新增公开文件分别承担：

- [WindowsRootExitFixture.csproj](../../../workers/image-enhancement/native/windows-root-exit-fixture/WindowsRootExitFixture.csproj)：独立 Windows 运行件，引用普通生产程序集，使用 WinExe 避免本夹具的额外控制台成员；不是服务宿主或安装器。
- [Program.cs](../../../workers/image-enhancement/native/windows-root-exit-fixture/Program.cs)：以确定性门控编排原根/后代，使用测试专用 DuplicateHandle 转移的原进程对象观察 pin，分别验证 identity、存活、退出和收尾。查询原 Job 的临时句柄及时关闭，不跨 Dispose 保留额外 Job owner。
- [windows-root-exit.os.test.ts](../../../workers/image-enhancement/tests/windows-root-exit.os.test.ts)：顺序运行四个原生场景，核原调用进程 close、双流真实 EOF、错误、guardian 和 fixture 证据；失败目录保留，成功目录在精确临时根校验后清理。

默认不选中该 OS 组。显式设置 `ZEB_WINDOWS_ROOT_EXIT_OS_TESTS=1`，并用 `ZEB_WINDOWS_ROOT_EXIT_FIXTURE_EXE` 指向已构建运行件；选中后若非 Windows、缺运行件配置或文件不可用，直接失败，不改为跳过。继续使用原执行和清理预算，不靠延时或放宽期限取得通过；一旦动用紧急 guardian，该场景失败。

| 场景                     | 必须真实成立的条件                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `suspended-natural`      | 未授权时等待 pending、原根仍挂起、marker 不存在；一次授权后原根自然退出 23，身份和重复结果一致；原树和双 EOF 完成，Dispose 后仍取同一缓存结果      |
| `root-before-descendant` | 原根自然退出 23，原后代仍活，root 等待已完成而树等待 pending，Job 为 active1/total2；测试计划中的 Force 后再证明原树退出与双 EOF                   |
| `caller-cancellation`    | 原根 READY 后两个调用方等待，取消其中一个不杀原根、不完成另一个；释放原根后另一等待与重复读取取得原结果                                            |
| `dispose-live`           | 原根 READY 且活、等待 pending 时 Dispose，原等待收到 ObjectDisposedException；独立原对象 pin 另证物理 kill-on-close 退出，流销毁错误不冒充真实 EOF |

## 4. 实际验证分轮保留

各轮均有独立源码与实际回执，不相加、不覆盖失败，不把单场景实验充作最终四场景。

1. **真实行为 RED：1 failed / 3 名称过滤。** throw-only API 在 `suspended-natural` 的授权前 pending 检查失败；原根未授权、marker 不存在，非编译或缺文件失败。
2. **生产实现首轮：3 passed / 1 failed。** 原根 23、重复读取、原后代仍活及树 pending 已正确，但 `root-before-descendant` 的 active2/total4 违反原 active1/total2 断言；未放宽断言。
3. **临时诊断：1 failed / 3 名称过滤。** 原 Job 快照观察到两份 fixture 与两份系统 conhost，原根退出后剩原后代与一份 conhost。诊断观察 pins 与原创建对象 pins 分账收尾；两份存活快照不等同于全部历史创建链，不能唯一归因安全软件、OS 或 BCL。
4. **单变量实验：1 passed / 3 名称过滤。** 仅将夹具 OutputType 从 Exe 改为 WinExe，原数量断言和预算保持，恢复 READY active2/total2 与 root 退出后 active1/total2。此结果只证明该夹具在本环境的拓扑变化，不推广为产品 Node 或所有 Windows 行为的结论。
5. **无诊断最终版本：4 passed，4.39 秒。** 恢复原 Program，移除诊断快照与额外观察 pins，仅保留 WinExe 项目变更；四场景均通过，原进程 joins、调用方双 EOF 及无 guardian 分别核验。
6. **旧 Job OS 回归：另轮 12 passed，14.92 秒。** 使用本片产品源码构建，原树及生命周期回归通过，无 forced fallback；最终版本产品 JobProcess 字节未变，沿用该有效轮，不重新加总或重跑。

普通产品与夹具实际发布构建通过，最终夹具引用的产品程序集与已验产品一致。TypeScript 检查沿用 T 阶段的实际通过结果，后续 TypeScript/JSON 字节未变；不将其写成最终版本重新运行的检查。最终源码/实际证据独审和文稿收口仍按各自回执核定。

## 5. 下一片及未证明边界

本片只提供原根观察接口，尚无宿主消费者，不能据此宣称已修复生产宿主在 Node 退出、detached reader 永久挂起时的收容。下一片才以薄宿主复用原 JobProcess，消费原根退出并封存启动、终止剩余后代、等待原整树及真实输出收尾，再 Dispose；正式 ServiceBase 尚未实施，也未引入其依赖。

宿主硬死后的最后非继承外层 Job handle 关闭、嵌套 Job、观察者不保留额外 Job owner、实际 SCM 注册/账户及服务 ACL，均须后续独立验证。本片 `dispose-live` 的物理退出不能替代完整服务硬死路径或业务 ExecutionExit。

后续依次完成运行入口、真实时钟与提交/取消唤醒装配，成功 result/receipt 传输，固定离线包，再验实际服务账户、GPU/图片及 M3 安装。Windows Store 目录刷盘已有实现和历史技术证据，仍需实际服务身份及耐久验收；不重复开发目录刷盘桥。

没有完整 Worker 安装包，未安装服务、部署、重启或接通 Worker/API/ZEB。M1 已验收、schema5、增强关闭/readiness=false 和自动 OOM 降 tile 重试暂缓保持；技术原语、kernel API 接受、物理 kill 或 reader exit0 均不增加完整增强/业务验收通过数。
