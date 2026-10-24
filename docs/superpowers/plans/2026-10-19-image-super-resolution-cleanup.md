# 成功结果退役与精确清理切片

## 当前状态与目标

本片接续[只读保留资格](2026-10-19-image-super-resolution-retention.md)和[持久接收确认](2026-10-19-image-super-resolution-receipt.md)，实现认证单 job 的持久退役围栏、仅原选中候选两个 final 文件的清理，以及[原下载路由](2026-10-19-image-super-resolution-http-result.md)的 410。实现、所定技术验证与 Task1/Task2 两个固定源码门禁均已完成，Spec compliant / Quality Approved，Critical/Important/Minor=0/0/0。

文稿、隐私、联合审、整体固定交付、服务器中文本地提交及独立回读各门禁分别按最终实际回执核定。源码批准只覆盖本片内核与所定证据，不代替文稿、隐私、交付、提交及独立回读，也不表示增强业务可用。

## 退役资格与共享围栏

每次由当前认证 principal 显式指定一个 job 和正安全整数 retentionMs，不提供生产默认值。期限从原真实成功 completedAt 起算，安全整数加法溢出拒绝；等于 retainUntil 满足期限，clock 早于原 receipt.receivedAt 仍须保留。前片只读八字段资格快照仍用于说明状态，本身不是删除权、锁或资源持有。

独立 immediate 写事务重新核归属、原真实 succeeded/选中 candidate/attempt、同一原 receipt、保留期限与同 job/attempt 的全部 released_at IS NULL 引用。旧 incarnation、run/recovery、NULL 或另一 candidate 的未释放引用均阻挡，不能只数当前 reader。同步外部 clock/signal 回调收口后重新核当前 Store、身份与事务边界；既有外层事务不进入退役写入。

只有资格满足才写入不可撤销的退役行。新 published-read acquire 在最后一次外部 clock 返回后、INSERT 引用之前核持久围栏，从而阻止新下载进入；共享的原成功事实查询仍供 GET job、同键 submit 和 receipt 使用。围栏不改写原成功结果、收据或执行历史。

## schema7 与一次清理许可

schema7 仅新增 `result_retirements` 六列：job_id、candidate_id、attempt_no、retention_ms、retired_at、cleaned_at。job_id 为主键并外键绑定原 result_receipts，candidate/job/attempt 复合外键指向原候选；安全整数及时间顺序约束持续生效。退役绑定不可改写、行不可删除，只有 cleaned_at 可从 NULL 单次前进且不得早于 retired_at。完整表说明见[数据库结构](../../content/docs/backend/backend-database.mdx)。

新鲜初始化写入版本 7；普通 open 精确要求 7，并探测收据表及退役表全部必要列。旧6、其他未知版本、缺必要表/列的伪7均拒绝，拒绝路径不新增 incarnation，不迁移、补表、删除或覆盖。此处是代码契约，没有发生实际数据库迁移或升级。

首次正常顶层退役 COMMIT 返回后，才创建冻结的真实 work 并登记在当前 Store，绑定原 principal、持久退役行、精确 candidate、两个 final 路径与候选目录。复制对象、跨 Store、重开、撤权、关闭或 abort 不能取得许可。若退役 INSERT/COMMIT 失败或真实提交后丢确认，当次异常按原 Store 错误拒绝，不追读后补发 work，也不开始文件清理；持久行若已存在，后续仍只读其事实。

已有退役行保留原 retentionMs 与时间，返回 work:null。已有 pending、并发第二调用或重开均不能补发许可；原行已 complete 时只返回原事实。这里没有恢复领取、租约续期或重新清理协议。

## 精确清理与不确定结果

持有真实一次 work 的调用按以下顺序执行，每个 await 前后用同一 work/signal 重核权限，已经发出的 I/O 必须等到 settle：

1. unlink 原选中 candidate 的 final PNG。
2. unlink 同一 candidate 的 final manifest。
3. 同步原候选目录并确认目录句柄关闭。
4. 再核许可，才提交 cleaned_at 并返回 complete。

只使用原 work 中已绑定的路径，不重建路径、不递归、不 rmdir，也不回收父目录。候选空目录、原件、engine/raw output、part、其他 candidate 和全部历史元数据保留；job/attempt/result/receipt 不被删除或改写。

I/O、目录 guard、认证、Store、signal 或 complete 发生异常/确认丢失时，停止后续并返回 pending；已发出的操作仍按原 helper 收容。pending 表示退役已持久、物理清理结果未完成或未知，不能据此声称两个文件已删完。后续调用不再 unlink 或 complete，恢复清理治理另片。

目录 sync 的 guard 必须直接传播原 assert 异常。一次瞬时错误即使随后许可恢复，也不能吞成 false、跳过 sync，再由外层下一次 assert 追认 complete；已打开目录句柄仍由原 finally 等待关闭。complete 真实 COMMIT 后外层丢确认时，当次仍 pending，不在 catch 中追加 fact read 追认成功；后续调用只读原行可返回 complete，且不重复删除或 complete。

## 原下载路由的结果

| 情况                                                 | 本片行为                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 认证后确认原成功结果已真实持久退役，含 pending       | 新 result 下载返回 `410/result_gone`；“增强结果已按保留规则停止提供，无法再次下载。” |
| 普通缺文件、坏图、close 不明或其他未知失败           | 继续按原读链返回 503，不能从 ENOENT 或内容错误推断退役                               |
| 原成功 GET job、合法同键 submit、原 receipt 精确重放 | 保留原成功事实与幂等行为；submit 仍202且 replayed:true，不改为200                    |
| 退役前已捕获完整 Buffer、句柄已关且引用已释放的响应  | 可继续以200发送原字节；新请求按真实围栏410                                           |
| reader 已结束但旧响应仍在发送                        | 下载槽继续持有，直到 reader 与 response finish/close 双完成                          |

认证失效401、未知或其他 client 任务404、非成功 result/receipt409 的原优先级保留。没有新远程清理路由，没有取消后重开路径发送、raw 修复、补像素或重算。网络 finish 不产生 receipt，也不证明远端永久存储；receipt 仍仅持久保存认证客户端的保存声明。

## 实施与门禁

| 阶段                                               | 当前结论                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| Task1：schema7、退役/一次 work、完成事实与新读围栏 | 实现及所定技术验证完成；新版固定源码复审 compliant / Approved，0/0/0 |
| Task2：原两个 final 清理、目录收口与原下载410      | 实现及所定技术验证完成；最终固定源码独审 compliant / Approved，0/0/0 |
| Task3：七份文稿及公开隐私/最终联合审               | 七份候选文稿已编写；文稿、隐私与联合审按独立实际回执核定             |
| 整体固定交付、服务器中文本地提交与独立回读         | 按独立实际回执核定；源码批准或工具准备不代替实际交付、提交及回读     |

Task1 末次复审关闭的是测试注入时点的唯一 Minor，产品逻辑未改；Task2 仅在 artifacts/contracts 与必要 fixture/新测试中增量，不新增依赖、生产配置或调度。历史源码审查与每轮测试保留原身份，以下是本片详细证据的单一记录。

## Task1 独立分轮证据

| 独立轮次                    | 实际结果                                      | 范围与解释                                                                                     |
| --------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Stage T 类型                | exit/close0                                   | 原空输出，输入不变                                                                             |
| Stage T RED                 | 55 failed / 55；总14.57秒，tests12.553秒      | throw-only/预期错误码或 clock 未调用、明确schema6≠7；不是模块或SQLite前置失败                  |
| Store P v1 类型与独立 build | 各exit/close0                                 | 两个独立命令，输出为空，输入不变                                                               |
| Store P v1 新测试           | 55 passed / 55；总19.04秒，tests16.21秒       | 原固定第一版的新测试，不改写为v2轮                                                             |
| Store P v1 旧四文件回归     | 126 passed / 126；总10.97秒，tests累计27.06秒 | 旧测试及产品在v2保持原字节；沿用原轮，不称v2重跑                                               |
| 首次 clock 受控对照         | 1 passed / 54名称过滤；总3.12秒               | “两次clock”修正仍不能抓到错误顺序，既不是有效失败反例，也不是55通过                            |
| 最终 clock 受控负例         | 1 failed / 54名称过滤；总2.92秒，单例429毫秒  | 将最后clock移到围栏后，目标断言因未抛result_gone而失败；仅证明测试有效，不是正式产品候选或交付 |
| Store P v2 类型             | exit/close0                                   | 正式新版，输出为空，输入不变                                                                   |
| Store P v2 完整新测试       | 55 passed / 55；总22.80秒，tests19.74秒       | 只在第三次 acquisition clock 注入真实退役并断言计数3；无名称过滤                               |

首次源码独审为 compliant / Approved、0/0/1；Minor 是用例在过早 clock 注入，不能识别围栏前移。第一次受控对照证明“两次clock”修正仍不足，最终第三次注入与有效负例关闭该缺口。v2 相对 v1 只有新测试字节变化；新版55与类型检查是新轮，build0及126旧回归沿产品/旧测试未变的v1原轮。最终定点复审为 compliant / Approved、0/0/0，不将原 Minor 或无效对照改判。

## Task2 独立分轮证据

| 独立轮次             | 实际结果                                               | 范围与解释                                                                                                                              |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Stage T 类型         | exit/close0                                            | 输入不变，完整stdout/stderr空                                                                                                           |
| 原 Stage T RED       | 31 failed / 31；总11.59秒，tests累计10.62秒            | cleanup28与HTTP3；缺行为、预期410实际503或退役/commit未发生，无过滤/skip                                                                |
| Guard 增量类型       | exit/close0                                            | 原31断言保持，只追加一个guard反例，完整输出空                                                                                           |
| Guard RED            | 30 passed / 2 failed / 32；总12.07秒，tests累计11.27秒 | 一项真实guard缺口：预期pending实际complete；另一项是新HTTP测试误期望200，而原submit契约为202                                            |
| HTTP 独立控制        | 3 passed / 3；总3.91秒，tests1.71秒                    | 仅修期望202并加replayed:true，保留同job/facts；原HTTP产品未改，控制树仍有guard缺口，不是完整32通过或交付源                              |
| 最终类型与独立 build | 各exit/close0                                          | 完整stdout/stderr空，输入不变                                                                                                           |
| 最终两个新文件       | 32 passed / 32；总13.49秒，tests12.75秒                | 移除吞guard异常的catchfalse，原目录finally继续关闭；没有名称过滤或skip，stderr空                                                        |
| 最终定点旧六文件回归 | 57 passed / 57；总10.49秒，tests累计19.43秒            | artifact-download、http-result、http-artifacts、http-download-lifecycle、http-receipt、directory-durability；无名称过滤或skip，stderr空 |

最终四轮的输入身份均不变，源码独审核过原完整输出、最终 receipt 与六处增量摘要；types/build 空输出、两轮测试 stderr 空。

guard 反例标记真实 guard 回调、先委托原 Store assert 后只丢一次确认，并证明许可随后恢复；原 RED 精确暴露“跳过sync却complete”，最终32通过包含此例。HTTP 200→202 是测试合同纠正，不能为迎合测试改原产品。原31 RED、guard30/2、HTTP3控制、最终32与旧57彼此独立，也不与Task1或前片测试相加；并行tests累计时长不是墙钟总耗时。

## 仍未验证与后续切片

本片只覆盖显式单 job 的内核技术合同。没有默认保留时长、批量扫描、调度、远程清理路由、pending 恢复治理或历史元数据清除。TC1 成功后60秒仅为受控clock测试，不是生产默认；清理后元数据120秒不在本片，全部历史元数据继续保留。

原目录 helper 的旧回归不等于掉电或磁盘故障恢复；guard 反例只针对一次确认丢失，不宣称枚举底层全部故障。authorized-recovery fixture 只有接口透传，由最终完整类型检查覆盖，本轮没有重跑其原生矩阵；未重跑已结案的 Task1/上游/native/GPU/browser/手机矩阵。controlled reopen 不作真实进程崩溃证明。

物理结果清理与本片内核验收不代表完整 Windows 离线安装包、SCM、Session 0、服务身份/Store耐久、GPU/真实图片、TLS、实际永久保存客户端或 WorkerAPI/ZEB 接线就绪。这些继续独立取证，增强 off、readiness=false、worker 未接和自动 OOM 降 tile 暂缓保持。整体接入边界见[主 SOP](2026-10-10-image-super-resolution-integration-plan.md)，未完成项保留于[待测试](../../content/docs/progress/pending-test.mdx)和[TODO](../../content/docs/progress/todo.mdx)。
