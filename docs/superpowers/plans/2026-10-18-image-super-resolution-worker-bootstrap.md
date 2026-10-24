# 图像超分：正式 Windows Worker 入口装配

日期：2026-10-18。状态：入口实现、技术检查与固定源码独审通过；文稿与本地交付按各自回执核定。尚无完整安装包或部署验收。

## 1. 目标与已经取得的证据

将既有模块接成单个正式入口，不重写执行器、持久层或调度器。仓库 worker 根目录作为 payload 的 `app`：`main.mjs` 固定加载 `./dist/bootstrap.js`，原 TypeScript 构建布局保持。薄服务宿主继续固定启动包内 Node 和该入口，工作目录为 `app`；不扩展宿主 argv、cwd 或任意执行路径。

以下是相互独立的前置实际结果，不累计为联合通过数：

| 前置切片          | 已确认结果                                            | 证明范围                                                                            |
| ----------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 生产 Clock        | 24/24，类型检查、构建和固定源码/实际证据独审通过      | 标准 epoch 时间、独立绝对时间调度、取消和迟到回调；不代表系统墙钟变更或服务身份实测 |
| HTTP 持久提交通知 | 新行为 7/7，类型检查、构建和固定源码/实际证据独审通过 | 真实 TCP/multipart、图片、SQLite COMMIT、取消、重放及通知错误隔离                   |
| 受影响旧 HTTP     | 接受/生命周期两文件另轮 65/65，独审通过               | 旧调用与原响应、授权、幂等和取消行为保持；不与新 7 项合并                           |

入口有效 RED-v2 为 **22 failed / 18 passed（共 40）**，保留为缺行为证据。最终入口两文件 **40 passed / 40，7.37 秒**，无 failed/skipped；旧 launcher 另轮 **98 passed / 1 平台门控 skipped（99），1.26 秒**。类型检查、实际构建与固定源码独审通过，Critical/Important/Minor 均为 0。原始失败、诊断、未执行与 Unknown 分别保留，不合计或改判。

当前 Windows 测试账户已取得独立 Store 初始化、关闭、重开且身份保持的前置事实；它不证明服务账户、Session 0、ACL 或掉电耐久。Windows 薄服务宿主、原根退出、Adapter 和原生控制既有证据继续按[对应计划](2026-10-18-image-super-resolution-windows-service-host.md)沿用，不重跑未改矩阵。

## 2. 固定入口与配置

库入口为 `startWindowsWorker(configuration, { appDirectory, signal })`，返回原 HTTP Server 和同步 `close(): void`。`configuration` 接受未知值，在产生 Store、监听或恢复副作用前完成全部校验；复用原配置创建器及 HTTP 组合请求预算，不增加隐式默认值或通用配置框架。

正式 `main.mjs` 只读取自身相邻的 `worker.config.json`，固定相对加载 `./dist/bootstrap.js`，拒绝任意 CLI 参数，不读取 CLI/env 指定的替代配置地址，也不热重载。配置文件读取、JSON 解析及业务模块动态加载均处于固定脱敏错误边界内；模块或原生依赖加载失败不得输出 Error、stack、路径或配置原值。

顶层精确七键：

| 键                 | 合同                                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| `storeDirectory`   | 已初始化 Store 的本地盘符绝对目录；正常启动只打开，不初始化、不重绑或轮换凭据 |
| `port`             | 库沿原 HTTP 工厂允许 0..65535，正式 main 只允许明确的 1..65535                |
| `workerConfig`     | 复用原模型、版本摘要、4×、tile 与资源预算配置                                 |
| `submissionLimits` | 复用排队容量、排队期限与幂等键限制                                            |
| `runnerLimits`     | 复用执行期限、取消宽限、lease 与 heartbeat 预算                               |
| `transportLimits`  | 复用原 HTTP 传输及组合请求预算                                                |
| `execution`        | 下表中的五个固定执行配置键                                                    |

`execution` 精确五键：

| 键                       | 合同                                                         |
| ------------------------ | ------------------------------------------------------------ |
| `installationRoot`       | 原批准安装根目录，本地盘符绝对路径                           |
| `recordsRoot`            | 原可信记录根目录，本地盘符绝对路径                           |
| `expectedManifestSha256` | 外部批准清单的既有摘要合同                                   |
| `bridgeLimits`           | 既有有界控制桥限制                                           |
| `journalLimits`          | 既有只读日志限制，进入副作用前完成字段、正安全整数及上界校验 |

精确键、own data 和原型规则拒绝额外字段、accessor、数组等非合同值；目录必须非空、无 NUL，并沿用 Windows 本地绝对路径规则。校验路径语法不等于已经验证 ACL、reparse、文件身份、完整安装清单或 GPU。

JSON 不接受 Bearer、serviceId、owner、ready、exe/helper 路径、environment、argv 或 cwd。`appDirectory` 是内部可信参数，从其父目录固定派生 `native/bridge/WindowsControlBridge.exe` 与 `native/supervisor/WindowsSupervisor.exe`，不向配置开放任意命令。

子进程环境只取当前进程的 `SystemRoot`、`WINDIR`、`TEMP`、`TMP`，忽略输入大小写并归一为固定键；`SystemRoot` 必须存在且满足本地绝对路径要求。不传整个 `process.env`，不继承 PATH、DOTNET_* 或 NODE_* 配置树，不附带用户凭据。

日志 reader 的数值限制原来可能到第一次读取才报错。本片从现有 launcher 中抽出唯一纯函数 `freezeWindowsJournalReadLimits`，launcher 与 bootstrap 共用同一校验；不复制两套规则、不创建无用 reader，也不改变协议或 Adapter 的解释边界。

## 3. 单一启动与调度生命周期

每次启动仅创建一个 System Clock、Windows ExecutionAdapter、Store 和 Runner。Store 使用同一 `clock.now` 及同一 Adapter 的中断证据读取；Runner 使用该 Clock 与 Adapter，并生成新的 owner UUID。稳定 serviceId 与原 credential 保持原值，不能用 serviceId 充当本轮 owner。

先装共享关闭入口和 AbortSignal，再监听原 HTTP 回环地址。监听成功后只发起一次非等待 `runner.recover()`，其拒绝仅固定脱敏观察；长期恢复不能阻塞 health、取消路由或入口返回。Unknown 保留原活动槽，不扫描、清槽或循环重试。已有持久任务可能被恢复执行，技术检查只能使用受控空队列或合成队列。

HTTP 已提交的新接受、合法重放和取消在原持久成功边界之后调用可选 `onJobCommitted`。本片将该提示直接接到同一个 Runner 的 `wake()`；closing 时忽略，其他时候立即返回原 wake Promise，不等待前一次通知，也不新建第二调度队列。原幂等、认证、grace、取消与 COMMIT 事实仍由原 HTTP/jobs/Store 决定。

通知失败不会反转已经提交的业务响应。同步抛错或异步拒绝仅观察固定 `enhancement_wake_failed`，不打印原错误；没有通知回调时不增加 Promise。

readiness 仍沿原合同为 false，不增加配置开关、测试模式或正式 ready=true。监听可达只证明入口可用，不证明 GPU 可用或增强任务可以交付。

## 4. 同步封存与明确进程退出

`runtime.close()` 是幂等同步逻辑封存和发起清理，不承诺物理 join。同一调用栈依次：closing=true，调用 Runner.close，调用 Adapter.close，停止 listener 并关闭连接，最后关闭 Store。各阶段错误独立隔离，不能因前一阶段抛错或返回未结算 Promise 而跳过后续封存或关库；异步拒绝只作固定脱敏观察。

已 abort 的启动不产生 Store、监听或恢复副作用。监听在途 abort 仍立即封存 Runner/Adapter/Store；若 listener 迟到成功，关闭该 Server，不恢复、不返回可用 runtime。启动失败走同一关闭入口，不换端口、不重建 Store，也不自动初始化。

关闭后的旧通知、timer、迟到 prepare/inspect/exit 结果继续受原 guards 约束，不能新增业务 COMMIT、授权、停止或 owner 转移。已发 I/O 可能完成；未知引用或目录保持，不为制造“清理成功”删除证据。

main 在读取配置、加载业务模块和启动前安装信号与致命错误处理。SIGINT/SIGTERM 先 abort 共享 signal、关闭已取得的 runtime，再显式 `process.exit(0)`；启动或运行致命失败同样先封存，再显式 `process.exit(2)`。不只设置 exitCode 等待事件循环，不等待可能挂起的 Adapter 清理，不增加 watchdog、第二 guardian 或业务停止 IPC。

成功只输出固定 `enhancement_worker_listening`；启动失败为 `enhancement_worker_start_failed`，运行致命错误为 `enhancement_worker_failed`。进程退出码、EOF、宿主物理收容或 SCM Running 均不能生成业务成功或 ExecutionExit。

## 5. 本片技术验证与源码独审

以下要求已由本片定点测试与固定源码独审覆盖；其范围仅限入口装配：

- 非法配置和 journal 数值/上界在 open/listen 前失败；纯 limits 校验与原 launcher 共用规则，旧配置行为不放宽。
- 真实 Store、原 credentials、同一 Clock/Adapter/Runner、新 owner 与监听后仅一次 recover；恢复在途不阻塞 health 或 DELETE。
- 新接受、合法重放和取消沿原 COMMIT 边界唤醒同一 Runner；pending、throw 和 reject 不延迟或反转业务响应。
- 已 abort、监听在途关闭、recover microtask 前关闭、迟到 listener，以及挂起 Adapter.close 仍同步封存和关库；迟到 native 结果不能改持久事实。
- 独立 Node 进程覆盖 CLI、缺/坏配置、固定模块加载与依赖失败的脱敏，以及启动在途和带活跃句柄时的明确退出。
- 至少一次实际 `dist/bootstrap.js`、受控空 Store 与真实回环 HTTP 的组合检查：health/capabilities 可达、ready=false、停止后可重开 Store，原身份与 credential 保持。合成模块的入口测试不能代替这一项。

Windows 独立进程测试须正确区分本地路径与 file URL：从 `import.meta.url` 还原路径，动态加载绝对文件时使用 Node 的 file URL 转换，不将盘符路径当 URL，也不直接把编码后的 URL pathname 当本地路径。先确认入口和 fixture 加载有效，再将失败登记为业务行为 RED。

测试使用独立 fixture 与受控队列，不创建目录 junction 或复制整个 node_modules。JS 预载向 `process.emit` 投递信号只证明 JS 信号处理和明确退出，不称实际 Windows OS/SCM 软停止；当前测试账户的 Store 重开不称正式服务身份耐久。

最终格式、类型、实际构建、定点组合/入口检查及受影响旧 launcher 回归均完成，固定源码独审为 Spec compliant / Approved，C/I/M 为 0/0/0。Windows 平台未执行旧 launcher 的 unsupported-platform 负例，因此保留 1 项平台 skip。构建之后只修一处测试 fixture，产品及 dist 字节未变；最终入口轮同时固定生产源码和实际 dist 输入。没有以测试中的源码字符串断言替代构建来源。

原入口第一轮因 Windows `--import` 使用盘符路径而在进入 main 前失败；最小对照证实应使用 file URL，该失败不记作产品 RED。后续 39 passed / 1 failed 的恢复例把完整任务记录传给只允许两字段的 descriptor target；生产严格校验在 reader 分配前正确拒绝为 Unknown。增加生产 context 前置检查后单项诊断立即失败，再仅修测试参数为明确 identity/launchTicket；原 pending reader、HTTP、取消、同步关闭及持久 slot 断言保留，产品未放宽。各原失败单独保留。不同轮次不合计，不重跑未改 Clock、宿主/native 矩阵，不增加手机端或无关浏览器测试。

## 6. 后续门槛

本片不是完整离线安装包，也未完成实际 SCM 安装/启动、Session 0、服务账户 ACL/Store 耐久、真实 GPU/图片质量、result/receipt、Worker API 对外接入或 ZEB 生图闭环。内部 EXE、库、可监听入口和健康检查均不能替代这些验收。

M1 普通插值放大移除已获用户验收。增强 off、readiness=false、schema5、worker 未接与自动 OOM 降 tile 重试暂缓保持；早期 CLI 诊断不能代作容量与完整业务验收。

本片源码与技术验证已完成，文稿与服务器本地提交按各自回执核定；后续分别推进成功结果传输/接收确认、固定包与安装/服务身份、真实 GPU，最后接测试环境普通完整图与 ZEB。公开文稿不包含真实部署地址、目录、账号、凭据或业务身份，不表示已发布、push、创建 PR、合并或变更生产。
