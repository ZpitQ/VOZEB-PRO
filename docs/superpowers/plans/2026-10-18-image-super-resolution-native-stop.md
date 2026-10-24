# 图像超分：原生业务停止

本切片接通 Windows Host → 原控制桥 → 原生会话的业务停止，为后续取消任务和执行超时提供停止通道。已完成本片内部实现、所定定向技术验证和固定源码/实际证据独立复审；文稿、本地提交及回读按各自最终回执核定。完整增强链路的阶段安排见[主 SOP](2026-10-10-image-super-resolution-integration-plan.md)。

## 范围与合同

业务停止使用独立 `request-stop`。原 bare `stop`、observer、主动关闭、EOF 和控制链路失联继续使用各自语义。新请求复用原 owner、Writer、permit、Pending、Job 和 cleanup。

Host 入口为 `requestStop(target, descriptor, request, guard)`，成功响应为 `{ kind: "stop-requested" }`。只有原 prepare/AUTH 已成功，原 owner/controller、完整 target/descriptor、安装与引擎绑定、requestFingerprint 一致，且原 resume succeeded、没有 Unknown/terminal 时才可执行。未授权或非法请求不固定业务时间或新增停止预算。

command 精确携带 `v/kind/requestId/op/executionId/target/descriptor/requestFingerprint/mode/stopRequestedAt/terminateAfterAt`；native frame 仅去掉 kind。permit 与 ACK 均关联原 requestId，不能挪用另一个请求的许可或写入回执。

## 两个有限请求与原期限

同一 binding 与时间对下，soft、force 各保留一个原 operation/Promise。相同 mode 重入返回原 Promise，完成后也不重发或更换 guard。冲突失败关闭。

原 owner Writer 包含最后许可和 native write，写完释放；ACK 在 Writer 外等待。因此 soft ACK 尚未返回时，force 仍可通过自己的单次许可发送。command write、permit write、许可和同 ID state 都成立后才返回 stop-requested。

所有仍 pending 的原 request deadline 都须同步检查，包括较早的 inspect。到期比较为 `>=`，覆盖准入、current/permission 回调后、发布和最后写入边界；计时器回调迟到也不能续期。Bridge 保存 inspect 原准入处的同一个 anchor，不能用 ACK 时提前移除的 Pending 记录推断整个请求已结束。

close/ending/fault 恰一次结算业务 pending、清理其 timer/listener，缓存 Unknown；迟到 ACK 或物理 join 不得翻转。原 inspect 可能在资源完整 join 后才得到 Unknown/closed，业务槽则可先固定 Unknown/unknown。

## 固定时间与唯一清理

`S=stopRequestedAt`、`T=terminateAfterAt` 使用规范非负安全整数，T>S、T-S 等于原 cancelGrace，首次 S 不晚于 native wallNow。显式 force 必须 wallNow>T，等号拒绝；合法 force-first 后的 soft 不得延长截止。

首次合法请求相邻采样原 tick、wall，只映射一次 `businessDueTick=tick+max(0,T-wallNow+1)`。首次业务请求建立 stop 原因时直接使用此 due；已有 stop/deadline/loss 时保留原 cause/causeTick，并与原截止取早。重复不重新映射，后续更新只压早。

继续使用原 WaitGraceOrTreeAsync、Timer 和同一 cleanup；更新 due 与 timing generation 在原 gate 下提交，异步通知避免 lost-wake。请求线程不执行第二次 Force。原 cleanup 复核 tree 后，仍只调用原 Job Force 一次，再收齐原 tree0、双 EOF、stdio 和进程 joins。

tick/wall 相邻采样不是原子采样。`+1` 不保证任意墙钟跳变或调度下，物理 Force 的 wall 时间也严格晚于 T；显式 force 准入与自动单调清理分别验收。

## 证据与结果的区别

stop-requested、state、helper exit0、Host closed 和 physical joins 都不是 ExecutionExit。缺 ACK 的业务 Promise 保持 Unknown；正常传输收尾仍可以是 stopped/closed、原 bridge exit0，二者分别核验。

真实 Node 三场景须直接核原 closeResult、close-return/return 时的进程和流事实、原 Node/bridge exit0，以及独立回读的 private native stop 终态、scope/descriptor/AUTH/engine/job 绑定和 tree0/双 EOF。owner loss 后的新业务请求只能拒绝，最终原 AUTH→controller-loss→interrupted 链仍须成立。

本片没有接入 strict TS stop/deadline 终态消费者或正式 ExecutionAdapter；直接断言 private native journal 不替代这些后续接缝。

## Windows 测试窗口

测试门仅存在于测试构建，普通构建不携带。A 在 soft 成功并固定原响应后、enqueue 前；B 在原唯一 Force 前。两门使用独立 reader/nonce/release，直接使用原外层 fixture deadline，不借已归零 grace 增加预算。锁外等待 A，原 operationTasks join 后才释放门资源；产品 cleanup 不等待 ACK。

主窗口为 A held → B reached 且树活 → wall>T → force 独立 permit/write/ACK → soft 仍 pending → 按场景释放 A/B → 原唯一 Force 与真实 joins。缺 ACK 场景先释放 B，soft Unknown 不因后来回执翻转。

该窗口证明发送、关联和唯一 Force。等待更新另以既有 deadline 成立后的 `GraceWaiting` 注册点验证：原 due/generation 已捕获且 Timer 已 arm，再提交更早 soft/force，确认旧期限不续期、更新不丢失。该注册点不声称系统已阻塞在 `await`。

## 实际验证

各轮独立计数，过滤和平台跳过不算通过；构建不算测试。

| 独立轮次               | 实际结果                                     | 边界                                                                                                       |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| wire RED-v2            | 1 failed / 14 名称过滤，13.19s               | 原 AUTH/running 后完整新 op 被旧 parser 拒绝；只证明 wire 缺口。                                           |
| inspect RED-v2         | 6 failed / 148 未执行，2.17s                 | soft/force 各在准入、current、permission 越过原 inspect 期限，实际多发 command 或 allow permit。           |
| R2 Host / decoder      | 153 passed / 1 平台跳过，2.53s               | 六个 inspect 回归转绿，双 mode、许可关联、Unknown 和旧 Host 语义。                                         |
| R2 类型与构建          | types、build、受影响 bridge publish 均 exit0 | 未变化的 ordinary/test-supervisor/fixture 复用已验证运行件；新 bridge 依赖的普通 supervisor DLL 哈希一致。 |
| R2 Windows bridge 覆盖 | 12 passed / 6 名称过滤，102.93s              | 新 wire/三个 Node stop、原 prepare、四个 raw 交错、natural/deny-auth/missing-ACK。                         |
| R2 native session 覆盖 | 9 passed / 86 未执行，79.35s                 | durable、force-first、拒绝、deadline 更新、loss 与旧 stop/deadline 回归。                                  |
| 独立源码与实际证据审查 | Spec / Quality 均通过，C/I/M 为 0/0/0        | H1/F1/F2 已关闭；独立读取原回执、日志和证据，未重跑测试。文稿及本地交付另行收口。                          |

测试准备中的历史 matcher 错误与 inspect 清理断言错误轮次独立保留，均不计为相应有效行为 RED。初轮较弱 Node 断言通过也不替代收紧后的实际验证。

R2 冻结完整 worker 源码 128 文件；manifest SHA256 为 `9a1e04257bdcc6571110bcc0ca63d2c672e09e2df79043460077fcf8c304bc6d`。每个实际 OS spec 另固定 51 个 dist、Node 与完整 778 个 native 运行件，合计 958 inputs，并核验运行前后哈希。旧轮 dist/runner 在后续 build 前独立保全，不覆盖历史运行事实。

## 下一阶段

先完成 strict stop/deadline 终态消费与正式 Adapter/runner/store 接线，再分别验收真实 GPU/图片、Windows 安装与服务身份、Worker/API/ZEB 完整链路。用户与实际部署验收独立记录，本片不代表完整 M2 或超分已上线。
