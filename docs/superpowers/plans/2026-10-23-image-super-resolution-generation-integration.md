# M5 普通完整图异步增强实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. 当前按用户明确的持续实施目标在本会话执行，不新增实施方式确认。

**Goal:** 完成原SOP M5：合格原图先交付、独立持久异步增强、显式重试／取消、稳定幂等与归属、完整校验和永久保存后确认，以及原图／增强图的展示、下载、引用和日志。

**低分辨率补全：** 见[720P到4K计划](2026-10-24-image-super-resolution-m5-4k-completion.md)。请求边界与原生推理尺寸分开：1280×720原生四倍为5120×2880，再等比缩为3840×2160；像素取整或其他原图比例按真实比例交付，不因严格比例等式跳过，不拉伸、裁切或插值放大。历史比例跳过仅在从未执行且原件／冻结策略完整时允许显式补做增强，原生生图不重跑。此前比例跳过记录保持为历史，补验另轮记录；开关与模型以管理员当前配置为准。

本轮运行源码为9a46d76，固定源码构建与Web／生成Worker同镜像开发发布已通过，就绪及心跳正常。独立合成720P在真实GPU得到5120×2880并下采样3840×2160，摘要与完整解码通过。原会话另轮增强成功，实际1672×941 → 6688×3764 → 3838×2160；三件永久文件认证下载／完整解码／摘要、接收收据、桌面双版本切换／刷新和管理员三组尺寸／阶段日志通过，原任务／冻结策略／幂等身份和生图调用数保持。客户端拦截导致浏览器最终保存待验，服务端返回200和正确附件头已核；照片材质与锐化效果由用户另验。后续文稿提交不改变该运行源码来源，不重复已成功GPU任务。

**Architecture:** 原图片任务保持自己的生成成功状态；在创建时冻结增强意图、目标及受控连接，在合格原件落盘后按确定规则形成独立增强任务。独立表的定向查询／行锁租约由现有generation Worker维护入口调度，使用已交付Windows API；完整AI中间件和等比下采样交付件分别永久保存后发布独立版本并发送固定收据。前台仅访问ZEB接口，增强完成不改既有原件资产或下一轮已冻结编辑。

**Tech Stack:** TypeScript、Next.js、现有PostgreSQL／JSON Provider、Undici、Sharp、Vitest、桌面Playwright；不新增依赖或要求Web安装GPU运行库。

**当前进度：** Task1～5 的后端、公开 API、资产关联、媒体保护、真实计时、前台和日志已有分轮检查及独立源码复审。必要 Windows Worker 候选已标准升级并取得同一新启动实例自检资格，无需新增 GPU 安装。F01/F02 的实际后端→GPU→永久媒体、三组尺寸／摘要、双下载／刷新、真实管理员日志与缓存分别通过；F01 首次发布失败后复用同一远端 job／staged AI 恢复，失败轮保持。一次实际图像模型调用保留 1672×941 原件，按目标比例不符明确跳过，规划受控。实际故障、配置冻结／重试／取消、尺寸、真实 Web 重启及跳过／失败日志已补验；公开 F13 v9 初始化加完整业务 2/2，完成 B 原图编辑→A 增强晚到→B 冻结不变→显式增强 C 的根父／新分支、真实选区、原生和保护合成、下载／刷新及零第二增强。固定业务源码已中文服务器本地提交 304f313，独立新 SSH 核 25 文件工作／提交摘要一致；该源码的隔离干净构建、完整 typecheck／build 和独立无网络 Sharp PNG 编解码通过。开发 Web／generation Worker 已发布同一镜像，来源、就绪／心跳、维护入口及桌面回读通过；后续文稿闭环提交不作为该产物的构建来源；本期 M5 开发及同产物开发测试发布完成，待用户验收。文件 Provider 的增强意图先可见时，执行器通过既有 generation 文件锁只读取得原任务快照，释放锁后才执行准备、远端调用及发布；不在锁内重写 generation 文件，不新增重试、延时或状态。PG 保持事务内原图成功与入队及执行器直读；原任务成功、归属／结果／原件身份和已持久原生技术失败门禁不弱化。不靠刷新或日志重建 GPU 任务。

**新增关键边界：** PG发布中的父资产读取与登记须共用当前事务executor，单连接池已验证；文件发布固定先creative锁再enhancement锁，复用锁内快照并先保存creative。跨文件中断可能留下已登记资产而job未提交，恢复须复用稳定child身份与staged产物，禁止重复推理或覆盖原资产。公开摘要仅返回白名单原件／发布变体、尺寸、版本、事件和可用动作，不暴露冻结连接、远端身份及租约。

**最终审查与指针边界：** file outbox 原 I1 已修复并独审闭合；Spec Approved C/I/M=0/0/0，Quality Approved C/I/M=0/0/1，保留既有 unused-config M1，本次新增 0/0/0。F13 专项 0/0/0 不代表整体无遗留。 公开 F13 v9 初始化加完整业务 2/2、stderr 空；正常 hover 后保留原意图精确相等，并通过可信指针各帧的独立像素等式，指针专项 Spec／Quality Approved、C/I/M=0/0/0。v7 具体帧因果仍为 Unknown，v8 保持业务前准备失败，原失败轮不改写。

**开发发布与使用验收：** 本轮开发发布回读时后台保持默认关闭，连接及凭据尚未配置；实际使用验收需管理员保存连接、完成连接／样图检查并开启。发布回读未保存凭据、未新生成或重跑 GPU；限宽预览仅为显示变体，不代替原生像素或新 GPU 质量证据。本轮 1440×900 桌面回读确认旧会话请求 3840×2160／实际 1672×941、参数弹层及限宽预览加载正常，无横溢出或控制台错误；该历史结果不是本轮新推理。

## Global Constraints

配置冻结补验已通过：原 8 故障与新增 A／B／C 时间线同轮初始化加 9 业务共 10 项；实际管理员切换已验证合成服务／模型后，旧任务独立重试保留冻结策略，新任务采用新默认，关闭不撤既有任务／交付，独立取消只作用指定增强。尺寸展示真实 RED 后 64 项单测、初始化加 2 场景桌面、全 Web 类型与定向 lint 分别通过；摘要注明原图尺寸，既有版本区显示当前所选真实尺寸，不写回 run.assetIds 或 native。实际 Web 重启 1/1 和公开 F13 2/2 另轮记录，协议夹具不作为 GPU 质量或全部 LLM 真实验收。

实际业务故障同轮补验已通过：初始化加 8 类故障 9 项；采用真实 HTTP 客户端、文件／登记／下载 Route 与桌面，Worker 产物为协议夹具。保存拒绝仅在 writeAssetBytes 边界映射既有 output_storage_invalid，前台使用固定中文原因，未知错误不误报磁盘故障或回显原始字符串。完整 AI 已 staged 时恢复不再下载业务产物；收据持久接受后丢响应只重发同一确认，原图与单次发布保持。实际 file＋单连接隔离 PG 57 项通过／1 项不适用跳过；此前失败轮独立保留。成功及另轮跳过／失败管理员日志对照已补齐，不以受控执行替代实际 GPU。

永久AI与交付件回读必须采用任务冻结的各自字节预算，不能误用普通参考图默认读取上限；普通参考图默认约束保持。日志缩略图优先使用已登记的站内永久媒体并生成限宽WebP；上游地址失效后仍须验证实际图片加载，不能只断言src含预览参数。

增强执行器须消费已持久化的当前结果／批次明确技术失败，在准备及下载发布前拒绝，不能只比较 nativeSource 身份；原件、nativeMatches 和合格历史不变。不得以 nativeMatches=false 单独拒绝已验证合法映射，也不得把 LLM 视觉建议恢复成阻塞验收。技术门禁不得阻挡已知远端任务的显式取消；提交结果未知且技术失败时仍不能借取消重提。已发布增强件只继续原收据确认，不因后续记录变化撤回。相关 file／隔离 PG 负例、合法映射正例和默认不链式放大检查已通过；实际 F13 的新输出按自身原生及保护合成契约验证，不伪造 provider_native 标签。

- 完整保留原SR-M5-01～12及与M4交叉的业务断言，不以配置测试替代业务。
- 首期仅普通完整图；canvas／商品保护／蒙版／分层／透明任务保持原契约并显式跳过，M6～M8分别交付。
- 管理开关默认关闭；无GPU／远端失败仍交付合格原件；禁止普通插值补尺寸，禁止新增LLM路由或重跑生成。
- 连接／模型／目标按任务冻结；凭据只受控引用，不进入任务公开响应、错误、日志、导出或源码。
- 使用现有锁、原子写入、事务、授权、站内媒体存储和后台权限。PostgreSQL测试使用`--no-file-parallelism`。
- 不新增拍脑袋重试、延时或资源限制。轮询复用现有图片任务节奏，租约和持久化并发复用既有调度契约，实际容量使用认证Worker能力。
- 无手机适配；只在开发测试环境验证发布；中文服务器本地提交，不推送、不创建PR、不操作生产。
- 关键边界及失败分轮记录；实际模型／GPU测试与fixture区分，不重放已完成M3/M4 helper。

显式续编基线必须绑定真实持久事实：普通原件核归属一致的完成 Run、成功原任务、稳定 resultId/nativeSource 及真实尺寸／字节／摘要；增强子资产核成功增强 job 的 committed publication、实际交付事实和原件父链。metadata 或 staged 本身不构成资格，不把 child 塞入原 run.assetIds；普通隐式历史和既有电商技术门禁保持。B 以原图为父，C 以增强 child 为父，两者保留原件根并各建分支；A 晚到不改 B 的冻结基线／选区。视觉分析入口与共享 assetAccessUrl 均优先永久 serverUrl，缺少永久源时保留原远端回退，不放宽 HTTP 或 data URL 规则。

选择器四文件 275/275、视觉分析入口三文件 220/220、共享引用 helper RED 1 失败／35 通过→GREEN 六文件 286/286 为独立轮次。实际 Web 重启 1/1 与随后 sanitizer 的 RED 2 失败／1 通过→GREEN 3/3、仓库 Node 另轮 3/3 分开；结构化认证／Cookie 键与错误字符串内嵌头值均脱敏，原业务 JSON 不改，派生另存并绑定摘要，不称新实跑。

公开复现从 web 目录运行 `node --test e2e/image-enhancement-restart.lifecycle.test.mjs` 和 `node scripts/run-image-enhancement-e2e.mjs`。F13 入口使用仓库已安装工具链，生成独立合成原件／数据目录／端口，执行受控 LLM／image／Worker 的实际应用与桌面链，不依赖私有原图或部署配置，不代替 F01/F02 GPU。本轮 B／C 未请求 4K，真实跳过原因为 not_requested，不能写为 protected_contract；保护步骤及独立原生／合成证据仍完整验证。

## Task 1：冻结策略与确定性路由

**Files:** 新增`web/src/lib/server/image-enhancement-plan.ts`及同名`.test.ts`；扩展`web/src/lib/server/image-enhancement-config.ts`与`web/src/lib/server/image-task-store.ts`。

**Interfaces:** `planImageEnhancement(input: EnhancementPlanningInput): EnhancementDecision`只消费已验证原件事实、任务冻结意图／目标／连接，产生queued/skipped/rejected与明确原因；`captureImageEnhancementPolicy()`从一次配置读取冻结启用意图和执行身份。现有`freezeImageEnhancementConnection()`继续保持M4语义。

- [x] 写并运行路由RED：F01/F02三组尺寸、关闭、非4K、原件足够、保护／透明／分层、不支持格式／比例／倍率、已增强和原生验收失败。
- [x] 实现最小纯路由，不做网络／磁盘／LLM调用；深复制必要快照，不修改输入。

```ts
expect(planImageEnhancement(f01)).toMatchObject({status:"queued",inference:{width:5016,height:5016},target:{width:4096,height:4096}});
expect(planImageEnhancement({...f01,nativeValid:false})).toMatchObject({status:"rejected",reason:"native_invalid"});
expect(planImageEnhancement({...f01,enabled:false})).toMatchObject({status:"skipped",reason:"disabled"});
```

- [x] 在原图片创建时持久冻结策略；测试后台修改后原快照不变、关闭后新任务跳过。相关回归、独立复审与中文本地基础提交通过。

Run: `pnpm exec vitest run src/lib/server/image-enhancement-plan.test.ts src/lib/server/image-enhancement-config.test.ts`；预期路由及原配置测试通过，无未捕获异常。

## Task 2：Worker策略绑定与真实客户端

**Files:** 修改`workers/image-enhancement/src/contracts.ts`、`http.ts`及其既有契约／HTTP测试；扩展`web/src/lib/server/image-enhancement-worker-client.ts`或聚合同目录专用任务客户端与`.test.ts`。

**Interfaces:** 请求复用`EnhancementPlanRequest`、认证multipart `plan/image`、`Idempotency-Key`及既有job/result/receipt接口。新增可选`expectedStrategyFingerprint`，`normalizePlan`计算实际既有策略指纹后比较，不匹配在接收前拒绝；能力响应声明该约束。M5提交必须使用约束，已有固定样图路径不重复创建。

- [x] 写RED证明同模型ID更换权重／预算时冻结指纹可检测，错误指纹不进入队列；原不带约束的内部自检保持原语义。

```ts
const frozen = normalizePlan(request, config);
expect(() => normalizePlan({...request,expectedStrategyFingerprint:frozen.strategyFingerprint}, changedConfig)).toThrow();
```

- [x] 实现并验证连接身份、所选模型版本／摘要及能力预算；先查身份再向旧job发请求。multipart提交必须沿用稳定键，提交结果未知沿同一键恢复，不按新设置重建。
- [x] 真实HTTP fixture覆盖认证、POST响应丢失、查询／下载故障、完整字节／尺寸校验、receipt重放及错误脱敏；原M4检查回归通过。
- [x] 必要 Windows Worker 候选已按原标准流程升级，固定源码／运行包配对及同一新启动实例的自检合格、策略指纹能力已独审通过；指定历史 job 与文件保留核验按原范围记录。未新建 GPU 安装／Native／安装器工程，不重跑旧安装矩阵；随后 F01/F02 业务与计时证据单列。

## Task 3：持久独立增强任务与恢复

**Files:** 新增`web/src/lib/server/database/image-enhancement-job-repository.ts`及文件／PG测试，新增`web/src/lib/server/image-enhancement-service.ts`及集成测试；修改`database/schema.ts`、`database/postgres.ts`及schema断言、`api/maintenance/generation-tasks/run/route.ts`。

**Interfaces:** `enqueueImageEnhancement(input)`按原图结果版本与冻结策略唯一入队；`runImageEnhancementBatch(input)`领取到期行并按原租约推进提交／查询／下载／发布／确认；`retryImageEnhancement(input)`只创建对应增强新尝试或恢复原获取／确认；`cancelImageEnhancement(input)`只改变对应增强任务。读取和修改均绑定任务及所有者。

- [x] 写真实文件与PG RED：同一原图只建一行、两个领取者只有一个有效租约、过期租约接管、旧租约不得发布、稳定提交键、独立重试防重入、关闭开关不取消已冻任务。
- [x] 单例状态不混入原生成任务status；每原结果稳定ID、输入sha／URL／方向尺寸、模型／连接引用、目标、尝试、远端job、产物／receipt身份和阶段事实均持久化。
- [x] 调度接入现有维护入口并合并下一到期时间；不修改其他媒体任务类别或计费并发，不扫描全表到Node筛选。

- [x] 文件完成窗口通过既有 generation 文件锁只读同步原任务，锁释放后处理增强；真实窗口 RED 后六文件 87 通过／50 个未启用 PG 跳过，另轮单连接隔离 PG 的双 Provider service suite 57 通过／1 个不适用跳过，不改原生技术门禁或新增状态／重试／延时。

```sql
SELECT id FROM image_enhancement_jobs
WHERE next_poll_at <= now() AND (lease_until IS NULL OR lease_until <= now())
ORDER BY next_poll_at, created_at FOR UPDATE SKIP LOCKED;
```

- [x] 故障、执行／发布、维护、真实 Web 重启、配置冻结及 file outbox 同步已有分轮检查和各接缝独审；最终源码已中文本地提交并独立回读。最终构建、同产物开发发布与桌面回读已通过，最终文稿复审及闭环提交另属 Task6，按实际回执收口。

## Task 4：原件、AI和交付版本的永久发布

**Files:** 修改`image-task-runtime.ts`、`image-task-result-service.ts`、`image-task-store.ts`、`creative-runtime-service.ts`、`agent-run-assets.ts`；复用`generation-log-repository.ts`现有媒体存取，新增聚焦发布测试。

**Interfaces:** 原结果完成与独立增强入队仅在合格原图落盘后发生；原图resultId／摘要不可变。增强保存完整AI PNG、合法等比缩小交付PNG及尺寸／摘要／受控provenance，注册独立创作资产ID。默认显示变体只更新同一原结果版本，不覆盖已有资产内容。

- [x] RED覆盖原生验收失败不能发布或填nativeUrl、已冻结下一轮不跳图、日志重复保存不重复入队／发布。
- [x] 保存使用现有本地／S3站内API身份，完成完整校验及永久保存后才发布；最后发送同一远端结果的稳定receipt。
- [x] 截断／摘要错／存储失败只保持原图；实际HTTP／永久媒体联合补验通过，恢复仅获取／保存原远端job。已有staged AI不再下载业务产物；receipt持久接受后丢响应只重发同一receipt，不回退已发布成功或再次推理。
- [x] 验F01 1254²→5016²→4096²与F02 1600×900→6400×3600→3840×2160；三组尺寸与摘要读取实际文件，增强独立发布与确认。另有受控4096增强件的持久provenance／足够尺寸／超4x检查；不据此替代生产引用接缝验收。

## Task 5：前台操作、历史回读与实际日志

**Files:** 新增`web/src/app/api/image-enhancements/[id]/route.ts`及权限测试，新增`web/src/components/image-enhancement-controls.tsx`与`web/src/services/api/image-enhancement.ts`；接入`web/src/services/api/image.ts`、`web/src/app/api/image-tasks/[id]/route.ts`、`web/src/app/(user)/image/page.tsx`、`web/src/components/agent/agent-media-preview.tsx`及实际调用记录详情组件。

**Interfaces:** 公开摘要仅含增强id／状态／原因、原件和增强件的站内变体／尺寸／摘要及尝试计时；不返回连接引用、地址、Token或系统账号。GET只读取／低成本唤醒原任务；显式POST动作`retry/cancel`独立于原生生成重试。前台先展示原图和增强状态，普通生成成功不等待增强。

- [x] 权限RED验证本人／管理员与越权、无登录、非法动作，拒绝不提交GPU或重发生图；公开API与客户端、原图身份白名单定向检查和独立复审通过。
- [x] 成功／跳过／失败与单独重试均显示；增强完成后保留原图下载，选增强继续编辑建立新资产与分支。
- [x] `/create`、普通图片工作台、历史刷新和调用详情分别验证；晚到结果不得改B的基线，显式选增强建立C。
- [x] 日志只报告实际执行阶段：native／AI／delivered尺寸、模型版本、队列／推理／编码耗时、尝试及具体跳过／失败原因；敏感内容零匹配。

当前`/image`已跳转`/create`，验收既有跳转与统一创作真实入口，不恢复第二套工作台。增强完成后资产须具有独立身份并可被输入区实际引用，不能只在预览里换URL；没有job的合格结果也需保留确定的跳过原因。媒体引用计数必须覆盖增强原件、staged完整AI／交付件及publication完整AI／交付件，包括失败或取消任务；本次不增加自动删除。计时须取真实Worker执行事实，不能把Web轮询间隔当纯GPU耗时。

资产登记需同时覆盖普通任务登记与Agent再次登记；聚合多个图片子任务时用稳定结果身份确认原任务，再按该任务实际可登记结果压缩计数，不能用全局序号或稀疏resultId槽号猜登记序号。公开结果共用白名单；普通4K关闭策略保留既有nativeSource/enhancementId与skipped job，其他无job成功分支如实记录disabled/not_requested/protected_contract/unsupported_layers。

计时字段分别为workerQueueMs（Worker接受任务至首次领取）、workerExecutionMs（当前attempt授权至退出观测，含引擎启动与写出）和deliveryEncodingMs（Web实际等比缩小与PNG编码）。无事实不造0，等尺寸直接复用AI件不记编码耗时；成功当前Worker快照替换旧Worker计时、保留Web编码计时，查询失败继续保留已有事实。管理员日志候选以单个enhancement_metadata JSONB保存四字段白名单，按分页内原owner/result/task关联只读增强摘要；真实数据库／桌面补验与独立复审已通过；真实runner另经到期上游的完整file链验证永久serverUrl透传，不能只凭局部规范化测试认定调用链已复用原件。

## Task 6：完整十二项审计、实机与开发发布

**Files:** 新增`web/e2e/image-enhancement-generation.spec.ts`，同步本计划、原主SOP、原M4/M5测试索引、数据库、todo、pending-test、readiness与CHANGELOG。

- [x] 按 SR-M5-01～12 原步骤逐项建立各自执行层次的实际证据，F13 公开 v9 初始化加完整业务 2/2；保留未适用 M6～M8，不把受控协议结果当真实模型／GPU。F13 源码与最终实际证据独审 Spec／Quality PASS、C/I/M=0/0/0；该专项通过不提前关闭最终整体门禁。
- [x] 最终源所定 Vitest／PG、完整类型、lint、格式、严格 UTF-8 及新增公开差异隐私检查已有实际回执；原整体 file outbox I1 经 RED／GREEN 与独审闭合。Spec Approved C/I/M=0/0/0，Quality Approved C/I/M=0/0/1；既有 unused-config M1 保留，非无告警输出。本次最终七文稿已通过独立 Spec／Quality 复审。
- [x] F13 v9 最终源码与公开实际 JSON 独立 Spec／Quality Approved、C/I/M=0/0/0，正常 hover 与真实可信指针各帧像素等式已实测；原增强 child 未加入原生 run.assetIds 的补强保持。v7 具体帧 Unknown、v8 准备失败保留；该专项不清除整体既有 M1。
- [x] 固定源码 304f313 的隔离干净项目构建与官方完整 typecheck／build 均 exit0，产物摘要已固定；独立无网络镜像容器实际使用 Sharp 0.35.5／libvips 8.18.7 完成 2×3 PNG 解码／编码，exit0 且 stderr 空。该项不代替同产物开发发布。
- [x] 受控上游F01/F02经过实际后端→Windows GPU→永久媒体→前台；另执行一次实际生图模型普通完整图，原生1672×941与请求方形不符，明确跳过增强且保留原件。后者规划为受控夹具，只有图像调用为实际模型，不冒称全部上游真实联调。
- [x] 成功、关闭、故障、重入／重试、晚到编辑、原图／增强下载及刷新回读各有相应层次证据；配置恢复和隔离验收不影响生产，各原失败／Unknown 保持。
- [x] 最终源码已中文服务器本地提交 304f313；独立新 SSH 核 25 文件工作／提交摘要一致，回读时工作区及暂存区干净。此为产物源码来源，不是最终文稿闭环提交。
- [x] 同一已验镜像已发布开发 Web／generation Worker，挂载与声明环境保持；维护入口 HTTP200／code0／claimed0、就绪 HTTP200 与 Worker 心跳、新 SSH／公开 HTTPS 及实际桌面回读通过，生产实例身份保持。后台默认关闭且连接／凭据未配，本轮未保存配置、新生成或重跑 GPU；预览显示尺寸不作原生证据。
- [x] 最终七文稿的严格 UTF-8／新增隐私差异检查、原十二项／Task6 最终对照及独立 Spec／Quality 复审已通过；闭环中文本地提交及独立新 SSH 回读已实际完成。该文稿提交与已构建业务源码 304f313 分开，私有原始证据不进公开交付。

## 原规格覆盖

| 原用例 | 对应任务 |
| --- | --- |
| SR-M5-01 | 2、3、4、5、6：F01/F02与实际模型、真实GPU及永久双版本交付 |
| SR-M5-02 | 1、3：确定跳过与零额外Worker／LLM |
| SR-M5-03 | 2、3、4、5：独立故障及原图成功保留 |
| SR-M5-04 | 3、5：冻结增强重试和重复点击去重 |
| SR-M5-05 | 2、3、4：稳定提交键、租约恢复与单次发布 |
| SR-M5-06 | 2、3、4：下载／永久保存／receipt的故障边界 |
| SR-M5-07 | 4、5、6：A/B/C独立资产、引用与晚到顺序 |
| SR-M5-08 | 1、2、3：原连接／模型、后续配置与显式取消 |
| SR-M5-09 | 3、4、5：真实阶段、尺寸、计时与脱敏 |
| SR-M5-10 | 1、4：原生／保护失败不得被增强伪造修复 |
| SR-M5-11 | 1、4：provenance保留、足够尺寸和不链式放大 |
| SR-M5-12 | 4、5、6：变体身份、下载、刷新、缓存及引用 |

原十二项的具名证据按原层次保留；F13 v9 及指针专项独审、最终源码审查与中文本地提交／独立回读、固定业务源码的干净构建／独立 Sharp 检查、同产物开发 Web／generation Worker 发布与桌面回读均已取得回执。本期 M5 开发及开发测试发布完成，转入 pending-test 待用户验收；整体既有 unused-config M1 仍登记。最终文稿独立复审、中文闭环提交及独立新 SSH 回读均已完成，文稿提交不冒称已构建产物来源；不直接移入功能总览，不表示生产／商业就绪或 M6～M8 已交付。
