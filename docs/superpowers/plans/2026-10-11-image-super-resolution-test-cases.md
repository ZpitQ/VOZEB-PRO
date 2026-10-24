# 图像高清增强 M0～M8 测试用例与验收索引

M5 低分辨率补验见[720P到4K计划](2026-10-24-image-super-resolution-m5-4k-completion.md)。新增横竖720P、整数比例取整、原图比例差异、原生四倍不足／原图已足够、旧比例跳过显式仅增强恢复、并发防重和真实交付尺寸用例。文件模式148项、最终单连接隔离PostgreSQL204项／1项不适用、桌面初始化加12个业务场景分轮通过。固定源码构建及同镜像开发发布、就绪／心跳通过；独立合成720P真实GPU5120×2880并下采样3840×2160的摘要／解码通过。原会话另轮实际完成1672×941 → 6688×3764 → 3838×2160，三件永久文件认证下载／完整解码／摘要、增强收据、桌面切换／刷新及管理员阶段日志通过，原任务与幂等身份保持且无新增生图调用。客户端拦截导致浏览器最终保存未验收；服务端返回200和正确附件头已核。照片人工画质另验，不改写旧比例跳过或失败轮，不增加下列原业务规格统计。

2026-10-24 最新 M5 开发及同产物开发测试发布完成，待用户验收：原 SR-M5-01～12 完整保留，原定路由／集成／真实 GPU／桌面层次分别取得具名证据；公开 F13 v9 初始化加完整业务 2/2，通过 B 原图编辑、A 增强晚到、B 冻结不变和显式增强建立 C，F13 源码及最终实际证据独审已通过，Spec／Quality PASS、C/I/M=0/0/0。实际 Web 进程重启 1/1 及成功／跳过／失败日志对照已补验；固定业务源码已中文服务器本地提交 304f313，独立新 SSH 核 25 文件工作／提交摘要一致；该源码的隔离干净构建、完整 typecheck／build 和独立无网络 Sharp PNG 编解码通过。开发 Web／generation Worker 已发布同一镜像，来源、就绪／心跳、维护入口及桌面回读通过；后续文稿闭环提交不作为该产物的构建来源。用户验收仍待实际使用确认；下方原失败、Unknown 和独立轮次保持，不累计为新的同轮总数。

M5 早期模块记录（保留各轮当时范围，当前状态以上段和第 6 节为准）：原件日志69项、成功入队36项、执行／发布隔离PG扩展79通过／1不适用跳过、共享资产40项、维护47项、公开API及关联142通过／1不适用跳过分别保留原轮，不累计为同轮总数。媒体引用保护另以真实file／PG及单位测试17项、原媒体调用方7项验证。资产关联／明确跳过七文件152项通过；独立复审发现多子任务汇总身份错配，新增连续及稀疏槽RED后修复，三文件22项与定向复审通过，原失败保留；相关回归33通过／5个PG分支跳过另记，成功入队真实file／PG补验10项另记。真实计时Worker四文件176项通过，Web先64通过／22个未启用PG跳过，后续旧尝试计时残留RED修正后真实file／隔离PG45通过／1不适用跳过，类型与独立源码复审通过。前台49项组件／hook及桌面5+3业务分轮通过，独立复审发现的同会话资产刷新逆序经三项真实桌面RED后修正，六项相关业务及独立复审通过；管理员日志先97项、修复真实caller永久地址透传后八文件152项、真实隔离数据库7项及管理员桌面分轮通过，最终类型检查和独立复审通过。后续实际媒体、Worker升级、GPU和业务补验按第 6 节的各自证据登记；上述模块数不计为原十二项完整业务通过数。

M4 管理配置开发与测试发布完成，具体分轮证据和待用户确认项见[M4 实施记录](2026-10-23-image-super-resolution-admin-config.md)。配置、API权限、真实 PostgreSQL、TLS、桌面流程与提示可读性、最终构建、独立复审及最终候选API到Worker样图链路分别通过，同产物开发页面已复核。SR-M4-01/05/10/11/12等与M5相交的任务／原图／资产子项仍按原要求组合验收，不能由面板用例填满业务验收。以下既有轮次为历史证据，不改写原失败或未执行项。

2026-10-23 最新：M3 Windows 内网部署阶段已完成本期功能、实机和最终安装／来源材料交付，见 [M3 逐项收口](2026-10-23-image-super-resolution-m3-delivery.md)。历史失败和候选状态保持原证据；当前运行字节复用实测 v13，新增来源输入及共享库替换验证独立记录，不重跑有效 GPU 矩阵。M4 管理后台、M5 业务增强等后续阶段尚未因此完成，用户最终使用确认另记。以下状态为各轮历史。

新增内部[原生执行桥验收](2026-10-17-image-super-resolution-execution-bridge.md)：完整互操作、单次 AUTH、自然收尾、调用方失联、四项原生交错与诊断清理后覆盖已完成所定分轮技术验证，最终固定源码与实际证据独审通过；文稿及本地交付仍待。验收项、失败与实际轮次仅记在该计划，不增加下列 86 项业务或 24 项 worker/部署规格通过数，不追补既有失败或未证场景。

普通产物文件刷盘实现及分轮技术验证已完成：复用 complete-intent 正例观察真实同句柄刷盘，初次半候选、published/durable、非成功尝试及 engine/raw 保持 `r`；完整预检后的替换、消失和资格失效均保守结束，不刷未验证内容、不创建 raw 回退或新根，打开/刷盘故障保留阶段。原 RED、编译 RED、Windows 旧夹具部分失败和两平台分轮修复记录统一见[主 SOP 当前切片](2026-10-10-image-super-resolution-integration-plan.md)；源码/文稿独立复审及本地交付仍待，不增加下列业务/部署规格通过数。

新增目录持久化回归：`directory-durability.test.ts` 用真实文件系统分别验证输入与产物目录刷盘，保留子文件原字节；复用 `credentials-store.test.ts` 的完整新建父链、初始化/重开身份、刷盘失败关闭与句柄释放测试。TDD 首轮 3 项失败，修复访问权限后 2 项通过/1 项失败，再修复命名空间停止边界后 3 项通过；三轮各有 26 项名称过滤，不计通过或平台跳过。最终 Windows 4 文件 120/120、Linux 5 文件 136/136 分别通过，类型与构建通过；不累加两平台或历史轮次，也不改变下列 86 项业务/24 项 worker 部署规格统计。普通只读产物文件刷盘和实际服务身份仍待；详见[主 SOP](2026-10-10-image-super-resolution-integration-plan.md)。

新增内部[执行发送许可验收](2026-10-16-image-super-resolution-execution-send-permission.md)：内部实现、所定技术验证与固定源码/实际证据独立复审已完成，详细 P1–P15、实际分轮及文稿/本地交付边界仅列于该计划。该内部切片不改变下列 86 项业务规格或独立 24 项 worker/部署规格的统计与验收状态，不代作 Windows 耐久 Store、原生接线、GPU、Worker/API/ZEB 或用户/部署通过；既有历史及未证边界保持。

日期：2026-10-11，Asia/Shanghai。关联 [高清增强 SOP](2026-10-10-image-super-resolution-integration-plan.md)。

状态：已授权实施。M1 已完成自动、桌面、同产物测试发布和单次真实生图技术验收，用户已确认验收通过，未发生 GPU 增强；M2-A/B1/B2/B3-1 保留各自固定证据，见第 2 节。B3-2 固定历史证据为租约边界补修后受影响 4 文件 104/104、未变化 7 文件 144 项沿用、248 个唯一用例分轮覆盖，类型检查、声明构建及独立规范与质量复审通过、无遗留项。

当前 B3-4 已实现 completion、合格成功/普通失败、真实文件与 durable 候选、同源重验、取消/成功终态竞争、安全 succeeded 摘要，以及联合资格下的运行后中断恢复和 runner 接线；本批实现、技术检查及代码/文稿独立复审已完成。B3-3 v2 与旧切片按第 2 节保留固定历史。B3-5 G1 独立 OOM 分类保留固定历史证据；B4 无重试 OOM 终态已实现并通过技术检查及固定代码独立 Spec PASS / Quality Approved、C/I/M=0/0/0，自动降 tile 重试暂缓。B4-0 普通原件真实 CLI 4× 诊断已通过；B4-1A Windows Job/process、B4-1B1a 本地控制入口、B4-1B1b 可信文件记录、B4-B2-1 安装绑定及 B4-B2-2 Job 保护/原句柄观察原语已分别通过有界技术验证。B4-B2-3 准备请求数据合同的完整两文件技术验证与固定七源码/实际证据独立复审已通过；B4-B2-4 实际原生会话、B4-B2-5 reader 与 B4-B2-6 内部有界只读 launcher 已分别取得技术验证与固定源码/实际证据独立复审，详见第 2 节。[B4-B2-7 受限原生控制桥](2026-10-16-image-super-resolution-native-control-bridge.md)核心控制及所选输出闭包已完成技术验证、对应固定源/actual独立Spec/Quality复审，五个输出场景和六项旧回归分四轮通过。最终文稿校验/独立批准与中文本地提交及fresh readback，分别按最终固定回执和实际Git回读核定，完整v2/更广矩阵未完成。随后实现有界 TS stdio host，再冻结真实 prepare/AUTH 与 Windows execution Adapter 接线，分别验证图片、安装/实际服务身份和完整 GPU/worker/API/ZEB。测试站仍仅部署 M1，增强 worker 未部署、生产 ready=false、增强默认关闭。以下 86 项业务规格与自动用例是不同统计对象，不能据自动断言数量宣布业务规格全部通过。真实平台归属、防伪、实际后台身份、TLS/安装/运行中管理、成功流/receipt/清理及后台/ZEB 接线仍待。

已有 Windows CLI 的 128×128 → 512×512 小样记录，只算引擎基础探测，不能填入这里的业务画质、后台服务身份、端到端 API 或 4K 验收结果。

[B4-B2-4 原生执行会话](2026-10-15-image-super-resolution-native-session.md)已实现，最终完整 Windows 35/35 及固定源码/运行证据独立 Spec/Quality Approved、C/I/M=0/0/0。该片仅覆盖实际 native 会话与原资源寿命，独立只读 reader 与有界 launcher 另记 B4-B2-5/B4-B2-6；受限原生控制桥、有界 TS stdio host、真实 prepare/AUTH 与 Windows Adapter，以及图片验收、安装/服务身份及 GPU/worker/API/ZEB 继续后续分片，下列历史统计保持各自原轮次。

## 1. 里程碑、依赖与用例位置

| 里程碑 | 交付目标                               | 依赖                                           | 用例位置                                                                            | 当前执行状态                                                                                                            |
| ------ | -------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| M0     | 明确尺寸、样本、引擎版本与业务画质基线 | 无                                             | 本文第 4 节，SR-M0-*                                                                | 规格已冻结；业务 A/B 与容量未执行                                                                                       |
| M1     | 清理普通插值放大，保留原件与真实尺寸   | M0 的尺寸与数据规则                            | 本文第 5 节，SR-M1-*                                                                | 自动验证、构建、受控桌面、测试发布与单次真实生图技术验收通过；用户已确认验收通过                                        |
| M2     | TypeScript/Node.js 远程增强 worker     | M0 的任务、模型与预算规则                      | [worker 用例](2026-10-11-image-super-resolution-tests-worker-packaging.md)，SR-M2-* | 历史与本批证据见第 2 节；B3-4 及后续原语分片保留独立记录，B4-B2-3 数据合同源码/实际证据批准；完整 worker 未完成、未部署 |
| M3     | Windows 安装包及实际后台身份运行       | M2；实际 GPU/驱动/模型                         | [部署用例](2026-10-11-image-super-resolution-tests-worker-packaging.md)，SR-M3-*    | 未执行                                                                                                                  |
| M4     | 管理员开关、按模式配置与检测           | M2 的接口契约；M3 提供真实自检环境             | [后台用例](2026-10-11-image-super-resolution-tests-admin.md)，SR-M4-*               | 远程API配置开发及独立验证通过，开发测试验收；12项逐项映射见M4记录，任务／资产组合到M5验                                 |
| M5     | 普通完整生图端到端异步增强             | M1～M4                                         | 本文第 6 节，SR-M5-*                                                                | 各项按原定层次补验；F13实际与专审通过，最终构建／开发发布未完成                                                                                                                  |
| M6     | 本机 CLI 适配与独立验收                | M0、M1、M2 的共用任务契约、M4；不依赖远程 HTTP | 本文第 7 节，SR-M6-*                                                                | 未执行                                                                                                                  |
| M7     | 电商场景的派生交付和商品保护           | M5；新保护/派生交付契约                        | [保护用例](2026-10-11-image-super-resolution-tests-protection.md)，SR-M7-*          | 未执行                                                                                                                  |
| M8     | 局部候选增强与保持源画幅的保护合成     | M7；已确认源图、蒙版与坐标规则                 | [局部用例](2026-10-11-image-super-resolution-tests-protection.md)，SR-M8-*          | 未执行                                                                                                                  |

M2/M4 可在接口冻结后并行开发。首批验收 M0～M5 的 Windows 远程 API 闭环；M6、M7、M8 分别交付。GPU/CLI/模型与 1254 级原件真实 4× 已取得 B4-0 诊断证据；B4-1A 底层原语、B4-1B1a 本地控制入口、B4-1B1b 文件原语、B4-B2-1 声明安装绑定、B4-B2-2 Job 保护/原句柄观察与 B4-B2-3 准备请求数据合同已有各自有界技术证据，接下来将新合同输入、安装租约与原引擎 prepare/authorize 接入 authorization/controllerLoss/terminal 因果顺序、原 session/wire、可信 reader 与 TS adapter，验证租约寿命，再验安装/数据目录配置及实际运行身份，补成功传输/其余必要持久接缝后验测试环境后台和普通完整图闭环。SR-M2-13 自动重试暂缓，不作为首批 GPU 前置，也不能记为通过；原件、尺寸、认证、归属及所选安装/TLS 验收保持。Linux 实机、SSH、mTLS、服务账号密码与其他尚未交付模式不作为首批额外前置条件。

用例总计 **86 项**：M0 6 项、M1 10 项、M2 16 项、M3 8 项、M4 12 项、M5 12 项、M6 6 项、M7 8 项、M8 8 项。执行从 M1 与 M2 基础层开始，完整规格状态随实际证据更新。数量统计只按用例标题计一次，参数化负例分别记录结果，不冒充多次真实 GPU 验收。

## 2. 执行与判定规则

### 2.1 用例等级与执行层次

- P0：数据真实性、原件可用、权限认证、任务恢复、版本归属与保护像素。相关失败必须修复后才能发布受影响功能。
- P1：业务画质选型、部署维护和用户体验。用例写明的验收结果仍需取得；人工画质意见用于选型/发布验收，不新增线上强制暂停用户任务的主观门禁。
- 确定性自动测试：在现有测试框架实现尺寸、字节、路由、协议和状态契约，按实际实现范围登记；可用可控 adapter/CLI 替身，但替身不证明真实 GPU 推理或画质。
- 真实 GPU：使用固定原件、实际引擎及服务身份验证完整解码、倍率、资源与观感；记录实际运行方式。
- 桌面 UI/部署：只覆盖交付的桌面入口、Windows 服务及选定 Linux 部署方式，不做手机适配、视频/音频矩阵或无关浏览器穷举。

所有用例初始状态都是“未执行”。后续执行记录只能使用：未执行、通过、失败、阻塞、不适用。不适用必须写清未交付模式或缺失硬件，并限制对应支持声明；不能统计成通过。端口连通、假引擎成功和旧 CLI 小样不能升级成整条链路通过。

### 2.2 共用前置与证据

1. 在独立开发测试环境执行，使用独立任务、工作目录和测试配置。故障注入只影响测试 worker，不关闭共享服务、不清理其他任务。
2. 每项记录用例 ID、实现提交/安装包摘要、执行环境类别、实际服务身份类别、fixture 摘要、冻结配置版本、操作时间、实际结果与证据路径。公开报告只使用匿名环境标识。
3. 图片证据包含原件、引擎输入、AI 中间件与最终交付的实际解码尺寸及 SHA-256；不存在某阶段时记“不适用”和原因，不能复制请求值冒充实际尺寸。
4. 原件、派生件不可变。保护像素比较使用冻结后的统一 EXIF 方向、色彩空间和 alpha 解码基线；验收件用无损 PNG。不能拿 JPEG 全图重编码误差当作局部允许变化。
5. 模拟故障记录注入时点及目标任务；进程验证只追踪本任务 PID/启动身份，不执行全局 kill。恢复允许对未完成推理受控重试，但不得产生两个同时活动的执行者、重复业务生图或重复发布。
6. Token、密码、私钥只在未来执行时生成/配置，证据只记脱敏凭据版本与校验结论。不得保存原值、真实账号、私有地址、环境域名或用户会话身份。
7. 运行资源预算写入匿名测试配置：输入字节/像素、AI 中间件字节/像素、交付字节/像素、队列容量、任务等待/执行时限与尝试上限。边界用例逐层测试限值减一、等于限值、限值加一，不擅自放宽其他层限制。
8. 真实 GPU 与真实生图模型分别标记。使用受控上游响应得到固定 fixture 可验证真实 ZEB 保存/远端 GPU/交付链，但不能声称真实生图模型返回了该固定尺寸。像素预算的精确整数边界可在解码/准入接口测试；实际图片另须满足格式、可构造宽高和解码限制，不能用虚假头部冒充合法图片。

建议执行记录表：

| 用例 ID  | 实现/包版本 | fixture/策略摘要 | 执行层次   | 实际结果及证据 | 状态   | 限制或缺陷 |
| -------- | ----------- | ---------------- | ---------- | -------------- | ------ | ---------- |
| SR-M0-01 | 执行时填写  | 执行时填写       | 确定性自动 | 执行后填写     | 未执行 | 当前仅规格 |

本轮 M1 补充执行记录（不增加 86 项业务规格数量，也不代表全部规格通过）：

- 受控桌面：Chromium 4/4（3 项准备、1 项业务），受控上游请求 4096²、返回原生 1254² PNG；原件保留、刷新、下载及同资产引用通过，上游生成与 Run 提交各一次。此记录属于受控上游证据。
- `SR-M1-LIVE-01`：测试环境 `/create` 单次普通文生图，无参考图、无 Skill，使用 `gpt-image-2.5-flare` 请求 4096×4096；真实返回、页面及下载 PNG 解码均为 1254×1254，下载 2,840,237 字节，生成完成耗时 1 分 43 秒。刷新保持原会话结果与请求/实际尺寸；“更多 → 引用结果”的预览与草稿复用同一个永久源文件，仅预览参数不同，未发送第二次生成。技术验收通过，无 GPU 增强。用户已确认 M1 普通插值放大移除并验收通过，范围与证据沿用说明见[主 SOP §10](2026-10-10-image-super-resolution-integration-plan.md)。

M2-B1 补充执行范围（补修后 B1 三文件 56/56、生产声明构建及类型检查、独立规范与质量增量复审通过；用户及实际部署验收仍待，不增加 86 项业务规格数量）：

- 补修前候选 5 文件 148/148 是历史快照，包含基础层 96 项及当时 B1 的 52 项。新增的三个祖先目录 EIO 故障及多层成功初始化/重开/刷盘顺序用例已先 4 项 RED、再同命令 4 项 GREEN；补修后受影响回归为 credentials 27、jobs 28、真实双 Node 进程独占锁 1，共 3 文件 56/56。基础层 96 项沿用既有证据，不把两轮结果合称一次全包 152 项通过。
- 首次多层创建数据目录时，刷盘顺序覆盖数据目录至首个既有父目录；故障路径验证脱敏、无首次凭据、目录 descriptor 关闭及真实 SQLite 连接释放。test 前置生产声明构建、随后类型检查均通过；独立规范与质量增量复审关闭原唯一 Important，Critical/Important/Minor 均为 0。
- CodeGraph 在源码同步后更新且状态为 up to date。只有独立包的技术层变化，尚无受影响的桌面业务流程，不重复执行 M1 桌面或无关媒体矩阵。

| 关联规格         | 本切分提供的技术证据                                                                                 | 仍需后续取得的证据                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| SR-M2-02、04     | 本地认证拒绝缺失/错误/吊销密钥；显式初始化、关闭重开后身份与密钥摘要保持，明文不落盘                 | 七个 HTTP 端点鉴权、离线管理入口及真实部署                     |
| SR-M2-05         | 同一稳定 client 下本地轮换/吊销后继续访问原排队任务，另一 client 不能查询或取消                      | 运行中 CLI 管理通道、运行/成功任务及服务切换                   |
| SR-M2-06         | 真实 SQLite 唯一约束；同键并发、重启、响应丢失后的重放；冻结配置复用及冲突；文件与 COMMIT 故障不接受 | HTTP 断流后的 202/409 语义与真实执行计数                       |
| SR-M2-07、08、09 | 事务内等待容量、队列重开、真实双 Node 进程独占锁与排队取消；文件/目录刷盘及原子 rename               | 活动 GPU 并发、排队超期推进、租约/运行恢复、精确运行取消与超时 |

B1 本切分测试使用真实临时 SQLite 和文件，少量受控 I/O 故障注入不等于断电验收；HTTP 证据由 B2 单列。B1 固定快照状态仅为 `queued/cancelled`，没有执行器、GPU、成功产物或接收确认，不将关联规格整体标记通过。测试脚本先构建当前包再运行，跨进程用例不能加载旧 `dist` 冒充当前实现。

M2-B2 已验补充执行范围（受影响回归、类型检查、声明构建及增量独立复审通过，本切分仅作为本地开发里程碑，未创建 PR 或发布，不增加业务规格数量）：

- 期限补修后 HTTP 三文件 85 passed / 1 skipped；该跳过项是已单独自然计时真实 TCP 验证通过的新增慢头部用例，避免重复长耗时验证。最终 HTTP 86 个唯一自动用例分轮覆盖，类型检查与声明构建退出 0、stderr 空。修复前统一五文件 115/115 与认证 21/21 补验属于历史证据，不与本次 85+1 相加；B1 jobs 28、jobs-abort 2 及基础 96 项沿用原证据。业务规格总数也为 86，统计对象不同，不能据自动断言数标业务规格全部通过。
- 七端点拒绝认证先于正文、临时目录与业务查询；公开 `request.read(0)` 不消费正文，收尾不读私有字段或无界排空。canonical 未知密钥、重复 rawHeaders、Expect 先认证、未完成 chunked 拒绝及能力白名单均有真实 TCP 证据。具名 Busboy 接收原始 plan/image 流，严格区分外部字段/文件角色及实际字节，plan fatal UTF-8 解码；独占背压 spool 后按冻结字节上限读取原件 Buffer 接入 B1。该接缝有界，不代表 B1/解码零拷贝或整个进程只保留一个 Buffer。
- receiver 独占显式上传期限，server 工厂 Node `requestTimeout=0`，保留 `headersTimeout`/`maxHeaderSize`；组合宿主不得有更早整请求期限。新增自然慢头部用例确认应用 timer 实际触发，返回结构化 408/upload_timeout、本次 spool 清理、上传槽释放及后续上传成功；真实 TCP 请求头预算 200/431 仍通过。
- 重放使用旧任务冻结原件预算与完整合法请求，新配置变化、未就绪或满队列不把正确旧键变成新任务。完整接收后写盘期间已观测断连拒绝，COMMIT 后真实丢响应保留输入并在重启后同键找回，真实数据库 COMMIT 失败不返回 202；并发唯一、原冻结预算及取消终态重放保持。独立规范与质量增量复审通过、Critical/Important/Minor 均为 0；本切分仅作为本地开发里程碑，未创建 PR 或发布。

| 关联规格     | B2 当前提供的已验技术证据                                                                                                                | 仍需后续取得的证据                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| SR-M2-02、04 | 七端点先认证、rawHeaders 歧义拒绝、Expect 鉴权、能力白名单与真实 TCP 零副作用；固定范围独立复审通过                                      | TLS 服务身份、运行中管理及实际部署                               |
| SR-M2-06     | 合法有界提交、冲突映射与冻结预算重放；durable 写入期间断连拒绝、COMMIT 后丢响应/重启找回和 COMMIT 失败映射回归通过，固定范围独立复审通过 | 真实执行计数                                                     |
| SR-M2-07、09 | 显式上传并发/receiver 期限、自然慢头部超时清理/槽释放/后续上传、queued 查询/取消和 ready=false 的真实映射                                | 活动执行槽、排队超期推进、lease/fencing、运行取消与恢复          |
| SR-M2-15     | 非成功 result/receipt 409、未知或他 client 任务 404                                                                                      | 成功结果流、持久 receipt、引用及清理；不把拒绝骨架当生命周期通过 |

以上 B2 固定快照只证明回环 HTTP 范围，不证明远程 HTTPS、真实 GPU、Windows 安装、管理员后台或 ZEB 接线；该快照无 runner 默认 ready=false，不伪造成功图片。

M2-B3-1 固定历史快照已验补充执行范围（统一受影响九文件 204/204、前置声明构建与最终类型检查通过；本批固定 worker 范围独立规范与质量复审通过、无遗留项，不增加业务规格数量）：

- 新 schema v2 普通打开拒绝版本不匹配，不迁移或清旧数据。真实 SQLite/文件验证单槽、createdAt 与稳定 queueSequence、队列截止前/等于/超过、超期容量恢复，以及冻结 executionPolicy 在配置变化/重开/合法重放后保持。running 不计等待容量；测试真实顺序先启动首项，再等待两项，第 4 个新键 429，active=1。
- 受控 adapter 和同源 Clock 验证领取、prepared 与 authorized 各自 COMMIT 屏障；读取真实 SQLite 快照观察持久事实，不增加生产测试后门。并发 wake 不重复 prepare/authorize，close 后迟到 prepare 不再授权；错误、响应丢失与未知活动槽保留真实状态，不释放槽或制造成功。
- running DTO 与 queue_timeout 来自持久事实；running 取消暂为 503/not_ready，非成功 result/receipt 为 409，未知或他 client 任务 404。排队取消与已有终态重放保留。生产默认 ready=false，测试 adapter 启动不是 GPU 推理或成功产物证据。
- 补修后受影响九文件同轮 204/204：runner-store 48、runner 12、credentials 27、lock 1、jobs 28、abort 2、HTTP 21/46/19；包含 descriptor 持久 JSON 边界及自然慢头部 HTTP 用例，本轮无跳过。前置声明构建与最终类型检查通过，本批固定 worker 范围独立规范与质量复审通过、无遗留项。首轮 focused 58 项、基础 96 项及旧 HTTP 分轮 86 项不与本轮数字累加；业务规格仍按实际覆盖范围登记。

| 关联规格     | B3-1 已验技术证据                                                          | 仍需后续取得的证据                                         |
| ------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| SR-M2-06     | running/failed/cancelled 同键重放、同次配置快照冻结 policy、原请求身份保持 | 实际部署下的真实执行计数                                   |
| SR-M2-07、09 | 数据库单槽、稳定领取、排队超期和容量恢复、先启动再等待的确定性顺序         | 活动 GPU 并发、lease 续租、执行期限停止及恢复/fencing 转移 |
| SR-M2-08     | 排队取消/领取竞争、wake/close 屏障、running 取消明确 503                   | 持久运行取消请求、精确停止、全树退出及终态竞争             |
| SR-M2-15     | running/failed 安全 DTO、非成功 result/receipt 拒绝及归属隔离              | 合格产物/成功终态、成功结果流、receipt 与清理              |

完整 B3/M2、真实 CLI/GPU、Windows、TLS、后台与 ZEB 接线仍未完成；初始 lease、fence 和执行截止的登记不能代作续租、恢复或停止验收。

M2-B3-2 固定历史补充执行范围（独立规范与质量复审通过、无遗留项，不增加业务规格数量）：

- 复审前同轮 11 文件 244/244、无跳过、测试 stderr 空；同步 soft 内 close 多发 force 已真实单项 RED→GREEN。租约/宽限同步交错补充 4 项真实 RED→GREEN 后，受影响 lifecycle-store18、lifecycle-runner26、runner-store48、runner12，共 4 文件 104/104、无跳过、测试 stderr 空，类型检查与声明构建通过。未变化的 credentials27、lock1、jobs28、abort2、HTTP21/46/19 共 7 文件 144 项沿用前候选证据，11 文件 248 个唯一用例分轮覆盖；首轮39与历史快照不累加。
- 真实 SQLite 覆盖 lease 等于/超过、错误 tuple、principal 过期后取消而旧 owner CAS 拒绝、最早停止事实保持、超期后的合法停止续租以及取消终态与清槽事务回滚；受控同源 Clock/adapter 覆盖 heartbeat、执行与 force 严格超过、悬挂确认、迟到 prepare、同步退出订阅、终局封存、关闭交错和等待槽。
- soft 同步 hook 推至本轮真实 lease 的前一刻、等于和超过，以及跨原取消宽限；验证命令前及调度前的新鲜事实、到期 heartbeat、严格未来 timer、各 mode 至多一次。过期不强停、不续租、不新增 timer，仍 running 并保槽；有效时按新时间推进 force，执行预算和最早停止事实不变。
- 真实 TCP 覆盖 running 首次/重复202、applied、归属404及不等待执行器；HTTP 不自动 wake。普通精确退出在 B3-2 固定快照仍保槽；该快照未含当时后续的产物/成功竞争，B3-3 历史与 B3-4 当前证据见下。B3-5 OOM、真实平台进程树/Windows/GPU、成功下载/receipt/清理及完整远端部署继续未执行。

M2-B3-3 v2 固定历史补充执行范围（补修与受影响回归通过，代码 v2 与公开文稿独立复审通过，不增加业务规格数量）：

- v1/r2 固定历史证据：同轮 13 文件 351/351＝新 recovery 两文件 103 项＋该轮重新验证的既有 11 文件 248 项，无跳过、测试 stderr 空，墙钟 63.90 秒，类型检查与声明构建通过。首轮 typecheck 失败时尚未进入 build/行为回归，已修正同步退出订阅回调后的所有权重读；该编译失败不记为行为 RED 或通过，首版证据不直接代作补修候选通过。
- v2/r3 补修证据：同步重入 guard 在外部 inspect 前建立，微任务进入恢复前重查 closed，新增重入用例已真实 RED→GREEN。类型检查、声明构建和受影响 recovery-runner31、lifecycle-runner26、runner12 共 3 文件 69/69 通过，墙钟 25.12 秒、无跳过、测试 stderr 空；未变 10 文件 283 项沿用 v1/r2，13 文件 352 个唯一用例按 69 本轮＋283 沿用分轮覆盖，不称同轮 352，不累计 351＋69、RED 或基础 96 项。
- SR-M2-08 部分：真实 SQLite 的内部 incarnation 与排他重开建立跨实例启动中断，持久控制绑定 source/publisher/ticket/代次，发放即拒绝旧普通写；`expectedControl` 刷新只接受仍有效的原控制。四类 inspect 均核对原 producer；unknown、异常和挂起保槽且不就绪，合法终局或未授权原子封存后才在同事务转移 publisher，原 attemptNo/producer/票据/目录保持。
- SR-M2-07/09 部分：恢复等待沿既有未来事件推进队列与全局期限，不新增固定轮询；恢复 soft/force 每次重核控制、原归属、持久停止事实和当前时间。原宽限不延长，等于不 force、超过才允许；同步回调、控制替换、close 及迟到结果不得产生后续越权写库、停止、转移或启动。停止返回、抛错或挂起不代作全树退出。
- SR-M2-08 部分：只有跨实例启动中断与未授权封存的联合证明可登记 store 持久去重事件；事件消费与替代 attempt/新票据/新目录和槽转移同事务。`created` 才可启动，`already-applied` 仅查询；新计算沿原 job、冻结输入/策略/tile 和首次执行截止，不回 queued。该快照的已授权终局且无 stop 留 running/awaiting-artifacts、保槽、ready=false，文件存在或缺失均不赋予成功、普通失败或重算资格。
- 该快照当时未验 SR-M2-08 的输出半写、校验/rename 后提交前、成功提交后恢复，以及 SR-M2-09 的成功竞争；本批技术范围见下。真实进程树/Windows/GPU、B3-5 OOM、TLS、安装、后台、ZEB、成功流/receipt/清理继续未交付。上述受控证据不表示 24 项完整 worker/部署规格、86 项业务规格、页面或真实 GPU/Windows 已通过。

M2-B3-4 当前候选补充执行范围：本批实现、技术检查及代码/文稿独立复审已完成，固定生产链、runner/RR7/schema 增量及八稿文稿均获独立 Spec/Quality Approved、C/I/M=0/0/0；不增加业务规格数量，不构造跨片唯一自动用例总数。

| 关联规格      | 本批已经取得的技术证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 仍须保留的范围                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-M2-08      | completion 分类与全树终局分离；真实输入/accepted engine/产物/manifest、半件与不可覆盖 durable 候选、同源重验和精确 run/recovery ref；可信 reader 实际读取 authorization/controllerLoss/terminal 三记录，原授权/跨 incarnation/当前 ref/control/no-qualified/无取消/原预算联合资格；event/attempt/slot/ref 同事务转移。runner 仅 transferred awaitingArtifacts+interrupted 进入 additive recover、完整 chain 缓存、created-only 交接并在 prepare 前核完整当前权限；already-applied、close、退役及 active recovery control 无迟到启动 | RR3/4 只证明 COMMIT 后未 prepare replacement 安全保留，可信未准备 ticket 封存及原样 reopen 留 B4；已 COMMIT success 只 GET/replay，不承诺自动历史成功扫描。受控三记录不是 OS 防伪或实机全树证明 |
| SR-M2-09      | 合格普通失败可提交 execution_failed；取消先终态 COMMIT、成功先 COMMIT、请求较早但成功先 COMMIT 均有真实门；原 lease/fence、首次 deadline、持久 execution_timeout 保持；正常续租、close/期限/模式与 runner timer/wake 分界有定点证据                                                                                                                                                                                                                                                                                                 | 取消请求不单独抢赢完整成功资格；有取消/stop 禁止恢复新计算。真实平台停止、Windows 子进程树与 OOM 交错另验                                                                                       |
| SR-M2-11      | 匹配原授权/producer/descriptor/ticket、success completion、exitCode=0/signal=null、全树终局与 durable 候选共同决定成功；真实坏像素、格式/透明/方向/倍率/字节与像素预算、非零退出残留好图已有部分技术覆盖；当前精确 ref 的确定性坏输出可裁 invalid_output                                                                                                                                                                                                                                                                            | I/O、accepted engine 或完整候选损坏保守留存并同源重验，不混为普通坏输出或新计算；错来源只拒绝，不使当前任务失败                                                                                 |
| SR-M2-12      | 沿原冻结 engine/AI 字节与输入像素预算校验真实 bytes，不重复归一；文件/manifest 耐久后才登记 DB result，终态/清槽/ref 结束有原子故障门                                                                                                                                                                                                                                                                                                                                                                                               | ZEB 最终交付预算与真实 GPU 峰值内存另验；文件故障注入不等于断电                                                                                                                                 |
| SR-M2-15 接缝 | run/recovery 持久引用在所有已发出 I/O/解码/close drain 后才精确结束，release 异常先澄清事实；未知旧 ref 跨重开保留，无 TTL 擦除                                                                                                                                                                                                                                                                                                                                                                                                     | 下载引用、receipt、purge claim/互斥、保留清理及 410 尚未交付，不标整条清理生命周期通过                                                                                                          |
| TC1           | succeeded 的 GET/合法同键 replay/重复取消输出持久安全摘要 format/width/height/sha256/byteLength；未知/异 client 404、非成功 result/receipt 409、成功 result/receipt 503/not_ready，ready=false 不阻止合法原任务重放                                                                                                                                                                                                                                                                                                                 | 成功 result 流、receipt、清理与完整远程 TLS/后台/ZEB 另验                                                                                                                                       |

切片统计按[主 SOP §10](2026-10-10-image-super-resolution-integration-plan.md)分别登记：G1 68、G2a 各组 24/16/6/46、G2b 分轮 50 与既有 123 及重叠补修 31、G3 raw 91/首条补修79/资格29、R4 同轮123、R5 新7与分轮213/15保留各自固定版本身份，不能跨组累加。本轮最后接线实际 runner **7/7（15.69秒）**；相同12hash四旧caller文件 **86/86（27.58秒）**；随后schema **4 passed / 47 filtered（1.79秒）**，三个实际运行组各自通过，测试stderr均0。typecheck/build各exit0，后两组复用相同hash编译；编译stderr为正常tsc回显。schema版本5正控及1/4/6拒绝通过，47是过滤数，不是执行或源码skip，不称同轮97。runner固定增量独立Spec compliant / Quality Approved、C/I/M=0/0/0；本批生产链与八稿文稿已分别取得独立复审批准，单片批准不替代这些回执。

R4 的 factory/Statement 动态观测结合就地事务静态审查，不称直接 immediate/exclusive invocation 动态计数或所有 await/lease 组合穷举。R5 是应用层 created 回执丢失后的只读 replay，不是 native 成功 COMMIT 后异常，也不是同步事务内部 replay 注入。RR4 仅指定公共 store 方法无关闭后访问，不泛化任意 SQLite 零访问。测试站仍 M1，worker 未部署、production ready=false、增强默认关闭；B4 真实 CLI/Windows/GPU、TLS/安装/运行中管理及后台/ZEB 和用户/业务 A/B/容量均独立验收，B3-5 自动降 tile OOM 补救暂缓。

B3-5 G1 固定历史仅验证独立 `oom` completion 的接受、严格拒绝与恢复检查分类，同轮四文件 90/90、34.90 秒，typecheck/build 各 exit 0、test.stderr 0；固定增量独立 review-v1 的 Spec/Quality 均 Approved、C/I/M=0/0/0，未部署，不代作本次文稿批准。schema 仍为 5，未新增 `oom_retry_used`、`oom_retries` 或 `settleOom`，G2/G3 与自动降 tile 均暂缓。用户提供 24GB 显存不代作容量验收或永不 OOM 的证明。

B4 已补无重试 `failed/execution_failed` 消费、精确清槽、原证据/输出保留及后续任务恰一次推进，覆盖直接 store、live runner、持久重开、合法当前 publisher 与停止/租约/恢复控制约束；残留完整 PNG 不发布成功。本轮四文件 82/82、34.84 秒，无跳过，typecheck/build 各 exit 0、测试 stderr 空，固定代码独立 Spec PASS / Quality Approved、C/I/M=0/0/0，与 G1 旧轮分开，不代作本次文稿批准。精确验收见 worker 规格的 `SR-M2-13-TERM`，不增加业务规格数，不将暂缓的自动降 tile 或 Windows/native/GPU/API/ZEB 验收记为通过。

B4-1A 底层原语补充技术记录：最终 Windows OS 套件 11/11 passed，12.35 秒（tests 11.08 秒），无 skip/filtered、exit 0、test.stderr 空；self-contained fixture publish exit 0、无诊断。普通 core build、普通 DLL 不含测试 seam 的独立反射及 TS typecheck/build 沿用未变源码的有效分轮证据，不与旧失败或 focused/filtered 运行相加。固定原语与 fixture 补修已分别取得独立 Spec PASS / Quality Approved、C/I/M=0/0/0，原两项 Important 关闭。

该套件仅验证创建时挂起归入原 Job、prepared 前真实成员与 PID/FILETIME/accounting 核验、一次授权、父进程先退出时保留后代、精确 Force/无关同名进程、字面 argv/句柄白名单、最后 owning Job 句柄关闭、双流内容/实际 EOF 与异常清理等原语边界。终局等待仍须联合原 engine 信号、原 Job ActiveProcesses=0 和调用方双流 EOF；普通 Job completion 通知不单独证明空树。夹具 outer guard 不持有 inner Job 句柄，不将独立清理视为 harness 硬崩溃 containment。11 项是有界技术用例，不增加 86 项业务规格或 24 项 worker/部署规格，也不把 SR-M2-08/09/10/14 整项标通过。原语与本地控制入口的执行授权接线、业务因果记录、安装/数据 ACL 与 install manifest、TS adapter、Windows 文件能力/main、实际后台/GPU/API/ZEB 接线仍待；schema 5、自动重试暂缓、worker 未部署、ready=false 和测试站 M1 保持。

B4-1B1a 本地控制入口的独立 Windows 技术轮次验证真实 EXE/local named pipe、pinned PID/FILETIME/SID、实际 protected pipe ACL、原 claim 连接唯一 owner、watch/inspect 与不可逆内存 seal；已 signal controller 在 ready 前拒绝，首实例完成旧 I/O 清理并实际断开后可继续接受连接。完整轮次、独立 native/fixture 复审及分轮边界见[主 SOP §10](2026-10-10-image-super-resolution-integration-plan.md)，不与上述 Job 原语轮相加。`ready` 仅监听、`stop` 仅封存 claim；C13 wrong-SID 和真实远端拒绝未执行。该片不提供持久 terminal、安装/数据 ACL、生产 helper 生命周期、引擎授权或 worker/GPU/ZEB 接入证据，不整项填 M2/M3/M5 或 SR-M2-08/09/10/14 通过。

B4-1B1b 文件原语的独立技术记录：前置普通正控 1 passed/8 filtered、5.56 秒，与随后 scaffold J1 的真实 Created 缺失 RED（1 failed/8 filtered、2.60 秒）分别保留。实现后 focused J1 为 1 passed/8 filtered、3.45 秒；最终同一不变候选完整普通 Windows 轮次为 **9/9 passed、43.10 秒，无 skip/filter、exit 0、测试 stderr 空**。九组包括独立 NTFS/Unicode/普通程序集反射正控及 J1–J8，覆盖完整身份、唯一原 Owner、无覆盖、严格重开、真实 write/flush 失败、同记录不确定重放与进程退出后重开；实际原 join、双流 EOF、独立 Job active0/无活成员及精确清理成立，普通程序集三个 test-only hook 类型缺席。四个正控内清理控制、私有诊断与祖先探针不增加分母；普通/测试 publish 各 exit 0、零诊断，未变 TS 沿用有效 typecheck/build 证据。

fixture 独立复审 v3 与生产 native 独立复审 v2 分别通过，批准范围止于各自文件原语技术任务；完整分轮及首次 J4 失败未证根因记录见[主 SOP §10](2026-10-10-image-super-resolution-integration-plan.md)。wrong-SID、remote、非 NTFS/other-volume 条件环境与罕见 STATUS_PENDING 分支未执行，不计入九组。文件 reservation/Existing 不授引擎权限或业务 terminal；B2 因果记录、引擎/TS 接线、安装/服务身份、生产 helper 生命周期和完整 GPU/API/ZEB 仍待，不增加 86 项业务规格或整项 M2/M3/M5 通过，M1 已验收与增强关闭/readiness=false 保持。

B4-B2-1 安装绑定的独立技术记录：最终同一不变候选完整 T0–T7 为 **8/8 passed、24.90 秒，无 skip/filter、exit 0、stderr 空**；八份实际 receipt/lifetime 对应、原 child close/双 EOF、全部租约释放及各一次精确目录清理均成立，普通程序集无测试 hook。T0 为独立 NTFS/UTF-8/hash/FileId/ACL/sharing 正控，T1 验证 selected pins 与固定 argv，T2/T3 验证外部原始清单摘要/严格解析及实际载荷/所选模型绑定拒绝，T4 验证真实 ACL/类型/hardlink/reparse/路径变体，T5 验证持有/幂等释放，T6 验证 selected-only/raw JSON/单一合法大小写拼写，T7 验证晚失败释放与非法 API 无 I/O。类型检查/声明构建、普通/fixture publish 及固定 native/fixture 独立源码复审通过。完整分轮、首次 7/8 的安全软件阻塞及不变代码解除阻塞过程见[主 SOP §10](2026-10-10-image-super-resolution-integration-plan.md)与[切片计划](2026-10-14-windows-engine-installation-plan.md)，focused、RED 和其他历史轮不累加。

wrong-SID、remote、非 NTFS/other-volume 条件环境未执行，位于八组分母之外；声明/inert 载荷绑定不证明完整 loader/helper、安装器/ACL 配置、服务身份、Job 授权/session/wire/reader/TS adapter 或真实 GPU/API/ZEB。此片与既有 M2-B2 HTTP 分开，不增加 86 项业务或 24 项 Worker/部署规格通过数；schema5、M1 已验收、自动 OOM 重试暂缓、增强关闭/readiness=false 和 worker 未部署保持。

B4-B2-2 Job 保护/原句柄观察的独立技术记录：原十一项扩展，加一项消费共享 independent empty-Job 安全正控回执，共十二项；tamper 变体不另增第十三项。独立安全正控为 1 passed/11 filtered、2.49 秒；prepared 实际 RED 为 1 failed/11 filtered、2.86 秒，失败是默认 DACL 未 protected/三 ACE/首 ACE SID 不匹配，先于 throw-only Inspect 调用，setup/清理健康。实现后 focused prepared GREEN 为 1 passed/11 filtered、2.64 秒；最终同一不变候选完整 Job 文件为 **12/12 passed、14.95 秒，无 skip/filter、exit 0、stderr 空**。上述各轮与历史 11/14/9/8 分别记录，不扩大原 86 项业务或 24 项 Worker/部署规格通过数。

实际验证创建时当前 SID protected sole-ACE Job ACL，以及九字段 `Inspect` 对原 PID/FILETIME、原 Job/raw membership、active/total、原 handles flags 和安全的只读观察。prepared1/1、sealed-live1/1、authorized3/3、父 signal/后代 live2/3、终态0/1或0/3与 Dispose 拒绝分别有独立事实；终态 raw membership 本轮为 true，不使用旧 dead-process shorthand。健康空树后的 harmless 第二 ACE 变体按固定错误拒绝。最终十一份原 child lifecycle（一 direct/十 harness）的 actual close、严格 UTF-8/双流真实 EOF、无强制或读错误、各一次精确 temp 清理成立；十个 subject native guard 健康，只有五次显式 engine join 有 engine 双 EOF，其余 null 不补造。scope 内 typecheck/build、ordinary/test publish 与普通程序集 hook 排除通过，固定四源码及完整实际证据的独立复审为 Spec Compliant / Quality Approved、C/I/M=0/0/0；本片文稿检查/独立文稿复审与提交另列。详见[主 SOP §10](2026-10-10-image-super-resolution-integration-plan.md)与[切片计划](2026-10-14-windows-job-observation-plan.md)。

本片仅为 SR-M2-08/09/10/14 的有界原语证据，双 EOF 不代作 SR-M2-10 高输出/有界日志完整验收。安装租约与原引擎 prepare/authorize、业务因果/session/wire/reader/TS adapter、安装/服务身份和完整 GPU/API/ZEB 接线仍待；M1 已验收、schema5、增强关闭/readiness=false、worker 未部署与自动 OOM 重试暂缓保持。

B4-B2-3 准备请求数据合同的独立技术记录：独立 control 为 1 passed/11 filtered、2.02 秒；TS 合法正样本实际 RED 为 1 failed/11 filtered、1.68 秒，native 独立合法正样本实际 RED 为 1 failed/11 filtered、2.18 秒，均为编译/传输健康之后的缺失行为。相同正样本 focused GREEN 为 3 passed/21 filtered、3.54 秒；最终同一七源码候选完整两文件为 **24/24 passed、77.33 秒，无 skip/filter、exit 0、stderr 空**，恰 12 TS 组和 12 Windows 组。各轮独立登记，不与旧 12/14/9/8、focused/RED 或 86/24 项规格累加。

完整轮 TS 为 365 条拒绝向量与 9 次正调用；native 为 309 条拒绝向量、7 次正解析与 1 次独立 BCL 正控，共 317 次真实 original fixture child。全部回执 actual close(code0/signalnull)、双流真实 end、严格 UTF-8、stderr 空、无 forced/timeout/error；这是 fixture EOF，没有引擎启动或 payload 路径 I/O，不代作 engine EOF 或故障注入 hang/kill 回收实测。共享独立 raw oracle 不依赖新 serializer，TS→native 另列；原字节/SHA/Base64、decoded duplicate、数值 token/Unicode、源 data-property/shape、冻结 policy/stored engine、source/result 不可变及合法替代 raw spelling 均有实际合同覆盖。语义负例重算匹配 SHA，组数、向量数和进程调用数分别统计。

typecheck/build 与普通/contract publish 各 exit 0，前两者 stderr 为正常 tsc 命令回显，不写为空；普通 managed DLL 无测试 hooks。固定七源码和实际证据独立复审为 Spec Compliant / Quality Approved、C/I/M=0/0/0；文稿检查、独立文稿批准与本地提交回读单独收口。完整职责、分轮及合同细节见[主 SOP §10](2026-10-10-image-super-resolution-integration-plan.md)与[切片计划](2026-10-14-windows-prepare-payload-plan.md)。此片仅为 SR-M2-14 等执行接缝的数据输入部分，不新增业务/Worker 规格通过，不证明路径/NTFS/ACL/安装安全、授权/session/wire/reader/TS adapter、服务身份或完整 GPU/API/ZEB；用户/部署验收仍待，M1/schema5/增强关闭/readiness=false/worker 未部署/OOM 自动重试暂缓保持。

B4-B2-4 [实际原生会话](2026-10-15-image-super-resolution-native-session.md)最终完整轮为 **35/35、212.45 秒总耗时/210.91 秒测试耗时，无过滤/跳过、exit 0、stderr 空**；离线逐项 35/35 verified、coverage=true、errors=[]，固定源码/运行证据独立 Spec Approved / Quality Approved、C/I/M=0/0/0。独立健康控制、真实 unsupported-prepare RED、focused controller-exit 与最终完整轮分别记录，历史 34/35 不追补为成功。已覆盖普通 prepare/AUTH/单次 resume/replay/自然收尾、冲突、九个 publication 写/刷/rename 故障、原 owner/controller/observer 区别、stop/deadline/长计时、后代/并发双流、session/public-wrapper count2、Unknown 及两次 crash/Existing 拒绝/独立读回。原 helper/引擎/树/双 EOF 与测试 fault containment 分别登记；AUTH、resume 与实际 ACK 不互代。

受影响生产回归独立沿用 control 14/14、32.49 秒；Job selected 2 passed / 10 filtered、3.78 秒；installation 8/8、28.82 秒，各自 stderr 空，不称完整 Job12，不与 session 或更早轮次累加。安装 wrong-SID/remote filesystem/non-NTFS/other-volume 条件环境未执行。完整分轮、fixture 排序更正和保留 Unknown 的故障边界见[主 SOP §10](2026-10-10-image-super-resolution-integration-plan.md)与独立计划。独立只读 reader 与有界 launcher 进展见下文，用户/部署验收、TS Adapter、图片/安装服务/GPU/worker/API/ZEB 仍待，不增加 86 项业务或 24 项 Worker/部署规格通过数。

B4-B2-5 独立只读 reader 的固定六源码/测试与实际证据独立 Spec/Quality Approved、C/I/M=0/0/0。native 真入口 `--read-records` 到实际 stdin EOF 严格解析一个 UTF-8 JSON，独立 inspect reservation 与读01/02/03/05/06，不读写04或创建 writer/新 reservation；existing 只证明物理 envelope。纯同步 `interpretWindowsJournalSnapshot(snapshot, expectedScope, originalDescriptor)` 核原 scope/descriptor/executionId、跨读物理身份、canonical Base64/fatal UTF-8/原 bytes SHA 和完整引用链，合格结果独立深冻结。private engine-exit 允许 loss Unknown、拒绝 existing 矛盾 loss；public interrupted 要求完整公共链，其他私有/partial/uncertain 结果仍 Unknown。Unknown 不证明缺失、未授权、无树或完成，也不授重试权限；AUTH/resume/ACK/原树/engine EOF/helper EOF 不互代，非零不推 OOM、exit0 不推图片成功。

| 独立实际轮次                | 已执行结果                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 纯 TS 新文件                | 265/265，768ms 总耗时/237ms 测试耗时、exit0、测试 stderr 空；Worker typecheck/build 各 exit0                            |
| 完整 reader 组              | 53 passed / 1 组外 C0 filtered（共生成54），302.23 秒总耗时/300.66 秒测试耗时、exit0、stderr 空；没有漏掉 reader 场景   |
| 实际 native stdout→built TS | 7/7、exit0；healthy engine-exit、public interrupted，以及 partial-auth/live/wrong-scope/wrong-id/raw-bad-record Unknown |
| 受影响旧 ordinary           | C0、ordinary-once、conflicts：3 passed / 85 filtered（共生成88），23.43 秒总耗时/21.23 秒测试耗时、exit0、stderr 空     |
| 受影响旧 control            | 独立旧 WinExe fixture 配同一普通 Core：14/14，27.74 秒总耗时/26.06 秒测试耗时、exit0、stderr 空                         |

53份原回执逐项独立核自然 join/真实双 transport EOF/noForce、exact census/active0、原 bytes/FileIds/目录不变与真实清理；旧 ordinary 精确 guard2/2、7/7、7/7。互操作的七份 stdout、scope/descriptor 与摘要来自同一原53场景，不是 synthetic/direct-control 快照；广泛 malformed/非零映射由未改 TS265覆盖，不泛称实际组合全覆盖。先行 focused2 被最终53覆盖，旧失败、有效 reservation 行为 RED、历史 session35/payload24 和业务86/Worker24 保持原范围，不加总或追补失败。

被动 console 诊断仅解释它自己的轮次，不追认旧失败对象、parentage 或严格 ACK 顺序。fixture 只补 assignment 前 Job IOCP/原句柄严格资格和 observer stop/join，原 enumeration/exact census 未放宽，通知仍可能不完整；未引入白名单、猜计数、轮询/重试/延时。B4-B2-5 当时未接 launcher/Adapter/runner/store/`readInterruptionEvidence`/HTTP/UI/实际恢复启动；独立 launcher 的后续证据见下段，原 reader 轮的 stdout 写失败、stop-post 失败、close-to-wake 未故障注入，wrapper close 不代作 native CloseHandle 回执。完整合同与限制见[主 SOP §10](2026-10-10-image-super-resolution-integration-plan.md)及[原生计划后续切片](2026-10-15-image-super-resolution-native-session.md)。文稿/提交门另行收口，用户/部署、图片/GPU/服务身份/Worker/API/ZEB/M2 验收仍待；M1/schema5/增强关闭/readiness=false/worker 未部署/OOM 自动重试暂缓保持，不新增业务通过 ID。

B4-B2-6 内部 Windows 有界只读 journal launcher 的固定九源码/测试/依赖及实际证据独立 Spec Approved / Quality Approved、C/I/M=0/0/0。同步冻结原 scope/descriptor 并复用 reader 校验；显式 request/stdout/stderr 字节与 read/cleanup deadline、固定 `--read-records <root>`/cwd/新 pipes、严格 fatal UTF-8/单 LF JSON/decoded duplicate-key 拒绝及合法 .NET Unicode 互操作均有覆盖，原解释规则不变。

| 本片独立轮次           | 实际结果                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| 完整新 launcher unit   | 96 passed / 1 non-Windows 平台 case skipped（97生成），1.48 秒总耗时/180ms 测试耗时、exit0、测试 stderr 空 |
| 受影响 reader 回归     | 265/265，1.79 秒总耗时/260ms 测试耗时、exit0、测试 stderr 空；与原 B4-B2-5 的265旧轮分开                   |
| 真实 Windows OS 完整轮 | 15/15，无跳过，26.72 秒总耗时/25.52 秒测试耗时、exit0、stderr 空，Node22.23.3/libuv1.51.0                  |

真实 OS 轮分别覆盖普通 helper transport、合成 qualified 历史、response-live/EOF-live、abort/deadline/close 与独立 sentinel、单路/并发 flood、early stdin failure、stderr/nonzero、Unicode/空格/单引号 argv 与实际 ENOENT/poison。15份 case 回执包含18次观察：17个已创建原 child 完整 join、1个 unresolved creation；3个 sentinel 自然 exit0/未 kill，断言失败、清理失败与 fallback test cleanup kill 均0。early stdin 实际 error=EOF/finish=false，后续完整原生命周期不能消除该通道错误的 Unknown/poison；ENOENT/undefined PID 不证明 OS never-created。完整 stdin、原自然 exit0、真实双 end、三 stdio close、child close 各自核验，kill 只使用原 ChildProcess。完整输出、close/killed 或本地 destroy 不替代 EOF/exit；未证清理保留 owner，迟到事实不升级已返回结果，创建/通道错误当前永久 poison admission，close 复用首次 promise/deadline。

普通 helper 未用 root 正控只证 transport 与合法 interpreted Unknown；qualified engine-exit 是合成历史，无新 engine/GPU 运行，helper EOF 不代作原 engine EOF。完整 Node/JS/helper/managed-runtime/loader/环境可信稳定部署仍为 TCB 前提，path/brand/pre-spawn hash 不认证部署；显式预算不证明 native reader 内存/深度/CPU 或硬实时有界，Node native handle 回收不冒充独立 CloseHandle 回执。Worker typecheck/build、格式/UTF-8/新增隐私/diff 检查和索引同步已通过；文稿/提交门另行收口。未改 Adapter/runner/store/session/engine 或注入 `readInterruptionEvidence`；当前推进受限原生控制桥，随后有界 TS stdio host，再冻结真实 prepare/AUTH 与 Windows Adapter 接线合同。reader53/nativeInterop7/ordinary3/control14/session35、RED/设置失败与业务86/Worker24 保留原轮次，不重跑、不合计、不新增整项通过。M1/schema5、增强关闭/readiness=false、worker 未接/未部署、OOM 自动重试暂缓保持；用户/部署、图片/安装服务/GPU/Worker/API/ZEB/M2 验收仍待。

B4-B2-7 [受限原生控制桥](2026-10-16-image-super-resolution-native-control-bridge.md)核心控制及所选输出闭包的技术验证、对应固定源/actual独立Spec/Quality复审已完成；v4→v5三项test/fixture增量源和五个输出场景/六项旧回归的四轮actual分别批准、C/I/M各0/0/0，生产五源未变。最终文稿校验/独立批准与中文本地提交及fresh readback，分别按最终固定回执和实际Git回读核定；只核已实施和已执行范围，完整v2/更广矩阵未完成。ordinary helper、专用故障helper与test-only原Job查询分账；没有TS host/ExecutionAdapter或engine completion。下表十三轮不能合计或用窄修追补旧失败。

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

只允许 ordinary helper ready 的末尾 CRLF 例外；桥 stdio/native pipe 仍严格 LF。Gate H 的原 helper 退出/双 EOF、native I/O 与真实桥 stdin EOF 先于唯一 terminal；Gate B 的实际 write/flush、queue/writer/全部 join 后才可结束。Unknown 不授重试或新 attempt 权限，迟到 cleanup 不升级。字节/观察预算不证明 native 内存/CPU 或硬实时有界，完整部署信任仍须单独证据。该片不增加业务86/Worker24整项通过；M1/schema5/增强关闭/readiness=false/worker 未接/OOM 自动重试暂缓、用户/部署与 GPU/Worker/API/ZEB 待验保持。

producer仅输出serializer depth2→3以支持合法bound，CLI配置parser depth2与输入schema不变。负例实际bound/刺激/ID次数/Unknown前成功权限、合法JSON空白配额隔离与单路EOF的close/stop触发顺序已有对应源/actual批准；local write不代远端消费，fallback不救回失败。v4 fixture曾有1条CS8602，v5仅复用已绑定query pin的非空local后fixture/fault发布均exit0、无warning/error，旧历史不删除；Worker type/build、格式/strictUTF8/新增隐私/diff/index及实际Process.dll身份已核，固定输出增量源码也已独立批准。

五个新场景先high两控，再low两例、held-close，actual独立批准。high各完整交付64个合法null-ID事件后自然0/stopped；low在caller stdin仍开、只发inspect且零close/native stop/本地cancel或disposal时，先独立见证原owner zero-read，helper settled/query0/真实barrier EOF后才caller EOF，bridge自然2/真实双EOF。低控各有真实native109部分写失败，session为4次event attempt/3次完成、stdout1279B低于S1536，queue为19次attempt/18次完成、stdout5553B；不称发完64，Q1024是队列而非累计stdout上限。held-close在真实pause中合法close/EOF，native stop、helper任务/query0/barrier EOF、sentinel响应和紧邻resume的原bridge未signal先于同一reader一次resume，之后自然0/唯一closed stopped/真实双EOF且无fixture force/outer fallback。ordinary回归有1个qualified OS console独立完整join，新五例为0，不能泛称全部无console。

原bridge创建pin/双EOF、helper陈述和test-only Job/query不互代，不是独立helper创建pin/ordinary helper双EOF权威。仅证明原reader pause与源码关联的Gate H/B生命周期，不直接观测exact kernel IRP/private queue counter；ambiguous create、OS Terminate失败、peer spoof与更广v2矩阵仍未证。最终文稿格式/MDX/隐私/链接校验、固定与独立批准，以及中文本地提交/fresh readback分别按最终固定回执和实际Git回读核定，不预填未来门通过。

B4-0 已用 `SR-M1-LIVE-01` 普通原件完成 1254×1254 RGB → 5016×5016 RGB PNG 的真实 SSH CLI 4× 诊断，7.644 秒、exit 0；完整证据见[主 SOP §10](2026-10-10-image-super-resolution-integration-plan.md)。5016² 约 25.16M 像素，超过 TC1 20M 最终交付上限，后续需合法等比下采样至 4096²，当前不称已交付或原生 4K。该次 CLI 未经过 Job Object 控制，后台服务身份未验、增强 API 与 ZEB 未接，不填整项 M2/M3/M5 通过；128 方图历史范围保持。

内部[有界 TS 控制 host](2026-10-16-image-super-resolution-ts-control-host.md)已完成所定技术验证与源码/actual独立复审，分轮结果及保留边界统一见该计划§6。受控流、Windows互操作与安装部署证据分账，本轮不新增业务或Worker/部署规格整项通过；prepare/AUTH/Adapter、图片/GPU及用户/实际部署验收继续分别进行。

### 2.3 共享测试数据定义

以下是待准备的 fixture 规格，不表示图片已经创建。实际准备时保存来源/使用授权、字节格式、方向、宽高、摘要、关键区域及预期事实清单；用户真实生产素材不进入公开仓库。

| 编号 | 数据                                                                               | 测试用途                                                          |
| ---- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| F01  | 1254×1254、无像素保护的家居照片 PNG；完整主体可见                                  | 原生不足；原生 4x 5016×5016；目标 4096×4096                       |
| F02  | 1600×900 家居 JPEG，无 EXIF 旋转                                                   | 原生 4x 6400×3600；16:9 目标 3840×2160                            |
| F03  | 4096×4096 PNG                                                                      | 已等于目标；不重复增强或重编码                                    |
| F04  | 6144×6144 PNG；另附项目已有合法缩小 JPEG 样本                                      | 原生已够；合法等比缩小及 JPEG 4:4:4 回归                          |
| F05  | 6000×3000 PNG，请求 4096×4096；面积 18MP 大于目标约 16.78MP，但高度不足            | 单边不足，禁止用总面积判定或中心裁切伪造目标                      |
| F06  | 1600×900 JPEG、EXIF orientation=6，展示为 900×1600；目标分别为 1000×1600、675×1200 | 方向后的不足判断与合法等比缩小；不重复旋转                        |
| F07  | PNG/JPEG 截断、头部正确但像素损坏、声明 MIME 与文件不符的集合                      | 真实解码与格式拒绝                                                |
| F08  | 1024×1024 透明 PNG                                                                 | 首期透明素材跳过及 alpha 不丢失                                   |
| F09  | 现有原生 canvas 批次与分层夹具；各层尺寸和内容不同                                 | 共用保存逻辑边界；原生证据与层关系保持                            |
| F10  | 三抽屉木纹商品、带可读标识；商品保护蒙版及场景基线                                 | 商品结构、材质、文字和保护区域                                    |
| F11  | 4096×3072 源图；内部、贴边、空、全图、越界与软边蒙版集合                           | 同画幅局部高清合成；软边 alpha>0 属于允许变化区、alpha=0 必须不变 |
| F12  | 1254×1254 源图；局部修改请求与独立“整图增强导出 4K”请求                            | 区分保持源画幅与改变整图尺寸                                      |
| F13  | 分支 A 原图→增强进行中→用户建立分支 B 编辑→A 增强晚到                              | 版本、分支、基线和选区归属                                        |
| F14  | 可解码但 native 尺寸、方向、摘要、蒙版或保护证据被篡改的候选集合                   | 增强不能洗白不合格原生证据                                        |
| F15  | 按冻结配置准备的输入/AI 中间件/交付字节与像素边界集合                              | 三层预算，不能只测压缩字节或只测输入                              |
| F16  | 受控能力与状态响应：正常、鉴权失败、缺引擎、缺权重、GPU 不可用、样图失败           | 后台分层检测；不得伪装成实际 GPU 验收                             |
| F17  | 六张业务样本，主要关注木纹、织物、玻璃/金属、细杆边缘、文字标识、墙面渐变/柔和阴影 | 同一原件 A/B 和保真选型                                           |

4K 的本套测试目标为方图 4096×4096、16:9 3840×2160；这是本轮推荐交付契约，M0 实施时需与产品和代码配置一致冻结。其他比例使用明确宽高，不能继续用 `high=2880` 代表所有 4K。

### 2.4 TC1：本套用例采用的建议测试契约

以下明确补足原 SOP 未细化的完整目标响应与生命周期。当前实现分支及技术证据以上文固定切片为准：受认证提交/查询、运行取消、安全 succeeded 摘要和终态竞争已有部分证据，成功 result 流、receipt、清理及 410/result_gone 仍待交付。后续调整必须同步版本、实现与受影响用例，不能在失败后临时改预期。

| 操作或情形                                                   | TC1 预期                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 经认证读取 health、capabilities、已知任务状态                | HTTP 200；capabilities 可返回 ready=false，存活正常不等于 GPU 就绪                                                                                                                                                          |
| 新提交持久化成功；同幂等键且同输入/策略重复提交              | HTTP 202，返回同一 job ID；重复提交不新增执行或改变终态                                                                                                                                                                     |
| 缺失、错误或已吊销访问密钥                                   | HTTP 401，结构化 authentication_failed；不返回任务数据或执行 GPU                                                                                                                                                            |
| JSON/必需字段损坏；不支持的媒体类型；图片不可解码/策略不合法 | 分别 HTTP 400 / 415 / 422；结构化原因与脱敏 request ID，无新增 GPU 执行                                                                                                                                                     |
| 同幂等键但内容或冻结策略不同                                 | HTTP 409，idempotency_conflict，不覆盖原任务                                                                                                                                                                                |
| 入队容量不足；执行环境未就绪；超字节/像素预算                | 分别 HTTP 429 / 503 / 413；按原因拒绝，不新增已接受任务                                                                                                                                                                     |
| 查不存在任务；取未成功结果；取已按规则清理的结果             | 分别 HTTP 404 / 409 / 410；已清理状态在元数据保留期内仍可查询                                                                                                                                                               |
| 当前已成功任务的元数据与尚未接线的传输                       | GET、合法同键 replay、重复取消可查安全结果摘要；成功 result 流/receipt 当前 HTTP 503/not_ready，非成功 409、未知/异 client 404；成功传输与上述清理后 410 仍为后续目标                                                       |
| 取消排队任务                                                 | HTTP 200、data={job, applied:true}、cancelled，不启动 GPU                                                                                                                                                                   |
| 请求取消运行任务                                             | HTTP 202、data={job, applied}，首次 true、重复 false；保留 running/reason=null 并记录 cancelRequested=true，精确全树终局退出后才进入 cancelled                                                                              |
| 重复取消已终态任务                                           | HTTP 200、data={job, applied:false}，返回原终态，不删除已发布结果；已取消保持 cancelled                                                                                                                                     |
| 成功提交与取消竞争                                           | 以终态事务 COMMIT 先后裁决；取消先 COMMIT 则旧尝试不能发布，成功先 COMMIT 则取消不得撤回。取消请求不单独抢赢完整成功资格，请求较早但成功先 COMMIT 仍可成功；原 lease/fence、首次 deadline 与持久 execution_timeout 继续强制 |
| ZEB 校验并永久保存结果后确认接收                             | 拟新增 POST /v1/enhancement-jobs/{id}/receipt，携带 job ID 对应的 AI 产物摘要与交付收据标识；同收据幂等 HTTP 200，现存任务的摘要/归属不符 HTTP 409，未知任务 HTTP 404，不提前清理                                           |
| 自动清理条件                                                 | 结果已被 ZEB 校验持久化并确认接收、已过结果保留期、无运行/恢复引用，三个条件同时成立才可清理；未确认结果不能静默丢弃，空间不足则拒绝新任务并记录原因                                                                        |

网络接口统一认证；TLS 链/服务身份失败属于客户端连接失败，不伪造 HTTP 状态。地址重定向不跨服务发送凭据、任务 ID 或输入图。API 只认服务凭据，本机模式不套用这些 HTTP 规则。

取消验收必须区分持久请求、已发送停止命令和终局退出证明。终局退出应匹配原 identity/descriptor/launchTicket，并保证该票据的已发出或悬挂 authorize 此后不能再启动执行树；不能仅依据当前没有 PID。soft/force 守卫在本 runner 对同一票据的生命周期内各一次，重复 wake 或命令失败不重置。过期 lease 后用户仍可请求取消，但旧 owner 的续租、停止、退出登记及清槽必须被拒绝；停止收敛可以越原执行期限，禁止延长预算或启动新计算。

关闭交错需单独验证：首次 soft 的同步回调调用 close，且当前已超过原宽限时，不得继续 force、重新调度或启动等待项；持久状态仍为 running、原槽仍占用且无伪造退出。后续 wake 返回 not_ready。

用于确定性协议/状态测试的受控配置如下，边界以“等于上限允许、超过拒绝”为规则。该配置仅供假执行器与可控时钟，不作为真实 GPU 的生产容量或性能承诺：

| 配置项                             | TC1 自动测试值                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| GPU 活动任务数、等待队列容量       | 1、2；等待容量不包含当前运行任务                                                             |
| 排队时限、执行时限、取消退出宽限   | 30 秒、60 秒、5 秒                                                                           |
| 租约与心跳间隔                     | 15 秒、5 秒；正常执行持续续租，租约过期仍须核实旧进程归属                                    |
| 输入字节、解码像素                 | 20×1024×1024 字节、40,000,000 像素                                                           |
| AI 中间产物字节、像素              | 160×1024×1024 字节、40,000,000 像素                                                          |
| 最终交付字节、像素                 | 96×1024×1024 字节、20,000,000 像素                                                           |
| 每任务持久日志预算                 | 256×1024 字节；双流继续消费，有界保留及截断标记                                              |
| 结果保留期、清理后任务元数据保留期 | 成功后 60 秒、结果清理后 120 秒；用可控时钟推进，不实际等待                                  |
| 显存不足补救（暂缓目标）           | 后续最多 1 次合法降 tile 重试；当前未实现，不作为首批 GPU 前置；取消、全局时限与预算不可绕过 |

真实 GPU 用例在 M0 先冻结实际设备适用的容量、tile 和时限，另存配置摘要。若限值与现有应用解码/上传限制不一致，须同时验收消费者，不能只放宽 worker。不能用上述 60 秒自动测试时限判定业务图片性能合格或不合格。

Windows 首选带运行时的服务安装包，CLI/模型可独立准备并配置到受控固定版本目录，安装包不必内含大模型。首次离线安装要求所有声明依赖事先备齐。升级先停接单并安全完成/停止本实例，默认保留任务、模型配置、密钥摘要、TLS 材料和产物；数据模式不兼容时用受控备份恢复，禁止只退二进制强行读新模式。默认卸载保留自有数据且保护 ACL，删除自有数据是独立明确选项，不涉及其他用户程序、原件或驱动。

Windows 服务身份若不能通过真实 GPU 验收，登录触发启动只能作为明确披露、独立验收的部署方案，不能把它记为“未登录即可运行的服务”通过。Linux 只验收实际选择的 systemd 或容器形态。

## 3. 分阶段验收与最小回归范围

| 验收批次 | 必须取得的证据                                                             | 可暂不执行的范围                       |
| -------- | -------------------------------------------------------------------------- | -------------------------------------- |
| M0/M1    | 规格、业务样本选型、尺寸/字节及共用保存路径回归                            | 尚未实现 API、安装包和保护增强         |
| M2/M3    | worker 协议/状态自动测试，Windows 实际服务身份 GPU、安装和重启证据         | 未选择的 Linux 安装形态；本机/SSH/mTLS |
| M4/M5    | 管理员桌面与后端权限、Windows API 真实链路、原图回退、版本/下载/日志一致性 | M6～M8 未开放功能                      |
| M6       | 实际交付本机模式的环境与任务契约                                           | 没有硬件的其他 OS/容器组合             |
| M7/M8    | 新冻结保护契约、可重建产物、源画幅像素比较与业务人工保真                   | 未实现的分层/透明全图超分与 SSH 扩展   |

一次测试执行可给多个用例提供证据，但每个断言必须独立记录结果。例如同一真实 GPU 作业可支持 M2 的产物检查、M3 的服务账户和 M5 的交付验证；不能因一个断言通过就填满所有相关用例。实现、权重、策略或安装身份变化后，由 CodeGraph 受影响范围及具体变化决定重跑项，不每次重跑完整 GPU 样本或平台矩阵。

## 4. M0：规格、真实样本与画质基线

### SR-M0-01 尺寸契约与适用范围冻结（P0；确定性自动/规格审查）

- 前置/数据：F01～F06、F08～F12；形成一份测试配置，分别列 requested、native、AI、delivered 的含义。
- 步骤：1）解析方图 4K、16:9 4K 和显式 3000×2000 请求；2）对原生足够/不足、比例不符、受保护局部/商品、透明/分层分别计算是否允许增强；3）将判定和契约版本保存，再改变后台默认值读取旧快照。
- 预期：方图目标 4096×4096，16:9 目标 3840×2160，显式尺寸保留；4K 请求和真实像素分开。比例不符不偷偷裁主体；保护契约及首期范围独立决定允许性；旧快照不跟随后台变化。F05 不因面积更大而判定原生足够。
- 证据：解析/路由输入输出表、快照版本及读取对比；实际未执行的 AI 尺寸留空并记原因。

### SR-M0-02 原件、引擎与样本身份可追溯（P0；规格审查）

- 前置/数据：F17 六张原件、拟比较的 Standard/High Fidelity 权重及固定 CLI。
- 步骤：1）记录原件摘要、来源、尺寸与关键事实；2）记录 CLI/权重版本、摘要、来源与所需使用说明；3）锁定同一输入清单、色彩/方向策略和对比区域，检查所有待比较输出使用同一份原件。
- 预期：每个输入、引擎与权重可唯一复核；不能把模型名相同当版本相同；未准备或摘要不同的样本不记为完成。比较区域在查看增强输出前固定，避免只挑效果好的局部。
- 证据：匿名样本 manifest、版本/摘要清单、事实与 ROI 清单。

### SR-M0-03 同原件真实画质 A/B（P1；真实 GPU/人工）

- 前置/数据：M0-02 的 F17；原件、离线 Sharp 插值比较件、Standard/High Fidelity AI 候选。比较件只用于离线评价，不进入线上交付链。
- 步骤：1）同原件分别运行固定候选，保留完整 AI 倍率 PNG 后再等比缩小至同一目标；2）打乱候选标签，按目标展示尺寸及固定 100%/200% 裁切比较；3）逐图记录清晰度、主体结构/颜色/文字、纹理、光晕、接缝与塑料感；4）选定默认权重或记录暂不发布增强。
- 预期：建议选型门槛为六张中至少四张比普通插值更清楚且无新增明显伪影，六张的关键商品事实均保持；这项门槛须在看结果前冻结。未达门槛不宣称画质已提升，可更换权重或延后该增强配置上线；线上已有合格原图继续可用，不新增主观强制暂停。
- 证据：同尺寸盲比图、固定 ROI、两名角色（业务/技术）结论；分歧保留并注明实际选型决定。锐度/SSIM 可辅助，不能替代保真判断。

### SR-M0-04 业务尺寸、资源和容量基线（P1；真实 GPU）

- 前置/数据：F01、F02、F15；目标服务身份；已冻结输入/中间件/交付预算、并发 1 和运行时限。
- 步骤：1）解码输入并预估原生倍率像素；2）分别记录首次推理与后续同尺寸作业的启动、队列、推理、编码/下载耗时和峰值 GPU/系统内存；3）验证 F01 为 5016² 中间件、4096² 交付，F02 为 6400×3600 中间件、3840×2160 交付；4）据实形成可接收尺寸/容量配置。
- 预期：原生 AI 输出和交付真实解码符合倍率/目标；预算覆盖完整 4x 产物；超预算在推理前拒绝，动态超限停止该增强。只记录测得性能，不用 128² 小样外推 4K 秒数，也不以提前降低分辨率冒充通过。
- 证据：两种输入完整产物摘要/尺寸、资源与耗时表、预算和设备/引擎版本快照。

### SR-M0-05 方向与色彩归一只作用于引擎输入（P0；确定性自动/抽样 GPU）

- 前置/数据：F06、带色彩配置的 F17 样本；原件及预先声明的引擎输入色彩规则。
- 步骤：1）保存原件后按规则产生引擎输入；2）重复读取并准备任务，检查是否二次旋转/色彩转换；3）比对原件摘要、输入展示方向与推理产物方向，使用固定色块检查明显偏色。
- 预期：原件字节不变；引擎输入方向/色彩策略可重建且只应用一次。EXIF orientation=6 输入按展示方向成为 900×1600；不能从原始头部尺寸误算倍率或蒙版坐标。方向/色彩归一不是普通补像素放大。
- 证据：原件/引擎输入/输出尺寸、方向/色彩元数据及摘要、固定区域观察。

### SR-M0-06 索引导航与旧规则不恢复插值（P0；开发工作流审查）

- 前置/数据：实际实施工作副本的 HEAD、CodeGraph 状态、已定位 normalizer 与保存调用链。
- 步骤：1）核对索引所属工作树及 pending 状态；2）按精确符号检查 normalizer 的两个直接生产调用与日志保存路径；3）实施后 sync 并记录受影响文件；4）审查对应仓库规则与旧测试断言是否仍强制低分图归一到目标。
- 预期：不把测试/导入边误算生产执行者；过期索引不得当当前代码证据。更新旧精确目标规则与过时断言，保留尺寸读取、合法缩小及保护合成；不以每次全仓扫描替代定点导航。
- 证据：匿名 HEAD/索引状态、精确调用链、规则和受影响用例映射。

## 5. M1：清理普通插值并保留真实数据

### SR-M1-01 双边不足保留原字节（P0；确定性自动）

- 前置/数据：F01，请求 4096²，增强关闭；通过普通素材写入路径保存。
- 步骤：1）记录输入摘要；2）保存并读取任务、文件和日志；3）刷新后下载，检查所有文件的真实尺寸和摘要；4）检查未启动 CLI/远程增强请求。
- 预期：仍为 1254²，原件/下载字节保持，无中心裁切、重编码或补成 4096²；请求 4K 记录保留，但不标为实际原生 4K。增强调用次数为零。
- 证据：输入/保存/回读/下载尺寸与摘要，增强执行计数。

### SR-M1-02 单边不足与面积误判负例（P0；确定性自动）

- 前置/数据：F05，请求 4096²，增强关闭。
- 步骤：1）同时计算总面积和两条有向边；2）经普通保存及日志路径；3）检查边缘主体、输出字节、实际宽高。
- 预期：6000×3000 原件完整保留，即使总面积大于目标也不裁成方图或补高；不能仅增加 `withoutEnlargement` 后仍发生重编码/裁切。比例不符另行说明，不把保存变成画幅修复。
- 证据：边长/面积判定、前后摘要与全图边缘对比。

### SR-M1-03 EXIF 展示方向决定不足判断（P0；确定性自动）

- 前置/数据：F06；分别请求 1000×1600 和 675×1200。
- 步骤：1）记录 JPEG 编码方向和展示方向；2）保存两组结果；3）对不足组比字节，对允许缩小组检查方向与既有缩小行为；4）刷新再次读取。
- 预期：以展示 900×1600 判定。1000×1600 组宽不足，保留原字节和有效方向；675×1200 组按 0.75 倍合法等比缩小，方向只应用一次，不静默裁切或拉伸。元数据与浏览器展示尺寸一致，不把 1600×900 当展示画幅。
- 证据：两组元数据、解码尺寸/方向及不足组摘要。

### SR-M1-04 等尺寸、合法缩小与 JPEG 编码回归（P0；确定性自动）

- 前置/数据：F03、F04及项目已有纯缩小/JPEG 4:4:4 夹具。
- 步骤：1）F03 请求相同尺寸；2）F04 请求等比例较小尺寸；3）运行受影响既有纯缩小与 JPEG 色度断言；4）检查保存与下载。
- 预期：相等时原字节保留，已有合法缩小仍满足尺寸/方向/编码规则；JPEG 4:4:4 回归保留。不因删除放大而删除全部 Sharp、下采样或缩略图功能。
- 证据：前后尺寸/摘要、合法缩小断言和 JPEG 元数据。

### SR-M1-05 无目标的尺寸读取不改变行为（P0；确定性自动）

- 前置/数据：F01、F06、F07；调用 ecommerce 尺寸读取路径，不传目标。
- 步骤：1）读取正常和 EXIF 图片尺寸；2）以返回结果进入规划/选区尺寸校验；3）读取损坏图片；4）检查未保存额外派生图、未运行引擎。
- 预期：正常真实尺寸/展示方向可用于既有分析、规划与技术检查；坏图按原错误契约拒绝，不返回虚假 4K。不发生重编码或新增 GPU 工作。
- 证据：读取返回值与受影响调用断言、存储/引擎计数。

### SR-M1-06 任务与日志共用保存不二次放大（P0；集成自动）

- 前置/数据：F01；覆盖实际受影响普通 OpenAI/自定义图片保存入口以及已有永久素材引用。
- 步骤：1）普通任务完成并落盘；2）沿 `writeImageGenerationLog → recordGenerationTaskLogResult → normalizeTaskResultAssets` 再记录结果；3）重复写日志/回读；4）检查原资产身份、对象数量及尺寸。
- 预期：两个入口都保留 native 1254²；日志不再次补像素、重复增强或覆盖永久原件。原有素材复用规则保持，不能每次记录日志再创建不同尺寸副本。
- 证据：任务/日志/素材关系、实际文件摘要、保存与增强调用计数。

### SR-M1-07 原生 canvas、分层与保护旁路不受清理影响（P0；集成自动）

- 前置/数据：F09、既有局部/商品保护夹具；包括原生尺寸正确与不正确的候选。
- 步骤：1）执行既有原生批次和分层保存；2）读取层尺寸与 native 证据；3）运行保护合成、选区映射与失败清理回归；4）提交不合格 native 候选作负对照。
- 预期：各分支保持原契约，不因普通结果清理而重缩放层/蒙版或放宽原生校验。正确候选保持原有保护行为；错误 native 仍按原契约失败，不能用新放大逻辑修复通过。
- 证据：既有受影响测试结果、原生/层/最终件尺寸与保护对比。

### SR-M1-08 损坏或超预算输入不生成有效资产（P0；确定性自动）

- 前置/数据：F07、F15 输入边界；测试目录已有合格原件。
- 步骤：1）分别保存损坏、不支持格式、真实格式与调用方 MIME fallback 不同、超输入预算内容；2）检查错误、半成品和已有原件；3）检查日志是否误记成功或写入请求尺寸。
- 预期：损坏、不支持格式及超预算沿明确校验拒绝；合法支持格式使用真实文件 MIME，调用方 fallback 不同本身不构成拒绝理由。不生成可下载的“成功 4K”资产，不覆盖已有原件。只清理本次未完成临时对象，不扩大预算来掩盖错误。
- 证据：脱敏错误类别、对象清单差异、原件摘要及成功记录计数。

### SR-M1-09 前台请求画质与实际下载尺寸一致表达（P0；桌面 UI/集成）

- 前置/数据：F01 作为普通上游返回；用户选择 4K，增强关闭或未配置。
- 步骤：1）在桌面创作入口生成；2）查看结果与调用记录；3）刷新并下载；4）引用该结果建立下一次编辑，检查新基线尺寸。
- 预期：允许显示“请求 4K”，实际结果显示 1254²/未增强，不写“原生 4K”或“增强成功”。下载、刷新、引用都以真实资产为准，不在预览或下载时补像素。
- 证据：脱敏桌面截图、实际下载解码、引用的资产/尺寸/摘要。

### SR-M1-10 上游请求意图不因取消本地插值丢失（P0；协议自动）

- 前置/数据：分别请求 4K 与显式宽高；使用当前已支持尺寸表达的普通协议适配器。
- 步骤：1）捕获最终上游请求；2）返回较低 native 样本；3）检查上游参数、请求记录与实际保存记录。
- 预期：原先有效的上游分辨率/质量/显式宽高表达继续按适配器契约发送；不删尺寸解析而让上游默认低清。低 native 真实保存，请求和实际尺寸分开记录；不对未支持的协议编造尺寸能力。
- 证据：已脱敏最终请求参数、requested/native 两份记录及文件尺寸。

## 6. M5：普通完整生图的异步增强闭环

M5 开发及同产物开发测试发布已完成，用户操作验收仍待。下表只记录原用例各自要求的层次，不将受控协议、一次实际图像模型和真实 GPU 合并为一轮。

| 原用例 | 当前证据与状态 |
| --- | --- |
| SR-M5-01 | 通过原定真实 GPU／桌面层：F01 1254²→5016²→4096²、F02 1600×900→6400×3600→3840×2160；实际文件／摘要、双下载、刷新、日志与缓存均核对。另一次实际图像模型为 1672×941，因比例不符明确跳过；其规划受控。 |
| SR-M5-02 | 通过路由自动层：合格原件、冻结策略、各参数跳过原因和零额外 Worker／LLM 调用分层验证，不称全部命名素材同轮 HTTP／GPU。 |
| SR-M5-03 | 通过集成故障层：原五类故障保持原图成功与下载、具体原因及零普通上游增量；引擎失败为协议注入。 |
| SR-M5-04 | 通过配置时间线：默认服务／模型变化后，原任务显式重试保留冻结策略及原件，重复点击去重，不重发生图。 |
| SR-M5-05 | 通过实际 Web 进程重启 1/1：原进程退出、新进程、自然租约到期、同 key／job、新 owner 和旧 token 围栏，单执行者／发布／收据，被动回读零新增调用。 |
| SR-M5-06 | 通过集成故障与永久媒体层：截断、仅 SHA 错、最终 EIO、staged AI 恢复及持久收据丢响应，只恢复同结果／确认；实际 GPU 大图按各自冻结预算回读。 |
| SR-M5-07 | 公开 F13 v9 实际补验通过：初始化加完整业务 2/2；B／A晚到／C、真实选区、根父关系、独立分支、原生与保护合成、下载／刷新及零第二增强齐全。F13 源码与最终证据独审通过，Spec／Quality PASS、C/I/M=0/0/0。 |
| SR-M5-08 | 通过配置时间线：旧 A、新 B、关闭 C 的冻结归属和单独取消保持；关闭不取消旧任务或撤回交付。 |
| SR-M5-09 | 通过真实成功与跳过／失败日志回读：native／AI／delivery、实际模型与分段计时、固定原因、刷新／下载和零业务写分别核对；未执行字段不造 0。 |
| SR-M5-10 | 通过 file／隔离 PG 负向集成：已记录技术失败不能凭增强修复或发布，原生证据及合格历史保留；合法映射与视觉建议不单独阻塞。 |
| SR-M5-11 | 通过路由自动层：持久 4096 增强子资产保留 provenance，重复保存／引用和足够尺寸直接使用，超路线拒绝，零链式 4x；不把手组 result 接缝冒充生产 reference→result 传播。 |
| SR-M5-12 | 通过真实 GPU 双变体媒体／下载／缓存及当前选择尺寸桌面补验；F13 的 C 后续编辑另列于 SR-M5-07。 |

HTTP／永久媒体八类故障曾单独初始化加 8 业务为 9/9；配置时间线随后与原八类故障同轮初始化加 9 业务为 10/10。尺寸两文件 64 项单测、初始化加 2 桌面场景分别记录。选择器四文件 275/275、视觉分析永久源修复三文件 220/220、共享引用 helper 的 RED 1 失败／35 通过及 GREEN 六文件 286/286 是不同轮次，不能相加。原失败和中断保留；单测不替代后续公开 F13 2/2。

最终 file outbox 补验：文件 Provider 的增强意图先可见时，执行器通过既有 generation 文件锁只读取得原任务快照，释放锁后才执行准备、远端调用及发布；不在锁内重写 generation 文件，不新增重试、延时或状态。PG 保持事务内原图成功与入队及执行器直读；原任务成功、归属／结果／原件身份和已持久原生技术失败门禁不弱化。 原完成窗口的确定性 RED 直接观察 queued 被误判 failed；同步读取后六文件 87 通过／50 个未启用 PG 跳过，另轮单连接隔离 PG 的双 Provider service suite 57 通过／1 个 file 锁不适用跳过；完整类型检查通过，lint 保留既有 unused-config M1。file outbox 原 I1 已修复并独审闭合；Spec Approved C/I/M=0/0/0，Quality Approved C/I/M=0/0/1，保留既有 unused-config M1，本次新增 0/0/0。F13 专项 0/0/0 不代表整体无遗留。 公开 F13 v9 初始化加完整业务 2/2、stderr 空；正常 hover 后保留原意图精确相等，并通过可信指针各帧的独立像素等式，指针专项 Spec／Quality Approved、C/I/M=0/0/0。v7 具体帧因果仍为 Unknown，v8 保持业务前准备失败，原失败轮不改写。

同产物开发发布补验：固定业务源码的 app／generation Worker 镜像一致，挂载与声明环境保持；维护入口 HTTP200／code0／claimed0、就绪 HTTP200 与 Worker 心跳、新 SSH 和公开 HTTPS 回读通过，生产实例身份保持。本轮 1440×900 桌面回读确认旧会话请求 3840×2160／实际 1672×941、参数弹层及限宽预览加载正常，无横溢出或控制台错误；该历史结果不是本轮新推理。本轮开发发布回读时后台保持默认关闭，连接及凭据尚未配置；实际使用验收需管理员保存连接、完成连接／样图检查并开启。发布回读未保存凭据、未新生成或重跑 GPU；限宽预览仅为显示变体，不代替原生像素或新 GPU 质量证据。

显式普通原件选择绑定归属完成 Run、成功原任务、稳定 resultId/nativeSource、归属、实际尺寸／字节／摘要；显式增强选择绑定成功 job 的 committed publication、交付事实和真实原件父链。metadata、staged 或仅替换 URL 均不足。视觉分析入口与共享 assetAccessUrl 均优先永久 serverUrl，保留缺少永久源时的原远端回退及原 HTTP／data URL 约束。

实际 Web 重启的业务 1/1 与随后证据脱敏修复分别记账。Authorization／Cookie 等结构化键及错误 message／stack 内嵌头值均脱敏；定向 RED 2 失败／1 通过→GREEN 3/3，仓库 Node 回归另轮 3/3。原业务 JSON 保持，脱敏派生另存并绑定原／派生摘要；脱敏派生不是新业务或 GPU 运行。

在 web 目录使用仓库已安装的 Node、pnpm、Sharp、Next、Playwright 和 Chromium 执行以下公开入口；共享该 checkout 开发构建目录的其他 Next 运行须先结束：

```sh
node --test e2e/image-enhancement-restart.lifecycle.test.mjs
node scripts/run-image-enhancement-e2e.mjs
```

F13 入口每次创建独立文件 Provider 数据目录、端口和不透明 1254² 合成原件，不依赖私有照片、私有 config 或远端凭据；实际应用／HTTP／桌面／持久化链使用受控 LLM、image 和 Worker 协议。公开命令本轮初始化加业务 2/2，不代表真实模型／GPU 画质，也不选择实际 Web 重启用例。固定业务源码已中文服务器本地提交 304f313，独立新 SSH 核 25 文件工作／提交摘要一致；该源码的隔离干净构建、完整 typecheck／build 和独立无网络 Sharp PNG 编解码通过。开发 Web／generation Worker 已发布同一镜像，来源、就绪／心跳、维护入口及桌面回读通过；后续文稿闭环提交不作为该产物的构建来源；本次开发发布不代表用户验收或生产／商业就绪。

### SR-M5-01 Windows 远程 GPU 端到端增强与交付（P0；真实 GPU/桌面）

- 前置/数据：M1～M4 完成；实际 ZEB 后端可访问已验收 Windows worker；受控上游响应返回 F01、F02，无保护契约。另安排一次实际生图模型的普通完整图请求，使用其真实 native 尺寸作业务实测，不要求模型恰好输出 1254²。
- 步骤：1）以普通完整生图链路得到冻结原件；2）页面先展示原图/增强中；3）后台提交、轮询并拉取 AI PNG；4）等比下采样、保存独立增强版本；5）刷新并下载原图及增强件；6）真实生图请求复用该流程，依据实际尺寸/保护/预算记录增强或跳过结果。
- 预期：固定 F01 native 1254²、AI 5016²、交付 4096²；F02 native 1600×900、AI 6400×3600、交付 3840×2160。真实生图请求按实际宽高计算 4x 中间件和合法交付，不凭夹具通过冒充该模型支持。尺寸来自文件；原图一直可用，增强版标为 AI 增强；浏览器只访问 ZEB，GPU 调用由实际后端发起。
- 证据：端到端任务关联、三组尺寸/摘要、两类下载与脱敏页面；分别标记受控上游/真实生图，可复用同作业的 M2/M3 证据。

### SR-M5-02 确定性跳过不产生额外增强请求（P0；路由自动）

- 前置/数据：参数化增强关闭、未请求 4K、F03 原生足够、F08 透明、F09 分层、F10/F11 首期受保护场景。
- 步骤：1）按每种策略完成合格原件保存；2）运行增强路由；3）查看阶段状态、原因和 worker/LLM 调用增量。
- 预期：分别明确 disabled、非适用请求、native_sufficient、未开放素材或 protected_contract 等语义原因；增强调用为零，也不为路由新增 LLM。原有分析/规划/生图流程按任务自身规则执行，不伪造未执行阶段。
- 证据：每参数的 frozen 策略、路由原因、实际调用增量与可用原图。

### SR-M5-03 远端故障仅影响增强阶段（P0；集成故障注入）

- 前置/数据：F01 已保存合格原件；分别注入服务断开、认证失效、GPU 失败、超时及损坏 AI 产物。
- 步骤：1）在增强对应阶段注入单一故障；2）观察生成/增强各自状态；3）刷新、下载原图；4）检查上游生图/分析/规划调用次数。
- 预期：原生生成仍成功，增强 failed/skipped 并给具体原因；原图可查看/下载，维持 1254²，不悄悄 Sharp 补成 4K。故障不自动重新调用生成或 LLM；日志/界面不将整次生成标失败。
- 证据：注入位置、状态迁移、原件摘要及上游调用计数。

### SR-M5-04 单独重试增强复用原件与冻结策略（P0；集成自动）

- 联合补验通过：真实管理员切换到另一已验证合成服务／模型后，原A明确引擎失败并由桌面仅重试增强，attempt2保留原件／目标／原服务／完整版本摘要，重复retry返回409；原A任务身份不发往新B服务。普通生图／分析／规划无重试增量，原生及永久媒体保持。该例与原8故障同轮共10项（含初始化）通过；不代表再次实际GPU换权重验收。

- 前置/数据：M5-03 的失败任务；服务恢复；后台默认权重已改为另一已验证版本。
- 步骤：1）对原失败任务点“重试高清增强”；2）读取该次尝试使用的原件、目标、权重和服务身份；3）检查生成与增强尝试记录；4）重复点击观察去重。
- 预期：按原增强计划重试，只有显式新增强请求才可换策略；同服务可更新有效凭据引用，不复制旧密钥。原生成次数不增加，原图不变；受控创建增强新尝试，重复点击不产生并行重复任务。
- 证据：旧/新尝试关系、冻结策略差异表、输入摘要和生成调用计数。

### SR-M5-05 ZEB 提交/回读重入不重复增强或发布（P0；集成自动）

- 实际补验通过：真实 Web 进程退出／新 PID、原租约自然到期、同 key／job 恢复和旧 token 围栏已覆盖完整顺序；合成执行进程只有一个，永久 child／publication／receipt 均一次，刷新／日志／下载零新增调用。该 1/1 不证明 Windows／GPU 重启或断电恢复。

- 前置/数据：F01，同一结果版本和策略；可控提交响应丢失与重复结果准备事件。
- 步骤：1）完成远端持久提交后丢失响应；2）ZEB 重启/重新处理同一结果；3）重复刷新或保存日志；4）恢复查询并发布。
- 预期：用同一稳定身份/幂等键恢复原远端任务；最多一个活动执行者、一个增强结果版本发布。日志回读与刷新不启动新增强；不能保证崩溃计算从未重跑，但受控恢复不重新生图、不出现两个执行者。
- 证据：业务/远端任务映射、尝试/租约事件、活动进程与发布计数。

### SR-M5-06 结果下载或持久化失败不发布半成品（P0；集成故障注入）

- 联合补验记录：真实客户端／永久媒体／桌面8类故障同轮通过；包含真实截断、同长度可解码仅SHA不同、最终写入单次EIO、staged AI同结果恢复，以及收据持久接受后丢响应的同一确认。原图下载摘要／尺寸、生成与增强独立状态、零新增普通上游调用和单次发布均有联合断言。协议夹具不作为GPU画质或进程重启证据；原步骤与预期完整保留。

- 前置/数据：远端完整 AI 产物已生成，F01 原图在 ZEB；在下载截断/摘要不符/最终存储写入失败处分别注入。
- 步骤：1）获取并校验产物；2）在指定位置故障；3）检查默认展示件、临时文件和永久原件；4）恢复存储后仅恢复结果获取/保存；5）另在永久保存成功后注入 receipt 响应丢失并重试确认。
- 预期：验证及持久化未完成前不切换增强成功、不发送接收确认；原图有效，未完成对象不成为公开下载。可恢复时复用已持久远端结果，不盲目重推理；清理只处理本任务无引用半成品。永久保存后收据响应丢失只重试同一确认，已发布增强件不回退失败、不重复发布或推理；未确认前远端不能清理该产物。
- 证据：持久化与收据顺序、远端结果身份、公开资产清单、收据幂等记录及原件摘要。
- 回归边界：完整AI／交付件在各自冻结字节预算内时，带Content-Length和chunked响应均可完整回读；不能误套普通参考图默认20MiB上限。超出冻结预算仍拒绝，普通参考图默认上限不变；已有staged AI的恢复不得重新下载或推理。

### SR-M5-07 晚到增强不覆盖下一次编辑（P0；事件顺序集成/桌面）

- 公开实际补验及源码／最终证据独审通过：B 以 1254² 原图完成真实选区编辑后，A 增强晚到发布；B 全部冻结事实、主编辑基线和刷新内容不变。用户显式选 4096² 增强建立独立 C，原 A 为根、增强为父且 branch 独立；真实蒙版、独立原生与保护合成文件、选区外像素证据、两类下载／刷新及零第二增强均通过。B／C 未请求 4K，本轮跳过原因为 not_requested；实际保护执行不改写该原因。原各失败轮保留，不把旧失败轮的未通过改写为当时已通过。

- 前置/数据：F13；分支 A 增强未完成，用户已以 A 原图创建分支 B，冻结 B 的基线与选区。
- 步骤：1）完成上述顺序并记录 B 快照；2）交付 A 增强；3）刷新 A/B；4）用户显式选择 A 增强图继续编辑，创建分支 C。
- 预期：A 增强属于 A；B 的资产内容、variant、尺寸、摘要、选区和父结果不变，当前编辑不跳图。C 有新资产/分支及正确根/父关系，以增强尺寸显式建立基线，不能仅替换旧 URL。
- 证据：事件时间线、A/B/C 关系和 B 前后快照、脱敏页面。

### SR-M5-08 配置变化与晚到任务保持冻结归属（P0；集成自动）

- 联合补验通过：真实管理员配置保存及连接／样图校验后，A保留旧服务／模型、B采用新默认、关闭后C持久skipped/disabled且无远端任务；A2／B可在关闭时完成，已交付图再开后关闭仍保留。只有另一独立A取消收到原服务DELETE，其他原件和发布不变，刷新／日志／下载无新增业务调用。合成协议执行计数与真实GPU证据分别记录。

- 前置/数据：任务 A 按旧模式/服务/权重排队；任务 B 在后台修改后创建；旧服务仍可查询。
- 步骤：1）改变模式、目标服务或默认权重；2）分别执行/查询 A、B；3）关闭增强后再创建 C；4）明确取消 A 的另一独立测试尝试。
- 预期：A 使用原执行归属，B 使用新冻结配置，C 跳过；不把 A job ID 发给新服务。关闭开关不自动取消 A、撤回已交付图或重建原图；明确取消只影响对应增强。
- 证据：A/B/C 配置快照、请求目标身份记录和状态迁移，不记录私有端点原值。

### SR-M5-09 可观测阶段反映实际执行（P0；集成/桌面）

- 联合回读已补齐：真实 GPU 成功记录与另轮 disabled／连接／认证／引擎／超时五条实际记录分别核对；详情打开、重开、原件下载及保护文件前后摘要保持，管理员读取没有业务写。未执行 AI／交付／计时字段缺省，界面显示未取得而不造 0；Worker execution 含引擎启动与写出，不称纯 GPU 耗时。

- 前置/数据：一项增强成功、一项跳过、一项失败；保留各自既有生图阶段记录。
- 步骤：1）查看调用记录详情及刷新回读；2）将实际文件尺寸、模型版本与计时和记录逐项核对；3）检查原图/AI/交付关系、重试、原因、最终下载身份；4）检查未执行阶段和敏感字段。
- 预期：新增独立增强阶段；native、AI、delivered 真实可核对，计时分队列/推理/编码，跳过/失败有原因。分析/规划/验收仍按实际调用展示，不造模型输出；不回显密钥、内部系统账户或私有地址。
- 证据：脱敏日志结构、阶段与调用计数对照、实际文件解码报告。
- 预览边界：列表和详情均优先使用已登记永久媒体的限宽WebP，上游URL失效后仍能加载；桌面检查实际naturalWidth大于零，不能仅凭src格式或成功状态认定可见。

### SR-M5-10 增强不能修复通过原生契约失败（P0；负向集成）

- 前置/数据：F14；原生 canvas/nativeMatches 或保护证据已经失败的候选。
- 步骤：1）保持原生失败证据；2）令增强产生看似正确目标尺寸的输出；3）尝试完成交付检查并回读原生记录。
- 预期：不把增强件写入 nativeUrl、不把 nativeMatches=false 改为 true；该候选仍不能作为合格原图/增强图发布。原有合格历史结果可用，未合格候选不能凭“失败回退原图”冒充成功。
- 证据：原生失败事实、增强身份、技术检查及发布拒绝记录。

### SR-M5-11 已增强版本不自动链式再放大（P0；路由自动）

- 前置/数据：F01 已交付 4096² AI 增强件，保存 provenance；另准备要求超出当前倍率/预算的独立增强请求。
- 步骤：1）重复保存/引用已够尺寸增强件；2）运行默认增强路由；3）提交超出已验证路线的请求，检查是否自动连续 4x。
- 预期：已够尺寸直接使用；provenance 不丢失，不重新把它当原生低清自动增强。超出路线明确不支持/预算不足并保留已有图，不默认连续两次 4x，不重新生图。
- 证据：版本溯源、路由原因、引擎调用次数和预算判定。

### SR-M5-12 原图/增强图刷新、下载与缓存身份一致（P0；桌面/集成）

- 尺寸展示补验通过：原图仍使用原run资产身份及真实尺寸，摘要明确标为原图尺寸；既有版本区随activeAssetId显示当前原图或当前AI增强真实尺寸，未知／非法尺寸不借请求4K或另一变体补值。迟到增强保留显式原图选择、引用及草稿；单测64项与初始化加2场景桌面分轮通过。原步骤、真实媒体／缓存身份及完整F13验收要求保持。

- 前置/数据：M5-01 的原图与增强件，具有独立不可变 variant/摘要。
- 步骤：1）增强前后查看预览；2）分别下载两种 variant；3）刷新、重新打开历史任务并引用增强版本；4）检查缓存命中时的资产身份和内容。
- 预期：同结果版本增强完成后可更新默认展示，但原图入口保留；下载名称/说明/真实尺寸对应所选 variant。缓存不会用旧原图冒充增强图，刷新/引用不会重新 resize 或覆盖原件；请求 4K 与实际 AI 4K 表达一致。
- 证据：变体/摘要映射、实际下载解码与缓存身份、脱敏桌面截图。

## 7. M6：本机 CLI 的独立适配

### SR-M6-01 实际同环境本机调用成功且无需网络凭据（P0；真实 GPU/契约）

- 前置/数据：实际交付平台的持久生成 worker 可访问同环境 CLI/模型/GPU；F01；未配置远程地址或 Token。
- 步骤：1）选择本机模式并运行环境/样图检查；2）持久任务领取后直接以参数数组启动 CLI；3）校验完整产物、下采样及发布；4）检查网络调用记录。
- 预期：本机完整推理通过，不要求网络账号/密钥。使用当前 worker 身份，真实输入/倍率/交付符合 M5；未发远程 API/SSH 请求。没有对应 GPU 的平台记阻塞/不适用，不凭其他平台推断通过。
- 证据：匿名运行身份/平台、受控 argv、产物解码、无远程调用计数。

### SR-M6-02 空格、中文与 shell 字符路径按字面传参（P0；进程契约/部署）

- 前置/数据：专用测试目录路径包含空格、中文和 `&` 等字符；文件名和配置模型名均来自受控清单。
- 步骤：1）配置这些路径；2）运行 CLI 适配器并捕获可执行文件和参数数组；3）确认 stdout/stderr 被持续消费；4）检查任务目录以外未出现输出。
- 预期：`shell: false`，Windows 隐藏子进程窗口；字符作为参数传递，不被 shell 解释，路径可正常读取。提示词不参与可执行文件、任意模型路径或 CLI 参数拼接；不启动额外命令。
- 证据：脱敏参数结构、精确子进程清单、目标目录产物和解码结果。

### SR-M6-03 路径、运行平台、权限与 GPU 错误分类（P0；参数化契约）

- 前置/数据：引擎不存在、不可执行/平台不匹配、缺权重、目录不可写、GPU/驱动不可用的独立配置。
- 步骤：1）逐项执行检查并提交测试增强；2）观察错误阶段；3）确认未重复下载依赖、未调用其他执行模式；4）恢复正确配置重新检查。
- 预期：分别说明路径/平台/OS 权限/模型/GPU 原因，不全部归为“账密错误”。不可执行时无有效推理；原图仍可用，不静默改走 API/SSH、不越界清理目录；恢复后才能标就绪。
- 证据：故障配置类别、错误阶段、进程/网络计数与恢复后的检查结果。

### SR-M6-04 同物理机跨执行环境不被误判为本机（P0；拓扑契约/条件部署）

- 前置/数据：受控声明 Windows 宿主、Linux 容器 worker、宿主 exe 路径；实际涉及该组合时追加同拓扑部署验证。
- 步骤：1）按本机模式提交宿主 Windows exe 路径；2）观察平台/路径检查；3）显式改选独立 API 模式，按容器实际可达地址执行 M4 检查。
- 预期：不把物理同机当同 OS 文件系统或默认执行 Windows exe；容器 localhost 不被假定为宿主。Docker Desktop 的宿主地址能力按实际部署确认，一般 Linux Engine 不直接套用；模式切换明确且重新检测，无隐式兼容 shell。
- 证据：匿名拓扑、检查结果、显式模式切换记录；无真实该拓扑时只标契约层通过。

### SR-M6-05 本机取消、超时、重启与并发契约（P0；进程集成）

- 前置/数据：本机 adapter；测试任务 A 运行、B 排队，另有与本任务无关的引擎进程；沿用 M2 的恢复/取消判定。
- 步骤：1）按顺序测试 A 明确取消、超时与 worker 重启；2）检查本任务进程/租约/结果目录；3）恢复 B 并查询已有产物；4）检查无关进程及活动执行者数。
- 预期：共用持久任务状态，不靠 Web 请求生存期；最多一个活动 GPU 任务。只终止本任务进程树，确认停止后清理；无关进程不受影响。完整产物可恢复，未完成推理受控重试，不重复发布或生图。
- 证据：任务事件、精确 PID/启动身份关系、活动计数及原件/无关进程保持。

### SR-M6-06 本机功能关闭不引入主应用 GPU 依赖（P0；启动/契约）

- 前置/数据：无 GPU、无 CLI/权重的普通 ZEB 测试环境；增强默认关闭。
- 步骤：1）启动默认应用；2）执行普通生图、保存日志、刷新和下载；3）观察是否加载 GPU、探测引擎或下载权重；4）仅在管理员显式检查本机配置时读取对应不可用状态。
- 预期：默认启动/生图完整可用，关闭时无 CLI、Vulkan 初始化或权重下载依赖。显式检查可以返回具体不可用原因，但不阻塞普通任务、不自动开启或安装服务。
- 证据：启动及普通链路结果、依赖/进程/网络计数、显式检测记录。

## 8. 最终验收记录要求

每个里程碑完成后填写本文件第 2 节的记录格式，并列出：通过/失败/阻塞/不适用的 ID、实际执行方式、遗留限制、可回退范围、下一里程碑依赖。P0 失败不得以降低原生尺寸、伪造摘要、放宽保护或跳过鉴权的方式处理。

首批 M0～M5 完成只代表已交付普通完整生成图的 Windows 远程增强，不自动代表受保护电商场景、局部高清、Linux GPU、本机或 SSH 已验收。各自取得相应证据后再更新支持范围。

关键问题与里程碑记入私有记录，并交 Mem0 会话提取；本地记忆不等于远端入库回执。M1 与 M2-A/B1/B2/B3-1/B3-2、B3-3 v1/r2 及 v2/r3 的固定历史证据保留于第 2 节，不另加到本批；B3-3 的 352 个唯一用例仍按 69 本轮＋283 沿用分轮记载。当前 B3-4 本批实现、技术检查及代码/文稿独立复审已完成；runner 7/7、旧 caller 86/86、schema 4 passed/47 filtered 是三个实际运行组，不能合称同轮97或累计历史矩阵。用户及实际部署验收仍待，测试站仍仅 M1、worker 未部署、production ready=false；其余规格按实际覆盖保留未执行，不将 86 项业务规格全部标记通过。M0 六类真实业务 A/B、容量、实际后台 GPU 身份及端到端增强仍待取得证据。
