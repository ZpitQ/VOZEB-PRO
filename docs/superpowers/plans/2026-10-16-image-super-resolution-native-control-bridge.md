# 高清增强：受限 Windows 原生控制桥

日期：2026-10-16，Asia/Shanghai。关联[主 SOP](2026-10-10-image-super-resolution-integration-plan.md)、[测试索引](2026-10-11-image-super-resolution-test-cases.md)与[原生执行会话](2026-10-15-image-super-resolution-native-session.md)。

**当前状态：B4-B2-7 核心控制及所选输出闭包的技术验证、对应独立复审完成。** 原身份绑定、inspect/close、协议拒绝/部分上限与单路EOF窄修已有分轮实际证据及相关固定源/actual窄范围独立批准。五个输出test-only场景已固定交付，高控、低控、held-close与六项受影响旧回归分四轮通过；输出增量源码及四轮actual分别取得独立Spec/Quality通过、C/I/M各0/0/0。最终文稿校验/独立批准与中文本地提交及fresh readback，分别按最终固定回执和实际Git回读核定；不表示完整v2/更广B4-B2-7矩阵完成。M1 accepted、schema5、增强 off、readiness=false、worker 未接/未部署、OOM 自动降 tile 重试暂缓保持。

## 1. 目标与边界

交付独立 Windows 原生控制桥 CLI。桥本身是 controller，只启动一个原 ordinary helper，并持有其原创建句柄、真实标准流、原 owner pipe 和独立 observer pipe。对外 stdio 只接受 inspect/close，对 helper 只发送 claim/watch/inspect/stop。

本片没有 prepare/authorize、engine/GPU、TS production host、ExecutionAdapter/runner/store 接线、恢复 reader 注入、恢复或新 attempt。既有 supervisor、只读 reader 和 launcher 的历史合同不由本片改写；控制会话关闭不形成 OwnerDescriptor、ExecutionExit 或 engine completion。

生产源范围为 `workers/image-enhancement/native/windows-control-bridge/` 下的 `Program.cs`、`WindowsControlBridge.csproj`、`BridgeProtocol.cs`、`OriginalControlSession.cs` 与 `BridgeNativeMethods.cs`。专用故障 helper 位于 `native/windows-control-bridge-fixture/`；共享 `native/windows-session-fixture/Program.cs` 只增加隔离控制桥场景，保持默认旧路径；新 OS 用例为 `tests/windows-control-bridge.os.test.ts`。专用 fault 代码不得进入生产桥或 ordinary helper。

完整 bridge/Node/JS/helper/managed-runtime/loader/环境的可信稳定部署是显式 TCB 前提。路径、品牌、摘要或返回的进程身份不认证完整部署；实际 runtime 的窄审计不认证所有部署文件，也不把公开 tag 源码称为实际二进制的精确源码映射。

## 2. 可信启动配置

CLI 恰为两个参数：`--control-bridge` 和一份严格 JSON。配置由可信 bootstrap 显式提供；验证完成前不创建 child，不从 stdin 无界读取首配置，不经 PATH 或 shell 搜索可执行程序，不接受任意 argv 或句柄移交。

```text
{v:1,helperPath:string,recordsRoot:string,installationRoot:string,
 expectedManifestSha256:Hex64,environment:{[name:string]:string},limits:{
   maxRequestFrameBytes:int,maxResponseFrameBytes:int,maxHelperStderrBytes:int,
   maxSessionInputBytes:int,maxSessionOutputBytes:int,maxQueuedOutputBytes:int,
   maxJsonDepth:int,startupTimeoutMs:int,requestTimeoutMs:int,
   sessionTimeoutMs:int,cleanupTimeoutMs:int}}
```

全部 limits 必填正整数，使用精确键及规范数字 token。字节值须适合数组边界，期限须适合正 signed32-bit 毫秒；request frame 不超过 session input，response frame 不超过 session output 或 queued output，JSON 深度须容纳合法 schema。CLI 配置自身先按派生的固定 schema 深度解析，不能让尚未验证的输入配置解除配置解析限制。

路径须为本机绝对 drive path，helper 明确为 `.exe`；原 manifest 为小写 Hex64。路径与环境必须是合法 Unicode、无 NUL，环境名非空且不含 `=`，按 decoded 名称忽略大小写拒绝重复。清空 child 继承环境后只复制该显式环境，loader 所需输入由可信 caller 提供；不回显配置、秘密或原异常文本。非法 CLI 在 Start 前以固定脱敏诊断/exit2 拒绝，不伪造 stdout 生命周期帧。

## 3. 原进程与原通道

1. 把桥 current-process pseudo-handle 直接 duplicate 为真实、非继承 self pin，并从该原对象取得 PID、规范正 UInt64 FILETIME 文本和 SID。
2. 为本次 owner 生成一个随机 pipe leaf，恰一次非 shell `Process.Start`，固定 helper 目录为 cwd，建立新的三路 stdio。只使用既有十参数 bootstrap：`--pipe`、`--controller-pid`、`--records-root`、`--installation-root`、`--expected-manifest-sha256` 及各自固定值；旧四参数模式不用于此桥。
3. Start 前记录 attempted。成功后保留同一未 Dispose 的 Process，以 SafeHandle 生命周期保护借用原创建句柄，直接 duplicate 为非继承 pin；不能按 PID 重开、选 replacement helper 或丢弃原 stdio。Start 尝试后 throw/false/缺可信句柄均为未证创建，不能推成 never-created 或重新 launch。
4. 关闭 helper 不使用的 stdin，独立消费其真实 stdout/stderr。恰一个合法 ready 才能继续；额外 stdout、任意 stderr、读错误或超预算均失败。只有原 reader 的零长度 read 证明 EOF，本地取消/Dispose 不制造远端 EOF。
5. 连接保留 leaf 的原 owner 与独立 observer 两条 pipe。按各自原 SafePipeHandle 查询 server peer，比较原 helper pin 的 PID，重核原 FILETIME/SID/非继承，并在 peer 查询后确认同一原 helper 仍未 signal。禁止 OpenProcess(server PID)、Process.GetProcessById 或按 Job 名重开。
6. 在原 owner claim 一次、原 observer watch 一次，精确关联原 requestId/op/executionId/role/state。全部核验和最终 open/EOF/deadline 检查通过后才可发布一次 bound；初始 observer state 不得先于 bound，最多保留一份受同一 queue 预算约束的最新状态。

原 .NET Process 创建句柄的复用前提须以实际发布 runtime 核定；改变运行库或发布包后，不能仅依据版本号沿用旧二进制审计。PID/FILETIME 是可信原桥的私有运行时陈述，不是部署认证。

## 4. 严格协议与预算

桥 stdin/stdout 和 native pipe 都采用 fatal UTF-8、恰一个 JSON object 加单 LF；拒绝 CR、空帧、BOM、额外后缀、注释、trailing comma，以及各层 decoded duplicate key。使用成熟 JSON parser 加精确字段校验。

**唯一 CRLF 例外是 ordinary helper stdout 的 ready 末尾。** 可移除 LF 紧前最多一个 CR，拒绝其他 CR，CR 和 LF 都计入 frame 预算；不能把这个例外推广到桥 stdio/native pipe，测试也不能靠统一换行归一化掩盖违规原字节。

```text
输入：
{v:1,kind:"command",requestId:Hex32,op:"inspect"|"close",executionId:Hex32}

输出：
{v:1,kind:"bound",executionId:Hex32,
 bridge:{pid:UInt32,creationFileTime:UInt64Text},
 helper:{pid:UInt32,creationFileTime:UInt64Text},state:Snapshot}
{v:1,kind:"state",requestId:Hex32|null,executionId:Hex32,state:Snapshot}
{v:1,kind:"unknown",requestId:Hex32|null,executionId:Hex32|null}
{v:1,kind:"closed",requestId:Hex32|null,executionId:Hex32|null,
 outcome:"stopped"|"unknown"}
```

每种帧只允许列出的字段。Snapshot 是既有八键：`phase/sealReason/requestFingerprint/descriptor/authorizationVerified/resumeState/evidenceOutcome/completion`；本桥 fingerprint/descriptor 始终 null、authorizationVerified=false、resumeState=not-attempted，其余只允许既有 no-request 合法状态。state 的非 null requestId 对应原 inspect 响应，null 只用于核验后的 observer event；state、ready、ACK 或 helper EOF 都不证明 engine 完成。

requestId 单次使用，最多一个普通 inspect 在途；额外普通命令不排队。绑定前、seal 后或非法 prepare/authorize/raw/额外字段不得转发。close、真实 EOF 和 deadline 独立 preempt 等待与输出，首次 cause/cleanup anchor 固定，不由后续帧或重复 close 延长。已 seal 的 inspect 可以继续 drain/correlate 原响应，但不能作为成功公开。

frame、累计 input/output 与 queued output 都按真实 UTF-8 字节计数，包含分隔符和正在写入的帧；超预算后停止捕获但继续原 drain。只有一个受界输出队列/唯一 writer，不用无界 queue 或未观察的后台 write。预算与 deadline 限定观察/捕获政策，不证明 native 内存、CPU、JSON 处理成本或硬实时有界。

## 5. 关闭顺序与两道门

helper stdin 在启动后关闭，与桥控制 stdin 的真实 EOF 是两件事。caller 必须保持桥 stdin；显式关闭时先完整发送合法 close，再结束 stdin。已经接受 close 后，随后的 EOF 只 join 输入，不再竞争 controller loss、不二次关闭 owner或取消原 stop write。close 之前 EOF 才是 controller loss；启动时立即 EOF 不算合法 open。

首次清理最多对原 owner 发送一次 stop；expected local cancellation/disposal 只证明本地 I/O settled，不当作远端 EOF或新的自动协议失败。自然成功还须 stop write 已实际完成，或原相关 stop reply 证明收到；ordinary helper 不保证末 ACK/state 必达，不能因单独缺失判失败。写入失败/不明或畸形/不匹配迟到帧仍为 Unknown。

| 证明门 | 必需实际事实                                                                                                                                                          | 允许的下一步                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Gate H | 原 helper 实际 signal/exit code、真实 stdout/stderr 双 EOF 且无读错误；原 pipe reader/writer/RPC 全部 settled；桥 stdin loop 经真实 EOF join，已无 live native writer | 在相同输出预算下提交最多一个 terminal closed |
| Gate B | Gate H 后 terminal 的实际 write/flush 结果、queue 完成、唯一 stdout writer 及全部剩余任务 join                                                                        | Main 才可结束                                |

Gate H 不等待必须负责交付 terminal 的 stdout writer。自然 stopped 还要求错误为零、显式 close、原 helper 自然 exit0、无强制清理且 stop write 确定完成；其他 outcome 为 unknown。Gate B 不因预算耗尽、输出错误或阻塞而跳过 queue/writer join，不能声称未实际交付的 closed。若输出任务实际以错误 settled 且 H 已证明，可以非零结束；输出仍阻塞则保留 owner/barrier。桥不能观察自己 stdout 的远端 EOF，后片 TS host 必须另证其原 bridge exit/双 EOF/close。

startup/session/request/cleanup 均使用原锚点的单调观察。cleanup 期限到达可先报告 Unknown；之后继续持有原对象等待真实 late facts，不重置期限、不重试或重连。原创建未证、pin/query 失败、流错误或清理未证均保留 owner/barrier，不靠结束 Main 丢弃未知归属。

本片构造上绝不 prepare/authorize，因此在原 helper pin 有效且先尝试正常关闭后，允许在一次 cleanup 期限到达时对该精确原对象请求一次 TerminateProcess。强制清理永远 unknown，不按 PID/name/global kill，不把它推广为将来含 engine 的停止策略；终止失败/不明仍保留 owner。原 helper pins 仅在自身 H 事实证明后释放，sealed bridge owner/barrier 活到 B。晚到 closed 只能描述 eventual cleanup，不能升级任何已经返回的 Unknown。

## 6. 实际验收与证据归属

所有结果按固定源码、实际包和独立运行组登记。相关生产serializer窄修、测试因果/成功权限/合法配额刺激修复、v4单路EOF窄修及其已执行证据已分别取得窄范围Spec/Quality通过；v4→v5三项test/fixture输出增量源码与新五场景/六项旧回归的实际证据也分别独立复审通过，五份生产源未变。只核定下列已实施和已执行范围，不由计划批准、局部通过替代完整v2/更广矩阵验收。编译/加载/guard失败不是行为RED，fallback containment不能挽救失败的行为断言。

| 组                | 必需验证的边界                                                                                                                                       | 当前实际结论                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| ordinary 真实正控 | 原身份 claim/watch、inspect 相关性、close 后真实 stdin EOF、stop write、helper 与 bridge 自然退出/真实双 EOF；原 bytes 分别证明 ready CRLF 与其他 LF | focused v3 的ordinary正控通过；ready CRLF来自独立保留的首轮focused观察，不合计                                   |
| EOF/关闭竞争      | ready 前/绑定后 EOF、helper stdin 与桥 stdin 区别、close 前后 EOF 优先级、一次原 owner loss/stop、无 replacement                                     | lifecycle v3为5通过/1失败；accepted-close期间单路EOF经v4窄修3项focused通过，原失败保留                           |
| 拒绝/身份/格式    | prepare/authorize/raw/额外字段/重复 ID/decoded key 零非法转发；ready/response/op/id/executionId/role/peer 不匹配 Unknown                             | protocol v3为17个真实OS场景加1个oracle-only通过；真实peer spoof仍未证                                            |
| 上限/阻塞         | stdout/stderr/frame/session/queue overflow、单路 EOF/held-live helper、独立取消/期限、真实 drain 与输出关闭门                                        | limits v3的6个已选场景与v5五个输出场景分轮通过，对应固定源/actual独立批准；exact pending write/queue counter未证 |
| 未知创建/晚清理   | 未证创建、失败/晚清理保 owner、无第二次 launch、Unknown 不因晚事实升级                                                                               | 已选withheld-EOF/held-live/单路EOF证实其Unknown边界；真正ambiguous create/OS Terminate失败仍未证                 |
| 字符/隔离         | Unicode/空格/单引号路径、规范 UInt64 FILETIME、独立 sentinel 真实响应与自然退出且未被停止                                                            | 已选held-live/单路EOF的sentinel真实响应/自然退出已核；字符边界按最终逐case清单核定，不由源码推演填通过           |

| 独立实际轮次             | 结果（各轮分别统计）                                                 | 证据边界                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| fixture 健康正控         | 1 passed / 1 mode-skipped，2生成；exit0、stderr空                    | 原 health child/外层原对象、真实双 EOF与原测试Job；不是 ordinary helper 正控                                             |
| 有效行为 RED             | 1 failed / 1 mode-skipped，2生成；exit1                              | 仅 expected bound / received unknown；只创建 scaffold，未启动 ordinary helper，不证明 Gate H                             |
| 首轮 focused（保留失败） | 1 passed / 2 failed / 31 filtered-skipped，34生成；exit1             | ordinary ready 的实际 CRLF 已观测；两项绑定正控因输出序列化深度失败，后轮不追补该轮                                      |
| 核心 focused v3          | 3 passed / 32 selection-skipped，35生成；exit0、stderr空             | ordinary、controlled、pending-close：实际 bound/inspect/close、原 bridge自然0/真实双 EOF；pending inspect 不发布迟到成功 |
| lifecycle v3（部分失败） | 5 passed / 1 failed / 29 filtered-skipped，35生成；exit1、保留失败栈 | 单路 EOF 场景超时并触发 fallback，仍为失败，不能以最终 Job 清空记通过                                                    |
| protocol v3              | 18 passed / 17 mode-skipped，35生成；exit0、stderr空                 | 17个真实OS拒绝场景加1个 constructed oracle-only断言；后者不是额外OS/GPU证据                                              |
| limits v3                | 6 passed / 29 mode-skipped，35生成；exit0、stderr空                  | 帧/累计输入/响应及 stdout/stderr 故障；未验证 session-output/queue/暂停读取闭包，部分故障同时触发多条规则                |
| 受影响旧默认 C0 v3       | 1 passed / 53 filtered-skipped，54生成；exit0、stderr空              | 只证原 harmless fixture engine/transport默认路径，非生产桥 prepare/authorize、Upscayl或GPU                               |
| 单路 EOF 修复 focused v4 | 3 passed / 32 filtered-skipped，35生成；exit0、stderr空              | controlled、held-live、accepted-close期间单路EOF；窄修源/实际复审通过，保留v3原失败，不合并成完整组通过                  |
| 输出 high v5             | 2 passed / 38 filtered-skipped，40生成；exit0、stderr空              | session/queue高控各交付64个合法null-ID事件，原bridge自然0/stopped；先于low与held-close执行                               |
| 输出 low v5              | 2 passed / 38 filtered-skipped，40生成；exit0、stderr空              | session/queue低控先见原owner自主zero-read，再给caller EOF；原bridge自然2/真实双EOF，无fixture或outer fallback            |
| 输出 held-close v5       | 1 passed / 39 filtered-skipped，40生成；exit0、stderr空              | 真pause中合法close/EOF；helper settled/query0/barrier EOF、sentinel响应与原bridge未signal先于resume，之后自然0/stopped   |
| 受影响旧回归 v5          | 6 passed / 34 filtered-skipped，40生成；exit0、stderr空              | ordinary、controlled、pending-close、duplicate-response-frame、held-live、one-sided-eof；定向回归，不合计旧轮            |

上表十三轮分别记账，selection/mode/filtered skip不计执行或通过，不形成跨候选总数。旧单路EOF失败的host final receipt缺失、超时与fallback事实保留；v4只证明经明确close/stop门后的新场景，不补造旧bound/EOF顺序。ordinary核心正控及v5 ordinary回归各有一个合格原OS console，由各轮原Job/SID/FileId事实独立核验并完整join；新五个输出场景没有console，不能概括为所有场景都无console。这不产生helper/engine创建pin证明。

实际v3发布bridge的Process.dll已与审计字节匹配，v5生产五源仍未变而复用该包；四个实际运行包的Process.dll均匹配已审字节，runtime窄审计不认证整个部署。v4 fixture发布exit0但曾有一条CS8602；v5仅将已绑定原query pin保留为非空local复用，fixture/fault发布均exit0、无warning/error，旧诊断保留。v5 Worker type/build、格式/strictUTF8/新增隐私/diff与索引同步通过；输出增量源码独立批准仅覆盖固定v4→v5范围，不代作公开文稿检查/独立批准及本地Git提交。

### 6.1 已确认的关键经验

- 合法bound的CLR身份对象会触发比表面JSON容器更深的converter。只将输出serializer depth2→3；CLI配置JsonDocument depth2、配置输入depth与精确schema不放宽，合成序列化probe与真实生命周期正控分开。
- 负例须实际到达预期阶段并发生目标刺激；post-bound场景不能提前Unknown就通过。成功state须匹配真实已发送inspect ID/允许次数且发生在Unknown之前，坏响应为零成功；原合法结果后重复帧只能保留此前一次成功，不能再返回第二次。
- 配额刺激只用合法JSON内空白或逐条合法帧隔离字节原因；oversized response可能被拒绝而没有完整local write完成，不能补造全量消费。额外stdout、任意stderr等复合故障只证明组合拒绝/drain/清理，不代表每条quota独立隔离。
- 单路EOF窄修是fixture触发顺序：实际bound/成功inspect→合法close/真实caller EOF→helper收到native stop并held→同一barrier释放stdout EOF、确认stderr保持。没有放宽生产策略或超时；旧fallback最终清空Job不升级为健康关闭。local WriteAsync完成不等于远端消费。

### 6.2 已执行的输出验收闭包

五个test-only场景为session-high/low、queue-high/low与高预算held-close，固定交付后已先执行两个high controls，再执行low两例和held-close；actual独立复审通过。quiet prefix恰为bound及唯一成功inspect，没有初始unsolicited event，之后只提供一次有限64条合法native事件；逐exact-stream串行写、全局attempt ID原子分配，attempt/write/flush/failure分别保留，不用全局序号推断并发完成顺序。每对high/low仅目标quota不同，合法负载、读取策略、捕获及期限政策一致。

两个high各交付64个合法null-ID state，随后显式close/真实caller EOF，原bridge自然0/唯一closed stopped。queue-high在实际bound/probe完整chunk处理后、无read in flight时暂停原stdout reader，stderr/control/barrier继续，有限batch完成后一次resume同一reader；没有取消或Dispose来制造pause/EOF。

低控先独立见证原owner的zero-read：caller stdin仍开、只有一条inspect且零close，native stop为零，没有本地cancel/disposal；helper任务settled、query0/真实barrier EOF之后才给caller EOF，queue-low此前保持pause，随后一次resume。低控原bridge自然2、真实双EOF且无fixture/outer fallback；可能没有Unknown/closed帧，不能将缺帧本身当完成证明。session-low有4次event attempt、3次write/flush完成、stdout1279B低于S1536；queue-low为19次attempt、18次完成、stdout5553B。两例各有一次真实native109写失败，未完成写入独立保留，不冒充owner EOF或已发完64条。Q1024限定待写/正在写入的队列字节，stdout累计5553B不代表违反Q；不得将queue cap当累计输出cap。

held-close实际在同一reader真pause期间发送合法close/EOF，一次相关native stop后，helper三项任务settled/query0/真实barrier EOF、sentinel响应及紧邻resume的原bridge未signal均已核定；一次resume后原bridge自然0/唯一closed stopped、无Unknown/fixture force/outer fallback，真实双EOF与原Job完整join。all-N-before-close只用于两个high control，不强加到pause期间close的场景；失败清理先release原gate再join，cleanup release不算成功刺激。

该闭包证明实际原reader pause及与已审源码关联的Gate H/B生命周期，不是直接观测精确kernel WriteFile IRP或private managed queue counter；pipe advisory/peek也不提供该证明。真正ambiguous creation、OS Terminate失败与peer spoof及更广v2矩阵继续明确未证，不用额外注入或静态逻辑伪造真实OS故障。输出源码与actual已分别独立批准，任何一份都不替代另一份或扩大上述证明范围。

fixture 使用原 retained test Job 在 bridge/故障 child 出生时收容，不使用 breakaway 或全局 kill。共享 fixture 默认路径仅按实际变更选必要旧 control；未变 session/reader/launcher 轮次不重跑、不合计，也不增加业务86/Worker24整项通过。

证据必须区分：fixture 直接持有的原 bridge 创建 pin/原 stdio；可信 bridge 关于原 helper 的陈述；原 test Job 的 query/containment census。后者不是生产原创建 pin，bridge 陈述也不是 fixture 独立 helper 创建/EOF 回执。原 Job 被动通知不能替代 exact census，测试 containment Job 不等于 engine Job；实际 OS console 独立定性。普通 helper、专用 fault helper、注入故障、自然清理与 fallback 强制收容分别报告，未证清理目录保留。

## 7. 收口清单与下一片

- [x] fixture健康正控和真正expected-bound/received-unknown行为RED分别固定；原对象/双EOF/guard/清理事实核定。RED只创建scaffold，不证明ordinary helper Gate H。
- [x] 核心focused、protocol、已选limits与v4单路EOF窄修实际证据及对应窄范围源/实际复审分别核定；lifecycle v3原失败仍保留。
- [x] session-high/low、queue-high/low与held-close五场景固定源交付、high先验及四轮actual通过；固定输出增量源码与actual分别独立Spec/Quality批准，不由已选范围宣布完整v2通过。
- [x] 六项受影响旧回归、Worker type/build、格式/strictUTF8/隐私/diff/index、实际runtime与v5无警告发布已核，对应固定输出增量源/actual独立复审通过；v4旧CS8602历史保留。
- [x] 核心及本次所选输出闭包的已实施范围、保留失败与未证边界由对应独立源/actual复审核定；完整v2/更广矩阵未证项保持待验。
- 独立文稿交付门：八份既有文稿加本计划须完成格式/MDX/strictUTF8/隐私/相对链接校验、固定与独立批准，按最终固定回执核定；源码或actual批准不替代文稿门。
- 独立Git交付门：中文服务器本地提交及commit/tree/parent/精确paths/hashes/clean/index fresh readback按实际Git回读核定，不预填提交或未来回读通过；无push/PR/部署/重启或生产修改。

下一片先实现有界 TS stdio host，独立证明原 bridge 的真实退出、双 EOF、close 与 Unknown owner 寿命。再冻结真实 prepare/AUTH、writable/current-attempt/recovery-control 与最后发送边界的单次许可，并接 ExecutionAdapter/runner/store；IPC 不等于 SQLite/Win32 原子事务。AUTH verified、resume 成功和收到 ACK分别核验，ACK 丢失不重复 authorize，Snapshot 不映射为 CompletionEvidence。

图片质量、安装/数据目录与服务身份、GPU/Worker/API/ZEB、TLS/成功流/receipt/清理、用户与部署验收须分别取得真实证据。当前不注入 `readInterruptionEvidence`、不启用恢复或新 attempt，不因控制 CLI 可运行而开启增强或就绪。

## 8. 后续 TS host 实施记录

[有界 TS 控制 host](2026-10-16-image-super-resolution-ts-control-host.md)已完成内部实现、所定技术验证及源码/actual独立复审，详细证据统一见该计划§6，不改变上文历史失败和未证矩阵。原生CLI仍不提供prepare/AUTH，后续权限与Adapter合同分别冻结；增强/readiness保持关闭，worker未接。
