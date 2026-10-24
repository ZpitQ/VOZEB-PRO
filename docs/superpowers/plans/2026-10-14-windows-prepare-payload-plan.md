# Windows 引擎准备请求合同 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已冻结的任务快照一次编码为原始请求字节，让 .NET 严格解码并保留同一份事实，为引擎准备与一次授权接线提供可测试的输入边界。

**Architecture:** 新增纯 TypeScript writer 和纯 C# decoder，复用既有 scope/engine/limits 语义；返回不可变 Base64 与原字节 SHA256，通过独立普通程序集 fixture 验证跨语言结果。此片不访问请求中的文件路径，不启动引擎，不接入控制会话或执行适配器。

**Tech Stack:** Node.js 22、TypeScript/Vitest、C#/.NET 10、成熟 JSON/UTF-8/Base64/SHA256 库、独立 Windows contract fixture。

## Global Constraints

- 本片为 B4-B2-3，继承[主 SOP](2026-10-10-image-super-resolution-integration-plan.md)，位于[安装绑定](2026-10-14-windows-engine-installation-plan.md)与[Job 保护/观察](2026-10-14-windows-job-observation-plan.md)之后。源码、完整跨语言技术验证及固定源码/实际证据独立复审已收口；文稿检查、独立文稿批准与本地提交回读单独记录，不由源码门推定。
- 仅新增下表七条源码/测试路径，不改现有业务、项目、依赖、SDK、schema、Program/bootstrap、Job/journal/control/installation、配置或界面。新 C# 文件由现有 SDK 项目自动纳入。
- 主执行者独占远端上传、构建、restore/publish、测试、索引、检查与中文本地提交；子代理仅写分配文件。保留开发分支，不推送、创建 PR 或部署。
- M1 已验收、schema5、增强关闭、readiness=false、worker 未接入、自动 OOM tile 重试暂缓保持。此片不是授权、安装器/服务身份、GPU/API/ZEB 或完整 M2 验收，不增加 86 项业务/24 项 Worker 规格通过数。
- 使用既有 60 秒执行/5 秒清理配置；不引入固定 sleep、重试或资源上限。不扩大到无关网页/手机测试。各轮、测试组和向量数量分开记录。
- 公开代码/文稿/提交仅含通用案例与技术结论，不含真实环境身份或私有证据链接。

| 路径（相对 workers/image-enhancement）                        | 职责                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| src/windows-prepare-payload.ts                                | 从冻结 Claim 转成不可变两字符串                                       |
| native/windows-supervisor/PreparePayload.cs                   | 严格原字节解码与只读 typed payload                                    |
| native/windows-contract-fixture/WindowsContractFixture.csproj | 复用普通 native 项目的独立测试产物                                    |
| native/windows-contract-fixture/Program.cs                    | 独立 BCL 传输正控与生产 Parse 入口，不启动子引擎                      |
| tests/windows-prepare-payload-fixtures.ts                     | 两测试文件共用的独立任务/向量构造                                     |
| tests/windows-prepare-payload.test.ts                         | TS 源快照、无损编码与拒绝规则                                         |
| tests/windows-prepare-payload.os.test.ts                      | 实际 .NET 接受/拒绝、两端一致、字节保留及 original-child close/双 EOF |

## 冻结 API 与数据

```typescript
export type FrozenWindowsRequest = Readonly<{
  requestUtf8Base64: string;
  requestFingerprint: string;
}>;

export function freezeWindowsPrepareRequest(
  attempt: ClaimedAttempt,
): FrozenWindowsRequest;
```

成功返回恰好两条自身 enumerable data 属性并 Object.freeze，不暴露 Buffer、spec 或 typed-array backing。无效内部快照抛现有 configuration_invalid。

原始 JSON 的九字段与写入顺序固定为：

```typescript
{
  v: 1,
  target: {
    identity: { jobId, attemptNo, ownerInstanceId, fence },
    launchTicket,
  },
  executionPolicy: {
    limits: {
      executionTimeoutMs, cancelGraceMs,
      leaseDurationMs, heartbeatIntervalMs,
    },
    allowedTiles,
    fingerprint,
  },
  engine: {
    modelId, binaryVersion, binarySha256, modelVersion, modelSha256,
    nativeScale, tile, tta, gpuId,
  },
  firstStartedAt,
  executionDeadlineAt,
  inputPath,
  workingDirectory,
  outputPath,
}
```

target 取本次 identity/ticket；engine 只取 stored job.plan.engine，并核 job.jobId 与 identity.jobId、attempt.tile 与 engine.tile 一致。leaseExpiresAt 和其他业务元数据不进入 payload；不要求整个 ActiveAttempt/JobDto exact shape，不重新选当前模型/默认 tile，不规范化路径，不重算时间。只取安全 data 属性，选中的 identity/policy/limits/engine 必须 exact plain object，拒绝多余键、symbol、nonenumerable 或 accessor；tiles 为无多余属性的 dense 普通数组。

新 prepare spec 仅 JSON.stringify 一次，再严格 UTF-8 编码；requestFingerprint 为这些原字节的 SHA256，requestUtf8Base64 为同字节的规范 Base64。既有 freezeExecutionPolicy 内部有独立序列化，不对全局 stringify 次数作恰一次断言。后续使用方缓存原两字符串；本片只证明保留原字节，不声称会话重放/冲突处理已接线。

```csharp
public sealed record PrepareLimits(
    long ExecutionTimeoutMs, long CancelGraceMs,
    long LeaseDurationMs, long HeartbeatIntervalMs);

public sealed class PreparePayload
{
    public static PreparePayload Parse(
        string requestUtf8Base64, string requestFingerprint);

    public JournalScope Scope { get; }
    public EngineSelection Engine { get; }
    public PrepareLimits Limits { get; }
    public IReadOnlyList<long> AllowedTiles { get; }
    public long FirstStartedAt { get; }
    public long ExecutionDeadlineAt { get; }
    public string InputPath { get; }
    public string WorkingDirectory { get; }
    public string OutputPath { get; }
    public string RequestUtf8Base64 { get; }
    public string RequestFingerprint { get; }
}
```

私有构造函数，只返回解析成功的新值；复用既有 immutable scope/engine，tiles 私有数组通过 Array.AsReadOnly 暴露。只保留规范 Base64 字符串，不暴露解码 array/ReadOnlyMemory backing。解析失败仅抛固定 `ArgumentException("Invalid native prepare payload.")`，不附原路径或请求。

## 校验方法与限界

- 所有对象按 decoded 名称拒绝重复、缺失、多余、大小写错误键及错误类型；成熟 JSON parser 负责语法，不手写解析器。规范 Base64 round-trip、原字节摘要、严格 UTF-8、单 object、无 BOM/首尾空白、无 comment/trailing comma 均校验；合法内部空白/属性顺序/escape spelling 原样保留。
- 数字是规范无符号十进制 token：0 或非零开头数字，值不大于 9007199254740991；正字段另大于 0。TS 显式拒绝 -0，native 不接受小数/指数/-0 的写法，不用浮点舍入。这是比 generic JSON.parse/Number.isSafeInteger 更窄的 wire 子合同。
- attemptNo/fence/四 limits 为正；heartbeat 不大于 lease。tiles 非空无重复，每项为 0 或至少 32，engine.tile 必须在其中；nativeScale=4、tta=false，gpuId 非负。边界值合法只表示数据有效，不表示 GPU 支持该值。
- TS 用既有 freezeExecutionPolicy 对原 limits 与原 tile 顺序核 fingerprint，并另验 tiles。native 仅验 opaque 小写 Hex64，不声称重算了原 TS policy 算法。请求摘要覆盖完整原字节，两种摘要不能混为一谈。
- identifier/version 沿 JS trim、C0/DEL 和非空规则，另要求 well-formed Unicode；不能用 .NET Trim 替代。U+0085 允许，FEFF/NBSP 等 JS whitespace 仅在边界拒绝，内部保持。ModelId 沿现有 ASCII 正则，hash 不把大写静默改小写。
- firstStartedAt/deadline 保持原 safe 非负值且 deadline>first，不读当前钟、不重置/续期、不增加 first+timeout 等式。后续运行判断继续沿 store 的 now<=deadline。
- 三路径非空、Unicode 无损、无 NUL，保持原 Windows 字符与分隔符；本片不证明绝对路径、本地 NTFS、ACL、文件身份或安装安全。
- 数据合法不授予原 owner 权限，不产生 request/prepared/AUTH/terminal 记录，不允许新 Job 或 resume。下一片再连接原会话、安装租约和一次授权。

## Task 1：测试与真实 RED

- [x] 保存本计划和冻结合同；主执行者先新增 compile-compatible throw-only 两生产声明，不实现合法接受。
- [x] 测试作者实现五条测试/fixture 路径。共享 expected spec/向量独立于新 serializer；原 policy 使用现有函数。ordinary ProjectReference、net10/win-x64/self-contained/runtime/SDK 沿项目，无测试 hooks。
- [x] 覆盖源快照隔离、精确 shape/data 属性、policy/tile/jobId 冲突、数值/Unicode 边界、真实 TS→.NET、原 byte/SHA/Base64、重算正确 SHA 的 raw negatives、decoded duplicate 与不可变结果。
- [x] 固定七源码与旧来源摘要，完成源码格式/UTF-8/隐私/diff/索引和受影响 typecheck/build，restore 新 fixture 并分别 publish 普通与测试产物。
- [x] 先运行真实独立 fixture 正控；逐次证明原 child close、真实双 EOF、严格 UTF-8/exit0/无强制兜底。它不是 engine EOF，没有运行子引擎或访问 payload 路径。
- [x] 分别用 TS 合法正样本和独立 native 合法正样本证明 throw-only 缺失行为 RED；import/build/setup/传输/生命周期失败不算 RED。

```sh
pnpm --dir workers/image-enhancement typecheck
pnpm --dir workers/image-enhancement build
pnpm --dir workers/image-enhancement exec vitest run tests/windows-prepare-payload.test.ts -t "encodes the frozen claimed attempt" --reporter=verbose --silent=false
pnpm --dir workers/image-enhancement exec vitest run tests/windows-prepare-payload.os.test.ts -t "independent transport control" --reporter=verbose --silent=false
pnpm --dir workers/image-enhancement exec vitest run tests/windows-prepare-payload.os.test.ts -t "accepts an independent valid payload" --reporter=verbose --silent=false
```

实际 Windows 命令使用明确新发布路径的 fixture 环境变量 ZEB_WINDOWS_CONTRACT_FIXTURE_EXE、ZEB_RUN_WINDOWS_CONTRACT_OS=1。普通核心与 fixture 产物独立固定，原始运行地址只留私有记录。

## Task 2：生产实现与完整 GREEN

- [x] 健康正控与真实 RED 后，仅两生产作者各自实现一条新源文件；根代理核 READY 与摘要后冻结候选。
- [x] 重新完成受影响检查和两个 publish，先验相同正样本 GREEN，再完整运行两份新测试文件，无 filter/skip；向量数与 it 组数分别报告。
- [x] 核实际 DLL/source/log、逐次原 child 生命周期、普通 DLL 无测试 hooks；固定差异与回执的独立 Spec/Quality 复审通过，无遗留发现。

```sh
pnpm --dir workers/image-enhancement exec vitest run tests/windows-prepare-payload.test.ts tests/windows-prepare-payload.os.test.ts --no-file-parallelism --reporter=verbose --silent=false
```

有效替代 raw spelling 应保留各自原 bytes/SHA，不从重新序列化结果推断成功。负向语义测试更新相符 SHA，以证明确实触达 decoder 规则。

### 实际源码门与统计

固定七源码候选 Tree 为 `af866f509071749746ba62e03b9adc4774b659e0`。以下实际各轮分开登记，不叠加 focused/RED、旧 12/14/9/8 或业务/Worker 规格：

| 轮次                          | 实际结果                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 独立 BCL control              | 1 passed / 11 filtered，2.02 秒、exit 0、stderr 空，不调用生产 Parse                                          |
| TS 合法正样本行为 RED         | 1 failed / 11 filtered，1.68 秒、exit 1；throw-only serializer 的 configuration_invalid，import/build 健康    |
| native 独立合法正样本行为 RED | 1 failed / 11 filtered，2.18 秒、exit 1；健康 control 后 compiled stub 返回 accepted=false，原 child/传输健康 |
| 相同正样本 focused GREEN      | 3 passed / 21 filtered，3.54 秒、exit 0、stderr 空                                                            |
| 最终完整两文件                | **24/24 passed，77.33 秒，无 skip/filter、exit 0、stderr 空**；12 TS 组与 12 Windows 组                       |

完整轮有 365 条 TS 拒绝向量/9 次正调用，native 有 309 条拒绝向量/7 次正解析/1 control，共 317 次实际 original fixture child。全部回执 actual close(code0/signalnull)、双流真实 end、严格 UTF-8、stderr 空、无 forced/timeout/error；这是 fixture EOF，不是 engine EOF，程序无路径 I/O 或子引擎启动。本轮只验证健康收尾，不外推 hang/kill 故障注入已测。测试组、参数向量和进程调用分母不同，86 项业务与 24 项 Worker/部署规格数量及完成状态不因本片增加。

受影响 typecheck/build 各 exit 0、stdout 空，stderr 为正常 tsc 命令回显；新 fixture 初始 restore 与独立 ordinary/contract publish 各 exit 0，无警告/错误。最终 ordinary 与 fixture-loaded supervisor managed DLL 身份一致；实际普通 DLL inspect-core 和各 contract 调用均核无测试 hooks，不能仅凭稳定 apphost EXE 认定受测 managed DLL。固定七源码/实际证据独立复审为 Spec Compliant / Quality Approved、C/I/M=0/0/0。

## Task 3：SOP 与本地里程碑

实际 GREEN 与源码批准后，主 SOP、测试索引、Worker/安装规格、TODO/pending-test、README、CHANGELOG 与本计划按上述真实结果同步；无 DDL，不更新数据库或正式功能总览。文稿候选仍须由主执行者执行格式、严格 UTF-8/乱码、公开隐私、类型/链接检查并保存实际回执，再交独立文稿复审；源码批准不代作这些门。

中文本地提交必须基于最终检查通过且独立批准的树；HEAD/tree/clean/source hashes/CodeGraph 以主执行者 fresh Git 与执行回读为准，不以计划勾选自证。保留开发分支，不推送/PR/部署。

下一片仍需实际原会话 prepare/authorization/loss/terminal 接线、安装租约寿命、可信 reader/TS adapter、服务身份及完整 GPU Worker/API/ZEB；M1/schema5/增强关闭/readiness=false/worker 未部署/自动 OOM 降 tile 重试暂缓保持。此计划只登记已批准的数据合同与实际技术验证，不代作用户/部署验收、提交或完整 M2 完成证据。
