# M8：局部编辑保护增强实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. 任务实施、复审及证据分别记录。

**Goal:** 新局部编辑任务在保留合格原图的同时，允许只在确认选区内交付 AI 增强版本，避免所有局部任务一律跳过增强。

**Architecture:** 复用 M5 队列、Windows HTTP Worker、版本与恢复链，新增 `ecommerce-delivery.v2` 的 `local_edit` scope。冻结源图和选区、分别保存原生候选与合格基线；Worker 读取合格基线作为完整上下文，最终只向允许区域写回，发布时由保存产物独立重建验证。

**Tech Stack:** TypeScript、Sharp、现有 PostgreSQL/文件 repository、Vitest、桌面 Playwright；不加依赖，不修改 Worker 协议或安装包。

## 当前状态

M8 本期技术开发、各任务及整分支独立复审、固定产物检查、干净构建和开发测试发布已完成。Task4 真实 `/create` 受控HTTP整链、M7与默认F13关联回归分别通过，原失败/中断轮保留。开发Web与生成Worker已使用同一镜像，就绪及历史页面回读通过；运行构建源为 `6e096d2`，后续纯状态文稿提交只更新记录，不作为该镜像构建来源。真实家居GPU、照片边缘/接触阴影与人工画质SR-M8-03仍未执行，用户验收待确认。

## Global Constraints

- 只推进服务器开发分支与测试环境；本期不 push、不建 PR、不改生产或重新安装/重启 GPU Worker。
- 沿用管理员增强开关、连接及模型；只有新任务显式请求 4K 且已有确认有效的局部选区时才冻结 `local_edit`，不给旧任务补签或自动重跑。
- mask alpha=255 保护，alpha=0 编辑，0<alpha<255 软混合；允许域 E 为 alpha<255。上下文读取范围不能扩大写回域。
- 输出与合格基线同画幅，E 外 RGBA 差异为零，最终为无损 PNG；不得宣称整图 4K，也不得将已合成最终件再次全图超分。
- 原始参考、provider native、合格原图、完整 AI 和最终交付身份独立，真实格式/方向/尺寸/摘要不互相覆盖。
- 原局部编辑的合法 uniform_scale/pixel_grid_scale 映射保持；raw native 与合格 baseline 可按该既有规则具有不同尺寸，不改原 native 技术要求。无效原生画幅不能借 AI、delivery v2 或改写技术证据洗白。
- 创建冻结、入队、执行、发布与继续编辑都核相同来源/合同；替换 mask URL、坐标、源、baseline 或 staged final 必须拒绝。
- 增强失败、资源预算不足或取消只影响增强，已合格原图仍可预览、下载和引用；不新增 LLM 审核或主观暂停。
- 当前编辑入口仍只签发可信二值矩形选区；软边合成按冻结规则支持，但不借本期扩展原生选区协议、画笔 UI 或商品/局部混合保护。空域、全域及不可信选区不冻结局部增强合同，合成器拒绝空/全域；不伪造独立全局导出入口。
- 桌面验证即可；不增加移动端、Linux GPU、本机 CLI、计费或短剧范围。公开文件禁止真实地址、路径、账号、密钥及会话身份。

---

## Task 1：可重建的蒙版合成器

**Files:**

- Create: `web/src/lib/server/image-enhancement-scene-protection.ts`
- Test: `web/src/lib/server/image-enhancement-scene-protection.test.ts`

**Interfaces:**

```ts
type SceneEnhancementProtection = {
    version: "scene-enhancement.v1";
    normalization: "srgb-upright-v1";
    scene: SceneEditProtection;
};
// 结果证据包含 source/mask/AI/final 摘要、源与AI尺寸、冻结映射、允许/保护像素数与零差计数。
compositeSceneEnhancement(baseline: Buffer, ai: Buffer, protection: SceneEnhancementProtection, maxPixels: number): Promise<{ bytes: Buffer; evidence: SceneEnhancementEvidence }>;
```

- [x] 先写真实 PNG 像素测试，确认 sourceSize/targetRegion/mask 摘要、单帧/方向/不透明、完整 AI 比例与大小验证。
- [x] 保存 RED v1 的模块缺失/0 tests 与 RED v2 的业务断言失败，不将导入错误或 stub 抛错的拒绝测试当作真实校验证据。
- [x] 实现严格解码、缩小映射、mask 软混合及无损输出复读；任何 alpha255 像素逐点保持。
- [x] helper GREEN 40/40，并同轮执行既有 scene/product 关联回归；覆盖 4096×3072 源画幅、内部/触边选区、软边、空/全域拒绝、越界、大小/方向/摘要/URL旁路与损坏候选。
- [x] 固定两文件差异独立 Spec compliant / Quality Approved，C/I/M=0/0/0；本地提交 `2be22f6`。

## Task 2：冻结、保存、队列与发布

**Files:**

- Modify: `web/src/lib/server/image-enhancement-delivery.ts`
- Modify: `web/src/lib/server/image-task-result-service.ts`
- Modify: `web/src/lib/server/image-enhancement-enqueue.ts`
- Modify: `web/src/lib/server/image-enhancement-plan.ts`
- Modify: `web/src/lib/server/image-enhancement-worker-client.ts`
- Modify: `web/src/lib/server/image-enhancement-service.ts`
- Modify: `web/src/lib/server/image-enhancement-publication.ts`
- Modify: `web/src/lib/server/database/image-enhancement-job-repository.ts`
- Test: 对应 delivery/enqueue/plan/result-service/service 测试及局部发布测试。

**Interfaces:**

`EcommerceEnhancementDelivery` 增加 `{version:"ecommerce-delivery.v2";scope:"local_edit";canvas?:EcommerceCanvasConstraint;protection:SceneEnhancementProtection;baseline:{url;sha256;byteLength;width;height;normalizedSha256}}`。其中合同baseline是原始参考，`decision.delivery.baseline` 是完成局部编辑的合格原图，两者明确区分。

`decision.source` 始终为 provider native。新增共用 `enhancementInferenceSource(decision)`，仅local_edit返回delivery.baseline，其余保持现有source。计划倍率、Worker准备/预算与提交必须使用该同一输入；提交读取冻结 `remotePlan.source.url`。

- [x] 先增加创建/保存/入队/推理输入与发布回归，取得 8 项预期业务断言 RED。
- [x] 只在创建阶段冻结本期受支持的局部合同，先验证原源/可信mask/确认范围/归属/规范方向，不支持仍保留原生成合同。
- [x] 原编辑照常先技术验收，保存真实native与合格baseline及sceneProtectionEvidence；仅有效新合同附带nativeSource/enhancementId，旧任务和非4K保持原路径。
- [x] 入队绑定scene、mask全部来源字段、ecommerceExecution、真实native和baseline证据；合法原生/基线不同尺寸分别核验，不能将二者混同。
- [x] 计划target=baseline画幅、inference=baseline×模型倍率，requestedTarget独立记录；prepare/submit 使用同一冻结 baseline 上下文，不受后台默认4K隐式改变交付尺寸。
- [x] 发布重新读原参考/native/baseline/完整AI，重建原局部合成核旧证据，再调用Task1合成器，核staged-final字节与摘要；发布独立增强资产并复用receipt/恢复/取消。
- [x] 分轮 GREEN 覆盖 source/mask/坐标/baseline/staged篡改、比例失败、合法native统一映射、增强失败原图可用及既有结果保存回归；隔离 PostgreSQL 禁文件并行、单连接通过。原 PG 入口失败保留。
- [x] 固定15文件差异独立 Spec compliant / Quality Approved，C/I/M=0/0/0；本地提交 `383649f`，不补签旧任务，不改真实业务记录。

## Task 3：版本、日志与连续编辑

**Files:**

- Modify: `web/src/lib/image-enhancement-contract.ts`
- Modify: `web/src/lib/server/image-enhancement-public.ts`
- Modify: `web/src/lib/server/agent-run-store.ts`
- Modify: `web/src/app/(user)/create/components/creative-image-enhancement.tsx`
- Test: public/agent-run-store 对应测试，`web/e2e/creative-image-enhancement.spec.ts`。

- [x] 增加local_edit公开scope与“局部保护增强 · 保持原画幅”说明，原图指向合格baseline，providerNative保留独立技术事实。
- [x] 公开记录实际原生、推理、交付尺寸、选区保护计数和状态，不暴露原始合同、内网地址或模型凭据；公开契约接线随 Task2 完成。
- [x] 服务端引用核原任务/result/用户/会话/父链和本期scene证据，随 Task2 完成；增强继续编辑新建独立资产分支并重新选区，晚到A不改B冻结baseline/mask。同一真实 `/create` 发布后选择final再编辑C的接缝已由 Task4 actual v2 验证。
- [x] 桌面验证切版本、大图、实际下载、刷新、引用，以及增强失败仍可用原图；确认下载与引用都与当前选择相同。
- [x] 旧 UI 两项业务 RED 后桌面 GREEN；固定两文件差异独立 Spec compliant / Quality Approved，C/I/M=0/0/0；本地提交 `f97b2dc`。

## Task 4：实际链、文稿与测试发布

**Files:**

- Modify: `web/scripts/run-image-enhancement-e2e.mjs`
- Modify: `web/e2e/image-enhancement-generation.spec.ts`（复用已有真实Agent/选区确认/下载与连续编辑fixture，追加独立M8用例，不复制整份scaffold）。
- Modify: `web/e2e/image-enhancement-business-faults.fixture.mjs`（仅M8显式启用的合格baseline输入，旧M5/M7严格输入断言保持）。
- Modify: 对应Playwright配置（仅选择M8隔离用例所需）。
- Modify: 本计划、`2026-10-11-image-super-resolution-tests-protection.md`、todo/pending-test、backend-database与CHANGELOG。

- [x] 真实 `/create` Agent及鼠标选区确认/resume→图片任务API/持久层→baseline真实Worker HTTP上传→完整AI/保护final永久件/receipt→版本/下载/刷新→显式final再编辑C整链通过；最终外部RGBA0，浏览器Worker直连0，不伪称真实GPU。
- [x] 固定31文件格式、严格UTF8/乱码、新增隐私0、限定ESLint errors0、diff、完整Web类型检查与CodeGraph通过；Docs构建39页exit0，stderr仅正常脚本回显。受影响M7及默认F13回归分轮通过，不合并统计。
- [x] 各任务与全分支固定产物独立Spec compliant / Quality Approved，C/I/M=0/0/0。Task4本地提交 `f70aa9b`，技术/验收文稿提交 `6e096d2`；不push/PR。
- [x] `6e096d2` 干净git archive构建exit0，镜像内Sharp PNG编解码通过；开发Web/生成Worker同镜像发布，ready/PG schema/加密/新Worker心跳及桌面旧会话/历史图片回读通过。生产指纹保持，增强设置及GPU Worker保持。
- [ ] 真实家居GPU/边缘与接触阴影的人工画质单列，不以纯色fixture关闭SR-M8-03；若本轮取得真实任务结果，只报告实际验证层次。

真实链从 `web/` 运行 `node scripts/run-image-enhancement-e2e.mjs --m8`；使用真实 `/create` Agent、鼠标选区确认/继续、图片任务与持久层，LLM/图片上游及 Worker 为受控 HTTP。actual v2为setup1+业务1共2 passed（2.3m），完整Web类型检查exit0、stderr空；已贯通同一Agent链的baseline上传、永久AI/final/receipt与显式增强引用再编辑。源/最终1254²、推理5016²，外部1,509,766像素changed0，内部62,750像素changed62,750；浏览器Worker直连0。精确尺寸优先使 `requestedTarget=1254×1254`，与显式4K/高画质、推理及最终尺寸分别记录。质量别名 `4k` 规范化为 `high` 后解析等价；不伪造更大的请求目标或称整图4K。本期另有独立构建/开发发布回执；受控整链及发布均不能代替真实GPU照片画质。

## 已取得的独立轮次

| 轮次                    | 实际结果                                                                      | 证据边界                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Task1 RED v1 / v2       | v1 模块缺失、0 tests；v2 19 failed / 21 passed                                | v2 的21项拒绝测试仅因 stub 抛错通过，不能单独证明保护校验                                                              |
| Task1 GREEN v1          | 3文件87 passed：helper40、scene29、product18；完整Web类型检查通过             | 合成器与关联规则；非真实GPU                                                                                            |
| Task2 RED v1            | 3文件8 failed / 167 passed / 61条件跳过                                       | 创建、合格基线与父链的业务断言失败                                                                                     |
| Task2 GREEN v1          | 10文件375 passed / 66条件跳过；完整Web类型检查通过                            | 早于两项源修正和恢复补测，不冒充最终版本                                                                               |
| Task2 GREEN v2          | 两项源修正后4文件230 passed / 61条件跳过；完整Web类型检查通过                 | 定向受影响回归                                                                                                         |
| Task2 recovery v1       | service63 passed / 63条件跳过；完整Web类型检查通过                            | 保存完整AI后恢复不重复提交/下载；同步伪造staged摘要仍拒绝                                                              |
| Task2 PG v1 / v2        | v1 80 failed / 133 passed / 1条件跳过；v2 5文件213 passed / 1条件跳过         | v1为临时库后缀不合既有守卫的入口失败；仅修私有runner后新建隔离库，v2单连接、禁文件并行                                 |
| Task3 RED v1 / GREEN v1 | RED为setup1通过、业务2失败；GREEN为setup1+业务6=7 passed；完整Web类型检查通过 | 桌面Chromium，含M8成功/失败、M7成功/保护失败、M5大图及迟到引用回归                                                     |
| Task4 actual v1         | B局部任务已完成并冻结local_edit；随后期望质量字面4k、实际high而失败           | 已确认别名4k→high及尺寸解析等价；属于测试语义断言修正，非产品RED，保留首失败                                           |
| Task4 actual v2         | 完整Web类型检查0；setup1+业务1=2 passed（2.3m），stderr空                     | 同一真实/create受控HTTP整链；非真实GPU画质                                                                             |
| Task4 M7回归 v1         | setup1+业务1=2 passed（55.6s），stderr空                                      | 独立M7回归轮，不与actual v2相加                                                                                        |
| Task4默认F13回归 v1     | exit130；setup1 passed、业务1 interrupted（6.3m）                             | 旧fixture预算仍4096²，不足当前原生4×5016²，A在prepare/budget_exceeded、remoteJobId=null；Root精确SIGINT收口，非产品RED |
| Task4默认F13回归 v2     | 完整Web类型检查0；setup1+业务1=2 passed（2.7m），stderr空                     | 仅旧F13调用显式native4xDelivery:true，新独立轮通过，不覆盖首中断                                                       |

各任务及整分支固定产物独立Spec/Quality均通过，C/I/M=0/0/0。各轮通过/跳过不相加，跳过不算已执行覆盖，三个2 passed轮次不能合称同轮6项。Task2分层证据、Task4实际整链和开发发布分别登记，不把受控HTTP升级为真实GPU；M5既有unused-config M1仍沿原记录保留，本次批准不表示该历史项关闭。

## 固定交付与开发发布回读

固定31文件的格式、严格UTF-8/乱码、新增隐私、限定ESLint、diff、完整Web类型及CodeGraph门禁通过；新增隐私0、限定ESLint errors0，不扩称全仓零warning。Docs构建exit0并生成39页，stderr仅正常`$ next build`脚本回显。整分支独立复审为Spec compliant / Quality Approved，C/I/M=0/0/0。

Task4提交 `f70aa9b` 与技术/验收文稿提交 `6e096d2` 已服务器本地保存。固定 `6e096d2` 干净git archive构建exit0，镜像内Sharp PNG encode/decode通过；开发Web和生成Worker同镜像发布后，ready、PG schema、加密配置及新Worker心跳正常。后续状态文稿提交只补记录，运行镜像继续以 `6e096d2` 为构建源，无需为纯文稿重新构建或发布。

实际桌面站回读旧会话和历史图片正常。发布切换期间旧页面曾出现ChunkLoadError，完整reload后会话/图片恢复，此后newErrors为空；保留为旧页面资源切换记录，不当作新生图或GPU验收。本轮未新增真实生图、未补签或重跑旧任务，未改增强设置、未重启GPU Worker，生产指纹保持，未push或新建PR。真实GPU照片及用户画质验收继续单列。

## SR-M8 验收口径

SR-M8-01/02 的旧alpha表述以共享约定为准：alpha255外部保护零差，alpha0完整写回，中间值软混合。当前合法局部native画幅沿既有 `compositeSceneEdit` 的统一比例/像素栅格规则，禁止用本期超分补救原规则不合格的native。M8不引入新的整图导出入口；用户明确的整图任务继续独立按M5/M7准入，不能因“导出”解除已有保护。

每项只按实际证据填状态；技术保护、受控HTTP、桌面与真实GPU人工分别记录。软件测试通过不等于家居画质验收。
