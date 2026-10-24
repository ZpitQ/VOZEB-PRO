# 图像超分执行发送许可 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Steps use checkbox syntax; source changes start with behavioral tests.

**Goal:** 将真实 Store 与原 runner holder 的新鲜权限带到 adapter 的最后一次同步 prepare/AUTH 发送入口。

**Architecture:** Store 保留业务准入规则，runner 为两个阶段分别创建一次性 guard；adapter 在最后一次等待后、唯一同步派发前消费。数据库准入与外部 IPC 不是原子操作，原生传输、引擎生命周期及结果终结证据分别验收。

**Tech Stack:** TypeScript、Node.js 22、better-sqlite3、Vitest；不改依赖或 schema。

**状态：本片内部实现、所定技术验证与固定源码/实际证据独立复审已完成；最终文稿检查/独审、本地提交及回读仍须各自实际回执。** 本文不预填文稿审批、提交或部署结论。既有 [TS 控制 host](2026-10-16-image-super-resolution-ts-control-host.md) 与[原生控制桥](2026-10-16-image-super-resolution-native-control-bridge.md)保持 inspect/close 范围。

## Global Constraints

- M1 已验收，schema5，增强关闭，readiness=false，worker 未接；自动 OOM 降 tile 重试暂缓。
- `ExecutionAdapter` 仍为 `kind: "test"`；guard 必填，不提供默认放行或可持久转交的授权令牌。
- 不新增公开 API、DB 表、schema 版本、固定延时、轮询、重试或资源预算；不改原生/TS host 文件。
- 业务时间沿用 `now <= leaseExpiresAt` 且 `now <= executionDeadlineAt`，相等有效；不套用传输 host 的 `>=` 到期判定。
- 各轮 RED、GREEN、受影响回归及平台证据分列，不重跑未变化的 native/host/OS 轮次，不累计成业务验收通过。
- 合成 adapter 发送只证明最后发送许可接缝，不证明 NamedPipe 写入、原生 AUTH、Resume、ACK、GPU、Worker/API/ZEB 或生产就绪。
- 公开交付不包含真实部署地址、目录、账号、凭据、业务身份或私有证据路径；部署及用户验收独立记录。

## 1. 冻结接口与文件职责

修改 `workers/image-enhancement/src/execution.ts` 声明以下接口；`src/store.ts` 保留业务权限，`src/runner.ts` 负责原对象绑定与阶段寿命。新增 `tests/execution-send-permission.test.ts`，其他测试只更新 guard 参数与真正发送点的直接消费者。

已接受源码 source-v4 的 tree 为 `50cf06ad87a2892fc34d066fbf11e946c1fc1d5b`，本轮范围为十九份源码/测试与八份文稿，共二十七路径；最终文稿与交付树仍须另行冻结。末次窄修仅涉及 `tests/recovery-fixtures.ts` 与 `tests/authorized-recovery-runner.test.ts`，相对此前实现的三份生产源码及原生/TS host 未变。formatter、类型检查与构建已确认各退出 0；行为回归及固定源码/实际证据独审另有下文分轮与批准结论。

```typescript
type ExecutionSendGuard = Readonly<{
  signal: AbortSignal;
  stillCurrent(): boolean;
  takeSendPermission(): boolean;
}>;

prepare(
  attempt: ClaimedAttempt,
  guard: ExecutionSendGuard,
): Promise<OwnerDescriptor>;

authorize(
  attempt: ClaimedAttempt,
  descriptor: OwnerDescriptor,
  guard: ExecutionSendGuard,
): Promise<void>;

canAuthorizeLaunch(
  identity: AttemptIdentity,
  launchTicket: string,
  descriptor: OwnerDescriptor,
): boolean;
```

`signal` 仅表达既有 runner close，不是取消、kill 或 terminal 回执。`stillCurrent()` 只观察新鲜事实；它不授予发送、不消耗许可，也不续租、写授权或触发 I/O。

## 2. 许可的所有权、一次性与寿命

`createRunner` 入口只捕获一次 `originalStore = options.store`。每个 guard 绑定该实例与原 `OwnedAttempt` 对象、完整身份/票据；AUTH 另外绑定冻结的 prepared descriptor。读取前后均核对 runner/store 未关闭、原 holder 仍在、`options.store === originalStore`。运行时替换 readonly 类型的 Store、复用 owner 字符串或创建新 Store 都不能复活旧 guard；谓词闭包必须读取捕获的原 Store。

每个阶段创建独立私有 `{ guard, seal }` 控制器。公开 guard 使用 `Object.freeze`；`takeSendPermission` 在任何可重入读取之前标记 consumed，第一次为 false 或抛错也已消费，后续调用一律 false。新鲜读取异常关闭权限；读取前后都核对 active/closed/holder/Store，不在 adapter 复制业务规则。

runner 在各自 `try/finally` 中调用 prepare、authorize；在 runner 观察到本次调用 fulfilled/rejected/同步 throw 后分别 seal，即使 adapter 从未消费也封存。泄漏的回调不能在该阶段结束后再次发送。这里是 runner 观察到调用完成的边界，不宣称同步观测任意 Promise 的内部状态。

adapter 可以在异步准备前后观察 `stillCurrent`，但必须在最后一次 await/排队之后，紧邻唯一同步派发消费 `takeSendPermission`。成功消费与派发之间不允许 await、排队、用户回调或重试。受控测试 fixture 在拒绝时抛既有 `EnhancementError("not_ready")`，不伪造 descriptor 或授权成功。

## 3. Store 新鲜读取与 AUTH 顺序

每次 `canPrepareAttempt` 或 `canAuthorizeLaunch` 调用都在一个一致的同步 SQLite 读取事务内复用 `#currentAttempt`、`#writableAttempt` 与 `#readAttempt`，核对当前 identity/fence/ticket、execution slot、有效租约/全局期限、停止状态及 active recovery control。使用最新耐久 lease；旧 claim 的 lease 不是授权依据。

先验证并冻结调用方 descriptor，先采样可能重入的 clock，再执行最终 `#writableAttempt` SQL 读取；其后仅作纯比较。禁止把回调前的旧 row 留作权限依据。事务在 adapter 调用/IPC 前结束，事务内无 await 或外部写入。

prepare 还要求 descriptor、prepared、authorized 均为空。AUTH 必须在 `registerPrepared` 与 `authorizeLaunch` 的真实 COMMIT 返回后、同步 `observeExit` 安装后，使用相同票据、非空 prepared_at/authorized_at 与精确已提交 descriptor 再读取权限。既有 prepare 入口检查保留，入口检查不消费 guard；AUTH 入口使用共享谓词，不能仅凭 `getActiveAttempt` 可读放行。同步订阅的重入取消、close、recovery 或退出须纳入最后一次权限检查。

## 4. 不确定发送与终结边界

SQLite 许可准入和随后 IPC 不原子。取消已在许可事务快照前提交时必须拒绝；成功准入后的取消可能与已准入发送竞争，沿既有精确 stop/inspect/terminal 路径处理。guard 无法撤回已经返回给不合规 adapter 的 true，不据此声称取消必定零发送。

AUTH COMMIT 后的拒绝、同步 throw、异步 rejection 或 ACK 缺失不能回滚 `authorizedAt`，不能清槽、再次授权或创建新 attempt；保留原 slot、身份、launch chain 与 Unknown。有效当前 owner/lease 只能消费同源精确 sealed tree-exit 证据；旧 owner 或 active recovery 必须由既有精确 recovery control 应用证明。非空 authorizedAt 不能被 `never-authorized` 清理。

prepare 的创建本身也是副作用。prepare 拒绝不能证明已进入或不确定创建已收尾；既有 helper-only force/release 不能越过 engine prepare 使用。EOF、helper exit、缺 ACK 或权限拒绝均不等于引擎终结证明。

## 5. 唯一详细验收表

以下是冻结的验收条件；实际技术接受范围与未覆盖边界以 §6 的分轮及独审结论为准。测试穿过真实 runner/Store 接缝并读取临时 SQLite；adapter 仅控制等待与合成发送边界。既有不变控制可引用精确断言，不为凑数复制测试。

| 案例                | 触发条件                                                        | 必须观察的事实                                                                                                                          |
| ------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| P1 正常两阶段       | prepare/AUTH 分别等待后消费                                     | 两个独立冻结 guard，各一次合成发送；AUTH 发送前 descriptor/授权已 COMMIT 且 observer 已安装                                             |
| P2 prepare 撤销     | adapter 等待中、prepare 派发前取消                              | prepare/AUTH 均零发送，不制造 terminal；保留槽按原证明规则处理                                                                          |
| P3 AUTH 撤销        | 授权 COMMIT 后、派发前取消                                      | AUTH 零发送，authorizedAt 不变，槽保留至精确证明                                                                                        |
| P4 时间边界         | 不交付 timer，直接设置 lease/global 的过期、相等与未到期        | 沿用共同 `<=` 边界；过期回调直接拒绝，不依赖定时器触发                                                                                  |
| P5 最新续租         | adapter 等待期间合法续租                                        | 旧 claim lease 已过但最新耐久 lease 有效时允许；原全局 deadline 不变                                                                    |
| P6 recovery         | tuple/slot 未动时安装 active recovery control                   | active attempt 仍可读而 guard 拒绝；无旧 owner 写入或第二次启动                                                                         |
| P7 原对象退役       | runner/store close、原 holder 退役或替换实际 options.store      | 旧 guard false；signal 仅反映 runner close；谓词内部替换 Store 也拒绝                                                                   |
| P8 精确绑定         | 错 identity/fence/ticket/descriptor                             | false 且无元数据改写；使用完整原 descriptor，不局部重建                                                                                 |
| P9 单次与寿命       | 重复/重入调用、首次 false/throw 或调用结束仍未消费              | 每阶段至多一次 grant，重入前已 consumed；stillCurrent 不重授；runner 观察 fulfilled/rejected/同步 throw 后泄漏的未消费 guard 也不能发送 |
| P10 订阅重入        | observeExit 同步取消/close/recover/exit                         | AUTH 入口及最后发送均遵守新鲜事实，observer-before-send 顺序保持                                                                        |
| P11 不确定派发      | 获准后副作用发生但 throw/reject/ACK 丢失                        | 再 wake 不重授权、不二次启动，原 slot/身份保留                                                                                          |
| P12 AUTH 准入后取消 | AUTH 成功消费之后取消                                           | 明确已准入竞态，走同源 stop/terminal 路径，不宣称原子性或零发送；该专项不宣称 prepare 准入后取消也已专门覆盖                            |
| P13 精确终结        | 先提交错误证明，再提交同源精确 sealed tree-exit                 | 错证明不释放；有效当前 owner 走既有释放路径，旧 owner 走精确 recovery                                                                   |
| P14 COMMIT 失败     | 既有授权提交失败控制                                            | adapter AUTH 不进入、零发送；不混同未知 ACK，也不回滚已确认 COMMIT                                                                      |
| P15 验证/时钟重入   | descriptor 验证或 clock 在最终 SQL 读取前同步提交 stop/recovery | prepare/AUTH 均不得依据回调前旧 row 授权；除故障安排的真实 stop/control 外无耐久状态变化                                                |

## 6. 实施与验证步骤

### 已确认的平台限制与独立待验门

Windows 首轮新增 Store 用例在 `Store.connect` 初始化时失败，尚未进入 guard/SQL 行为，不属于行为 RED。该轮执行的三个用例与按 name filter 排除的五十四个用例分别记录；过滤不称平台 skip。独立诊断使用固定 Node.js 22.23.3/libuv 1.51.0：SQLite 3.53.4 内存查询和既有目录 open 正常，随后目录 fsync 返回 EPERM。诊断进程因捕获并记录异常而退出成功，不表示 fsync 成功；未证明 Windows 系统或 360 的具体根因，也未证明持久化修复方案。

本许可切片不吞该错误、不跳过 flush、不加 shim。Windows 只作 TypeScript 类型/构建与静态检查，真实 Store/runner/SQLite 行为及直接受影响回归在 Linux 候选上验证，分轮及独立批准见下文。Linux 结果不能代替 Windows 耐久 Store、目录刷盘及安装后实际服务运行验收。旧 Windows native/host 证据保持原范围，不因本平台缺口重复测试或升级为完整 M2/M3、GPU、Worker/API/ZEB 或业务验收通过。

- [ ] 在所选 Windows 安装与实际服务身份下，独立核验真实 Store 初始化、目录持久化和受影响运行/恢复；保留具体失败与因果证据，不以 Linux 结果、目录 open 或诊断进程退出成功代替。未取得实际证据前，该门禁保持待验。

### 已确认的实际分轮记录

Linux 行为轮使用 Node.js 22.22.2/libuv 1.51.0。下表各行为轮、夹具修正轮与范围回归分别保留，不把失败轮写成 GREEN，不相加为同轮 519、63 加 2 或业务规格通过。

| 实际轮次                | 数量与耗时                                                             | 事实与范围                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows RED setup       | 3 failed；54 name-filter 排除；共 57                                   | 三例均为 Store.connect 初始化失败，非新增行为 RED；平台缺口见上文                                                                                                                                   |
| Linux behavioral RED-v2 | 3 failed；54 name-filter 排除；共 57                                   | 实际行为失败为 prepare 缺 guard，以及 clock 内真实 cancel/recovery 后旧权限仍 true；与 Windows setup 失败分列                                                                                       |
| Linux focused-v1        | 61 passed / 2 failed；共 63；37.37s                                    | persistent spy 再次替换的夹具错误；保留失败，不称完整聚焦通过                                                                                                                                       |
| fixed-v3 focused-v2     | 2 passed / 61 name-filter 排除；共 63；2.93s                           | 只验证被修正的两个聚焦夹具控制；不称重跑了全部 63                                                                                                                                                   |
| Linux regression-v2     | 25 文件中 23 passed / 2 failed；517 passed / 2 failed，共 519；198.06s | 新 focused 文件在本轮完整 63 passed、39.646s；整轮仍失败。两个旧控制分别为一参数 spy 断言及 sealed ticket 先执行 owner assertion，后续只窄修两个测试/fixture                                        |
| source-v4 focused-v3    | 3 passed / 77 name-filter 排除；共 80；3.35s                           | 两个原失败控制与 prepared 对照；真实退出 0、stderr 空、122 文件闭包 before/after 字节一致，不代表全部 80 通过                                                                                       |
| source-v4 regression-v3 | 16 文件，315 passed / 0 failed / 0 skipped；155.97s                    | 由十五个 recoveryExecutor 直接消费者与改动的 authorized-runner 组成；实际原 child close code0/signalnull、stderr 空、122 文件闭包 before/after 一致；本轮 GREEN 与后续固定源码/实际证据独审分别核定 |

其余九个 suite 及新 focused 完整 63 项的未失效证据按 regression-v2 各自单 suite 回执沿用；最后一轮仅验证实际受影响范围，不将两轮数字相加或把 regression-v2 的失败抹去。许可准入后的专门取消控制覆盖 AUTH；没有单独证明 prepare post-admission 也已覆盖。原生传输、引擎及 Windows 耐久 Store 的验收范围均不因此扩大。

固定源码及实际分轮的独立 Spec/Quality 均 Approved，Critical/Important/Minor 均为 0；两个旧测试/fixture 修正、十六文件重验与其余九个 suite 沿用范围已获批准，没有剩余源码必修项。本片内部技术范围已接受；公共文稿最终检查/独审、最终树、本地提交及 fresh readback 尚待各自回执，不由源码接受自动完成。

### Task 1: Store/runner 最后发送许可

- [x] 在 `tests/execution-send-permission.test.ts` 写行为 RED，使用 deferred arrival 与调用已结束的替代观察，禁止因未触发 barrier 挂起而冒充行为失败。
- [x] 在 `src/execution.ts` 加必填 guard，在 `src/store.ts` 加共享同步读取谓词与最终 SQL 顺序，在 `src/runner.ts` 加原 Store 捕获和每阶段控制器；保持既有授权 COMMIT、observer 顺序与 Unknown 规则。
- [x] 仅为直接消费者补显式 guard；发送前消费必须留在原因果位置，arrival/call 先于等待。不合规 fault fixture 在测试内明确标注范围。
- [x] 完成所定聚焦/受影响回归及类型/构建，直接消费者范围与沿用证据分别核定；命令入口及实际分轮见本节。

从 `workers/image-enhancement` 使用各平台既有固定 Node 22 运行；真实 Store/SQLite 行为命令只在 Linux 候选执行，Windows 保留类型/构建与静态验证。以下是初始聚焦命令入口，实际受影响范围按候选依赖与上表各轮回执核定；不得因文稿变化重跑未失效证据。所定技术验证及固定源码/实际证据独审已完成，最终文稿与本地交付仍待另行核定。

```text
node node_modules/vitest/vitest.mjs run tests/execution-send-permission.test.ts
node node_modules/vitest/vitest.mjs run tests/execution-send-permission.test.ts tests/runner.test.ts tests/runner-store.test.ts tests/lifecycle-runner.test.ts tests/lifecycle-store.test.ts tests/recovery-runner.test.ts tests/recovery-store.test.ts tests/authorized-recovery-runner.test.ts tests/authorized-recovery-qualification.test.ts
node node_modules/typescript/bin/tsc --noEmit --pretty false
node node_modules/typescript/bin/tsc --project tsconfig.build.json --pretty false
```

### Task 2: 独立审核与文稿闭合

- [x] 固定候选源、每轮命令/日志/receipt 与完整范围；分别记录 RED、GREEN、沿用证据、失败和仍未知项。
- [x] 独立 Spec/Quality 复核固定源码及实际证据，修复 Critical/Important 后只重跑覆盖修正的检查；Linux 的纯 TS/SQLite 验证不代替 Windows 原生证明。
- [x] 根据批准的实际事实一次收口本计划草稿，其他七份 SOP 文稿只保留短状态/链接；不改变 86 项业务与 24 项 worker/部署规格的统计或未获验收状态。
- [ ] 对最终文稿完成 UTF-8、隐私、链接、格式、Docs 类型与独立审核；纯文稿变更不重跑源码测试。本地提交与回读须另有真实回执，不推送、不创建 PR、不部署或重启。

## 7. 后续独立切片

先冻结真实 prepare/AUTH 的原生发送与副作用收尾，再实现 Windows ExecutionAdapter/runner/store 原身份、生命周期和恢复消费。Windows 耐久 Store/目录刷盘及安装后实际服务运行按上节独立待验。图片校验、安装/服务身份、成功传输及 receipt/清理、完整 GPU worker、后台配置与 ZEB 普通完整图分别取证。内部发送许可的完成不能代替这些后续门禁，现有商业/平台就绪和运营矩阵保持。
