# 大图处理、Worker 多副本与资源排队推进 SOP

结果资源准入暂停已有分项验证：未校准AVIF和超预算PNG均持久保存同摘要的paused子任务、原ImageTask引用及needs_review状态，清活动租约和调度；普通Worker不能领取。File与独立单连接PostgreSQL分别验证PNG同配置显式检查保持原事实、回执和计费不变，调整预算后仅重开同job，首次实际领取才产生执行身份。AVIF增加预算仍不能越过未校准限制；原件、上游与业务attempt保持。普通双copy交付及既有已claim V8资源失败恢复在两Provider各两项另轮回归通过，未新增格式或操作矩阵。完整S3/S4、最终产物和真实桌面故障链仍按下方清单验收。

启动期OOM识别已有真实File Worker分项证据：合法隔离测试配置使实际图像子进程在启动时发生V8堆内存耗尽，真实Worker通过失败Route将原父子任务持久暂停，保留冻结输入、原件和登记；释放预算后的同配置领取为空。新真实OOM、受影响损坏图片和既有OOM后正常任务分别验证通过。仅补充已观察到的V8诊断识别，未知退出仍保留原语义，不改变正常Worker堆、预算算法或接口；独立Web/另一Worker故障同窗、PostgreSQL完整Worker接管与其余取消/中断仍待。包含该修复的独立产物按当前源码另行核验，不能沿用修复前产物声明。

状态：S0/S1材料及S2阶段结果已有证据，见[固定契约与阶段门](2026-10-27-image-processing-worker-contracts.md)和[S2结果](2026-10-27-image-processing-worker-s2-results.md)。S3/S4技术开发与本阶段所定分轮工程验证已完成，尚未部署。独立像素进程、持久队列、父子检查点、执行身份、取消与恢复按各轮实际范围核定；当前Standalone常驻Worker/Chromium代表链及最终镜像分发另有新产物证据。下文历史分项记录保留原失败和限制，当前阶段结论见本节收口，不以旧待办重跑已闭合行为。

prepare/build的失败上报已有File与真实PostgreSQL单连接池局部验证：真实子进程关闭后的拒绝、受控资源报告、无效报告不改状态、旧身份拒绝、当前父依赖守卫、失败回执重放及父子回滚。原件、暂存工件、检查点和冻结配置保留；内部诊断不进入父公开文案。PG实际持父锁跨过租约截止后拒绝且完整行不变；File新增过期用例仅证明有效调用跨截止后拒绝，未观察到实际进入mutation队列。受控报告不代表真实OOM；其余取消恢复组合和完整故障链仍待验收，native实际Worker/Agent结果分项见下文。

prepare/build的内部child-only取消局部门已通过File与真实PostgreSQL单连接池检查。它核对真实用户/Run绑定及已保存的父取消意图，只更新指定子阶段：锁后仍pending则置cancelled/completed并清活动owner、租约、心跳和调度；已running则置cancelled/cancel_requested并只清调度，原owner、executionId、租约、心跳、冻结输入与暂存证据保留，租约过期也不伪造关闭。有效当前owner心跳仍可读取取消意图，过期或旧epoch拒绝；终态及取消重放保持完整父子行不变。两项真实PG进程竞争分别证明取消持子锁时领取跳过、取消等待父锁时已提交的领取owner被保留，原三项独立进程领取/接管回归也已同轮重跑。测试中的父取消是显式持久化前置，尚未接入实际Run/action；Worker预算归还、Worker中断后的持久取消恢复和Agent整链路仍待验收。

prepare/build取消关闭确认已实现并通过File与真实PostgreSQL单连接池局部检查：实际Task2正PID关闭后，原owner通过heartbeat提交closed固定投影与stopCause，服务端保存私有cancelClose及稳定cancelled/completed收据并清活动字段。仅原取消owner可在lease过期后ACK，普通过期heartbeat仍409；相同报告只读重放首次收据，父行、冻结输入与暂存证据保留。

独立File/prepare真实Next TCP夹具已观察子进程SIGTERM关闭及ESRCH；代理仅转发一次，读完首次200及精确收据后丢弃全部响应，调用方得到fetch failed，再将原请求直接重放至同一Route，返回相同收据且完整父子行与工件描述不变。工件在中止前已暂存，不是aborted子进程的产物；此为控制接口局部网络资格，不能替代实际Worker或全部TC-Q04。not-started确认、实际Worker的close/I/O drain与恰一次预算归还、跨Worker/容器中断恢复、Run/action、native及Agent整链仍未完成。

S1父关系已按操作修约：prepare_reference/build_protection仍以Agent Run为父，仅process_result由实际ImageTask当前租约授权；原Run只是可选业务关联。取得/封版/恢复与窄投影规则见[固定契约第4.3、7.1、7.2节](2026-10-27-image-processing-worker-contracts.md)。修约固定后续实现要求，不代表collector、B事务、alpha事实或receipt补偿已有运行资格；prepare/build原摘要及已取得资格保持。

配套文档：[大图处理与多 Worker 稳定性测试用例](2026-10-27-image-processing-worker-test-cases.md)，包含43个设计用例及已有测试复用边界。S2执行范围见阶段结果；S3/S4模块与入队检查不代表整条设计用例通过，其余按新链路逐项补证。

结果处理补充分项：普通非保护Run的4K请求已通过CPU Worker原生字节保留、原ImageTask/日志、Agent采用与重放检查；本地及对象存储原件、冻结辅助源和最终结果已有分轮证据，包含关闭新写入后的原对象读取与交付。File modes24/24为此前轮次，独立单连接PostgreSQL modes10/10为后续轮次；普通Run的4K请求另轮仅聚焦两项并保留未运行项，不合并总数。其余商品保护/分层/Canvas Run分支、其他Web像素入口、完整故障、真实HTTP/SSE/桌面及最新最终镜像仍需补证，S5 Compose、多人容量和部署未执行。

2026-10-30场景链路补充：历史inline局部场景Run结果已分别通过File、PostgreSQL各一项，覆盖1024×1024原图、外部确认的256×256选区、永久蒙版与final保存、原账单和日志、Agent采用及重放。此行保留历史inline结果的独立范围；当前native结果资格按下述实际双copy和技术QA轮次另列。

当前native场景在File夹具中已走通真实参考prepare、鉴权选区receipt、claim A、原生蒙版完成和新claim B；两份ImageTask通过实际POST建立，仅copy 1继续首提交，实际provider表单、画幅、一次attempt及原流水消费2积分取得证据。提交前拒绝已分别核对源字节变化、蒙版字节变化、同用户其他真实native job的蒙版，以及蒙版流读取期间的逻辑child或图片租约身份变化；完整财务、native记录、登记和第二副本保持。源字节由既有frozen-source门拒绝，其余四项属于native提交桥；实际分轮计数见配套测试文档。

native场景的File用户恢复与明确终态失败后的一次自动重试已补限定资格：实际蒙版字节复核后恢复原字节，用户recover在同一ImageTask完成首份提交；实际查询解析明确失败后，原attempt完成失败并按原流水退款，清理原上游身份后仅再提交一次，新attempt使用新消费流水；第二次明确失败终结并退款，后续领取为零。原Run逻辑attempt/copy、native证据及第二副本保持。原两门RED为File 2失败/7名称过滤跳过（9项）；后继GREEN另轮为8通过/1跳过（9项），相邻单元另轮59/59，格式、ESLint和完整Web类型检查通过；不与此前六例或其他轮次累加。

连续性、Agent参考恢复与独立进程参考恢复已补真实登记素材、原生prepare和新的父领取证据。各轮按实际筛选分别记录，原File/PG组合720秒超时仍保留，后续拆分通过不证明原超时根因，也不记作一次全套运行。

当前native局部场景Run的双copy结果已分别通过File与独立单连接PostgreSQL完整正例：真实prepare、认证选区receipt、原生build、新父领取与两份实际POST，随后由各原ImageTask取得native、CPU Worker完成保护合成并消费原结果；原build蒙版永久保留，final、原attempt/账单/日志、Agent资产采用、兄弟copy隔离与完整重放均已核对。enqueue/input/upload/complete/consume五个边界的故障按File与PostgreSQL各自轮次验证；PostgreSQL另有真实原蒙版登记行锁等待及锁后单登记漂移拒绝，完整快照守恒。该锁门不等于租约过期门，也不代替File锁竞争验收。

native Agent技术QA先取得有效业务RED：Web观测为raw 4、stats 2、toBuffer 4，resize/toFile为0；完成记录桥接后，File与独立单连接PostgreSQL分别通过原native及受影响inline两项回归，其中native观察窗口的raw/stats/resize/toBuffer/toFile均为0。inline仅作受影响回归，没有独立spy资格；既有QA套件111/111为另一轮。新增当前final同长度损坏与真实uniform_scale映射两案，File、PostgreSQL各自独立两项通过：前者按实际文件摘要阻断并暂停，后者由512×512原生图经CPU Worker得到1024×1024结果并被Agent采用，两案各自五项Web像素调用为0，原媒体、保护像素、账本与重放后继保持。该资格限定这些native观察窗口，不证明pixel_grid_scale、其他Web像素入口或整条/create通过。

native PostgreSQL生命周期分项：用户蒙版复核恢复项在原两项轮次中通过；明确终态重试项当轮已到首轮失败与退款，但第二提交被PostgreSQL空结果载荷判断阻断，构成有效业务RED。修正该单一空载荷判断后，原PostgreSQL重试项独立通过，实际第二attempt/新消费流水、原流水退款、第二次明确失败终结、无第三create与终态重放均到达；受影响File重试项另轮通过。原前置失败与业务RED保留，恢复项、重试后继和File回归不合并为同轮全过。

S3/S4仍未完成。启用用户图片配额另轮取得独立单连接PostgreSQL四项通过（4通过/23名称过滤，27项）：消费2积分与真实零积分分别覆盖成功消费/重放和两次明确失败/退款/终态重放。有限dailyImages=1时，成功沿原native、三输入CPU结果Worker和原消费保持用量1且不重复扣费；失败按不同生产attempt键与原流水退款，用量1→0→1→0，零积分也保存真实消费/退款记录，终态后领取0、recover 409且无第三次创建。原兄弟copy、源图/蒙版及prepare/build保持，测试计划/分配清理与设置语义恢复已核对。该轮不包含日积分桶、付费订单、系统全局代理或多人容量验收。

W7原生场景4K基线冻结先取得有效File业务RED：真实prepare、认证Action、build、claim B与两份实际POST/pending及守恒均通过，原build未冻结baseline、两delivery缺失，在qualified基线断言失败；诊断窗五项为0，后续delivery严格相等及最终五零断言当轮未到。补齐producer→POST桥后，File 1通过/18名称过滤（19项）、独立单连接PostgreSQL 1通过/26名称过滤（27项）分别通过：原build请求freezeEnhancementBaseline并返回qualified local_edit，两份原ImageTask的delivery严格等于该Worker基线和原源图/蒙版契约；覆盖claim B、源/蒙版复核、POST及pending GET的广域Web观察raw/stats/resize/toBuffer/toFile均为0，原字节/阶段/登记和无provider/无扣费守恒保持。既有delivery套件27/27、受影响低清native与inline在File和PostgreSQL各两项回归分别另轮通过，不合并统计，也不授予4K结果资格。该冻结轮次仅授予POST冻结资格；结果与故障后继按以下独立轮次核定，增强默认false、GPU未运行。

native创建响应不确定另轮取得独立单连接PostgreSQL限定资格（1通过/27名称过滤，28项，仅2积分且启用dailyImages=1）：受控provider完整接收原源图/蒙版multipart后真实消费一次，客户端实际取得计费headers并开始真实JSON解析，屏障随后中断响应body，自然产生原typed Uncertain。原ImageTask保持running/needs_review、原attempt和消费/图片用量保留，不退款或自动再创建；后继batch领取0、真实认证TCP GET 200/recover 409，以及携原请求key的实际认证create Route重放200并返回原ID均到达，每步完整原始任务/媒体/财务快照守恒。charged解析wrapper未到达；create-key重放不是原HTTP body的wire重放，受控provider不代表系统全局代理或真实供应商整链。该项不授予File、零积分、日积分桶、订单或容量资格。

4K局部场景结果后继已在File、独立单连接PostgreSQL分别通过原双copy完整结果链：冻结基线、CPU结果Worker、原ImageTask消费、永久蒙版/final、Agent技术QA、父链资产/消息、原账单及完整重放保持。POST流式故障的源图变更项在原File双例轮中单项通过，同轮receipt项失败、整轮exit1保留；receipt夹具校准后另轮单例通过，未重跑源项。两项故障分别为：原源图首磁盘chunk后同长度末字节变化、原字节读取期间receipt确认变化，分别由真实最终检查拒绝，完整持久行/文件/财务守恒与实际流和handler排空均到达；不据此扩展PostgreSQL故障矩阵。原失败、夹具校准和成功轮次分别保留。

电商结果接入补充：非4K strict_product、非4K全局scene_edit，以及合法full_image交付的4K全局scene_edit，均已取得File与独立单连接PostgreSQL的分轮完整资格。真实上传/prepare、规划/compiler及POST后，由原ImageTask取得原生结果，ordinary CPU Worker仅处理原生输入、不传targetSize或伪造蒙版；完成事实继续供Agent技术QA使用，Canvas/完整batch证据、最终父链、单次扣费与重放保持。对应各正例的六个Web观察窗口中raw/stats/resize/toBuffer/toFile均为0，逐窗raw对象未另行打印。4K全局场景保持冻结full_image契约、原始字节和disabled跳过元数据，只登记一个已完成的skipped增强任务，不领取增强租约或提交GPU。该4K质量档位用例遵循原图精确1024×1024画幅，不授予原生4096像素负载或照片画质资格；受影响的非4K全局场景及普通4K回归另scope通过。

低清商品局部编辑已取得独立分轮资格：count1/quality low/exact1024×1024的local_edit + strict_product使用商品锚A和不同的场景源B，真实两prepare、B的local-edit-target.v1蒙版及POST后，由原ImageTask取得native，经无targetSize的ordinary CPU Worker、原消费和Agent技术QA完成。File本例19525ms、PostgreSQL本例19807ms分别通过，既有白底商品File回归另scope18119ms通过；各Provider七个Web观察窗的raw/stats/resize/toBuffer/toFile均为0。Canvas/完整batch、原消息、A主父资产及metadata.parentAssetIds=[A,B]、单笔-2积分/单条日志与完整重放保持。File父测试库设置raw完全一致，PostgreSQL父测试库设置仅updated_at审计变化、非审计全列一致。局部unmodified_region为N/A，视觉质量检查和增强关闭；不宣称选区外像素保持，亦非真实GPU/照片质量、fullproxy、终态调度租约释放、真实浏览器或完整S3/S4验收。

4K商品局部编辑另增分轮资格：count1、quality4k、exact1024×1024的local_edit + strict_product沿用低清已接入的同一生产实现，保留不同商品锚A与场景源B。真实双prepare、B的local-edit-target.v1蒙版与实际POST后，原native经无targetSize的ordinary CPU Worker、原ImageTask消费及Agent技术QA完成；Canvas/完整batch、A主父与metadata.parentAssetIds=[A,B]、原消息、原source/mask及双prepare/B build、原单笔-2积分/单条日志和完整重放保持。既有disabled且无delivery合同保持，无nativeSource/enhancementId且无增强job，局部unmodified_region=N/A，不宣称选区外像素保持。各Provider七个父Web窗的raw/stats/resize/toBuffer/toFile均为0，Worker窗包括父进程HTTP处理和消费；CPU执行在另一PID，夹具生成及显式像素断言在观察窗外。

File本例另轮20064ms通过（1通过/27名称过滤，28项；scope24.35s），独立单连接PostgreSQL本例另轮20089ms通过（1通过/36名称过滤，37项；scope24.32s）；两轮均先实际列出用例并确认唯一完整名称。此前File筛选轮因$title名称截断而28项全跳过，退出0仅为0业务执行，不授GREEN或RED；改用tuple %s后才取得上述独立通过。历史low的19525ms/19807ms轮次保留，当前low档新增metadata断言未获执行资格。File父设置含审计字段raw完全一致；PostgreSQL父设置仅updated_at变化、非审计全列精确恢复，父/子对象设置raw完全一致。本片仅新增4k档位资格，未改生产实现；原exact1024请求不授4096像素负载、真实GPU/照片质量、真实Next/常驻Worker/桌面浏览器或完整S3/S4资格，不合并为历史或整套通过。

单连接对象原件读取单列回归：真实4×4 PNG在只读事务持有期间遇到配置缓存自然过期，原实现8403ms失败，5秒截止仅PUT而无GET；沿同一执行器读取后，同一测试原文3399ms通过，事务内完整facts、真实PUT+GET和登记守恒均到达。该内部读取修复不替代商品局部编辑的S3业务链验收，不并入File/PostgreSQL业务正例轮次。

非Run 4K分层结果新增File限定资格：真实登录session的正式POST经系统逻辑模型、实际system Route和本地TCP relay到受控provider；持久配置4k/1:1/layers不改，实际请求为high/2880×2880、无n和原source字节。两native与永久冻结原source组成三输入CPU Worker，layers无targetSize；原ImageTask消费两份4×4 element/background原字节，稳定result身份、永久登记、单条日志、两资产及原单笔-2积分保持，完整重放不新增provider或扣费。POST、claim/create、persist、consume和replay五个Web窗的raw/stats/resize/toBuffer/toFile全部为0；保留disabled skip，结果无enhancementId/nativeSource且无增强job。

原持久配置matcher前置失败只到POST/任务保存，未授业务RED；修正夹具后，在已完成真实provider、单次计费与result_ready的原native首门因nativeResults缺失取得有效业务RED，无result断言和后继当轮未达。完整File正例另轮15481ms通过；既有provider分层14390ms与普通4K10764ms在受影响回归的另一scope各通过，不合并统计。该4×4夹具仅验证4K请求路径，不代表4096像素负载、PostgreSQL专项、真实Next服务/浏览器、Agent Run分层、Canvas、GPU或完整S3/S4；本轮未部署、未运行S5 Compose。

4K白底商品结果新增File与独立单连接PostgreSQL分轮资格：count1、quality4k、exact1024×1024，既有增强disabled且无delivery。真实上传/prepare/build/规划/POST后，原ImageTask先封native，再由无targetSize的ordinary CPU Worker交付原字节并消费；Agent技术QA、Canvas/完整batch、商品父链与原消息绑定、永久原件/final、原source/mask及prepare/build、原单笔-2积分/单条日志和完整重放保持。沿旧无delivery合同保留disabled skip，无nativeSource/enhancementId且无增强job，不补签product_background或开启freeze/GPU。各Provider的dispatch、claim/create/query、persist、Worker/consume、Agent及replay六个父Web窗中raw/stats/resize/toBuffer/toFile均为0；Worker窗包含父进程维护HTTP处理与消费；CPU子进程像素执行不计入父进程计数，夹具生成及显式结果像素断言在观察窗外。

原首门5974ms为有效业务RED：真实上传/prepare/build/规划/POST及原helper领取/创建/计费/查询result_ready已达，nativeResults真值断言失败；具体native值/slot与两项Web零断言当轮未打印或达。File完整正例另轮18588ms通过（1通过/26过滤，27项）；独立单连接PostgreSQL同例18204ms另轮通过（1通过/35过滤，36项）。File低清白底18286ms、普通4K11402ms为另一scope两项通过（2通过/25过滤，27项），不合并统计。File轮次父测试库设置含审计字段raw一致；PostgreSQL轮次仅updated_at审计变化，非审计全列精确恢复，父/子对象设置raw一致。该4K请求以原1024×1024 native交付，不授予4096负载、真实GPU/照片质量、真实Next/常驻Worker/浏览器或完整S3/S4资格；本轮S5 Compose及部署未执行。

增强发布producer沿Worker完整AI PNG→闭合文件流核对长度/SHA/字节上限→临时自有 `enhancement-raw-ai`→冻结实际原图绑定→原子入队独立 `process_enhancement`。旧模型下File及单连接PostgreSQL实际创建无execution的资源暂停，并由新进程读回；原图/资产不变，无提前永久发布或ACK。此前producer、任务客户端、CPU恢复和离线G4证据保持各自范围。

当前 `image-processing-memory.s3.v4` 与CPU编译产物已核对：global JPEG为1536MiB，legacy PNG/product/scene各1280MiB，仅覆盖当前producer/B0和已定义的PNG8 RGB(A)/JPEG3角色与几何域；未知域继续uncalibrated，工程reserve不是通用内存上界或并发容量。成功consumer核验闭合child的完整AI及CPU交付物，先固定永久promotion键并保存原字节，再沿PostgreSQL同事务或File既有creative→generation→enhancement→registry锁序提交资产父链，最后发送原receipt/ACK；保留原ImageTask/native、原资产、remote ID、binding和raw TTL。媒体保存失败后的显式retry仅续publication，不新增CPU、RAW下载或CREATE。

无保护全局增强的原File publication/ACK尾段、单连接PostgreSQL原资源暂停→显式retry/新execution→正式supervisor CPU/真实产物上传/complete→publication/HTTP ACK，以及隔离File副本一次媒体I/O失败后恢复，分别为1通过/4名称过滤；File尾段及故障恢复复用原闭合child，未重跑CPU。该资格限受控本地Worker fixture与真实CPU边界，不覆盖磁盘满、S3网络故障、常驻HTTP CPU Worker、GPU/照片质量或完整Agent `/create`。旧25项为历史迁移清单，按本阶段真实行为与可达性核定，不作为当前未完成计数；本条历史资格不单独授完整阶段通过。

本阶段收口：最新严格类型检查和Standalone构建通过；7997×5334商品参考图经交付目录内常驻Worker及七个短子进程完成预处理、保护、结果处理和视觉准备，Chromium结果显示、刷新及原Run读取通过，同窗health/status各112次均200，SSE自然完成。该轮业务用例及三项必要初始化通过，原外层退出码1因资源组消失时观测脚本读取失败而保留；五份原资源回执与另轮只读核对支持清理结论，不改记整轮exit 0。当前Standalone与最终镜像内同一小图保护任务输出一致，Sharp/libvips、镜像普通用户、runtime与四个运行脚本及默认Web静态资源已核对。各轮不合并为一次总通过，不授多人容量或真实照片质量资格。

## 1. 目标及交付边界

目标：让大参考图处理具有可计算的资源开销；支持一个 Worker 服务启动多个副本；图像计算与 Web 隔离；容量不足时持久排队；中断后从已完成阶段继续。

完成必须同时证明以下行为：

1. 当前问题尺寸的商品图能够完成原尺寸保护处理。
2. 图像处理资源耗尽不会导致 Web 随之崩溃。
3. 多副本不会同时占有同一有效执行身份，不会用旧结果覆盖新执行结果。
4. 并发处理量受真实 CPU、内存预算约束，排队任务不会提前完整解码。
5. 已完成分析、编辑方案和蒙版可以恢复；已有上游提交身份继续沿用。
6. 页面显示真实阶段，资源失败不再表现为无期限等待和循环重启。

首版配置采用环境变量和 Compose；每个 Worker 副本先验收同时一个重图像任务。最终允许的副本数与并发值由完整任务压测确定。

本 SOP 的阶段使用 S0—S8 编号，与项目其他功能的里程碑编号无关。

## 2. 已取得的依据与仍需验证的内容

已经取得的证据：

- 问题会话的参考读取与视觉分析已通过，尚无保存的编辑方案和生图子任务。
- Web 日志反复出现 V8 heap OOM，进程随后重启。
- 同尺寸合成背景直接执行当前分割源码，在现有 384MiB old-space 配置下可复现 OOM。
- 现有 Worker 通过 HTTP 触发 Web 执行；增加当前 Worker 不等于像素计算已离开 Web。
- 此前大图桌面回归使用大风格参考图与小商品图，没有覆盖大商品分割。

不能据此宣称：已经证明每次线上崩溃的 JS 分配语句、测得完整任务峰值、修复完成、支持特定人数、真实照片质量通过。

S0基线阶段已核对开发源码分支、当时干净的 tracked 工作区、Node 22.22.2、pnpm 11.9.0、包脚本、CI 和桌面测试入口。后续开发保留已有改动，逐阶段按准确源码与原始回执核验。运行环境中的镜像、任务与资源会变化，进入实际开发或发布时再定向核对。

## 3. 目标执行路径

```text
Web 接单与持久化
  → 参考预处理阶段入队
  → Worker 领取、预留资源、启动图像子进程
  → 完整解码校验、原尺寸读取、生成分析缩图
  → 保存产物引用和阶段结果
  → 视觉分析与参考角色确认
  → 编辑方案校验并立即保存
  → 原尺寸商品保护阶段入队
  → Worker 子进程构建保护区域和蒙版
  → 保存蒙版引用、hash、尺寸、算法版本
  → 沿用现有上游创建与查询路径
  → 实际ImageTask原claim取得/封版原槽原件
  → 同image原子建立结果依赖并让出，Worker处理process_result
  → child只唤同image本地保存，新合法image claim关联结果
  → 原图片成功链及现Agent poll/patch投影可选Run
```

Web 与队列中传稳定资产 ID、hash、参数、阶段身份和存储引用。完整 RGBA、大幅蒙版及长 base64 不作为控制消息反复复制。

现有 PostgreSQL 队列、租约、服务令牌与媒体 Provider 继续作为基础。文件 Provider 的现有单服务行为需要回归；多 Web 实例的文件 Provider 分布式能力不属于本次交付。

## 4. 全程执行规则

- 每一阶段先记录入口提交、当前差异、前置阶段证据，再实施。
- 每一项只能标记为未开始、进行中、通过、失败、未验证或受阻；未执行不能填通过。
- 每个测试轮次单独保存命令、退出码、输出、源码身份和环境；失败轮次保留，不被后续成功覆盖。
- 已通过且源码未受影响的验证复用；重跑必须指出相关变更或未解决风险。
- 公共文档使用技术案例名；真实会话、部署地址、服务器路径、账号与原始业务证据留私有记录。
- 对问题会话的取消、重试、重新生成是业务操作，不因编写或执行 SOP 自动发生。
- 当前授权推进S3/S4；S5及后续阶段、提交、推送、合并、部署分别遵循届时明确的任务范围。既有授权不重复索取，也不把先前单次发布当作任意新发布授权。

## 5. 阶段总览

| 阶段                  | 交付物                                   | 进入下一阶段的条件                     |
| --------------------- | ---------------------------------------- | -------------------------------------- |
| S0 基线与规格         | 基线、范围、用例、资源测量方式           | 入口与验收目标明确                     |
| S1 契约与方案固定     | 模块边界、阶段状态、配置、存储和打包设计 | 新旧执行路径及恢复规则可逐项说明       |
| S2 算法与单任务预算   | 原尺寸算法修复、回归、完整峰值报告       | 正确性通过、内存开销有界               |
| S3 Worker 执行与隔离  | 图像子进程、产物链路、镜像内入口         | 重计算离开 Web、故障范围明确           |
| S4 持久队列与恢复     | 原子领取、执行身份、检查点、故障恢复     | 并发和恢复行为通过真实 PostgreSQL 验证 |
| S5 配置与多副本       | 容量表、资源准入、排队、Compose 扩容     | 不超卖预算，多副本无重复提交           |
| S6 综合验收           | 桌面、多人、故障与长稳证据               | 各类证据分别通过或明确受阻             |
| S7 固定交付与测试发布 | 审核快照、镜像、发布和恢复记录           | 实际授权范围内发布并完成读回           |
| S8 用户验收与收尾     | 原照片验收、文档、最终状态               | 用户验收结论和剩余限制明确             |

## 6. S0：固定基线与验收规格

### 操作步骤

1. 读取最新用户要求、目标目录 AGENTS、开发/数据库/部署文档和最新私有进度。
2. 核对分支、HEAD、tracked 与 untracked 差异。复用适合的开发工作区，保留用户改动。
3. 固定本次输入案例：原问题尺寸的大商品锚点、大风格参考、小图控制组、透明图、细腿镂空、EXIF 旋转、多主体、损坏图、64MP 边界与超预算图。
4. 将实际照片保存在授权私有位置或保留其既有私有媒体登记身份；记录是否重新核验过字节。测试需要的通用合成夹具与业务照片分开管理。
5. 固定三个测量对象：图像子进程 RSS、整个 Worker 容器总量、Web 可用性与事件循环延迟。
6. 在隔离环境确定基线。旧实现已经取得的 OOM 证据复用；不在正在使用的 Web 反复制造崩溃。
7. 明确测试资源额度、负载层级、持续时段与 API 响应目标，写入测试运行清单；这些参数在执行负载前固定。

### 验收标准

- 所有案例能回答验证哪个对外行为。
- 当前调用链、同步重计算位置、既有状态恢复入口已记录。
- 对需要新写回归的行为有明确预期；不机械补与本次无关的矩阵。

### 证据及失败处置

交付 `baseline.json`、`scope.md`、`acceptance-manifest.json`。若工作区身份或同一位置改动归属不明，保留现场，继续可独立的文档和夹具设计。

## 7. S1：固定模块、阶段及配置契约

### 操作步骤

1. 绘制实际入口到效果的调用图，确认以下既有文件的职责和调用方：
   - `web/src/lib/server/agent-run-executor.ts`
   - `web/src/lib/server/ecommerce-generation-service.ts`
   - `web/src/lib/server/ecommerce-generation-snapshot.ts`
   - `web/src/lib/server/generation-task-store.ts`
   - `web/src/lib/server/generation-task-scheduler.ts`
   - `web/src/lib/server/generation-task-recovery-service.ts`
   - `web/src/app/api/maintenance/generation-tasks/run/route.ts`
   - `web/scripts/generation-worker.mjs`
   - `web/scripts/generation-runtime.mjs`
   - `Dockerfile`、S5 列出的业务 Compose 与测试站实际启动文件、Standalone 打包路径。
2. 明确参考预处理、商品保护、结果处理的输入输出。输出包括原尺寸、原件 hash、分析缩图引用、保护产物引用；不得以缩小的蒙版冒充原尺寸保护。
3. 沿用任务表设计：prepare/build与Run建立依赖，process_result使用ImageTask私有nativeAcquisition/nativeResults/resultProcessing；结果parent_task_id指实际image，run_id仍为可选关联。实际字段和恢复边界同步数据库文档，不另建队列或假Run。
4. 规定领取、续租、完成、取消接口的职责。控制接口只做鉴权、边界校验、元数据事务和响应，不直接执行像素计算。
5. 规定领取过滤条件：旧 HTTP 恢复入口不领取新图像阶段任务，新领取入口只领取对应类型。按实际风险实现最小必要的版本边界。
6. 规定执行身份检查。写入结果必须仍持有本次有效执行身份；旧执行迟到不能提交。
7. 固定子进程的构建方式和镜像内入口。运行产物必须脱离源码目录、开发依赖和临时 tsx 工具仍能启动，并携带对应平台 Sharp/libvips。
8. 固定环境变量的最终名称、单位、有效值、启动时机和错误响应。首版配置通过受控重建生效，活动任务先排空。
9. 保持既有参考输入 64MP、视觉输入 2048px/4MiB、生成输出默认保护和原图身份规则；不为了“跑通”统一扩大其他预算。

### 配置清单

| 配置能力            | 规格必须说明                                   |
| ------------------- | ---------------------------------------------- |
| Web V8 堆           | MiB、作用于哪个服务、Compose 覆盖顺序          |
| Worker 监督进程堆   | 与子进程是否分别传参、避免意外继承             |
| Worker 容器总内存   | 包含所有子进程和原生分配                       |
| 图像子进程堆        | 仅约束 V8，不代表 RSS 硬上限                   |
| 单副本处理预算/并发 | 解码前准入、任务完成后释放                     |
| Worker 副本数       | 部署操作与唯一身份                             |
| CPU/Sharp 并行      | 按实际需要配置，避免副本乘内部线程造成过量竞争 |

### 验收标准

- 可以逐项说明正常完成、排队、取消、退出、接管和迟到结果的状态变化。
- 输入在网络、文件、环境变量、数据库和子进程边界各自校验一次；内部不重复堆叠检查。
- 配置项均对应当前需求，源码模块按职责需要建立，不预建空抽象。

交付 `contracts.md`、调用图、配置表、状态转换表、打包清单。契约未固定的模块不开始跨模块实现。

## 8. S2：修复单任务内存开销并测出预算

### 操作步骤

1. 添加能暴露大商品保护处理失败的回归，覆盖实际实现及最终蒙版行为；原 OOM 在隔离子进程中观察退出，不让测试 runner 一起崩溃。
2. 使用小图和精确蒙版像素断言固定现有保护语义。
3. 替换逐像素增长的普通数组和主体 Set；使用紧凑标记、可复用工作区，按遍历统计连通域面积、边界和必要候选摘要。
4. 维持四连通、背景边界连通、白/透明判断、多主体判定和原尺寸输出。
5. 明确原图、解码 RGBA、遍历工作区、蒙版及编码缓冲的生命周期，减少同时保留的全图副本。
6. 在实际进程配置下执行完整“读取—解码—分割—编码—保存”，分别测小图、问题尺寸和 64MP 边界。
7. 记录内存模型和实际峰值；使用相同输入、源码和配置作可复现比较。

### 资源预算计算

```text
单任务预算 = 进程基础内存
           + 解码像素缓冲
           + 算法工作区
           + 同时存在的输出缓冲
           + 编解码原生开销及实测余量
```

不能只用 heapUsed 验收，也不能把 TypedArray 移到堆外当作消除了内存开销。单函数复现数值不是完整任务峰值。

### 验收标准

- 原问题尺寸作为商品锚点完成处理。
- 小图保护结果保持既有语义，细腿、镂空和透明边缘符合测试预期。
- 完整任务在所声明资源预算内完成，无 OOM，无未经约定的缩图降级。
- 输入损坏、超既有预算、多主体等可达拒绝路径仍清晰。

交付回归报告、`single-job-memory.json`、算法工作区说明和源码 diff。失败时先定位内存持有位置，不能直接提高堆、延时或重试次数掩盖失败。

## 9. S3：实现图像进程与 Web 隔离

### 操作步骤

1. Worker 使用 S1 固定的受控入口启动图像子进程。监督进程只调度、续租、收集阶段结果。
2. 将本链路全像素处理迁入子进程，核对视觉准备和结果处理，避免只移动分割循环却留下 Web 完整解码。
3. 输入通过授权媒体路径读取；保存产物后传回小型结果描述。
4. 接入本地和 S3 两种既有 Provider；源媒体继续按登记的 Provider 读取。
5. 在实际 Standalone/镜像内验证执行入口、Sharp PNG 编解码和同一合成保护任务。
6. 在隔离夹具中注入子进程失败，检查 Web 健康读取、SSE 与其他 Worker。

### 验收标准

- 图像任务的重 CPU 和大幅 RGBA 出现在受控图像进程。
- 子进程正常退出后，进程占用被回收，监督进程仍能处理下一任务。
- JS OOM、原生/容器 OOM、未知退出分别保留证据；不把 SIGKILL 直接解释为 OOM。
- 容器 OOM 可能连监督进程一起终止，实际隔离边界按 Worker 容器说明，不能承诺 fork 等于每子进程 RSS 硬隔离。

交付 `process-isolation.json`、镜像内执行记录、媒体读写回归。若产物缺少入口或原生包，只修打包缺口，不回退到 Web 内计算作为成功路径。

## 10. S4：持久队列、阶段检查点与故障恢复

### 操作步骤

1. 用现有 PostgreSQL 事务领取任务，查询范围按任务类型、状态、到期和容量限定。
2. 准入后才领取适合当前副本执行的任务；等待任务不占活动计算槽，避免批量占租约后排队。
3. 续租、释放及完成提交在取得持久锁后复核当前 Worker、执行身份和尚未过期的租约；重复完成幂等，旧执行不能覆盖新领取。
4. 编辑方案在蒙版前保存；预处理及蒙版产物保存完成后再标记阶段完成并唤醒同一 Run。
5. 数据库成功而响应丢失时允许读回完成结果；媒体写成功而完成事务失败时，重试阶段提交并按生命周期处理未引用产物。
6. 已确证资源耗尽暂停对应阶段，保留输入身份和配置证据，阻止同一失败配置自动循环执行。
7. 进程中断与确定业务失败分开。上游已提交或结果未知时沿用查询/复核规则；模型调用中断的未知结果不能伪称已完成或保证可无损重放。
8. 排队取消与领取竞争原子处理；运行取消只作用于本次执行拥有的图像进程。
9. 回归 PostgreSQL 单连接池事务和既有文件 Provider 单服务行为。

原图片任务在现有 `payload.executionId` 中保存每次领取的新私有身份；心跳保留该身份，同一 Worker 重新领取也必须换值。恢复、结果保存、错误处理和取消释放都传原持有租约的身份，不能从后续任务读取取得新身份。真实锁等待跨过截止后必须拒绝续租与释放；正对照仍能正常续租/释放。该边界不等于旧上游调用和计费的全部写入已经隔离。

### process_result实施顺序与取得恢复

以下为持续核对的实现与验收门，覆盖普通无Run、非电商、同步no-ID、多copy与多结果，不扩S5或运行Compose；已取得的分项证据见上方状态，尚缺证据的部分继续验收：

1. 原claim贯穿provider结果、取流/关闭/登记与最终锁内关联；锁外媒体I/O后仍用原tuple，失权先退出，不能进入失败/退款/新create或清新owner。payload业务attempt与row attempt_no分开。
2. 全部原槽裁决且至少一槽真实原件能关联时才首封nativeResults；metadataRejected保留真hash/bytes。封版部分失败槽是终局洞，同job本地重试不回填、不改摘要；全部未durable不建ref/空child。
3. 无native时，真实ID按TC-R04同ID取得；同步no-ID只在原响应有现授权可再读URL时先存最小私有nativeAcquisition，不存长base64/凭据，不进digest或公开结果；封版同事务清该快照。no-ID无持久源、来源过期不可读或响应未落盘保留Unknown，不自动重建上游/退款。
4. native/ref存在后纯本地推进：同job enqueue/让出、child只唤同image、新合法claim本地消费；详情POST和recovery先判本地依赖，不被上游query或missing-URL旧分支吞掉。显式重开同stage只重跑本地处理，下次child换执行身份，不承诺确定输入拒绝变好。
5. PG按可选Run→image→child→登记同executor；File按creative→一次generation mutation。核Run先取消而image尚running窗口；保留新有效owner及原due，等待写null前同锁重核child success，不凭假设新增扫描/调度参数。
6. 保持无target/无需缩小原bytes已有正确路径，补实际字节/hash/EXIF/格式断言并优先复用stats获取真实alpha；Web仅复制经Task2验证的原件取得合法image URL，final同hash/bytes才复用。保持nativeSource与现增强消费者/保护baseline语义，新增alpha事实单独核峰值和IPC/result-only摘要。
7. Run事实只沿现link/poll→patch应用到实际copy的私有imageProcessingFact；新child执行再次pause/error与旧重放区分。File先Run truth/指针再runtime receipt；正常patch/link、鉴权owner后的Run GET及resume变更前的外层补已应用事实receipt。低层getter纯读，无Run不投影，GET不改logical状态、不取得Agent权或重开任务。

原43个设计用例不增号；具体补门归入配套用例的既有Q/R/F/S/U ID。真实PG pool1/回滚、同ID取得失败、no-ID来源三界、终局洞、旧tuple I/O gate、等待/完成交错、显式retry新事实、消息漏写与公开白名单分别取证。各门按已记录的实际轮次分别核定，缺少证据的部分继续保留待验收。

### 必测故障及预期

| 场景                       | 预期                                 |
| -------------------------- | ------------------------------------ |
| 两个 Worker 同时领取       | 同一有效执行只有一个所有者           |
| Worker 中断、租约接管      | 任务可恢复，已完成阶段可复用         |
| 旧执行迟到提交             | 不能覆盖新身份结果                   |
| 编辑方案已保存后子进程退出 | 复用方案，继续或明确暂停本地图像阶段 |
| 上游提交结果未知           | 保留原身份，禁止自动重复创建         |
| 产物已写、完成响应丢失     | 可核对产物并幂等读回/提交            |
| 本地资源耗尽               | 有明确阶段错误，无自动崩溃循环       |
| 排队任务取消               | 不再被领取，也不创建上游任务         |

交付状态转换用例、PostgreSQL 集成报告、故障矩阵。不能用进程内锁测试替代多 Worker/数据库并发验证。

## 11. S5：配置、容量准入与多副本部署能力

### 操作步骤

1. 用 S2 完整峰值建立预算表，为 Worker 监督进程和运行余量预留空间。
2. 校验环境参数和 Compose 最终渲染配置；错误配置启动失败并说明原因，不能静默回退为伪成功。
3. 实现解码前的本副本内存/CPU 准入。独立容器各有硬预算时，预算之和形成全局上界；共享预算组才实现必要的共同额度。
4. 区分图像计算槽位与网络等待/上游轮询。用户公平性在任务领取时处理，不能一位用户长期占满所有副本。
5. 容量不足保持持久排队；单任务大于任何副本可用预算时明确标识资源不足，不无限等待。
6. Worker 服务移除固定容器名称冲突，不绑定固定宿主端口；副本与执行身份唯一。
7. 确认同机卷共享或媒体流式接口；跨主机使用可访问的共享媒体路径。
8. 在预算允许的隔离环境实际启动多副本，核对每个容器真实内存限额、进程参数与领取结果。

### Compose 文件修改子任务

Compose 修改属于本次方案的明确交付项，修改与专项验收范围限定为下表四份仓库模板、目标测试站实际启动文件及相关配置文档：

| 文件                                | 需要处理的内容                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `docker-compose.yml`                | 默认部署的 Web/Worker 资源配置，Worker 多副本启动能力                                            |
| `docker-compose.external-db.yml`    | 外部 PostgreSQL 部署的相同能力，保留原数据库接入方式                                             |
| `docker-compose.local.yml`          | 本地镜像启动、开发与验收配置，行为与发布镜像对应                                                 |
| `docker-compose.lowmem.yml`         | 参数化既有堆与容器限额，明确图像任务可执行的实际预算                                             |
| 测试站实际 `docker-compose.dev.yml` | 让本次测试发布真正使用新资源参数、执行入口和副本规则；该文件属于环境部署材料，不在当前源码模板中 |
| `.env.example` 与部署文档           | 说明变量名称、单位、覆盖顺序、实测适用范围和启动方式                                             |

具体修改步骤：

1. 在环境启动清单记录实际 Compose 文件、加载顺序、项目名与环境变量来源。模板更新后，还要更新测试站实际启动材料；若由部署脚本生成，修改其生成来源，保证下一次发布不会覆盖新配置。
2. Web 与 Worker 分别显式接入约定的 V8 堆配置；Worker 另传图像子进程配置，避免直接继承监督进程的堆大小。
3. 为 Web/Worker 接入容器总内存限额。Worker 的限额按每个副本计算，包含该副本全部子进程和原生分配。具体值来自容量报告，不在模板中随意写大。
4. 移除影响 Worker 扩容的固定 `container_name`；Worker 不映射固定宿主端口，服务内部访问继续沿用对应拓扑。
5. 显式接入图像处理预算与并发参数。现有 HTTP lane 数量不能代替重图像任务准入。
6. 按 S1 的媒体读写方案配置 Worker：需要直接访问本地媒体时使用正确共享卷；经现有鉴权媒体接口读写时按接口方案启动。不能无依据复制 Web 全部卷或密钥挂载。
7. Web 与 Worker 使用同一固定发布镜像，核对图像子进程入口已进入镜像及 Standalone 产物；保留既有健康检查、服务令牌和数据卷语义。
8. 表内业务启动模板执行配置渲染和现有 Compose 契约回归，新增或调整的断言仅覆盖本次变更，随后在隔离环境验证单副本、多副本与缩容排空。低内存配置若无法容纳单个图像任务，明确返回资源不足，不能宣称该档位已经支持完整大图处理。

验收时检查三个层次：

- **文件层**：正确的变量和服务结构进入目标启动文件，覆盖顺序清楚。
- **容器层**：实际 Docker 内存限额、副本数、唯一身份、入口、网络及所需卷符合配置。
- **进程层**：Web、监督进程和图像子进程各自实际堆参数正确，图像任务受预算控制。

Compose 渲染结果还要结合镜像默认环境和实际进程读回，避免只看到文件中没有 `NODE_OPTIONS` 就认为没有堆限制。配置渲染输出可能包含凭据，公共证据只保留必要的脱敏字段。

交付 `compose-config-check.json`、各模板的任务相关 diff、测试站实际启动清单、单/多副本启动及缩容证据。S7 发布必须使用这份已核对清单。

### 主机约束

```text
所有 Worker 容器预算之和
+ Web 预算
+ 数据库及其他服务预算
+ 系统余量
≤ 本部署实际可分配资源
```

不能让每个副本独立把整个宿主可用内存当作自己的预算。变更内存或副本数时，按排空—重建—检查实际值的流程执行。

### 验收标准

- 超容量请求在解码前排队，活动任务预算不超卖。
- 多副本处理数量与任务状态吻合，副本数变化不丢任务、不重建已有上游任务。
- 配置表给出测量依据、生效方式和当前硬件适用范围，不承诺未经压测的支持人数。

交付 `capacity-profile.json`、配置文档、Compose 回归和扩容/缩容记录。

## 12. S6：综合验证

### 2026-11-04 S6 综合验证记录

S6使用本地受控上游、完整Standalone Web、真实PostgreSQL与常驻Worker。TC-U01的大商品常驻Worker/Chromium代表链复用S5已审F02分轮证据；TC-U02另轮覆盖小商品占槽等待、刷新/切换/返回同Run，TC-U03覆盖真实子进程启动期V8 OOM、暂停及配置调整后用户显式继续原job；48MP风格参考和页面点击取消/刷新另轮通过。等待阶段消息已写回原助手消息；取消轮次标题使用“已取消生成”，不再显示生成成功。

TC-L01四档1/5/10/20用户共39项全部完成；TC-L02以20用户持续62.48分钟完成400项和1500图像job，排空后再观察10分钟空闲。68418次Web请求无失败，7649次健康请求全部成功，最大1408.68ms，满足预登记5000ms门。无Web OOM或非预期重启，任务与账本/上游创建核对保持，空闲Worker约79MiB、活动child与临时目录均为0，后继全容量空领取成功。reservedMemoryBytes无直接观测，继续Unknown，不能写成0。

本轮配置为Web384MiB/0.5CPU、PG256MiB/0.25CPU、单Worker1920MiB/1CPU（图像预算1536MiB、child heap384MiB、slot1），工具控制组1024MiB/0.25CPU，合计3584MiB/2CPU；仅为测试档位，最终内存、CPU、预算、并发与副本数均由部署方配置。多副本机制复用S5的S档双副本与活动缩容原件，不能据此声称双L吞吐。64MP只覆盖风格prepare，不扩大到64MP商品完整保护。

桌面、四档、长稳及故障按独立轮次保存，不相加为同轮全套；原工具失败、真实业务RED及有限故障恢复范围保持。故障复用S3/S4原矩阵，当前U03补足可达桌面恢复，不重复注入已闭合故障。S7发布、真实模型/原照片、GPU及用户质量属于后续阶段；本轮尚未部署。

### A. 自动化与桌面

- 先跑受影响模块测试，再执行本次共享契约变更要求的完整检查。
- Chromium 通过正常交互覆盖原问题流程：大图作为商品、大图作为风格参考、等待资源、结果展示、刷新恢复和可达取消/重试路径。
- 使用仓库本地上游 fixture；真实业务模型验收单列，不把 fixture 成功当真实照片质量通过。
- 应用、协议和支付夹具使用执行前确认空闲的独立端口，禁止静默复用未知服务。
- 自定义 NEXT_DIST_DIR 时，先保存并最终精确恢复 tsconfig 和 next-env 原始字节。
- 启动完整 Web 与常驻 Worker 监督流程，不只启动 next dev；历史假等待的测试 harness 失误不重演。

### B. 多人负载

按测试清单依次执行 1、5、10、20 用户的混合大小请求；这是验收层级，不是线上默认并发限制。副本数在已证明可用的资源预算内增加。

每层记录：提交/成功/失败/排队数量，源像素分布，排队/处理耗时分布，峰值子进程 RSS，Worker 容器峰值，Web 错误率与响应分布，上游创建和计费记录。

通过条件：无 Web OOM/非预期重启；任务预算不超卖；已接收任务可完成或有明确终态；队列在输入停止后可排空；故障恢复没有额外创建或扣费。响应时延按 S0 预先固定的目标判定，不在失败后临时放宽。

### C. 长稳与故障

- 按预先登记的持续时段重复混合任务，观察任务完成后的内存回落、容器趋势与资源释放。
- 执行 S4 故障矩阵，单独报告每种故障的已知、未知与恢复结果。
- 共享宿主资源不足时，不在生产服务旁顶格压测；记录容量门受阻，保留已完成的正确性证据。

交付 `desktop-round-N`、`load-round-N`、`soak-round-N` 和故障报告。不同轮次和不同源码身份不混记为一个通过结论。

## 13. 已核对的检查入口

以下是现有仓库命令，均从相应目录执行。执行时再次核对依赖和脚本；本 SOP 编写阶段没有运行这些业务检查。

受影响算法回归，从 `web`：

```sh
pnpm test src/lib/server/ecommerce-generation-service.test.ts src/lib/server/generated-image-normalizer.test.ts src/lib/server/ecommerce-visual-analysis.test.ts
```

任务恢复与调度回归，从 `web`：

```sh
pnpm test src/lib/server/generation-task-scheduler.test.ts src/lib/server/generation-task-recovery-service.test.ts src/lib/server/agent-run-executor.test.ts
```

Compose 变更回归，从 `web`：

```sh
pnpm test scripts/compose-contract.test.mjs scripts/render-contract.test.mjs
```

需要真实 PostgreSQL 且会建表/清理的文件，在隔离测试库配置下使用 `--no-file-parallelism`。上述通用命令本身不代表已完成 PostgreSQL 专项。

最终 Web 质量检查，从 `web`：

```sh
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm test
```

桌面先列出匹配项，再运行，从 `web`：

```sh
pnpm exec playwright test '(^|/)ecommerce-product-generation\.spec\.ts$' --project=chromium --list
pnpm run e2e '(^|/)ecommerce-product-generation\.spec\.ts$' --project=chromium
```

桌面运行前需完成对应快照构建，并准备隔离数据和夹具端口。精确测试筛选可依据 S1 新增用例标题收窄，不能把未匹配到用例当通过。

构建与文档检查：

```sh
# web 目录
pnpm run build

# docs 目录
pnpm run types:check
pnpm run build
```

pnpm、Node、安装目录和锁文件遵循仓库。依赖未变不重复安装；需要安装时使用相应目录的锁文件和 frozen-lockfile。新增测试/检查入口只有在实现并读回脚本后才能写进可执行命令清单。

## 14. S7：固定交付、测试发布及恢复准备

### 当前S7结果

已合入主线修复，构建源为 `e1241ed`；冻结增强预算已沿当前独立文件处理链贯通。固定源码通过规格/质量独审、受影响检查、完整类型与镜像构建后，Web/Worker已同镜像发布测试环境；旧Worker排空，实际资源限制、schema、新心跳、原暂停任务、媒体挂载与桌面入口已读回，恢复材料保持。资源和副本由部署方配置。新增大于40MP完整AI输入仅取得合法预算检查后持久未校准暂停的资格，不扩大既有增强CPU容量域；S8真实模型、原照片与用户质量仍待。

### 发布前

1. 核对 diff、敏感信息、生成文件和 UTF-8；只包含本任务内容。
2. 按固定源码快照进行独立规格/质量审阅；问题修复后只重跑受影响的检查，最终证据绑定到交付身份。
3. 更新数据库/API/部署文档，以及 todo、pending-test、CHANGELOG 的真实状态。
4. 构建干净快照，记录源码提交、镜像 digest、检查轮次、支持的阶段任务和配置。
5. 读取目标测试环境的当前镜像、活动任务、配置与存储，形成发布清单和具体恢复步骤；清单包含 S5 已核对的实际 Compose 文件、加载顺序、项目名和环境来源。
6. 旧 Worker 停止新增领取；等待任务完成或落到明确可恢复状态。Web 与 Worker 使用匹配契约的镜像。

### 发布及读回

在已明确授权该次测试环境发布时执行一次，保留原始操作标记和结果。读回镜像 digest、实际内存限额、Web ready、PostgreSQL/schema、Worker 新心跳、图像子进程入口和受影响桌面路径。

不能用 ready=true 替代端到端业务验收，也不能仅凭外层 helper exit0 宣称内部构建或部署完成。

### 恢复与回滚

- 部署结果不明时先查原操作结果和实际运行身份，不直接重放发布。
- 先停止新领取并保留任务、媒体和诊断，再按失败类型处置。
- 新阶段任务已经入库时，旧版镜像可能无法处理；不能直接回滚并清理这些任务。恢复清单必须说明由哪个兼容镜像继续处理或如何明确暂停。
- 已有上游身份不重建；运行参数变更需重新核对任务预算。
- 不通过删除业务数据或共享历史来完成回滚。

交付 `release-manifest.json`、发布/读回结果、恢复清单。推送、PR、合并、生产发布与 GPU 维护不包含在“测试发布”一词中。

## 15. S8：用户验收与文档收尾

1. 在用户确认的测试路径使用原照片，分别验证大商品锚点与风格参考角色。
2. 验证等待资源、完整生成、结果尺寸、保护行为和刷新恢复，保存独立验收结论。
3. fixture 验收、真实模型成功、人眼质量确认分别记录。
4. 用户通过后再更新正式功能说明；未通过的问题保持在待测试记录并按具体失败阶段处理。
5. 输出当前硬件的配置建议、可持续处理能力及测量条件；不把在线用户数等同于同时处理的大图数。
6. 收尾记录包含源码身份、镜像、配置、有效证据、未完成项和下一步，便于后续从准确阶段继续。

## 16. 每阶段进度记录模板

```text
阶段：Sx
状态：未开始 / 进行中 / 通过 / 失败 / 未验证 / 受阻
入口提交与工作区差异：
本阶段输入与约束：
实际修改文件：
验证命令、运行目录、退出码：
证据文件和源码/配置身份：
通过条件逐项结果：
失败原因及已完成部分：
下一步：
已有副作用标记与禁止重复项：
```

当前进度：S0/S1与S2证据保留；S3/S4技术开发、S5运行资源配置及S6限定负载/长稳与桌面代表链已按各自分轮范围核验。S7已完成固定源码、独立审阅、干净镜像及测试环境发布和读回，发布清单与恢复材料保持；尚未推送，未操作生产或GPU。后续为S8原照片、真实模型和用户质量验收，原失败、Unknown与容量资格限制继续保留。
