# 图像超分：停止终态读取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将完整、同源且已恢复执行的原生 stop/deadline 日志解释成可消费的退出证据，为 Windows 执行器接线提供已验证的前置接口。

**Architecture:** 复用现有 journal reader 的原 scope、descriptor、request/prepared/AUTH 与 engine-tree 验证。stop/deadline 使用原 `ExecutionExit` 的可省略 completion 形式，不新增业务终态；取消或超时原因继续来自 Store 的原持久记录。

**Tech Stack:** TypeScript、Vitest、现有 Windows 原生运行件；不新增依赖或 native 生产改动。

## Global Constraints

- 只改原 reader 与受影响测试、必要文稿。正式 Adapter/runner/store、GPU、安装服务、Worker/API/ZEB 接线和实际部署分别验收。
- `stop`/`deadline` 只有原 request、prepared、AUTH、terminal 完整，原 scope/descriptor/fingerprint/installation/engine/job 绑定正确，`resumeState === "succeeded"`、授权封存、tree0 和双 EOF 全部成立时才有资格。
- 仍检查 proof.exitCode 为规范 UInt32，包括停止记录中的 exitCode；不因为结果不公开 exitCode 而省略验证。
- 新解释标签使用原生名称 `kind: "stop" | "deadline"`，携带冻结的 `ExecutionExit`；其中没有 `completion` own property。不映射为 success/failure/OOM/interrupted，也不由 native cause 推断用户业务原因。
- 原 engine-exit 和完整 public interrupted 链语义保持；任何已存在的 controller-loss 与 private terminal 冲突仍 Unknown。
- missing AUTH、not-attempted/uncertain resume、不完整或异源记录、坏 proof、解析/传输失败继续 Unknown。不修改原 Host 已缓存的 Unknown，不用新读取改判之前的请求结果。
- ACK/state/helper0/closed/joins 本身不构成 ExecutionExit。不创建新 attempt、自动重试或新的停止预算，schema5 与 OOM 自动重试暂缓保持。
- 用原调用路径和现有测试工具；真实 OS 验证复用源码未变的已验运行件，不重编 native 或扩大无关检查。
- 公开源码、文稿与中文提交不含实际部署地址、账号、数据库、服务器目录或业务身份；原始运行材料仅留私有记录。

## Task 1: 原生停止记录的严格解释

**Files:**

- Modify: `workers/image-enhancement/src/windows-journal-reader.ts`
- Test: `workers/image-enhancement/tests/windows-journal-reader.test.ts`
- Test: `workers/image-enhancement/tests/windows-journal-launcher.test.ts`
- Test: `workers/image-enhancement/tests/windows-session.os.test.ts`
- Test: `workers/image-enhancement/tests/windows-execution-bridge.os.test.ts`

**Interfaces:**

- Consumes: `interpretWindowsJournalSnapshot(snapshot, expectedScope, originalDescriptor)` 的原三个参数与原始 native envelope，不增加参数、旁路验证或新的配置。
- Produces: `WindowsJournalInterpretation` 增加 `{ kind: "stop" | "deadline"; exit: ExecutionExit }`。退出中的 identity、descriptor、launchTicket、treeExited 仍由原 freezer 绑定。
- Existing consumers: `windows-journal-launcher.ts` 完整传递 interpretation，无需新增分支；Store 已用自己的 stopReason 与树退出证据完成取消，此片不修改该消费规则或注入正式 Adapter。

- [x] **Step 1: tests-first，确认旧实现真实拒绝合法停止记录。** 在原 reader 测试复用 `engineFixture`、`setAt`、`recordPath`、`exitBase`。从旧 deferred 表只移出 stop/deadline 两项，保留 launch-failure/unauthorized-cleanup；新增正控的核心断言如下。Root 只选新正控运行，旧 reader 实际返回 Unknown；有效 RED-v2 的六个正控均命中原等值断言，不是缺 API 或夹具错误。

```typescript
it.each(["stop", "deadline"] as const)(
  "qualifies resumed %s without business completion",
  (kind) => {
    const fixture = engineFixture();
    setAt(fixture, recordPath("terminal", "completion"), { kind });
    const actual = interpret(fixture);
    expect(actual).toEqual({ kind, exit: exitBase(fixture) });
    if (actual.kind !== kind)
      throw new Error("qualified stopped tree required");
    expect(Object.hasOwn(actual.exit, "completion")).toBe(false);
    expectFrozen(actual);
  },
);
```

- [x] **Step 2: 添加有意义的边界用例。** 两 cause 均覆盖 exit0/非零/高 UInt32，证明没有成功、OOM 或 interrupted 推断；新增结果符合原 freezeExecutionExit 且与输入分离。两 cause 的相邻负例包括缺 AUTH、未恢复/不确定恢复、已有 loss、异源 request/descriptor/engine/job、tree未退出/active非0/任一EOF缺失、未封存、坏exitCode及completion额外字段。原 launcher 健康 transport 夹具增加 stop/deadline 两个透传正控，不改生产 launcher。复用已有表和 helper，不复制整套无关解析矩阵。

- [x] **Step 3: Root 确认真正行为 RED 后修改原 reader。** 在原 private terminal 共同验证路径中严格接受 engine-exit/stop/deadline 三种精确 completion，所有共同验证保持原位置。只对 engine-exit 生成原 success/failure completion；stop/deadline 仅产生原 treeExited Exit 与原 kind。避免复制共同 proof 校验、一般化框架或新依赖。

- [x] **Step 4: Root 格式化并冻结候选后执行类型、构建与定向单测。** 使用现有固定 Node、原 Vitest 与原直接文件记录器，执行 reader 全文件、受影响 launcher 单测；原 spec/argv/输入集合与前后SHA、stdout/stderr、child exit/close均保留，各轮分别核定。源未变的旧验证不重复运行。

- [x] **Step 5: 用真实 Windows 原件验证跨语言接缝。** 在已有 OS 测试中从原 strict readback 选固定槽，test-only 将 `Existing/Unknown` 结果规范化为 named slots，保持 envelope/record 完整原字节事实。覆盖 resumed stop、resumed deadline、未恢复 deadline 仍 Unknown、原 loss→interrupted；Node 三个停止场景核新解释，同时保留原 soft ACK Unknown、正常 transport 收尾与 private journal 断言。复用既有 native 程序，不改 producer 或为通过测试改原数据。

- [x] **Step 6: 独立源码与实际证据审查。** 固定源码及原实际证据分别独审通过，Spec/Quality 均为 0 Critical / 0 Important / 0 Minor；Root 已全文与摘要核定正式报告。实际证据复核覆盖六轮原件、五份 native receipt、四份 bridge evidence、778 个 native 输入及 52 个保全运行文件，不合计不同轮次或把过滤/未执行算通过。

## Task 2: 文稿与开发分支本地交付

- [x] 同步本计划的实际结果、TODO、pending-test 与 CHANGELOG；这是待最终审查的文稿，不提前确认本地提交、用户/部署或正式 Adapter 完成。
- [ ] 固定完整 worker 与文稿，检查严格 UTF-8、格式、链接和新增隐私；独立审查最终交付绑定。
- [ ] 核原开发分支基线与全部输入，唯一应用精确补丁，增量更新 CodeGraph，核 exact paths/全部 SHA 与 staged tree。
- [ ] 生成中文服务器本地提交，并用真正另一连接只读回读 HEAD/tree/唯一parent/原消息/全部路径SHA/clean/index。没有 push、PR、merge、部署或重启。
- [ ] 更新私有进度、恢复回执和记忆；明确 Mem0 后台捕获不等于服务端入库确认。

## 实际进展

### 已实现范围

生产只修改原 `windows-journal-reader.ts` 的共同 private terminal 验证路径；另修改四个相关测试和 README 入口。128 个 worker 文件中 6 个变更、122 个不变，无新增或删除；native、launcher 生产、Host、bridge、runner、Store、schema 和依赖均未修改。固定源码、合同及原实际证据独立审查均通过，Spec/Quality 的 Critical/Important/Minor 均为 0/0/0；最终交付审查独立进行。

合格 stop/deadline 保留原生标签，返回冻结且没有 `completion` own property 的 `ExecutionExit`。exit0 也不能推导成功；取消/超时原因仍由 Store 原持久 stopReason 决定。本片没有将 reader 注入正式 Adapter/runner/store。

### 独立运行记录

各轮依据各自原 spec、调用、退出回执与日志记录，不累加为一次全包通过。RED-v1 因 Vitest 将 `$kind` 显示为带单引号的字符串，原名称选择器没有命中新例；v2 仅修选择器为 `qualifies resumed`，源码相同。

| 轮次              | 实际结果                                 | 边界                                                                                 |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| unit-red-v1       | exit0；395 项全名称过滤；1.04 秒         | 零用例执行，不算 RED 或 GREEN，保留原件。                                            |
| unit-red-v2       | exit1；6 failed、389 项名称过滤；1.24 秒 | stop/deadline × exit0/1/UInt32max 在旧 reader 得到 Unknown，六例均命中预期等值断言。 |
| types-v1          | exit0                                    | 原类型检查，129 项输入前后不变。                                                     |
| build-v1          | exit0                                    | 原声明构建，129 项输入前后不变。                                                     |
| reader-green-v1   | exit0；395 passed；1.31 秒               | reader 全文件，129 项输入前后不变。                                                  |
| launcher-green-v1 | exit0；98 passed、1 项平台跳过；1.41 秒  | launcher 全文件，129 项输入前后不变；跳过项不计通过。                                |
| session-green-v1  | exit0；5 passed、90 项未执行；40.44 秒   | 所选五个原生场景；未执行项不计通过。                                                 |
| bridge-green-v1   | exit0；4 passed、14 项名称过滤；36.15 秒 | 三个 Node stop 场景与原 natural 路径；过滤项不计通过。                               |

两个 OS 轮次各自固定 958 项输入：128 个源文件、51 个 dist、Node 及 778 个 native 运行件；各轮前后不变，复用源码未变的既有原生程序，没有重编 native。原始材料只保留在私有执行记录，不写入公开文稿。

native session 选择 `business-late-soft`、`deadline-business-soft-wake`、`business-loss-reject`、`stop-prepared`、`deadline-before-resume`。原 strict readback 保留文件字节/摘要、root/reservation/file identity、envelope 与 expected scope 核验；test-only 仅映射固定槽和读结果名称。负例中缺失的原授权请求保持缺失，不为解释补造字段。Node bridge 三个停止场景分别为 soft、held 和 missing-ack；后者原 soft Promise 仍是 Unknown，后来的独立合格 journal 不能回写或升级该历史结果。正常 engine-exit 和 public interrupted 仍按原链解释。

### 收口与后续

实际证据已独立批准。Root 另核六轮原始调用与回执、当前输入摘要及原生/Node 接缝，保全本轮 51 个 dist 和原 runner；保全与后续原件复解不是新增构建或业务测试。首次私有复核脚本曾漏写自然 success 的 `signal:null` 预期，在任何保全/结果写入前失败；仅修私有断言后复核通过，原六轮没有重跑。

最终文稿/格式/严格 UTF-8/链接/新增隐私检查、完整交付冻结、服务器本地提交及另连接只读回读按对应原回执核定，不由上述技术检查预填完成。没有 push、PR、merge、部署、重启或生产修改。

正式 Adapter 需要另行冻结原执行与 journal 观察生命周期；prepare/authorize 的发送 guard 在 Promise 结算时已封存，不能充当后续观察者的存活 guard。ACK、closed 或双流 join 不授树退出/清槽资格；未知和不完整事实仍保留。

正式 Adapter/runner/store、实际 GPU/图片质量、安装服务身份、Worker/API/ZEB、完整 M2、用户及实际部署验收仍待。M1 已验收、schema5、增强关闭/readiness=false、worker 未接和 OOM 自动重试暂缓保持；本片不重复查询或变更这些既有部署边界。私有笔记与 Mem0 后台捕获不代表已确认服务端入库。
