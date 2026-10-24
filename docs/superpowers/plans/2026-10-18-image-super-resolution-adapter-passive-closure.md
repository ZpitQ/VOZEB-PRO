# Windows Adapter 接入前置：被动等待原会话闭合

日期：2026-10-18。范围：高清增强 SOP 的 Windows ExecutionAdapter 接线前置片。所定实现与技术验证已完成；固定源码独审、中文本地提交和独立回读按最终交付回执核定。

## 问题与方法

现有控制 host 的 `close()` 会主动关闭会话并触发停止。执行器在授权生效后需要等待原计算自然完成，不能以主动关闭代替等待。

新增 `whenClosed()`，直接复用[原执行桥](2026-10-17-image-super-resolution-execution-bridge.md)的同一个闭合 Promise。调用只观察原生命周期，不启动进程、封存会话、发送关闭或停止命令，也不新增定时器。调用发生在 `open()` 之前时可以保持待定，不影响之后正常打开和检查。主动 `close()` 仍保留原行为，并返回同一个 Promise。

## 验收条件

1. 观察期间没有反向关闭命令或提前 stdin EOF，原会话仍可执行正常检查。
2. 自然 ending 或 Closed 帧、单个进程退出、单边 EOF 均不单独完成等待；沿用原进程退出、真实双 EOF、所有管道 close 和 write/end 回调的完整条件。
3. 重复观察与主动关闭共享原 Promise；清理超时已经结算的 Unknown 不因后来物理闭合升级。
4. 授权 ACK 缺失仍保留原阶段 Unknown；物理闭合不生成 `ExecutionExit`，不释放持久槽或重新授权。
5. 真实 Windows 的既有自然完成案例在授权后直接调用该入口，验证零反向关闭命令与原进程完整收尾。

## 实施与验证记录

先行 RED 实际捕获了等待位置发出的关闭命令，随后才增加被动入口。最终相关 host 与解码测试为 125 passed / 1 平台跳过（126），类型检查与构建通过；新增观察保留原操作准入、原闭合 Promise、完整 join 与 sticky Unknown。

真实 Windows 自然完成补验为 1 passed / 13 名称过滤（14），8.55 秒，外层记录程序也自然退出 0；源码、测试、编译产物与既有原生程序的运行前后哈希一致。实际观察开始早于 ending 和原 child close，未提前关闭 stdin，唯一 prepare/AUTH 完成后没有反向 close 命令；原进程完整收尾与独立严格 journal 的普通成功分别证明。

首轮测试断言通过后，外层测试记录器的额外 stdout 管道未闭合，因此该轮记录器结果保留 Unknown/interrupted，不计作补验通过。补验仅将记录器输出改为直接写独占普通文件；产品原管道与收尾规则不变，底层管道异常原因未作扩大结论。两轮证据分账，不将名称过滤或历史轮次累加为通过。

## 下一步与边界

被动等待只是 Adapter 接入的一个必要接缝。普通和恢复停止的最终发送许可、持久停止时间与 soft/force 语义、stop/deadline 的严格 journal 消费，以及真正的 Adapter 与 runner/store 接线继续独立完成。

本片不改变 native 清理状态机、严格 reader、数据库结构、重试或 readiness。M1 已验收、schema5、增强关闭、readiness=false、worker 尚未接通以及自动降 tile 重试暂缓均为既有边界；本片不代表 GPU 画质、安装服务、Worker/API/ZEB 或 M2 整体验收完成。
