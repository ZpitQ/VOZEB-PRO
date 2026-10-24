# 成功结果保留资格：只读快照计划

本片已实现认证单job的同步只读一致事务资格查询，返回八字段冻结快照；所定新行为、types/build与定点旧回归已独立完成，固定源码独审Spec compliant / Quality Approved、C/I/M=0/0/0。公开文稿/隐私门禁与服务器本地交付仍待各自实际回执，不预填这些后续成功。

## 1. 本片目标与范围

既有成功 PNG 下载与持久 receipt 已完成。本片实现仅为**认证单 job 的同步、事务一致只读资格查询**，解释原收据、显式保留期和全部保护引用是否同时满足。接口放在现 `workers/image-enhancement/src/store.ts`，不拆新通用模块。

不删除、退役或改写结果，不产生410；不新增数据库表/字段、schema版本、HTTP路由、批量扫描、自动调度或生产默认保留期。schema保持6，数据库结构文稿没有新增字段需要同步。原下载、同键replay、receipt首次/重放、HTTP状态与既有九字段transport预算保持原合同。

快照不是删除许可、锁、租约或永久事实。查询返回后可出现新下载引用；实际物理清理必须在后续独立写事务围栏中重核三条件并阻止新下载竞态，本片不能代替该围栏。

## 2. 同步接口与八字段

```ts
export type ResultRetentionInspection = Readonly<{
  serviceId: string;
  jobId: string;
  state:
    | "awaiting_receipt"
    | "retention_pending"
    | "reference_held"
    | "eligible";
  checkedAt: number;
  retentionMs: number;
  retainUntil: number;
  receivedAt: number | null;
  heldReferences: number;
}>;

inspectResultRetention(
  principal: AuthenticatedClient,
  jobId: string,
  retentionMs: number,
  signal?: AbortSignal,
): ResultRetentionInspection;
```

返回值Object.freeze，恰八字段且只有primitive/null；不返回client、candidate/attempt对象、路径、token、输入对象或artifact grant。四态均返回真实heldReferences、retainUntil和原receivedAt/null，不因当前阻挡原因省略其他事实。

| 字段           | 固定含义                                   |
| -------------- | ------------------------------------------ |
| serviceId      | 当前Store稳定服务身份                      |
| jobId          | 当前认证principal所拥有的原成功job         |
| state          | 按§5优先级解释本次一致快照                 |
| checkedAt      | 本次唯一合法Store clock值                  |
| retentionMs    | 本次调用显式传入的保留时长                 |
| retainUntil    | 原成功completedAt + retentionMs            |
| receivedAt     | 原持久receipt时间；没有收据时null          |
| heldReferences | 原selected job/attempt全部未释放精确引用数 |

## 3. 参数、时间与错误合同

retentionMs每次调用显式必填，为正安全整数，无默认值、无配置回退。非法值、零、负数、小数、NaN、Infinity、非number以及completedAt+retentionMs安全整数溢出均为400/invalid_request。

保留期只从真实成功job.completedAt起算；retainUntil恰为其与retentionMs的和，checkedAt等于retainUntil即满足期限。延迟receipt不把起点改成receivedAt；receivedAt取原记录不改写。checkedAt早于receivedAt表示clock回退，即使结果期限已到仍retention_pending。

clock沿现Store.now()合法安全整数合同，只取一次，不自造时间来源。TC1“成功后60秒”只作可控clock用例值，不是生产默认；清理后元数据120秒属于后续范围，本片不实现其保留、退役或清理。

| 情况                                   | 固定拒绝                                        |
| -------------------------------------- | ----------------------------------------------- |
| 未认证或已撤权                         | 401                                             |
| 未知job或其他client任务                | 404                                             |
| 非真实succeeded                        | 409/result_not_ready                            |
| closed、已有外层事务、SQLite读取错误   | 503/internal_error                              |
| 已abort、非法retentionMs或加法溢出     | 400/invalid_request                             |
| 已有receipt错绑定、必要字段/时间不合法 | 503/internal_error，不能降为无receipt或eligible |

错误固定脱敏，异常不启动新执行或产物文件I/O。非法内部成功链沿原完整性校验处理，不从目录/文件存在猜成功。

## 4. 权限、快照与只读边界

先验证closed、已有外层事务、abort及retentionMs；初次signal getter返回后也再核closed/外层事务，已有或该回调新开的外层事务均须在clock之前拒绝。之后只取一次合法clock；外部clock/signal的同步回调全部收口后，重新核closed/abort与当前principal，并在开始自身事务前再次拒绝新出现的外层事务。

随后才读取同一真实一致只读事务快照。事务中不调用新外部回调或clock；不能携入口旧principal跨过同步撤权，也不能隐式加入尚未提交外层事务，向调用方交付“已接收”或“可清理”的状态。

复用getOwned与getPublishedResultPublisher/#publishedArtifactAttempt/#publishedCandidate等原资格链，核真实成功及selected candidate/attempt，保持原内部数据完整性校验。查询result_receipts的原job行；有收据时核client/candidate/attempt与selected成功结果一致，received_at合法。不完整或错绑定为内部503。

方法不读图、不创建/释放引用、不wake，不改job、attempt、candidate、receipt、slot、recovery等事实。重复调用只是新的只读解释，不获得artifact访问grant，也不改变收据重放的原receivedAt。

## 5. 全引用与四态优先级

直接按selected job/attempt查询artifact_references中全部released_at IS NULL的精确数量，不能只用readArtifactReference(retired)或当前实例视角代替。

必须计入：

- 所有incarnation，包括旧Store留下的真实持久未释放引用；
- run和recovery purpose；
- candidate_id为NULL或指向另一candidate的同job/attempt保护引用。

其他job或其他attempt的引用不计入；已release引用不计入。HTTP并发槽、lease/目录年龄、当前incarnation或clock经过不能替代引用事实；新Store不能假释放旧key，未知旧引用不按TTL消除。

| 优先级 | 事实                                                         | state             |
| ------ | ------------------------------------------------------------ | ----------------- |
| 1      | 没有原持久receipt，即使期限已经到                            | awaiting_receipt  |
| 2      | 有receipt，但checkedAt < retainUntil或checkedAt < receivedAt | retention_pending |
| 3      | 前两条件满足，heldReferences > 0                             | reference_held    |
| 4      | 有合法receipt、期限满足且全部精确引用已release               | eligible          |

无论返回何态，八字段都来自同次事务一致快照。eligible仅说明checkedAt时的本次事实；之后新增下载引用会改变资格。它不授权删除、不提供排他保护、不产生410。

## 6. Stage T、实现路径与最小测试

本片先固定类型与throw-only接缝及真实SQLite测试，经唯一T类型检查与有效行为RED后实现P；P未改固定测试，最终types/build、GREEN及定点旧回归按各自原轮读取。没有以编译/导入/SQLite捕获或到达前fixture错误代替RED。

| 独立轮          | Root已核实际结果                                                             | 边界                                                                              |
| --------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Stage T types   | exit/close0，166 inputs不变，完整stdout/stderr空                             | 仅类型有效，不证明行为完成                                                        |
| 原行为RED       | 17项15 failed / 2 passed，测试6.424秒，总9.06秒                              | 15失败均为缺实现桩的正向/错误码/clock差异；两internal_error守卫通过不代作功能实现 |
| 最终types/build | 各exit0，166 inputs不变，完整日志空                                          | 固定P来源，测试保持T字节                                                          |
| 新行为GREEN     | 17 passed / 17，总9.45秒，测试7.01秒                                         | 独立有效通过轮，原RED保留                                                         |
| 定点旧回归      | receipt-store与artifact-download两文件34/34，总9.78秒，无跳过/错误、stderr空 | 测试时长13.52秒为并行累计，不能写成墙钟总耗时                                     |

各轮不相加；既有receipt及更早历史结果保持各自原件，不冒称本片重跑或计入本片通过。

| 路径                                                                                                             | 本片职责                                                            |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| workers/image-enhancement/src/store.ts                                                                           | 唯一新类型、同步只读inspectResultRetention                          |
| workers/image-enhancement/tests/result-retention.test.ts                                                         | 真实SQLite/已发布PNG的固定合同测试                                  |
| workers/image-enhancement/tests/receipt-store.test.ts、workers/image-enhancement/tests/artifact-download.test.ts | 本片已完成的两文件定点旧回归，原断言保持；34/34单列，不扩展HTTP矩阵 |
| worker README、CHANGELOG、TODO、pending-test、主SOP、本计划                                                      | 当前合同与实际分轮、八字段、时间/引用及后续边界                     |

测试用既有artifactFixture/publishedArtifactControl和真实SQLite、合格已发布PNG，不mock数据库；等价非法参数复用最小fixture，避免每个值重复昂贵发布。

| 测试组           | 固定合同与证据边界                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DTO与时间        | 八字段精确/冻结/primitive，显式时长与不同调用值；无receipt即使晚于期限仍awaiting_receipt；receipt存在时期限前、等号、之后；延迟收据仍completedAt起算，clock早于receivedAt保留 |
| 全引用           | 当前真实held recovery阻挡，精确release后eligible；多引用只release一条仍阻挡；旧incarnation真实未释放行及NULL candidate阻挡，其他job/attempt不阻挡                             |
| 无副作用         | 重复检查不新增artifact I/O/ref，不改job/attempt/candidate/receipt/slot/recovery；原成功摘要、同键replay与receipt重放保持                                                      |
| 权限与取消       | 归属、认证、非成功、closed、abort；clock同步撤权/关闭/abort、最后signal getter同步撤权；已有事务在clock之前及自身事务前拒绝                                                   |
| 参数与内部完整性 | retentionMs非法类型/非正/非安全整数/加法溢出；合法schema错绑定receipt实际拒绝503；非法received_at构造由schema拒绝，不称inspector读到该值或给出eligible                        |
| fixture证据边界  | 前后snapshot从数据库文件副本读取，不重开活Store；controlled reopen验证旧incarnation持久引用，不称真实崩溃；不能假释放旧Store key                                              |

TC1可控clock例：retainUntil = completedAt + 60_000；有receipt且无held ref时，在retainUntil-1为retention_pending，等于retainUntil为eligible。延迟receipt不得延长该completedAt起算期限；clock早于receivedAt仍retention_pending。此例不是配置默认，也不引入元数据120秒清理。

错误receipt绑定已在保持公共schema约束的真实SQLite fixture中合法构造，并由方法实际拒绝503；非法received_at构造被schema阻止，未让inspector读到该非法值，不把17/17冒称为这一不可达读取分支已执行。测试没有破坏schema约束或篡改断言伪造覆盖。前后数据库snapshot读取文件副本，不重开活Store；辅助副本读取与产品方法的产物I/O/状态副作用分开解释。controlled reopen仅是受控重开，不能称真实进程崩溃。

## 7. 验收、证据与后续

本片实现、所定技术验证与固定源码独审已完成，Spec compliant / Quality Approved，Critical/Important/Minor=0/0/0。公开文稿/隐私门禁与服务器本地交付仍待各自实际回执，不预填这些后续成功。Root独占执行、format、types/build/test、哈希、Git、SSH和CodeGraph；作者仅提供独立文稿与报告。所定新行为和必要旧回归按上表分轮完成；后续公开文稿与隐私门禁、服务器开发分支中文本地交付及新连接回读，按各自实际回执收口，不预填文稿批准或提交。

本片无HTTP/UI变化，不扩展浏览器、手机、native/宿主/GPU矩阵；schema保持6，无数据库结构增量。公开新增内容仅用通用协议与仓库相对路径，不含真实部署路径/域名/IP/账号/会话/凭据或本机环境维护细节。

后续物理清理、持久退役围栏和410须独立合同与验证。实际客户端永久保存未接，receipt仅为认证客户端声明，不是远端ZEB持久存储证明；原成功PNG的五字段不得被下采样派生图替换。完整离线包、SCM/Session0/实际服务账户、Windows Store耐久、GPU/画质、TLS/API/ZEB与用户/实际部署仍分别后置。

增强关闭/readiness=false、worker未接、OOM自动降tile暂缓保持。无push/PR/merge/部署/重启/SCM/GPU/生产变更；私有记录与后台记忆捕获不代表服务端记忆入库。
