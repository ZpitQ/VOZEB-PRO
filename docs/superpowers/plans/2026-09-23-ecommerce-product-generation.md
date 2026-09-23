# 电商商品图生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/create` 统一创作入口中建立可切换模型、商品保真、连续编辑的电商商品图生成编排层，首期交付白底商品图到欧美家居场景图和非商品区域局部修改。

**Architecture:** 保持现有 Next.js 单体部署，在 Agent Run 与 image task executor 之间增加 `EcommerceEditPlan` 编排边界。GPT-5.6 或后台配置的同类模型负责视觉分析和编辑规划，gpt-image-2.5 与 nano banana 2 通过逻辑生成角色接入；商品主参考图和场景参考图使用显式角色，连续编辑使用原始商品锚点与当前场景基线双基线。

**Tech Stack:** Next.js App Router、TypeScript、React、PostgreSQL/JSON Provider、现有 Agent Run、图片任务、系统渠道代理、Sharp/现有图像处理能力、Vitest、Playwright、本地 TCP 上游 fixture。

## Global Constraints

- 首期只修改 `/create` 统一创作入口；Canvas 和短剧不接入本计划。
- 用户只提供参考图和一句话；模型、策略、mask 和内部 prompt 不作为首期用户控件。
- 默认策略为 `strict_product`；没有可信商品 mask 时禁止静默降级。
- 用户原话、内部 `EditPlan`、最终执行 prompt 和公开摘要必须分开保存。
- 模型按逻辑角色路由；每次任务保存实际模型、策略、编译器和计划快照。
- 生成任务继续使用稳定 `runId`、`taskId`、`resultId` 和幂等身份，不按 prompt 文本匹配或合并。
- 连续编辑默认继承最近成功结果，但原始商品锚点永久保留；明确引用历史结果创建分支，不覆盖旧结果。
- 商品核心验收失败直接拦截；场景美观不能抵消商品身份、轮廓、包装文字或比例失败。
- 内部视觉分析、规划和验收不进入用户公开消息；当前计划不改造计费规则。
- 上游协议、渠道代理、任务恢复和退款沿用现有契约；新编排层不能重复创建不确定的上游任务。
- 每个阶段必须有旧流程回退开关，并通过影子、内部、灰度、默认四阶段发布。

---

### Task 1: 固化 EcommerceEditPlan 契约

**Files:**
- Create: `web/src/lib/server/ecommerce-edit-plan.ts`
- Create: `web/src/lib/server/ecommerce-edit-plan.test.ts`
- Modify: `web/src/lib/server/agent-run-store.ts` only to add typed internal snapshot fields if the existing task payload cannot carry them

**Interfaces:**
- `EcommerceEditPlan`：包含 `planVersion`、`operation`、`source`、`baseline`、`delta`、`preserve`、`strategy`、`modelRoles`、`continuity`、`validation`。
- `normalizeEcommerceEditPlan(value: unknown): EcommerceEditPlan | null`：拒绝缺少商品来源、操作类型、策略或校验项的计划。
- `validateEcommerceEditPlan(plan: EcommerceEditPlan): void`：校验来源归属、策略与操作组合、严格商品保护项和连续编辑父结果。
- `planPublicSummary(plan: EcommerceEditPlan)`：只返回用户可见的操作摘要，不包含内部 prompt、分析细节或模型选择理由。

- [x] **Step 1: 写失败测试**

覆盖：`product_to_scene` 必须有商品主参考；`strict_product` 必须有商品核心保护项；`local_edit` 必须有目标对象或手动区域；场景参考不能成为商品主参考；无效 `continuity.parentResultId` 不能被静默接受；公开摘要不包含内部字段。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-edit-plan.test.ts`

Expected: FAIL because the new contract functions do not exist.

- [x] **Step 3: 实现最小契约与校验**

使用不可变的输入输出对象；规范化字符串数组、稳定 ID 和策略枚举；不要在该模块调用模型、数据库或图片处理库。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-edit-plan.test.ts`

Expected: PASS with coverage for valid plans, rejected plans and public summaries.

- [x] **Step 5: Commit**

```bash
git add CONTEXT.md docs/adr/0001-logical-model-roles-for-ecommerce-generation.md docs/adr/0002-strategy-modes-for-product-imaging.md docs/adr/0003-adaptive-multimodal-planning.md web/src/lib/server/ecommerce-edit-plan.ts web/src/lib/server/ecommerce-edit-plan.test.ts
git commit -m "feat: define ecommerce image edit plan contract"
```

### Task 2: 加入影子规划和内部快照

**Files:**
- Create: `web/src/lib/server/ecommerce-generation-snapshot.ts`
- Create: `web/src/lib/server/ecommerce-generation-snapshot.test.ts`
- Modify: `web/src/lib/server/agent-run-executor.ts`
- Modify: `web/src/lib/server/agent-run-store.ts`
- Modify: `.env.example`
- Test: `web/src/lib/server/agent-run-executor.test.ts`

**Interfaces:**
- `buildEcommercePlanningInput(run, assets, conversationContext)`：为规划器提供一句话、图片角色候选和连续编辑上下文。
- `recordEcommerceGenerationSnapshot(task, snapshot)`：只保存服务端内部的计划、模型角色快照、编译器版本和验收状态。
- `legacyPlanFallback(input)`：当新计划不完整或开关关闭时，继续走现有 Agent 任务流程。

- [x] **Step 1: 写失败测试**

验证新开关关闭时生成请求与当前旧路径一致；影子模式不改变任务 prompt 或结果；内部快照不出现在公开 Agent Run、用户消息或公开摘要；新计划解析失败时能记录原因并回退旧流程。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/agent-run-executor.test.ts web/src/lib/server/ecommerce-generation-snapshot.test.ts`

Expected: FAIL on missing snapshot and shadow-path assertions.

- [x] **Step 3: 接入影子路径**

在 `agent-run-executor.ts` 中保留原有 `normalizeTasks` 和任务执行行为，只在内部生成并记录快照；不得把分析摘要或执行 prompt 写入公开消息。影子模式由 `ECOMMERCE_GENERATION_ROLLOUT=shadow` 显式开启，默认关闭。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/agent-run-executor.test.ts web/src/lib/server/ecommerce-generation-snapshot.test.ts`

Expected: PASS with legacy behavior unchanged and snapshot fields isolated.

- [x] **Step 5: Commit**

```bash
git add .env.example web/src/lib/server/agent-run-executor.ts web/src/lib/server/agent-run-store.ts web/src/lib/server/ecommerce-generation-snapshot.ts web/src/lib/server/ecommerce-generation-snapshot.test.ts web/src/lib/server/agent-run-executor.test.ts
git commit -m "feat: add shadow ecommerce generation planning"
```

### Task 3: 实现商品/场景参考角色识别

**Files:**
- Create: `web/src/lib/server/ecommerce-reference-roles.ts`
- Create: `web/src/lib/server/ecommerce-reference-roles.test.ts`
- Modify: `web/src/lib/server/agent-run-assets.ts`
- Modify: `web/src/lib/server/agent-run-execution.ts`
- Test: `web/src/lib/server/agent-run-assets.test.ts`

**Interfaces:**
- `classifyReferenceRoles(assets, visualHints): ReferenceRoleDecision`：返回一张商品主参考图、至多一张场景参考图、歧义原因和是否需要澄清。
- `resolveContinuitySources(run, explicitAssets, selectedHistory): EcommerceSources`：解析原始商品锚点、当前场景基线和明确历史引用。

- [ ] **Step 1: 写失败测试**

覆盖：白底单主体优先判为商品图；完整家居空间优先判为场景图；超过两张图片进入拒绝/澄清；新商品图建立新锚点；新场景图不替换商品锚点；明确历史结果创建新分支；无法判断时只返回一个澄清问题。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-reference-roles.test.ts web/src/lib/server/agent-run-assets.test.ts`

Expected: FAIL because role and continuity resolvers are not implemented.

- [ ] **Step 3: 实现角色与来源解析**

使用稳定资产 ID 和用户明确引用，不按标题相似度或 prompt 文本猜测历史结果。保留商品主参考图和场景参考图的优先级。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-reference-roles.test.ts web/src/lib/server/agent-run-assets.test.ts`

Expected: PASS with no source role ambiguity leaking into generation.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/ecommerce-reference-roles.ts web/src/lib/server/ecommerce-reference-roles.test.ts web/src/lib/server/agent-run-assets.ts web/src/lib/server/agent-run-assets.test.ts web/src/lib/server/agent-run-execution.ts
git commit -m "feat: classify ecommerce product and scene references"
```

### Task 4: 建立多模态视觉分析和编辑规划

**Files:**
- Create: `web/src/lib/server/ecommerce-visual-analysis.ts`
- Create: `web/src/lib/server/ecommerce-visual-analysis.test.ts`
- Create: `web/src/lib/server/ecommerce-edit-planner.ts`
- Create: `web/src/lib/server/ecommerce-edit-planner.test.ts`
- Modify: `web/src/lib/server/text-planning-runtime.ts`
- Modify: `web/src/lib/server/agent-run-surface-policy.ts`
- Modify: `web/src/lib/server/agent-function-call.ts`

**Interfaces:**
- `analyzeEcommerceReferences(input, candidateRole)`：返回商品事实、场景事实、商品核心候选区域、融合光晕候选区域和置信状态。
- `planEcommerceEdit(input, visualAnalysis, candidateRole)`：返回经 `validateEcommerceEditPlan` 校验的 `EcommerceEditPlan`。
- `planEcommerceEdit` 必须支持两阶段调用；简单请求可以使用同一模型的合并实现，但仍返回同一契约。

- [ ] **Step 1: 写失败测试**

使用本地结构化模型 fixture 验证：商品图和场景图角色不会混淆；模型返回缺字段时计划被拒绝；核心保护项缺失时严格策略不可用；同角色候选可切换；跨角色降级被拒绝；用户请求“商品旁边增加咖啡杯”不会被规划为修改商品本体。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-visual-analysis.test.ts web/src/lib/server/ecommerce-edit-planner.test.ts`

Expected: FAIL before multimodal content and planner adapters exist.

- [ ] **Step 3: 扩展规划传输以支持多模态内容**

在 `text-planning-runtime.ts` 中增加结构化内容部分的传输能力，保持已有纯文本规划请求不变；图片 URL 必须经过现有站内权限和媒体访问边界。

- [ ] **Step 4: 实现分析和规划适配器**

分析和规划分别使用独立输入输出契约；记录实际逻辑角色和候选模型；分析失败只能同角色切换或进入待复核，不能变成无图文本规划。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-visual-analysis.test.ts web/src/lib/server/ecommerce-edit-planner.test.ts web/src/lib/server/text-planning-runtime.test.ts`

Expected: PASS with existing text planning tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/server/ecommerce-visual-analysis.ts web/src/lib/server/ecommerce-visual-analysis.test.ts web/src/lib/server/ecommerce-edit-planner.ts web/src/lib/server/ecommerce-edit-planner.test.ts web/src/lib/server/text-planning-runtime.ts web/src/lib/server/agent-run-surface-policy.ts web/src/lib/server/agent-function-call.ts
git commit -m "feat: add multimodal ecommerce visual planning"
```

### Task 5: 实现商品核心区与融合光晕区

**Files:**
- Create: `web/src/lib/server/ecommerce-product-regions.ts`
- Create: `web/src/lib/server/ecommerce-product-regions.test.ts`
- Modify: `web/src/lib/server/image-task-store.ts`
- Modify: `web/src/app/api/image-tasks/image-task-support.ts`
- Modify: `web/src/app/api/image-tasks/image-task-openai.ts`
- Modify: `web/src/app/api/image-tasks/image-task-gemini.ts`
- Test: `web/src/app/api/image-tasks/route.test.ts`

**Interfaces:**
- `buildProductProtectionRegions(analysis, sourceSize): ProductProtectionRegions`：返回 `productCore`、`fusionHalo`、`editableBackground`。
- `validateProductProtectionRegions(regions, sourceSize): void`：拒绝越界、空核心区和编辑区覆盖核心区的 mask。
- `compileStrictProductEdit(task, regions)`：把商品角色、独立 mask、融合光晕和保护约束转换为当前 provider 适配器能理解的请求。

- [ ] **Step 1: 写失败测试**

覆盖核心区不能为空；融合光晕必须与核心区相邻且范围有限；背景编辑不得覆盖核心区；mask 尺寸与源图一致；provider 不支持可信 mask 时任务进入待复核而非静默整图生成；已有 Canvas mask 行为不回归。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-product-regions.test.ts web/src/app/api/image-tasks/route.test.ts`

Expected: FAIL on new region validation and strict-product request assertions.

- [ ] **Step 3: 实现区域校验和 provider 输入编译**

复用现有图片尺寸、参考图访问和蒙版规范化能力；provider-specific 字段留在图片任务适配层，编排层只传递领域区域。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-product-regions.test.ts web/src/app/api/image-tasks/route.test.ts web/src/app/api/image-tasks/image-task-openai-live.test.ts`

Expected: PASS with native and legacy provider contracts preserved.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/ecommerce-product-regions.ts web/src/lib/server/ecommerce-product-regions.test.ts web/src/lib/server/image-task-store.ts web/src/app/api/image-tasks/image-task-support.ts web/src/app/api/image-tasks/image-task-openai.ts web/src/app/api/image-tasks/image-task-gemini.ts web/src/app/api/image-tasks/route.test.ts
git commit -m "feat: protect ecommerce product regions during edits"
```

### Task 6: 交付 `/create` 的 product_to_scene 垂直切片

**Files:**
- Create: `web/src/lib/server/ecommerce-generation-service.ts`
- Create: `web/src/lib/server/ecommerce-generation-service.test.ts`
- Modify: `web/src/lib/server/agent-run-execution.ts`
- Modify: `web/src/lib/server/agent-run-validation.ts`
- Modify: `web/src/services/api/creative.ts`
- Modify: `web/src/app/(user)/create/components/creative-generation-waiting.tsx`
- Test: `web/src/lib/server/agent-run-executor.test.ts`
- Test: `web/src/app/(user)/create/components/creative-generation-waiting.test.tsx`

**Interfaces:**
- `createEcommerceProductSceneTask(run, plan, settings)`：从合法计划创建 image task，传递商品主参考图、可选场景参考图、区域和模型快照。
- `publicEcommerceProgress(stage)`：将内部阶段映射为“正在识别商品/正在规划场景/正在生成图片/正在检查商品细节”。
- `ecommerceGenerationEnabled(settings, run)`：读取影子、内部、灰度和默认开关，关闭时保持旧流程。

- [ ] **Step 1: 写失败测试**

验证一句话 + 白底商品图会创建 `product_to_scene`；可选场景图只作为场景参考；没有场景文字时从受控欧美家居场景类别自动规划；结果任务使用 `strict_product`；用户公开消息不包含内部计划；阶段状态映射正确。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-generation-service.test.ts web/src/lib/server/agent-run-executor.test.ts web/src/app/(user)/create/components/creative-generation-waiting.test.tsx`

Expected: FAIL before the vertical slice is wired into Agent Run execution.

- [ ] **Step 3: 接入商品生成服务**

只在 `/create` 的图片生成意图和特性开关命中时进入新服务；Canvas、短剧和其他能力继续旧路径。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-generation-service.test.ts web/src/lib/server/agent-run-executor.test.ts web/src/app/(user)/create/components/creative-generation-waiting.test.tsx`

Expected: PASS with legacy path and new product-to-scene path both covered.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/ecommerce-generation-service.ts web/src/lib/server/ecommerce-generation-service.test.ts web/src/lib/server/agent-run-execution.ts web/src/lib/server/agent-run-validation.ts web/src/services/api/creative.ts web/src/app/(user)/create/components/creative-generation-waiting.tsx web/src/lib/server/agent-run-executor.test.ts web/src/app/(user)/create/components/creative-generation-waiting.test.tsx
git commit -m "feat: add ecommerce product to scene flow"
```

### Task 7: 交付 local_edit 的非商品区域局部修改

**Files:**
- Modify: `web/src/lib/server/ecommerce-edit-planner.ts`
- Modify: `web/src/lib/server/ecommerce-generation-service.ts`
- Modify: `web/src/lib/server/ecommerce-product-regions.ts`
- Create: `web/src/lib/server/ecommerce-local-edit.test.ts`
- Modify: `web/src/app/(user)/create/components/creative-composer.tsx`
- Test: `web/src/app/(user)/create/components/creative-composer.test.tsx`

**Interfaces:**
- `resolveLocalEditTarget(plan, analysis, optionalManualRegion)`：自动定位唯一编辑目标，多个候选返回单个澄清问题，手动区域优先。
- `createEcommerceLocalEditTask(run, plan, regions)`：只允许背景、环境、道具、光线和阴影目标进入首期 local edit。

- [ ] **Step 1: 写失败测试**

覆盖“把背景换成厨房”“增加一杯咖啡”“去掉右边绿植”“让光线更亮”；覆盖多个相同目标只返回一个澄清问题；手动 mask 优先；商品颜色、材质、结构和包装文字被拒绝并提示后续能力；局部编辑不扩大到商品核心区。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-local-edit.test.ts web/src/app/(user)/create/components/creative-composer.test.tsx`

Expected: FAIL until target routing and UI clarification behavior exist.

- [ ] **Step 3: 实现局部目标路由**

复用当前场景基线和原始商品锚点；本轮只加入当前 `delta`，不拼接历史 prompt。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-local-edit.test.ts web/src/app/(user)/create/components/creative-composer.test.tsx`

Expected: PASS with strict product core protection.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/ecommerce-edit-planner.ts web/src/lib/server/ecommerce-generation-service.ts web/src/lib/server/ecommerce-product-regions.ts web/src/lib/server/ecommerce-local-edit.test.ts web/src/app/(user)/create/components/creative-composer.tsx web/src/app/(user)/create/components/creative-composer.test.tsx
git commit -m "feat: support non-product local ecommerce edits"
```

### Task 8: 交付连续编辑、双基线和编辑分支

**Files:**
- Modify: `web/src/lib/server/ecommerce-generation-service.ts`
- Modify: `web/src/lib/server/ecommerce-reference-roles.ts`
- Modify: `web/src/lib/server/ecommerce-generation-snapshot.ts`
- Modify: `web/src/lib/server/agent-run-store.ts`
- Modify: `web/src/lib/server/agent-run-assets.ts`
- Create: `web/src/lib/server/ecommerce-continuity.test.ts`
- Test: `web/src/lib/server/agent-run-store.test.ts`

**Interfaces:**
- `resolveDualBaseline(run, explicitReference)`：返回不可替换的 `productAnchor` 和当前可分支的 `sceneBaseline`。
- `createEditBranch(parentResultId, run)`：创建稳定 branch ID，保留父结果并为新轮写入快照。
- `selectCurrentSceneBaseline(conversationId, explicitResultId?)`：无明确选择时返回最近成功结果，有明确选择时返回指定结果。

- [ ] **Step 1: 写失败测试**

覆盖“再亮一点”继承最近场景结果；商品核心事实仍来自原始白底图；明确引用旧结果创建分支；新商品图建立新锚点；新场景参考图不改变商品锚点；历史结果不会被覆盖；刷新和恢复后仍能读取父子关系。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-continuity.test.ts web/src/lib/server/agent-run-store.test.ts`

Expected: FAIL until continuity fields and branch selection are persisted.

- [ ] **Step 3: 实现双基线和分支持久化**

只用稳定资产、结果和任务 ID 建立关系；禁止按标题或 prompt 文本推断父结果。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-continuity.test.ts web/src/lib/server/agent-run-store.test.ts`

Expected: PASS with round-trip persistence and no result overwrite.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/ecommerce-generation-service.ts web/src/lib/server/ecommerce-reference-roles.ts web/src/lib/server/ecommerce-generation-snapshot.ts web/src/lib/server/agent-run-store.ts web/src/lib/server/agent-run-assets.ts web/src/lib/server/ecommerce-continuity.test.ts web/src/lib/server/agent-run-store.test.ts
git commit -m "feat: preserve ecommerce edit continuity and branches"
```

### Task 9: 接入逻辑模型路由和 provider compiler

**Files:**
- Create: `web/src/lib/server/ecommerce-model-routing.ts`
- Create: `web/src/lib/server/ecommerce-model-routing.test.ts`
- Create: `web/src/lib/server/ecommerce-image-compiler.ts`
- Create: `web/src/lib/server/ecommerce-image-compiler.test.ts`
- Modify: `web/src/lib/server/logical-model-router.ts`
- Modify: `web/src/lib/server/ecommerce-generation-service.ts`
- Test: `web/src/lib/server/logical-model-router.test.ts`

**Interfaces:**
- `resolveEcommerceRoleCandidates(settings, role, capability)`：按逻辑角色返回有序候选。
- `routeEcommerceRole(settings, role, snapshot)`：只在同角色候选内切换，并返回实际模型快照。
- `compileEcommerceImageRequest(plan, providerProfile)`：将领域计划编译为 image task 的提示词、参考图角色、mask 和参数。

- [ ] **Step 1: 写失败测试**

验证管理员可以排序多个视觉、规划、验收和生成候选；失败只在同角色切换；不同模型收到不同 provider compiler 输出；已开始任务继续使用保存的快照；策略和模型切换不影响历史任务重试。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-model-routing.test.ts web/src/lib/server/ecommerce-image-compiler.test.ts web/src/lib/server/logical-model-router.test.ts`

Expected: FAIL before role candidates and compiler adapters exist.

- [ ] **Step 3: 实现角色候选和编译器**

保持逻辑模型 ID 与上游模型名分离；编译器不得向用户公开 foundation、analysis、model reason 或内部依赖上下文。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-model-routing.test.ts web/src/lib/server/ecommerce-image-compiler.test.ts web/src/lib/server/logical-model-router.test.ts`

Expected: PASS with role failover, snapshot stability and provider-specific request fixtures.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/ecommerce-model-routing.ts web/src/lib/server/ecommerce-model-routing.test.ts web/src/lib/server/ecommerce-image-compiler.ts web/src/lib/server/ecommerce-image-compiler.test.ts web/src/lib/server/logical-model-router.ts web/src/lib/server/ecommerce-generation-service.ts web/src/lib/server/logical-model-router.test.ts
git commit -m "feat: route ecommerce roles through model compilers"
```

### Task 10: 加入商品核心验收和发布开关

**Files:**
- Create: `web/src/lib/server/ecommerce-quality-check.ts`
- Create: `web/src/lib/server/ecommerce-quality-check.test.ts`
- Modify: `web/src/lib/server/ecommerce-generation-service.ts`
- Modify: `web/src/lib/server/ecommerce-generation-snapshot.ts`
- Modify: `web/src/lib/server/agent-run-public.ts`
- Modify: `web/src/app/(user)/create/components/creative-generation-waiting.tsx`
- Test: `web/src/lib/server/agent-run-public.test.ts`

**Interfaces:**
- `checkEcommerceResult(input, roleCandidate)`：返回每项检查、硬失败项、可公开状态和内部原因。
- `shouldBlockEcommerceResult(check)`：商品核心、Logo、包装文字或轮廓失败时返回 true。
- `ecommerceRolloutStage(settings, userId)`：返回 shadow、internal、canary 或 default，并提供旧流程回退。

- [ ] **Step 1: 写失败测试**

覆盖商品核心失败拦截；场景轻微不符进入待调整；验收模型不可用不自动判定成功；影子结果不影响公开任务；开关关闭时完整回退旧流程；用户只看到简短状态。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-quality-check.test.ts web/src/lib/server/agent-run-public.test.ts`

Expected: FAIL before quality check and rollout gates exist.

- [ ] **Step 3: 实现双门禁和灰度开关**

自动验收只负责结构和硬失败；业务人工复核通过黄金回归集完成。验收结果写入内部快照，不写入公开消息。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-quality-check.test.ts web/src/lib/server/agent-run-public.test.ts`

Expected: PASS with strict hard-fail behavior and legacy fallback.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/ecommerce-quality-check.ts web/src/lib/server/ecommerce-quality-check.test.ts web/src/lib/server/ecommerce-generation-service.ts web/src/lib/server/ecommerce-generation-snapshot.ts web/src/lib/server/agent-run-public.ts web/src/app/(user)/create/components/creative-generation-waiting.tsx web/src/lib/server/agent-run-public.test.ts
git commit -m "feat: gate ecommerce results and rollout stages"
```

### Task 11: 建立真实黄金回归集和浏览器验收

**Files:**
- Create: `web/e2e/ecommerce-product-generation.spec.ts`
- Create: `web/e2e/fixtures/ecommerce-product-cases.json`
- Create: `docs/content/docs/progress/pending-test.mdx` entry for the release
- Modify: `docs/content/docs/overview/features.mdx` only after business acceptance

- [ ] **Step 1: 准备真实素材和本地 fixture**

使用真实家居商品素材，覆盖收纳、灯具、厨房、卫浴、软装、家具和小家电；每个案例定义商品图、可选场景图、用户一句话、预期操作类型和硬保护项。上游请求使用本地 TCP fixture，不调用管理员真实渠道。

- [ ] **Step 2: 写浏览器失败断言**

覆盖上传商品图、上传场景图、发送一句话、阶段状态、结果恢复、连续编辑、历史结果分支、歧义追问和严格流程失败提示。不得使用 `force` 点击或固定延时掩盖定位问题。

- [ ] **Step 3: 运行桌面和移动端测试确认失败**

Run: `pnpm exec playwright test web/e2e/ecommerce-product-generation.spec.ts --project=chromium`

Expected: FAIL until `/create` flow, fixtures and result persistence are wired.

- [ ] **Step 4: 完成自动和人工双门禁**

读取真实任务请求、mask、计划快照、模型快照和公开结果；产品/业务负责人逐项确认商品核心和场景可用性。任何商品核心失败都阻止灰度升级。

- [ ] **Step 5: 运行完整相关回归**

Run: `pnpm exec vitest run web/src/lib/server web/src/app/api/image-tasks web/src/app/(user)/create`

Run: `pnpm exec playwright test web/e2e/ecommerce-product-generation.spec.ts --project=chromium`

Expected: all relevant tests pass; no Canvas、短剧、旧图片任务回归。

- [ ] **Step 6: Commit**

```bash
git add web/e2e/ecommerce-product-generation.spec.ts web/e2e/fixtures/ecommerce-product-cases.json docs/content/docs/progress/pending-test.mdx
git commit -m "test: add ecommerce product generation golden regression"
```

## 发布顺序

1. Task 1-2：完成契约和影子快照，默认用户结果不变。
2. Task 3-4：完成素材角色和多模态规划，仅内部账号可见。
3. Task 5-6：完成 `product_to_scene` 严格商品 MVP。
4. Task 7：上线非商品区域 `local_edit`。
5. Task 8：上线连续编辑、双基线和分支。
6. Task 9：接入多模型候选和 provider compiler。
7. Task 10-11：启用验收、灰度和黄金回归门禁。

每一步必须先通过自动测试，再进行内部账号验收，然后才能扩大灰度范围。商品核心失败、参考角色错误、历史结果覆盖或旧流程回退失效，任何一项都停止发布。

## 计划自检

- 规格覆盖：目标、两条工作流、连续编辑、模型路由、商品 mask、失败回退、用户体验、发布灰度和验收均有对应任务。
- 占位符检查：计划没有依赖未定义的组件名称、任务编号或待补充字段；所有新接口在任务中给出名称和职责。
- 类型一致性：后续任务使用的 `EcommerceEditPlan`、`buildProductProtectionRegions`、`routeEcommerceRole`、`compileEcommerceImageRequest`、`checkEcommerceResult` 均在前置任务中定义。
- 范围检查：首期只覆盖 `/create`，Canvas 和短剧明确排除，商品本体修改单独延后。
