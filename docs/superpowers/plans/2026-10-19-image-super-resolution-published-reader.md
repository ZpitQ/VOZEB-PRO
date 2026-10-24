# 已发布成功产物只读出口：结果下载前置

日期：2026-10-19。模式：ponytail full。

状态：库内实现、所定技术验证与固定源码独审通过；文稿和本地交付按各自回执核定。HTTP 下载、持久接收确认与完整安装验收尚未完成。

关联：[主 SOP](2026-10-10-image-super-resolution-integration-plan.md)、[正式 Worker 入口](2026-10-18-image-super-resolution-worker-bootstrap.md)、[Worker README](../../../workers/image-enhancement/README.md)。

## 1. 本片解决的问题

成功任务已有持久摘要和 durable 产物，但 HTTP result 仍返回 `503/not_ready`。后续下载需要先取得一份经过原验证链核对的图片，不能把任务成功或文件存在直接当作读取权限，也不能读取后重新打开文件路径发送。

本片只补库内 `createArtifacts({ store, files? }).readPublished(principal, jobId, signal)`，返回已验证的 `ValidatedAiArtifact`。复用现有 Store、engine、canonical manifest、完整 PNG 解码与文件读取逻辑，不另造解析器、执行器或产物副本协议。

## 2. 读取与收容合同

1. Store 先验证真实 principal、任务归属、持久 succeeded、匹配的合格成功退出和精确 durable 候选，再派生 publisher。调用方不能传入路径、票据或自定 publisher；当前 ready、模型配置或预算变化不重新定义旧成功任务。
2. 每次请求都有独立 generation 和新的 held recovery 引用，不复用旧 publisher 的在途结果。published 查询事实不等于仍持有读取许可；读取链在每个 await 前后重核 Store、身份、信号、当前 generation、原 publisher/candidate 及本次精确 held 引用。
3. 沿同一原句柄有界读取，验证真实 EOF、长度、engine、canonical manifest、完整 PNG、摘要、尺寸和格式。只返回这次验证得到的同一份字节，不重新开路径、resize、转码、读 raw 修复或触发新计算。
4. 取消或撤权后不得发新读取或交付成功。已发 I/O、迟到 open 和已取得的原句柄须先收容；仅当 Store 仍可用、原句柄确认关闭且本次引用事实明确时，才允许清理这一精确引用。Store 关闭后只收容原资源，不再鉴权、查询或写入数据库。
5. 第一次 close 回执不明时保留 held/Unknown；即使后续资源收容关闭成功，也不能抹掉第一次不明事实或交付图片。release 最多发出一次，抛错后仅读回同一个 key：确定已 released 才可按其余条件继续，仍 held 或读回不明则保守失败，不重放 release。
6. 初始认证、归属和未成功状态保留原错误边界；异步 I/O、完整性或清理不明不回显内部异常。读取失败不改业务 succeeded、不重新执行、不构造 receipt，也不据此删除产物或宣告 410。

旧 settle/recover 分支及 schema5 保持。本片没有新增 HTTP 配置、下载计数、网络响应或原生执行行为。

## 3. 最小改动范围

| 文件                                                        | 改动                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `workers/image-enhancement/src/store.ts`                    | 增加内部、只读的已发布成功 publisher 查询。                         |
| `workers/image-enhancement/src/artifacts.ts`                | 复用原 reader，增加每请求独立的 published-only 读取及精确收容出口。 |
| `workers/image-enhancement/tests/artifact-download.test.ts` | 用真实 SQLite、成功发布前置和受控文件句柄验证新行为。               |

没有新增依赖、schema、raw 回退或执行重试。文件读取逻辑与原完整校验共享，旧恢复权限不因新出口放宽。

## 4. 实际验证，按独立轮次保留

| 轮次            | 实际结果与边界                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage T 类型    | exit/close 0；测试先保持固定缺行为出口。                                                                                                                |
| RED-v1          | 17 failed / 17，6.44 秒。真实成功发布前置已完成，失败来自新读取行为缺失，不是类型或 Store 初始化失败；原失败保留。                                      |
| 最终类型与构建  | 各自 exit/close 0，stdout/stderr 空。                                                                                                                   |
| 新行为 GREEN-v1 | 单文件 17 passed / 17，7.64 秒，无跳过。                                                                                                                |
| 受影响旧回归    | 六文件 80 passed / 80，18.60 秒，无跳过；覆盖 artifacts、artifact-io、artifact-commit、artifact-recovery、artifact-store 与 authorized-recovery-await。 |

各轮独立，不把新 17、旧 80、原 RED 或历史结果相加。测试覆盖同句柄短读/真实 EOF、精确原字节、并发独立引用、旧引用已结束、迟到 open、取消、撤权、Store 关闭、PNG/manifest 损坏或缺失、首次 close 回执不明，以及 release 后 committed/held/readback-unknown。故障只窄注入被观察的 I/O 或提交边界，真实 Store、产物和精确引用仍参与验证。

固定源码独审结论为 Spec compliant / Quality Approved，Critical/Important/Minor=0/0/0；结论覆盖本片库内源码与所说明技术证据。构建通过不等于新 dist 已完成本片独立进程交付验收，源码独审也不代替文稿、提交或部署验收。

## 5. 下一片与验收顺序

1. 先测试独立下载容量配置：新增必填正安全整数 `maxConcurrentDownloads`，不借用上传槽、不静默补默认值，下载总期限沿显式 `requestTimeoutMs`。本片尚未修改此配置。
2. 再用真实 TCP 和受控 I/O 冻结 HTTP result 生命周期，随后接同一个 `readPublished`。认证/归属/真实成功检查先于取槽与读产物；取消或超时先封存并中止。下载槽须等 reader 真实结束与 response finish/close 同时成立才归还，已发图片头后不得再拼 JSON；下载不能唤醒新执行。
3. HTTP 验证同一 PNG 的真实字节、摘要与响应头，并覆盖重复读取、配置变化、权限与归属拒绝、损坏产物、容量、超时、断连及迟到句柄。HTTP result 尚未接线，现有成功 result/receipt 的 `503/not_ready` 不由库内 GREEN 改判。
4. HTTP 交付后单列持久接收 receipt；网络 finish 不等于 ZEB 已验收并永久保存。保留/清理、retention/410、完整离线安装包、实际 SCM/服务账户/Session 0、Store 耐久、GPU/画质、TLS 和 Worker/API/ZEB 继续分别实施与验收。

M1 已获用户验收；schema5、增强关闭、readiness=false、worker 未接与自动 OOM 降 tile 重试暂缓保持。本片没有完整可验收安装包，也没有完整超分业务链路就绪结论。

未重复未变的 Clock、native、宿主、GPU 或浏览器矩阵；主要剩余风险是尚未验证的网络资源生命周期、持久接收确认与实际服务/GPU 接线。
