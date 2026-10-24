# 图像超分：停止请求最后发送许可

本片补齐 runner/store 到 test ExecutionAdapter 的停止控制前置合同。任务的取消意图已经持久化，但 Adapter 排队之后仍可能丢失控制权；仅在方法调用前检查一次，无法阻止迟到的停止发送。

本片不是原生停止协议、Windows ExecutionAdapter 或增强业务上线。当前 `kind` 仍为 `test`；M1 已验收、schema5、增强关闭、readiness=false、worker 未接以及自动降 tile 重试暂缓的产品边界保持。

## 实施范围

- `requestStop` 传递冻结的 `ExecutionStopRequest` 和既有 `ExecutionSendGuard`。请求包含 `mode`、首次持久 `stopRequestedAt` 与 `terminateAfterAt`；排队、恢复和重复唤醒都不能重开宽限。
- 普通停止最终资格核当前身份、槽、票据、descriptor、prepared/authorized、有效租约、原停止时间及未封存/退出。已超过执行截止仍可合法停止；不能复用拒绝 stop/deadline 的启动资格。
- 恢复停止核当前控制记录、Store incarnation、原 producer、publisher、票据、槽及 owned-alive 分类。已过期的 producer 租约不阻止合格恢复；控制权替换后旧请求必须失效。
- 两种资格读取均只读，不续租、写停止意图、变更恢复分类或重新计算时间。完成参数验证及可重入 clock 回调后，先再查 Store 是否关闭，再读取最终 SQL；最终行读取后不调用传入 getter。
- 复用原单次 guard，并在可重入前后核 runner holder、原 Store 与恢复状态。第一次拒绝也消费许可；soft/force 独立，force 仅在严格超过 `terminateAfterAt` 后合法。
- 保持每个 mode 最多一次尝试。在 runner 观察到 Adapter 返回 Promise 的兑现/拒绝或同步抛出时封存未消费 guard；未知返回、异常、挂起及 ACK 都不能生成退出证据、取消终态或释放槽。

SQLite 资格快照和实际 IPC 发送不是同一个原子事务。Adapter 必须在最后等待之后、同一同步发送片中消费许可；本片测试发送只证明该接缝，不证明 native pipe/GPU 已接通。

## 验收记录

| 验证                           | 实际状态        | 范围                                                                                                                                             |
| ------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| tests-only RED                 | 已取得          | 隔离 Linux 副本的两项真实 Store/runner 场景；runner 关闭、恢复 control 被替换后，旧代码各发送一次，预期为零；两个失败均到达最终发送断言。        |
| 最小实现与 focused GREEN       | 已通过          | 隔离 Linux 单文件 39 项通过、无跳过或失败，32.25 秒；包含两项原行为复现及普通/恢复权限、首次时间、force 边界、单次消费、重入和 settlement 封存。 |
| 类型检查与声明构建             | 已通过          | 两项实际退出码均为 0，stdout/stderr 空，128 份 worker 源文件前后哈希一致。                                                                       |
| 受影响回归                     | 已通过          | 独立 Linux 轮次的 9 个实际 runner 消费套件、178 项通过，无跳过或失败，151.69 秒；原 prepare/AUTH、恢复、产物与 HTTP 路径保持。                   |
| 固定候选独立 Spec/Quality 审查 | 按独立报告核定  | 审查精确候选的源码、原始结果、夹具边界与文稿，不用作者结论代替审查。                                                                             |
| 中文本地提交与独立回读         | 按 Git 回读核定 | 核精确 tree、全部变更/worker 哈希、clean 和索引；本地交付不代表推送或部署。                                                                      |

测试使用实际 SQLite/Store、job service、runner、手控时钟及 deferred 发送队列，分别观察到达、synthetic send 与原调用结算。RED 中缺 guard 的旧调用仅在测试边界保持旧发送行为，避免用缺 API、类型错误或参数存在断言冒充行为复现。失败与后续通过按原轮次保留，不相加为一次成功。

本轮 GREEN 已覆盖普通 lease 等于/超过和续租读取、原 Store/runner 关闭或替换、恢复 producer 租约失效仍合法、控制权和绑定不匹配拒绝、force 等于/+1、独立单次与首拒消费、未消费 guard 的三种结算封存，以及停止确认不改变槽/授权/终态；权限检查没有改变持久状态。focused 和回归是两个独立轮次，不合并为一次通过统计。全量测试类型检查覆盖夹具签名，回归只选择实际 runner 调用路径，没有重复仅导入工具的套件或无关 UI、手机与原生矩阵。

历史持久收敛夹具存在刻意不遵守最后发送权限的测试模型；只迁移签名并明确边界，不能把它计作本片停止权限或真实 Windows 证明。新合同以符合 guard 的确定性发送边界验收。

## 下一阶段的关键点

1. 原 `close()` 会封存并结束 stdin；之后无法完成 native 请求发送许可的交互。业务停止不能通过给 close 加 guard 实现。
2. 既有 bare `stop` 同时服务物理清理和 observer 控制，必须保留兼容。下一片新增独立业务停止操作，绑定原 owner、完整 target/descriptor/fingerprint、durable pair 和原 permit 通道。
3. 迟到 soft 不能按接收时刻重开 grace；force 应唤醒同一原清理等待，由原 Job 统一执行至多一次终止。已有 deadline/loss 清理不能被更晚请求延长。不能在 TS 杀 helper，不能按 descriptor PID/Job 名重新取得 owner。
4. 严格消费 stop/deadline terminal 证据、真正 Windows Adapter/runner/store 接线、GPU/图片、安装/服务身份和 Worker/API/ZEB 分别验收。ACK、helper0、snapshot 和物理 Closed 都不代替业务 ExecutionExit。

现有 todo/pending-test 的业务就绪事项继续保持待验，本片没有新增可由页面验收的部署功能。详细内部切片由本计划记录，功能说明与 production-readiness 不升级。
