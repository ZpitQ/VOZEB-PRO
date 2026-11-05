# 图像处理 Worker：S0 基线与 S1 固定契约

本文件记录 [SOP](2026-10-27-image-processing-worker-sop.md) 的 S0/S1。以下新类型、字段、接口和构建入口是后续实施必须遵守的固定契约，尚未作为运行功能上线。S2单任务实现及分项验证见[阶段结果](2026-10-27-image-processing-worker-s2-results.md)；各接口的实际资格按下文与配套用例分项记录；未取得对应资格的接口仍待实施和验收，不据此完成43项综合验收。

## 1. 范围与依据

- 复用既有 `generation_tasks`、PostgreSQL事务、文件Provider、Worker令牌和媒体Provider。
- 保持参考图64MP、视觉输入2048px/4MiB、生成结果默认40MP资源保护；不改变上游模型尺寸能力。
- 原尺寸保护仍保持四连通、边界连通背景、现有白/透明阈值、多主体规则及细杆/通道语义。
- 一个 `generation-worker` 服务支持多个副本；首个验收profile每副本一个图像进程。Web只负责控制与流式媒体访问，不执行该链路的全像素处理。
- Compose范围为默认、外部数据库、本地、低内存四份模板，以及测试站实际启动文件与生成来源。
- 内部图像阶段不新增模型调用、扣费或用户生图并发额度；用户只看到原图片任务及可选所属Run的阶段，不出现第二条业务生成轮次。

S0已经重新读取源码与运行资源；生成13份合成输入并逐一验证hash、尺寸和指定细节像素；保留原照片的既有私有媒体身份。原测试Run当前已取消，不作为恢复目标。真实照片内容与画质验收仍留S8。

隔离夹具任务使用1CPU/1536MiB、无网络容器，峰值约321MiB。该数据只证明夹具准备成功，不证明完整商品分割峰值。20次只读健康探测均成功；原分割OOM证据复用，不在活动Web重演。

S0的源码、资源、夹具、原件引用和测试profile记录在私有 `baseline.json`、`scope.md`、`fixture-manifest.json`、`acceptance-manifest.json`。私有记录不进入公共业务接口。

## 2. 实际调用路径与拆分位置

当前路径：

```text
generation-worker.mjs
 → POST /api/maintenance/generation-tasks/run
 → runGenerationTaskRecoveryBatch
 → processAgentLease / executeAgentRun
 → 参考原件读取、视觉准备、编辑规划
 → decodeEcommerceCanvasSize / buildWhiteBackgroundProductProtection
 → 保存包含方案与保护数据的snapshot
```

当前像素计算位于Web；编辑方案的最终snapshot晚于保护计算。现有90秒租约、25秒恢复续租可复用；仅有worker_id检查不足以表示同一Worker再次领取时的新执行身份。

固定目标路径：

```text
executeAgentRun
 → ensureImageProcessingTask(prepare_reference) → 保存依赖并让出执行
Worker claim → 独立子进程 → 媒体产物 → 原子完成阶段并唤醒所属Run
 → 复用已完成视觉分析与参考决策
 → 编辑方案校验后立即保存
 → ensureImageProcessingTask(build_protection) → 保存依赖并让出执行
Worker claim → 独立子进程 → 原尺寸蒙版 → 原子完成并唤醒所属Run
 → 沿用原生图提交/查询
原ImageTask当前claim → 取得并封版原生结果 → ensureImageTaskResultProcessing
 → 原子保存image依赖并让出 → Worker处理process_result
 → child完成只唤同image本地保存 → 合法image claim关联结果
 → 原图片成功链 → 现Agent poll/patch投影可选Run
```

父关系按操作固定：prepare_reference/build_protection仍以Agent Run为父；仅process_result由原ImageTask当前实际租约授权，覆盖无Run、非电商、同步无upstream ID及同Run多copy。结果分支的私有字段、取得/封版、本地恢复和投影见第4.3、7.1、7.2节；这些是待实现的固定契约，不是结果阶段运行通过。原Agent分支、prepare/build输入与manifest摘要及已取得资格保持。

prepare/build建立子阶段、保存父检查点的 `waitingFor` 和将父记录 `next_poll_at=null` 必须在同一事务提交，并校验父Run的当前执行身份；已有成功阶段则直接合并结果，不进入等待。完成子阶段与重新调度对应父记录也在同一事务提交。process_result使用image私有依赖和本地唤醒规则，不能借Agent execution或waitingFor冒充image授权。等待不占图像计算槽位、不反复触发模型。

## 3. 模块边界与后续文件

| 文件                                                                                                      | 固定职责                                                             | 进入阶段            |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------- |
| `web/src/lib/image-processing/contracts.ts`                                                               | 纯数据契约、IPC和工件描述；不依赖Next、数据库或鉴权                  | S2/S3按实际使用建立 |
| `web/src/lib/image-processing/core.ts`                                                                    | 已解码RGBA的纯像素分割，原地输出蒙版像素及边界；Sharp适配暂留service | S2                  |
| `web/src/workers/image-processing-child.mts`                                                              | 单任务入口，读取IPC、调用内核、报告结果后退出                        | S3                  |
| `web/scripts/image-processing-supervisor.mjs`                                                             | 子进程生命周期、资源准入、控制接口、文件传输；由现有Worker接入       | S3/S5               |
| `web/src/lib/server/image-processing-service.ts`                                                          | 入队、边界校验、结果登记、Run依赖和完成事务                          | S3/S4               |
| `web/src/lib/server/generation-task-types.ts`、`generation-task-store.ts`、`generation-task-scheduler.ts` | 扩展内部任务类型及限定领取/更新；继续沿用当前持久层                  | S4                  |
| `web/src/lib/server/agent-run-executor.ts`、`ecommerce-generation-snapshot.ts`                            | 检查点与依赖恢复，保留原有模型选择/计费/上游提交路径                 | S4                  |
| `web/src/app/api/maintenance/image-processing/**/route.ts`                                                | 下述控制/媒体接口，调用service，不做重计算                           | S3/S4               |

共享内核使用普通`.ts`，独立NodeNext构建输出ESM`.js`；独立运行目录随产物携带`package.json`并声明`type: module`。独立模块内部引用真实`.ts`源文件，TypeScript的`rewriteRelativeImportExtensions`在编译时改为`.js`；Web开启`allowImportingTsExtensions`，其服务端包装仍沿项目无扩展导入。子进程入口为`.mts→.mjs`。该组合已通过实际Turbopack生产构建，不能用仅有独立编译探针替代Web解析验证。没有实际使用前不建立空模块。

## 4. 持久任务与身份

### 4.1 记录结构

复用 `generation_tasks`，增加 `task_type='image_processing'`。沿用 `pending/running/success/error/paused/cancelled`、既有租约字段和执行阶段，不建立第二张队列表。

| 位置                       | 字段与含义                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 既有列                     | `id/user_id/run_id/conversation_id/parent_task_id`绑定业务归属；`worker_id/lease_until/last_heartbeat_at`表示租约   |
| `payload.version`          | 固定 `image-processing.v1`                                                                                          |
| `payload.operation`        | `prepare_reference`、`build_protection`、`process_result`之一                                                       |
| `payload.inputDigest`      | 本阶段确定性输入摘要，也是同一业务身份的请求指纹                                                                    |
| `payload.algorithmVersion` | 本阶段明确的算法版本，版本变化建立新阶段身份                                                                        |
| `payload.inputs`           | 每项含 `assetId`、`assetVersion`；有冻结hash时带 `expectedSha256`；只有与完整解码hash绑定的检查点尺寸可用于降低预算 |
| `payload.options`          | 判别式操作参数；只存该阶段实际需要的保护/目标尺寸/结果处理选项，不存完整模型配置                                    |
| `payload.resource`         | 冻结`profileVersion/requiredMemoryBytes/facts`；facts绑定输入身份和实际编码布局，需求来自各操作实测模型             |
| `payload.executionId`      | 每次领取新生成，连同worker_id约束续租、上传、完成和失败                                                             |
| `result_payload`           | 完成manifest、工件引用、退出/资源摘要；不存原图RGBA或长base64                                                       |

首次 `prepare_reference` 尚无内容hash时，以用户、Run、操作、assetId、已冻结assetVersion及输入策略版本建立身份。Web在claim前对归属已验证的原件流式hash/计数，并对同一关闭后的受控临时文件读取元数据，将真实hash、字节量和format/depth/channels一次性冻结为该阶段的内部资源事实；不完整解码。初始inputDigest仍绑定最初规范输入，补hash不重算摘要或新建任务，也不能覆盖已经冻结的hash；资源profile另行冻结。后续阶段必须包含该hash。已有checkpoint带hash时，预处理也必须验证，不能以“初次”绕过已知身份。

首次预处理按 `prepare_reference` 操作独立校准的64MP输入profile准入，不信任客户端或仅登记的宽高，也不在取得额度前完整解码。S3完成该操作的完整任务预算校准前不得启用其领取；S2的934MiB商品分割候选不能替代该预算。真实尺寸、方向、hash和分析缩图在子进程内验证后一起保存；后续阶段才能依据该检查点估算。超64MP和可读头损坏图仍在该边界拒绝。

结果处理的压缩输入没有参考预处理的20MiB统一上限。服务端按媒体归属和登记Provider读取原件，取得同一编码文件的实际字节量与真实格式/位深/通道，绑定输入索引、assetId、assetVersion和冻结hash，保存于内部resource事实；登记MIME、文件名、Content-Length或客户端声明不能替代实际值，也不能把文件头尺寸当作完整解码检查点。首次prepare仍保留64MP，仅用layout选择经校准的工作区系数。source、mask、native和编码产物按各操作实际存活的工作区计入；缺少匹配事实或未校准分支明确不可领取，不借用其他操作预算。传输完成后、启动子进程前再次核对冻结bytes/hash，防止原件变化先产生完整Buffer分配。

`facts.encodedInputs`逐项保存`inputIndex/assetId/assetVersion/sha256/bytes`和真实`layout:{format,depth,channels}`；仅同一文件的元数据读取实际失败时，以互斥的`metadataRejected:true`替代layout。该标记只允许坏native槽省去无法进入的解码/输出工作区，实际编码字节仍计入；全局source/mask不能借此准入。缺少采集结果与元数据已失败不同。`facts.decodedInputs`只保存同身份完整处理检查点的真实宽高，未完成解码时为空。

当前模型版本为`image-processing-memory.s3.v4`，已测prepare的uchar PNG/JPEG、ushort PNG及float三通道TIFF；后续保护/结果只对已校准uchar PNG/JPEG布局准入。首次prepare分别保留64MP，对应样本需求405/649/893MiB；布局缺失时不能套用405MiB。多结果累计实际编码输入与各成功槽的输出预留，raw/codec按单活跃槽峰值计入。这些系数是锁定Sharp版本的实测工程预留，不是任意编解码器的数学内存上界；未校准布局明确不可领取。

`process_enhancement` 的四类工程预留为：global JPEG 1536MiB，legacy PNG、product、scene 各1280MiB；仅覆盖当前producer/B0已定义的PNG8 RGB(A)/JPEG3输入角色和几何域，域外保持uncalibrated，不代表通用内存上界或并发容量。

初次任务的jobId/inputDigest及输入版本v0保留入队时身份；`referenceSourcesLoaded`在完整prepare完成后补全hash并更新父检查点assetVersion到v1，不能重算并重建已完成的prepare任务。旧任务manifest仍绑定v0；只有核对同一来源tuple、assetId、hash和实际完成manifest后，才能为后续新阶段构造v1绑定的编码/解码事实。恢复优先核对保存的processing任务引用及其实际sourceIdentities；没有有效完成记录才按当前冻结输入建立任务。

阶段ID固定为 `image-process-` 加上述固定字段顺序序列化后的SHA256；选项按判别式的明确字段顺序构造，不使用未规范化的任意JSON对象或公共客户端幂等键。`client_request_id`使用同一摘要，`attempt_no=0`；同ID不同指纹返回409。

阶段队列的数据库变更仅扩展 `generation_tasks_type` 检查约束；执行身份保存在payload，不新增通用lease表。opaque附件沿现local_media_assets四类type CHECK和file存储，不新增列或表。沿用主键、用户客户端请求唯一索引、Run索引与现有恢复到期索引。查询限定类型/Run/用户与状态，不读取全表JSON后筛选。

`generation_concurrency_reservations`不增加此内部类型；费用、用户生成额度和用户公开任务列表不得把该阶段当作第二次生图。管理员可查看其与父任务关联的诊断。

### 4.2 原子领取与公平性

- 旧 `claimDueGenerationTasks` 的既有类型集合不增加 `image_processing`。新领取入口只处理该类型，避免旧HTTP执行器误领。
- 在事务中从到期、未过期、可承载、无有效租约的记录形成候选；每个用户先选一条最早可执行任务，再锁定实际任务行，使用 `FOR UPDATE SKIP LOCKED`。
- 一次只领取当前空闲槽位和剩余预算能够容纳的任务。总预算可承载但暂时无余量时保留pending并返回空数组；永久不可承载按第7节暂停，不能用空数组掩盖。
- 每次领取在同一次更新中写 `worker_id`、新 `payload.executionId`、租约和开始状态。
- 续租和活动提交同时要求当前worker、executionId以及未失效租约。服务端时间为准，复用既有90秒租约/25秒续租机制。仅第5.1节的原取消owner关闭确认可在lease过期后提交；该例外不续租，不适用于普通heartbeat、上传、complete或fail。
- 已完成请求的重复完成：执行身份与manifest摘要均相同则200读回；身份/摘要冲突409，不重新发布或再次唤醒。
- 旧执行上传时丢失所有权，其工件不能关联为成功结果；按现有未引用产物生命周期处理。

### 4.3 process_result：ImageTask私有输入与执行父（待实现）

仅结果阶段的`parent_task_id`指实际ImageTask；`run_id/conversation_id/project_id`保留原可选业务关联，不用image ID冒充Run，不新增数据库列、通用ownerKind或队列表。stage读取投影须带回既有parent_task_id。ImageTask使用三个顶层私有字段：

```ts
nativeAcquisition?: {
  version: "image-task-native-acquisition.v1";
  attemptNo: number;
  upstreamTaskId: null;
  slots: Array<{ resultId: string; resultIndex: number; source?: { url: string; remoteUrl?: string } }>;
};
nativeResults?: {
  version: "image-task-native-results.v1";
  attemptNo: number;
  upstreamTaskId: string | null;
  slots: NativeResultSlot[];
};
resultProcessing?: { jobId: string; inputDigest: string };
```

attemptNo取实际image payload的业务attemptNo，不是generation row的attempt_no或child领取次数。NativeResultSlot按provider原数组顺序保存服务端`${imageId}:${index + 1}`与一基resultIndex：stored槽含稳定assetId/version、scope/storageKey、Provider/instance、同一闭合文件的真实EOF hash/bytes及layout或互斥metadataRejected；read/store失败槽只有原ID/index和安全阶段/code，不补造引用/hash/尺寸。inputIndex在组成Task2 inputs时独立零基分配。不得先normalize、dedupe、flatMap或按完成顺序重编号；相同字节的不同槽保留各自身份。

唯一封版政策：一轮全部原槽完成裁决且至少一槽真实闭合原件能在原claim事务合法关联时，才首次COMMIT nativeResults；metadataRejected仍是有真实hash/bytes的stored原件，交Task2完整解码。封版后的部分失败洞是本业务批次终局，不由同job本地retry回填，不能更改已封digest。全部原件尚未durable时不提交nativeResults、不建ref/空成功child；尚未关联的孤儿媒体不算durable映射。

没有native/ref且已有真实upstream ID时，沿TC-R04查同一提交继续取得/保存，不重新create或增加同提交费用。仅同步no-ID且有现授权媒体reader可再读的URL时，在媒体I/O之前用原claim保存nativeAcquisition；无source的原槽仍保留。locator绑定原user/image/业务attempt/null upstream，沿既有地址解析、出站及授权路径，不保存inline bytes/长base64、cookies、Authorization、解密凭据或临时路径；签名locator只留私有字段，不进digest/result/error/event/log，也不承诺可刷新。该快照不替换原slot/source，封版时同事务清除。no-ID无持久来源、来源已过期且不可再读或响应未落盘时保留Unknown/安全needs_review，不假NativeReady、不自动新create/换渠道/退款。

创建TS输入和普通update Pick不开放三个字段及executionId；factory必须在input spread之后显式重置，不能只靠TS阻止context运行时注入。实际内部边界固定为`captureImageTaskNativeResults({taskId,workerId,executionId,attemptNo,upstreamTaskId,result,origin,authContext})`及`ensureImageTaskResultProcessing({taskId,workerId,executionId})`；不是公共HTTP接口。原image claim从recovery取得后穿过create/query、共同provider结果、真实流/关闭/登记和最终关联，不能I/O后读取新epoch替换原参数。

native封版、enqueue和最终image关联须读取并锁当前实际record，核type/user、record与payload状态、锁后TTL/lease、原worker/executionId、payload业务attempt、payload upstream与row upstream_task_id的真实/null绑定及可选Run取消/终态。generic payload-only mutation不足以证明这个fence；runtime实际attempt/submission/upstream/billing写入同样携原claim走窄image校验，不能仅在native提交加fence而让前后旧调用写新行，不建立通用owner/callback框架。I/O在锁外；失权用独立ownership_lost退出，先于普通catch/failure/refund/retry，不能释放新epoch或污染新claim。已有封版映射的新合法claim复核同绑定后纯本地复用，不再query/download/register。

结果options只用现有四模式：ordinary为results/targetSize?/transparentBackground；layers为results/sourceInputIndex；scene_protection为results/sourceInputIndex/maskInputIndex/protection/baseline?；product_protection同类索引/protection且baseline必需。targetSize沿现canvas/layers/preserveNative4k/custom native-size政策，不对所有ordinary强行resize。source/mask绑定实际image冻结来源/hash和保护契约；引用prepare/build检查点时须核真实成功阶段及原摘要，不借同Run另一copy或伪造Agent快照。全局source/mask无效或layers整批契约不成立仍拒绝，不能降为ordinary。

结果专用有序canonical摘要绑定真实user/image、payload业务attempt、真实/null upstream、完整封版原槽（含终局安全错误）、冻结原件/source/mask身份与资源事实、现有四模式的实际options和算法/模型版本；不含parent/child当前执行epoch、时间戳、临时路径、签名URL、部署可用预算或任意对象键序。继续以image-process-加digest建立稳定job，换image claim不换job。prepare/build原digest与manifest序列化保持逐字节语义；结果新事实只进结果分支摘要。

## 5. 控制接口契约

全部使用既有Worker Bearer令牌及 `{code,data,msg}`。Worker继续不持有数据库连接串、完整应用`.env`、模型密钥和对象存储密钥。

流式输入/输出使用 `x-vozeb-pro-worker-id`、`x-vozeb-pro-execution-id` 请求头传本次身份；Bearer仍单独鉴权。该内部接口根据任务绑定的userId调用既有媒体Provider，不接受客户端另传用户覆盖归属。

| 接口                                                          | 请求与响应                                                                                                                                   | 错误                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `POST /api/maintenance/image-processing/claim`                | `{workerId,profileVersion,availableMemoryBytes,slots}`；200返回 `{tasks:[{id,executionId,leaseUntil,payload,inputUrls}]}`，空闲为 `tasks:[]` | 无效入参400，令牌缺失/错误401，资源profile不一致409 |
| `POST /api/maintenance/image-processing/[id]/heartbeat`       | 普通`{workerId,executionId}`返回`{leaseUntil,cancelRequested}`；第5.1节关闭确认返回稳定cancelled/completed收据                               | 结构400，不存在404，身份/状态/收据冲突409           |
| `GET /api/maintenance/image-processing/[id]/inputs/[assetId]` | worker/execution身份通过内部请求头携带；按该任务输入清单流式读取既有媒体                                                                     | 不存在/不在输入清单404，过期身份409                 |
| `PUT /api/maintenance/image-processing/[id]/outputs/[kind]`   | 原始文件流及worker/execution身份；kind为该操作允许的 `analysis/mask/final`；final以`?resultId=`选择冻结槽位；201返回登记工件描述             | 格式400/415，字节预算413，身份冲突409               |
| `POST /api/maintenance/image-processing/[id]/complete`        | `{workerId,executionId,manifest,metrics}`；200返回已完成阶段及父任务重新调度结果                                                             | 产物或参数无效400，身份/重复结果冲突409             |
| `POST /api/maintenance/image-processing/[id]/fail`            | `{workerId,executionId,failure}`；200返回该阶段失败/暂停状态                                                                                 | 错误体无效400，身份冲突409                          |

prepare_reference/build_protection的fail只接收已关闭子进程的两种确定失败报告：共同字段为`jobId/executionId/pid/exitCode/signal/stderr`，rejected另含`error:{code,message}`，resource_failure另含`reason:'v8_heap_oom'`。pid、exitCode、signal沿IPC契约允许null；报告jobId必须匹配路径，报告executionId必须匹配外层身份。crashed、aborted、completed、未确认的资源原因、未知字段或无效结构返回400且任务不变；SIGKILL本身不构成OOM。运行中V8资源失败不使用入队准入原因`image_processing_resource_unavailable`代替。

首次fail必须持当前worker/执行与有效租约；rejected将子置error，资源报告将子置paused，均为needs_review并清活动owner、租约、心跳和调度。200仅返回`{jobId,status:'error'|'paused',executionPhase:'needs_review'}`。失败result_payload保留暂存工件，并保存原worker/执行及规范固定字段failure；不伪造manifest或峰值。父子事务只暂停仍匹配waitingFor的jobId/inputDigest且未取消、未终结的父，保留检查点与方案，父文案使用固定安全中文；原始诊断留内部子记录。同一原worker/执行、同一规范报告只读重放首次收据，对象键序不影响比较；冲突409，success不能被fail覆盖。process_result与取消关闭确认不由该已实现分支取得资格。

协议无新固定字节上限；输入沿用既有上传/媒体策略，输出按实际工件类别与冻结处理策略确定。`image_processing_resource_unavailable`是失败原因码，持久状态为paused / needs_review；不新增同名状态枚举，也不返回“已开始处理”。

工件描述固定字段：`kind/storageKey/sha256/mimeType/bytes/width/height`。引用由服务端登记并绑定任务与执行，complete不能提交任意存储地址。signed URL和对象内部Key不持久化进业务payload。

S3为实际多结果路径补充槽位绑定：`final`额外保存既有`resultId/resultIndex`，index沿用一基语义；上传时resultId只能选择本阶段冻结的允许槽位，不能由Worker另传index覆盖。`analysis/mask`为单工件，不接受resultId选择器。不同槽位内容相同也保留各自身份，不按hash合并。

完整像素校验在子进程完成一次。Web对工件做流式hash、字节/签名、归属与元数据一致性校验，不再次完整解码；Worker是受鉴权的内部执行边界，不能接受用户伪造的“已解码”标记。

取消沿用用户现有Run/任务操作；heartbeat携带 `cancelRequested`，监督进程只终止该执行拥有的子进程。失去租约同样停止本次执行，不新建上游任务。

当前已实现的局部接缝仅为prepare_reference/build_protection的内部child-only取消服务，不新增公开接口。事务先锁真实父再锁子，核对用户/Run绑定与已保存的父取消意图；文件Provider沿creative→generation锁序在一次mutation内更新指定子阶段，父记录不写。锁后pending置cancelled/completed并清owner、租约、心跳及nextPoll；running置cancelled/cancel_requested并只清nextPoll，保留原workerId、executionId、租约、心跳、payload与result_payload，过期owner也保留。有效原owner仍按既定heartbeat读取cancelRequested，旧epoch或过期租约409；终态与重复取消不改完整父子行。父取消目前由测试前置保存，实际Run/action尚未接此服务；当前所有者真实close后的确认已按第5.1节实现并取得服务端局部资格；Worker预算归还及中断恢复仍未实现或验收。

### 5.1 prepare/build取消关闭确认（固定契约，服务端局部已验证）

复用现有image-processing heartbeat，不新建ACK Route。普通请求仍为`{workerId,executionId}`，返回`{leaseUntil,cancelRequested}`并要求当前有效租约；该响应不能作为关闭确认。请求携带`notStarted`、`closed`或`stopCause`任一字段即进入取消确认分支，不能回落普通续租。`closed`分支仅允许且必须包含`workerId/executionId/closed/stopCause`四个字段；closed:null、closed缺结构、缺stopCause或只有stopCause无closed均400且整行不变，不能回落普通续租。沿原Worker Bearer、`{code,data,msg}`与无缓存响应，结构无效或未知字段400且任务不变。

`stopCause`仅为`cancel_requested|lease_lost|worker_stopping|null`，由所属Worker忠实报告第一次实际中止来源；自然退出用null，后来读到取消不能覆盖先前事实。server不从aborted、退出信号或租约过期推断cause；cause本身不授权取消任务。`closed`只投影实际Task2 close的固定字段：

| status              | 所有分支共同字段                                  | 唯一额外字段         |
| ------------------- | ------------------------------------------------- | -------------------- |
| aborted / completed | jobId、executionId、pid、exitCode、signal、stderr | 无                   |
| rejected / crashed  | 同上                                              | error:{code,message} |
| resource_failure    | 同上                                              | reason:'v8_heap_oom' |

共同字段必须齐全；jobId匹配路径，executionId匹配外层原执行身份；pid为正安全整数，exitCode为整数或null，signal为字符串或null，stderr为字符串。error仅含字符串code/message。completed不能携result；任何分支均不接收工件路径、artifacts、metrics或其他字段。SIGKILL不是OOM证据。`closed`分支仅接收已spawn并实际close的报告；pid=null的预启动aborted、未启动或启动失败不属于该分支，返回400。

未启动声明使用互斥的四字段请求`{workerId,executionId,notStarted:true,stopCause:"cancel_requested"}`，仅适用于prepare_reference/build_protection。notStarted必须为true、cause必须为cancel_requested，不得携带closed、PID、退出字段或其他字段；缺字段、混合两种声明或无效值均400。Worker只有在收到真实取消且从未调用supervise时才能声明未启动；进入supervise后即使没有outcome也必须保留Unknown。下载中取消还必须收口实际输入连接和写入描述符，不能因没有outcome就归还预算。

首次ACK只允许仍有效的prepare_reference/build_protection子阶段处于cancelled/cancel_requested，且当前worker_id、payload.executionId与外层原worker/epoch精确匹配。仅本ACK允许原取消owner在lease过期后提交真实close或未启动声明；它不续租，也不授予上传或继续计算权限，普通过期heartbeat仍409。不同状态、owner或epoch均409；pending取消产生的cancelled/completed没有所属执行关闭收据，不能补造。任务TTL已过或不存在沿现有不可见语义404，不重建任务，不以TTL或lease推断close。

PostgreSQL持真实child锁、File在一次既有generation mutation内核对当前状态和任务有效期，一次性保存规范固定字段报告与首次收据，置cancelled/completed并清活动worker、lease、heartbeat与nextPoll。私有`result_payload.cancelClose`固定为`{workerId,executionId,closed,stopCause,receipt}`；未启动声明改存互斥的`cancelNotStarted:{workerId,executionId,notStarted:true,stopCause:"cancel_requested",receipt}`，不伪造close证据。receipt为`{jobId,executionId,status:'cancelled',executionPhase:'completed'}`，200响应的data就是该receipt。原result_payload其余证据、payload.executionId、冻结输入/资源配置与暂存工件保留；不写父、不唤醒、不删除媒体、不写计费。

只有当前仍cancelled/completed、payload原epoch未变且已有匹配cancelClose收据时，相同原worker/epoch、相同规范报告与stopCause只读重放首次200；JSON对象键序无关，时间戳和完整父子行不变。报告、身份或stopCause冲突409，结构无效400。success/error/paused、已重开或已换owner/epoch不能因旧收据回放而被覆盖。未启动声明只读重放相同原worker/epoch、marker和cause的首次收据；已有另一种回执或两种回执并存均409，不覆盖首个收据。HTTP200但data仍是leaseUntil/cancelRequested不算ACK，Worker必须核对完整收据身份和状态。

本节服务端ACK已通过File与真实PostgreSQL单连接池检查，包含实际Task2关闭、过期原owner ACK、严格报告、当前epoch/重开/TTL拒绝及同报告重放，数量与分轮证据见配套用例。另有独立File/prepare真实Next TCP资格：代理仅转发一次，完整读到首次200及精确收据后丢弃全部响应，调用方fetch failed，原请求直连重放返回同一收据，完整父子行与暂存工件描述不变。工件预先暂存，不是aborted子进程产物。该网络门不代表其他操作、Provider、实际Worker或全部TC-Q04通过。未启动声明的服务与Route已分别通过File和单连接PostgreSQL两种operation的新增用例，并通过完整受影响服务回归；这不授予实际Worker未启动或下载关闭资格。实际Worker图像lane、真实close及I/O drain后的恰一次预算归还、跨Worker/容器重启的持久证据、真实Worker not-started、实际Run/action、native与Agent整链路仍是后续必需门；本局部服务和网络检查不代作它们通过。

## 6. IPC及工件

子进程收到一个 `{version,jobId,executionId,operation,inputs,options,outputDirectory}` 消息；inputs是监督进程已读取到受控目录的文件路径及冻结身份，不传网络凭据。输出为 `{jobId,executionId,sourceIdentities,artifacts,results?,geometry,metrics}`，artifacts包含本地路径与工件描述。

`geometry`仅包含调用方需要的原尺寸、商品边界及保护区域。监督进程核对本次子进程结果的身份后上传工件，再complete；不把文件字节转成IPC JSON。

`process_result.options.results`以`{resultId,resultIndex,inputIndex}`绑定本批上游结果，inputIndex为零基输入索引。原生图必须在入队前按原用户登记为持久输入；完成时复用该输入的真实原字节、hash与归属作为native证据，不新增native工件类别，也不能用Worker临时路径或合成图冒充native。结果manifest逐槽保存`{resultId,resultIndex,nativeInputIndex,finalArtifactIndex,...evidence}`，成功槽位与final工件一一对应。

候选图的像素损坏或尺寸/保护验证失败按原槽位记录`error:{code,message,failureStage}`，失败项不含finalArtifactIndex，同批合格候选继续交付。坏native若已读到原字节并验证冻结身份，则sourceIdentities中只保存真实身份/hash/bytes及decodeError，不伪造可解码尺寸或MIME；合格项保留完整已验证身份。全局源图/蒙版不合格或完整分层契约不成立时拒绝整个阶段；全部候选均不合格时明确失败，不返回空成功。普通结果没有全局源图时可省略geometry.sourceSize，逐槽尺寸以对应的已解码身份为准；prepare/build与具有全局源图的保护/分层操作仍返回实际源尺寸。

每任务一个短生命周期子进程，正常或失败后退出；不引入常驻图像池。Raw RGBA、遍历数组和Sharp本地分配随进程释放，峰值仍受Worker容器总限额约束。

本地和S3均通过Web现有媒体Provider读写；默认不新增Worker共享业务卷，Worker只使用私有临时目录。文件写入入口要扩展现有 `writeReferenceMediaFile` 的图片/工件能力，复用 `persistExternalMediaIfEnabled` 和本地登记，不另建存储体系。

源图按登记Provider读取；外部存储启用时只写外部业务对象，Worker临时材料不成为永久本地副本。工件先完整写入、登记，再做阶段完成事务；中断产生未引用对象按既有生命周期清理。

process_result成功解码的原件sourceIdentity另保存最窄`nativeImage:{format,hasAlpha}`，decodeError分支没有假事实。format取原编码，hasAlpha表示真实像素透明性，不从channels或metadata.hasAlpha推断。无target/无需缩小的既有normalizer已在stats后返回同一原bytes，应保留并补真实字节/hash、EXIF展示尺寸和编码断言；优先复用已有同源stats的isOpaque，不追加整份RGBA。有resize/composite时事实仍来自原件，独立核实际峰值、IPC validator和result-only digest，不能拿final stats冒native或借旧资源门自动取得新资格。

opaque原件沿现permanent/reference/attachment/octet-stream/.bin存储；只扩独立的结果输入attachment assertion，不放宽prepare/build image assertion或public.bin/dataURL/reader白名单。Task2完整验证后，Web可沿原Provider流复制同一原件到受控闭合文件、复核EOF hash/bytes，再经现image file writer和实际MIME/操作字节政策取得合法image URL；不在Web解码/resize/合成/alpha扫描。合格final已是同hash/bytes原件时复用URL，仅尺寸相同不够。nativeSource及各proof/canvas.nativeUrl绑定真原件，final/baseline绑定实际合成/交付件；保持现enhancement native/final尺寸与URL equality及保护baseline条件，不借thumbnail/resize件补原件事实。

## 7. 状态转换与恢复

下表父Run/waitingFor行为适用于prepare/build；结果分支按第7.1节处理，不扩大已有prepare/build资格。

| 原状态/事件                        | 子阶段状态                                                                          | 父任务处理                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 入队                               | pending / created，next_poll_at到期                                                 | 同事务校验父执行身份、建立子阶段、保存依赖并令父next_poll_at=null                         |
| 准入并领取                         | running / created，写新执行身份与租约                                               | 保持等待，不重复分析/规划                                                                 |
| 工件上传                           | running / persisting                                                                | 仍不展示未完成结果                                                                        |
| 完成                               | success / completed，保存manifest、清租约                                           | 仅父waitingFor的jobId/inputDigest仍匹配且未取消时，同事务合并当前检查点、清依赖并重新调度 |
| 单任务需求超过部署单副本总图像预算 | paused / needs_review，next_poll_at=null，原因image_processing_resource_unavailable | 同事务暂停匹配依赖的父Run并显示需求与可用总预算；配置调整后显式重试                       |
| 明确输入/分割拒绝                  | error / needs_review                                                                | 按实际原因暂停/显示说明，不调用生图上游                                                   |
| 有证据的资源耗尽                   | paused / needs_review，next_poll_at=null                                            | 保存配置/退出证据，明确暂停，不自动重跑同一失败                                           |
| 无法确认的进程/容器中断            | 保留当前持久状态等待租约接管                                                        | 纯计算可重领；不能把未知中断当确定业务失败                                                |
| 排队取消                           | cancelled / completed                                                               | 原Run取消规则，不启动子进程                                                               |
| 活动取消                           | cancelled / cancel_requested，当前所有者收口后completed                             | 只终止所属进程；原上游身份按既有取消语义处理                                              |
| 显式重试本地失败                   | 同一内部任务pending / created，下次领取换执行身份                                   | 复用有效方案，保留同一Run/公开轮次                                                        |

已成功阶段不可被失败回写覆盖。prepare/build入队和complete涉及本阶段、父Run检查点及父调度，PostgreSQL中复用同一executor事务并锁定当前父记录；完成时合并当前记录，不回写执行开始时的整份旧Run。旧子阶段完成可以保留合格工件，但不能覆盖父的新依赖或取消状态。父执行让出后不再用旧身份保存waiting，避免快子任务唤醒被覆盖。

当前父Run实际保存在generation_tasks的agent记录payload中。文件Provider在一次既有generation-task文件mutation提交父/子任务真值；保持creative→generation-task的既有锁顺序，不在锁内重入公开Run mutation。creative文件的消息/事件是独立投影：任务提交后按jobId/inputDigest和转换身份幂等更新、发出通知；中断后从任务真值补齐，刷新仍能读到正确状态。不得声称消息文件、任务文件和媒体跨存储原子提交。媒体写入先于完成事务。

`EcommerceGenerationSnapshot.processing`承载 `{version:'image-processing-checkpoint.v1',prepareReferences,protection?,waitingFor?}`，已完成项保存 `{jobId,inputDigest,manifest}`。编辑方案先写既有 `plan/modelRoles/modelRouteSnapshots/stageTimings`，再入队保护任务。process_result引用只在ImageTask.resultProcessing，不写Agent单result/waitingFor作为多个copy的结果依赖。

恢复前逐项核对阶段摘要和工件归属；方案已完成时不重调规划。已有上游ID继续查询，`result_ready`只进行结果处理。上游/文本调用已经发出但响应未落盘时保留未知语义，不宣称外部exactly-once。

### 7.1 process_result本地等待、恢复与取消（已接入，按分项证据验收）

本节主路径已接入，既有File与单连接PostgreSQL结果链资格按各自轮次保留；具体恢复、取消和故障窗口须分别取得证据，不能据已接入声明本节全部验收完成。

native可先封版提交；后续enqueue以当前原claim在同一PG事务/File mutation建立或复用稳定child、写image.resultProcessing、置persisting/nextPollAt=null并让出lease。封版后入队前中断由下一合法claim纯本地接续。新增内部local_result_wait表示已建本地依赖，不伪造pending.upstream或result_ready.url。取得全失败用既有needs_review控制结果，保留原成功上游/billing/attempt，不当模型失败或退款。

| 当前事实                        | 固定恢复行为                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 无native/ref，有真实upstream ID | 同ID查询并取得/保存，不能新create                                                                                         |
| 无native/ref，仅no-ID取得快照   | 仅按原授权locator/原槽再取；无源或不可再读保持Unknown                                                                     |
| native已封版，无ref             | 同映射建立同job，不取上游或回填洞                                                                                         |
| ref pending/running             | 同image本地等待，无URL仍合法                                                                                              |
| ref success                     | 同image当前合法claim本地消费                                                                                              |
| ref paused/error                | image仍running/needs_review、停调度；显式重开同stage，下次child claim换执行身份，仅重跑本地处理，不承诺确定输入拒绝会变好 |
| 取消/新业务attempt或绑定变化    | 旧合格child可保留，不能唤醒/关联新业务                                                                                    |

recovery在submission_unknown、upstream query、needsPersistence和missing-URL旧分支之前检查native/ref；详情POST也先识别本地依赖，再选择同ID取得、no-ID locator或Unknown。无Run同样可恢复原image；不新增image paused、公开轮次或生成预留。child完成使用child当前租约，不要求已让出的旧parent租约；核当前image业务/native/ref与可选Run，success只使同image本地保存可继续，不写image success、Agent wake、费用/资产/增强。

有新有效image owner时保留其worker/epoch/lease及原due；无owner的本地等待才按既有规则置due。pending→等待写null/让出前在同锁重核child已否success，不能由迟到快照覆盖唤醒。当前领取保留原due，不能据假设添加恢复扫描/调度参数；按真实交错门验证。消费方锁外写合法媒体，随后用原消费claim锁内核当前image/child/ref/登记并合并当前payload，成功后才复用原success/日志/attempt/资产/增强链，不宣称旧post-success全部副作用已exactly-once。

Run cancel可先持久化Run cancellation再HTTP取消image；native封版/enqueue/complete wake/final关联均核该窗口。Run有cancellation或status为cancelled/completed/failed时不得新关联，普通paused无cancellation不等同取消。image取消只级联其匹配结果child：pending→cancelled/completed；running→cancelled/cancel_requested，保留原owner/epoch/lease/关闭证据，不碰其他copy或prepare/build。结果fail/cancel/close ACK单独实现验收，不能删除现拒绝条件后借用prepare/build已通过结论。

PG统一锁序：可选真实Run→image→processing child→registrations；所有登记复验用同executor批读，不能锁内调用另借池的singular getter，需pool1门。File保持creative→一次generation mutation，无Run且不触creative时可直接一次generation mutation；不在generation锁内重入creative，不在锁内做媒体I/O。任务、媒体、消息跨文件/Provider不声称原子。

### 7.2 可选Run的B事实投影与receipt补偿（待实现）

正常事实只沿现dispatch/link→image GET/POST的pollTask→patchTask/updateAgentRunTaskById更新logical task。实际image ID与当前tasks[].childTasks/taskIds成员确认copy；context.parentTaskId会被link改成Run ID，不能用于辨认logical task，不能解析clientRequestId自造权威。成员尚未link不丢native/重建模型，公开投影等真实link及poll；无Run完全不进Run事件分支，child/image回调不直接更新logical状态或自动恢复Agent。

实际AgentRunChildTask增加私有指针`imageProcessingFact:{jobId,inputDigest,factIdentity,eventType}`，eventType限既有task.needs_review/task.child.completed/task.child.failed。当前Agent execution的正常B patch锁内重读同logical attempt/来源image/native/ref和child事实，与实际copy状态同时提交指针；不把一copy的事实铺到其他pending copy。指针仅标记已应用事实，不存待发事件队列/原始报告或新通用revision。

factIdentity来自已持久证据：失败/暂停用child id/digest、保存的execution/worker及规范failure；success用已提交child execution和manifestDigest；未claim的准入paused用已持久row转换时间、resource.unavailable及当次资源快照，不造epoch或读取时Date.now。无新转换的同配置恢复保留原事实。投影key再绑定Run/logical task/当前logical attempt/实际image和eventType；同事实重放只一次，显式retry后新child execution再次pause/error必须产生不同事实，业务job仍不含parent epoch。

正常B patch在Run锁内查已有key receipt；PG查重、Run/指针、event/assistant使用同一executor。File仅此B分支先提交Run truth/指针，再在仍持creative锁时一次写runtime event+assistant、最后notify；状态已相同但receipt缺失仍补，不把旧通用updater当幂等实现。

外层显式修漏入口为正常B patch/真实link之后，以及现Run GET鉴权→纯getAgentRun→owner校验后、public序列化前；Run action POST在权限/conversation核对后、resume变更前也可补。低层getter保持纯读，补偿在未持锁处进入并按上述锁序复核，不在concurrency/mutation锁内重入，不需要旧Agent lease。只补已应用且当前仍匹配的指针receipt，不取得执行权、不改logical状态或重开任务；无指针、未link、取消、新attempt或已被新事实取代时不补。自然completed且完成指针仍匹配可补既有receipt，不接受新关联，不承诺历史事件全量重建。无缺口读取不写。

public Run/task白名单不含指针；真实publicAgentRunEvent必须剔除event.data的imageProcessingProjectionKey，只输出既有安全状态/文案，不透传native/ref/locator/路径/资源原报告。File漏消息与重复SSE、跨显式retry新事实、noRun/noID/多copy及真实GET/action补偿均为待执行门。

## 8. 配置与容量模型

下列变量为S1固定的新配置入口，尚未写入运行Compose。MB字段均指MiB；Docker变量带单位时遵循Compose解析。

| 变量                                    | 默认/要求                                         | 用途                                                               |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| `VOZEB_PRO_WEB_HEAP_MB`                 | 保留现有384                                       | app的NODE_OPTIONS                                                  |
| `VOZEB_PRO_WEB_MEMORY_LIMIT`            | 普通模板保留0；lowmem保留512m                     | Web总内存；0保持既有未设置语义，不用于Worker预算                   |
| `VOZEB_PRO_GENERATION_WORKER_HEAP_MB`   | 普通模板384，lowmem64                             | 监督进程NODE_OPTIONS；与图像子进程分离                             |
| `VOZEB_PRO_GENERATION_WORKER_MEMORY_MB` | 新图像Worker启动必须显式配置正整数                | Compose mem_limit和Worker容器预算的共同来源                        |
| `VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB`     | Web与Worker使用相同显式正整数，严格小于Worker总量 | 单副本所有活动图像进程可预留预算之和，也是本部署单任务最大可承载量 |
| `VOZEB_PRO_IMAGE_PROCESS_HEAP_MB`       | 默认384，必须为正整数                             | 子进程显式execArgv；剥离继承的old-space参数后设置                  |
| `VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY`   | 默认1，正整数                                     | 图像槽位；仍同时受内存/CPU约束                                     |
| `VOZEB_PRO_GENERATION_WORKER_CPUS`      | 测试/部署profile显式配置正值                      | Worker容器CPU额度，副本总额不超过分配                              |
| `VOZEB_PRO_WORKER_STOP_GRACE_PERIOD`    | 发布profile显式配置合法Compose时长                | 缩容/更新排空窗口，按实际最长处理策略确定                          |

新Worker要求显式资源预算是本次启动契约变更；部署材料必须补齐后才能升级，不通过静默默认绕过。配置校验在环境变量边界一次完成。参数化四份模板，测试实际文件及生成来源同时更新；移除Worker固定container_name，保留鉴权和网络边界。

首版多个副本使用同一资源profile；Web读同一图像预算用于入队判定，Worker领取上报profileVersion且必须匹配。需求超过总预算时在入队事务直接暂停；需求可承载但所有槽位忙、可用余量不足或Worker暂离线时才持久排队。部署预算变化受控排空重建后生效，已暂停任务显式重试；不从“没有在线Worker”推断永久资源不足，不增加跨副本内存令牌或异构副本注册系统。

领取的profileVersion由S2内存模型版本和已校验的图像预算/子进程堆/槽位按固定顺序摘要得到，避免同名模型但实际配置不一致。配置至少满足监督堆与图像预算之和小于Worker容器总量；剩余空间还须覆盖S2/S3测得的监督进程原生分配与运行余量，未满足时不接单。

环境文件先由Compose插值，服务environment中的显式值覆盖env_file和镜像ENV；Web、监督与图像子进程分别赋予对应堆参数，不让子进程继承另一层old-space设置。无效值或非法预算组合在启动边界报配置错误并非零退出，控制接口在profile失配时409、不领取。CPU由容器额度限制；每个图像子进程固定Sharp concurrency=1、UV_THREADPOOL_SIZE=2，首版每副本一个图像槽；这些值是所选测试profile，不能据此宣称最优吞吐。副本数通过Compose scale指定，各副本复用当前Worker唯一身份机制。

`requiredMemoryBytes`按操作、像素、通道、同时存活工作区和编解码余量计算，校准版本写入resource.profileVersion。首个商品保护候选profile由S2完整任务测量产生，64MP按候选模型为934MiB，见阶段结果；S3需按实际子进程和各operation复核后才能启用，不能以S0夹具峰值或商品保护结果替代其他操作的预算。

同时满足：活动任务预算和不超过图像预算；图像预算与监督进程空间/运行余量不超过容器总量；各副本容器预算之和不超过部署分配。独立容器额度组合即可形成上界，不另建分布式内存令牌系统。

图像计算从解码前占用额度，子进程退出并收口后释放。模型HTTP等待和上游轮询使用原有网络lane，不占图像槽。资源不足返回排队/明确资源说明，不先解码，也不自动降精度。

## 9. 独立打包清单

先前TypeScript 5的`.mts→.mjs`隔离探针有效，但S2实际Turbopack无法将Web的`.mjs`引用解析到`.mts`；S3实际构建又证明独立模块中的`.js`不能直接解析为`.ts`源。当前使用普通`.ts`内核、内部真实`.ts`引用及标准扩展名重写，输出NodeNext ESM`.js`。最新完整Web类型检查和生产构建通过；从实际Standalone排除src后的独立目录、普通用户资格镜像已执行真实PNG保护。资格镜像不等同于仓库Dockerfile全构建，完整Worker链路、最终Dockerfile与桌面验收仍须后续分别记录。

固定构建方案：

1. 新增 `web/tsconfig.image-processing.json`，ES2022、NodeNext、strict，rootDir=src，outDir=`.image-processing-runtime`；仅编译独立内核/契约和子进程入口。
2. 内核仅依赖Node、Sharp和同层相对模块，不导入 `@/`、Next、数据库、系统设置或模型服务。
3. 独立入口输出 `.image-processing-runtime/workers/image-processing-child.mjs`；共享模块保留对应lib目录结构并输出`.js`；运行目录必须携带`package.json`的`type: module`声明，不依赖祖先目录的模块类型。
4. Web类型检查继续原入口，并校验独立项目；`production-build.mjs`在Next构建前实际编译该独立项目，不能因NEXT_SKIP_BUILD_TYPECHECK跳过产物生成。
5. `standalone-assets.mjs`将运行目录和监督脚本放入Standalone；Dockerfile显式COPY同一产物和监督脚本，继续携带Sharp原生包/libvips并使用普通node用户。
6. `generation-runtime.mjs`与现有generation-worker负责本地/Standalone启动接入；图像进程失败由Worker收口，不能让本地总监督器因单个图像任务失败关闭Web。
7. 现有本地5秒强制停止逻辑与Compose停止窗口需在S3/S5按新的排空状态调整，不能把它直接当作长任务安全交接保证。

实际产物入口、Sharp可加载、工件输出、退出码和缺包失败由TC-P04验证；镜像完整复制与普通用户权限由既有构建契约及实际镜像读回验证。

## 10. 测试绑定与阶段门

- S2：TC-A01包含42.7MP与64MP完整任务；TC-A02保持细杆/通道像素；输入预算与损坏图复用已有测试。
- S3：TC-P01—P04、TC-F01/F02验证进程与产物；不能以打包探针替代完整进程隔离。
- S4：TC-Q01—Q07、TC-R01—R06、TC-S01使用真实PostgreSQL/进程/网络故障；内部阶段无独立扣费或生图额度纳入TC-R04/R06账本断言。
- S5：TC-B01—B04、TC-C01—C05验证参数真实生效、预算与副本生命周期。
- S6：负载profile固定1/5/10/20用户，代表性混合负载60分钟、随后空闲观察10分钟；健康探测沿用既有5秒窗口并要求全部成功、Web非预期重启为0；吞吐和p95单列报告，不宣称全天候SLA。
- 测试Worker组最多使用2CPU/3GiB，单次准备/探针最多1CPU/1536MiB；这是本轮测试额度，不是产品上限。运行前必须复核宿主余量，资源不足保持容量门未验证。

S0/S1完成门：基线、范围、夹具hash、acceptance manifest、调用图、字段/接口、状态转换、配置与打包方案均有明确文件；打包关键选择有实际探针；独立复审关闭关键缺口；Mem0里程碑有可核对记录。业务实现、43项执行、容量与真实照片结论不属于本阶段完成声明。

## 增强 CPU 成功结果的发布

仅消费与原增强父任务、原成功图片及冻结输入绑定相符的已闭合 `success/completed` 子任务；清单、交付工件和保护证明复用完成边界的验证。`publicationProcessing.promotion` 在保存前固定 `aiStorageKey`、`deliveredStorageKey`，中断恢复复用同一永久原件。Web 只校验登记、流字节/SHA 和头部元数据，通过现有媒体 Provider 保存原字节，不重新解码像素、合成或编码。

媒体 I/O 在关系锁外完成；资产和父任务发布在既有关系边界内复核当前图片、父子绑定、登记、取消及有效租约。PostgreSQL 复用同一 executor，末尾租约失效回滚资产和父任务；文件 Provider 沿 creative → generation → enhancement → registry 锁序，以稳定资产身份恢复跨文件中断。发布后沿原远端任务和 receiptId 确认，不重新 CREATE 或下载 RAW。
