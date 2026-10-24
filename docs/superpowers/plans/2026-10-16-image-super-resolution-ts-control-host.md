# 高清增强：有界 TypeScript 控制 host

依据：[主 SOP](2026-10-10-image-super-resolution-integration-plan.md)、[受限原生控制桥](2026-10-16-image-super-resolution-native-control-bridge.md)。本片只给既有 Windows 桥增加内部 TypeScript stdio host，不修改 native bridge、只读 journal launcher、ExecutionAdapter、runner、store 或 GPU 路径。

**当前状态：内部 host 已实现，固定 source v2 与 actual v2 各获独立 Spec/Quality Approved、C/I/M 各 0/0/0。** 只批准本片源码及所执行技术范围，未发布用户功能；文稿、Git、安装/服务与业务交付依各自独立回执。旧桥十三轮、历史失败和未证矩阵保持原记录，不由新轮追补。

## 1. 接口与范围

| 接口                            | 允许行为                                                           | 返回边界                                            |
| ------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| `open(signal, stillCurrent)`    | 每个 host 至多一次原 ChildProcess 启动尝试；启动前取消或失效可零次 | `bound` 或 `unknown`；重复 open 不再启动            |
| `inspect(signal, stillCurrent)` | 对已绑定原 session 发送一次关联请求，同时最多一项                  | `state`、立即 `busy` 或 `unknown`；无命令排队       |
| `close()`                       | 永久封存 admission，使用原 stdin 发送一次完整 close 并结束输入     | 同一个 Promise；仅完整停止证据可为 `stopped/closed` |

factory 不启动进程，非 Windows 在构造阶段拒绝。配置和结果均复制并深冻结；不回显原始异常、配置或未信任内容。启动尝试前记录 admission，抛错、ENOENT、缺失 pid/流或不明创建都不允许第二次 spawn，也不证明 OS 从未创建。原 child 的有效 pid 与 `bound.bridge.pid` 只做可信 runtime 关联，不按 PID 重开，不冒充独立创建句柄 pin。

不提供 prepare、authorize、原始命令、替代 child、重连、自动重试、PID/名字/全局 kill、`destroy()`、`unref()` 或制造 EOF，也不调用原 ChildProcess 的 `kill()`。helper 仍由原 native bridge 持有，host 不能为清理绕过其所有权。

## 2. 可信配置与既有预算

配置只来自可信 bootstrap，严格接受既定 own enumerable data 字段，不调用 getter，不接受 symbol、缺失或多余字段；不读取继承值。字符串须有效 Unicode、无 NUL；路径为绝对本地 drive 路径，执行文件为 `.exe`；manifest 为小写 Hex64。环境变量名称不能为空或含 `=`，忽略大小写后唯一；仅复制显式配置环境，不继承进程环境。

启动固定为受控 executable 与 `--control-bridge`、一份 native 配置 JSON；使用 executable 所在目录作 cwd，非 shell、隐藏窗口、正常 argv escaping、非 detached，三路均为原 pipe。bridge/helper 使用同一显式环境快照。

沿用 native bridge 十一项必填 limits，无新增部署默认值或性能常数：

- 字节：`maxRequestFrameBytes`、`maxResponseFrameBytes`、`maxHelperStderrBytes`、`maxSessionInputBytes`、`maxSessionOutputBytes`、`maxQueuedOutputBytes`。
- 深度：`maxJsonDepth`。
- 观察期限：`startupTimeoutMs`、`requestTimeoutMs`、`sessionTimeoutMs`、`cleanupTimeoutMs`。

字节为正整数，最多 `min(Buffer MAX_LENGTH, 0x7fffffc7)`，与 native Array.MaxLength 一致；深度/毫秒最多 `0x7fffffff`，深度至少 2。请求帧不大于累计输入，响应帧不大于累计输出或 queue 预算。边界测试允许合法最大配置但不实际分配该数量，不以测试值形成生产默认。

## 3. 严格字节协议与关联

直接读取 Buffer，严格 fatal UTF-8 和 LF 分帧；拒绝 BOM、CR、空帧、残缺 EOF、非法 Unicode/NUL、注释、尾逗号、额外尾部与任意层 decoded duplicate key。复用现有 `jsonc-parser` 和 JSON 解析，在深解析前检查显式深度。版本只能为 canonical 数值 token `1`；pid 为 canonical 正 UInt32 数值；creation FILETIME 为正 UInt64 十进制字符串，用 BigInt 检查，不能经 Number 丢精度。

只接受 native 的精确 `bound/state/unknown/closed` 形状和合法 Snapshot 组合。最多一个 bound，且须在原 spawn 事件之后、所有 state 之前；后续 executionId 精确一致。非空 requestId 只对应原 inspect/close，请求 ID 为一次随机产生的小写 Hex32，碰撞封存 Unknown，不隐藏再生成。observer 的 null-ID state 只校验，不完成 inspect 或建立无界事件队列；过期、重复、身份错误或额外 terminal 不交付成功。pre-bound unknown/closed-unknown 即使带桥自身 ID 仍为 Unknown。

帧和累计输入/输出预算均包含 LF；stderr 使用既有预算，任何 stderr 都是故障。累加计数饱和于 cap+1，在分配/复制前检查剩余空间，不保留完整 transcript。故障后停止捕获与解析，继续消费原双输出；至多保留一项 inspect 写入和一项预占 close 写入，并观察原 write callback。

## 4. 正常关闭与真实故障分开

正常 `close()` 预占在途 inspect：inspect 立即返回不可变 `unknown/unknown`，这只表示该方法不再交付结果，不把正常关闭污染为会话故障。host 对原 stdin 调用一次 `end(closeFrame, callback)`，完整 close 后才产生真实输入 finish/close。迟到的正确关联 inspect 响应只校验、消费，不再返回 inspect 成功；迟到 malformed frame 仍为真实故障。

实际预占和最后发送前都必须核仍在途的原 inspect deadline 与 scope。timer callback 尚未执行，或 caller callback 自身跨过期限，都不能清掉原 timer 后把真实过期当作正常预占；v2 仅将 close 两次检查改为携带原 `inspectRequest`，沿用已有 fault/原 stdin EOF 路径，无新期限或重试。

真实协议、创建、流、取消、失效作用域或期限故障封存会话；若尚无有效 close，不再发新命令，只结束原 stdin 一次并保留原输出 drain。首次 seal 固定 cleanup anchor，后续 close/事件不能重置期限。已返回的故障/期限/取消 Unknown 粘滞，迟到完整收尾只能释放已证明可释放的资源，不能把原结果或 close Promise 改为成功。

`open` 的原 stillCurrent 回调保持不变，相关 signal/当前作用域在 dispatch、写入与发布 bound/state 前重核，包含回调同步重入 close。startup/session 在 open admission 一次锚定，request 在 inspect admission 一次锚定；除 timer callback，还在实际边界核同一单调期限，事件循环延迟不延长许可。startup 适用至 bound，request 适用至 inspect 交付或被 close 预占，session 适用至首次 seal；seal 后使用首次独立锚定的 cleanup 期限，不延长或重新启动已结束阶段。观察期限不是硬实时保证。

## 5. 完整生命周期门

成功 `stopped/closed` 同时要求：

1. 合法关联的 `closed/stopped`、原 close 写 callback 完成及真实 stdin finish。
2. 原 child 自然 `exit(0, null)`，真实 stdout end 与 stderr end，且没有读错误或 stderr 内容。
3. 原三路 stdio 全部 close，原 child close 为 code0/signal null 且与 exit 一致，所有已发 write callback settled。
4. 没有先前协议/创建/流/取消/失效作用域/期限故障，发布 stopped 前仍满足首次 cleanup 观察期限。

terminal frame、helper 陈述、child close、测试 Job census 或清理最终 join 都不能单独替代真实 exit/双 EOF。流 error 不是 EOF。资源 join 与业务结果分开：Unknown 后若原 exit/双 EOF/全部 close/写任务完整，可释放原资源但不升级结果；任一事实缺失，cleanup deadline 后仍保留原 state、监听器、drains 与 admission barrier。一次 host 始终不可重开，不能以“最终清完了”取得重试权限。

## 6. 本轮实际验证与证据分账

固定 source v2 为五条新增源码/测试，其他115条 worker 文件与基线逐字节相同。源码与actual分别获独立Spec/Quality批准、C/I/M各0/0/0；相应源码格式、strict UTF8/隐私、类型检查/构建与CodeGraph同步已核。编译stderr的30/36字节仅为tsc命令回显，不是warning。文稿与Git交付门依各自独立固定回执，不由源码/actual批准代替。

| 独立轮次                    | 实际结果                                                                                       | 证据边界                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| v2 行为 RED 与预算 coverage | **2 failed / 8 passed / 90 filtered-skipped（100生成）**                                       | 两项期限失败为修复前stopped与unknown的真实断言差异；八项预算在原guard上直接通过，仅补coverage |
| Root Windows unit fixed v2  | **99 passed / 1 non-Windows平台skipped（100生成），code0/signal null、stderr0**                | 受控child身份/事件加真实Node streams；含两项期限回归及四类LF equality/+1的八项独立用例        |
| Linux unit v2               | **24 passed / 76 Windows平台skipped（100生成），inner code0、测试stderr0**                     | 独立平台轮，不与Windows数量合并，不把skip记通过                                               |
| Windows actual v2           | **ordinary与close-preempts-inspect两例2 passed / 0 skip / 0 fail，code0/signal null、stderr0** | Vitest加载TS源码并调用已审native；原bridge实际生命周期，不是编译dist产物或完整部署验收        |
| 作者另一完整unit尝试        | 日志显示99/1，但没有终态receipt，原记录器/管道收尾**Unknown**                                  | 原状态保留，不标GREEN、不补造exit/EOF，不把其99加到Root新有效轮；根因未证                     |

v1合法unit/OS、早期RED/timeout/failed及旧native十三轮仍各自保留，不以v2或最终清理追补原失败。原始无receipt记录器收尾不归因于杀软或生产源码。每轮按实际命令、固定候选、pass/fail/skip/filtered与清理分别核验，不累计为业务86/Worker24整项通过。

源码复审发现并关闭两项问题：close曾漏核在途inspect期限；原输入/输出测试同时收紧多个额度，不能分别证明guard。v2两项期限回归分别保持timer未投递、在close scope callback内跨期；四类独立LF测试分别只刺激request frame、response frame、累计input、累计output，等于边界允许、超出1字节拒绝，并按场景核无额外command及继续drain。合法JSON whitespace只用于测试帧，不增加生产API/默认常数，不包装成新的独立queue或stderr能力。

actual ordinary输出849字节、preempt输出534字节，两例均恰一个原spawn、未kill，并在close返回前具备原bridge自然exit0、真实stdout/stderr EOF、三stdio close、一致childclose及原write/end callbacks。所用已审native运行包在before/after核对中bridge与ordinary各192个文件字节/摘要均相同；这是复用构建的窄证据，不认证完整部署或新增native矩阵。helper身份/生命周期仍为可信bridge陈述，不是独立helper创建pin/普通helper双EOF、Job或engine/GPU证据。独立TypeScript构建通过与这次TS-source互操作分账，不能据此声称dist包已经运行验收。

严格配置/协议、关联、busy/observer、有界capture与原drain、真实生命周期Gate、scope/期限/重入、Unknown粘滞及迟到join的受控单测不冒称OS证据。原生退出、helper陈述、测试Job census和engine completion继续分别证明。

## 7. 交付边界与后续

本片仅内部 host，未发布用户功能；不注入 `readInterruptionEvidence`、不启用恢复或新 attempt。真实 prepare/AUTH、writable/current-attempt/recovery-control 与最后发送边界的单次许可，以及 ExecutionAdapter/runner/store，另冻合同再接线；IPC 不等于 SQLite/Win32 原子事务，AUTH、resume、ACK 和 completion 分开证明。

完整 Node/JS/bridge/helper/managed runtime/loader/环境可信稳定部署仍是 TCB 前提，配置/路径/预先 hash 不认证完整部署。字节与观察预算不证明 native 内存、CPU 或硬实时有界；安装/服务身份、图片质量、GPU、Worker/API/ZEB、TLS/成功流/receipt/清理和用户/实际部署验收分别取证。

M1 已验收、schema5、增强关闭、readiness=false、worker 未接/未部署与自动 OOM 降 tile 重试暂缓保持。本片仅内部技术里程碑；没有 push、PR、部署、重启或生产修改，用户及实际部署验收独立记录。记忆后台捕获与服务端写入确认分开，没有回执不宣称入库。
