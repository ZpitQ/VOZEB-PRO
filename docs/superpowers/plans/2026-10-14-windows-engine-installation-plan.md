# Windows 引擎安装绑定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为预先配置的 Windows 安装建立只读租约，将声明的 CLI 载荷与所选模型绑定到冻结的 `EngineSelection`，生成唯一固定参数配方。

**Architecture:** 外部预批准的原始安装清单 SHA256 是信任入口；逐层核验实际文件对象并保留严格只读 pins，再核对清单、CLI 和所选模型对。`TrustedInstallation` 只返回配置事实，租约由未来调用方持有到实际引擎树生命周期结束；本片不启动进程。

**Tech Stack:** C# / .NET 10、BCL `System.Text.Json`、严格 UTF-8、流式 SHA256、Windows 文件/安全句柄；TypeScript / Vitest。

## Global Constraints

- 本片名为 **B4-B2-1 安装绑定**，与已验 M2-B2 HTTP 切分分开记载；继承[主 SOP](2026-10-10-image-super-resolution-integration-plan.md)及[Worker/安装规格](2026-10-11-image-super-resolution-tests-worker-packaging.md)。当前完整八组技术验证、固定 native/fixture 源码及最终整体代码/证据独立复审已通过；最终文稿交付检查、本地提交另列，不由代码审查代替。
- 代码仅新增下表四条路径。既有 native 项目自动包含 `.cs`，不得修改项目、Job/control/journal 源码、业务 TypeScript、依赖或数据库。
- 安装必须预先存在，为当前 SID 独占保护的本地 fixed NTFS 普通目录；不得修复 ACL、复制载荷或创建安装器。不得启动 CLI、GPU、Job、shell 或服务。
- Fixture 使用 `WinExe`、`net10.0`、runtime `10.0.12`、`win-x64`、self-contained；普通 `ProjectReference` 必须为 `ZebNativeTestBuild=false`。Node.js 22 / pnpm 11.9.0 沿用现有包。
- M1 用户验收、schema 5、自动 OOM tile 重试暂缓、增强关闭及 `readiness=false` 保持；本片不增加业务规格或 Worker/部署规格通过数。
- 主执行者独占上传、格式化、构建、实测、索引同步和最终本地提交；子任务只编辑分配路径。不得 push、创建 PR 或部署；原始环境及执行回执只保留私有记录。

| 新增公开路径                                                                                      | 责任                                                       |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `workers/image-enhancement/native/windows-supervisor/TrustedInstallation.cs`                      | 下述公共 API、严格解析、实际对象绑定、持有 pins、固定 argv |
| `workers/image-enhancement/native/windows-installation-fixture/Program.cs`                        | 独立受保护测试包、真实 Windows 探针、场景回执              |
| `workers/image-enhancement/native/windows-installation-fixture/WindowsInstallationFixture.csproj` | 引用普通 native 程序集的独立 fixture                       |
| `workers/image-enhancement/tests/windows-installation.os.test.ts`                                 | 恰好 T0–T7 八组测试、单个原始 child 生命周期与精确清理     |

## 冻结合同

`TrustedInstallation.cs` 使用命名空间 `Zeb.WindowsSupervisor`。主执行者在 RED 前只能创建以下完整 throw-only 脚手架；测试作者不得把它改成成功实现。

```csharp
using System;
using System.Collections.Generic;

namespace Zeb.WindowsSupervisor;

public sealed record EngineSelection(string ModelId, string BinaryVersion,
    string BinarySha256, string ModelVersion, string ModelSha256,
    long NativeScale, long Tile, bool Tta, long GpuId);

public sealed record ResolvedEngineLaunch(string RecipeId,
    string InstallationManifestSha256, string ExecutablePath,
    string ModelDirectory, string ModelName);

public sealed record InstallationDiagnostic(string Stage, int? NativeError);

public sealed class InstallationException : Exception
{
    public InstallationDiagnostic Diagnostic { get; }
    public InstallationException(string stage, int? nativeError = null)
        : base("installation_invalid") => Diagnostic = new(stage, nativeError);
}

public sealed class TrustedInstallation : IDisposable
{
    private TrustedInstallation() { }
    public static TrustedInstallation Open(string installationRoot,
        string expectedManifestSha256, EngineSelection engine)
        => throw new InstallationException("installation_not_implemented");
    public ResolvedEngineLaunch Launch
        => throw new InstallationException("installation_not_implemented");
    public IReadOnlyList<string> CreateArguments(string inputPath, string outputPath)
        => throw new InstallationException("installation_not_implemented");
    public void Dispose()
        => throw new InstallationException("installation_not_implemented");
}
```

最终 API 的非法值在任何文件 I/O 前抛出无路径/内容的通用 `ArgumentException`；真实安装证据失败抛出 `InstallationException`，消息固定为 `installation_invalid`，诊断仅有稳定 stage 和可选 native error。`Dispose` 幂等，已释放对象的 `CreateArguments` 抛 `ObjectDisposedException`。返回的 launch、参数与选择快照不可被调用方改变。

### 清单、选择和摘要

固定入口为 `installation-manifest.json`。所有固定对象严格拒绝重复、未知或缺失键、错误类型、非法 UTF-8、尾随/不完整/非对象 JSON，使用成熟 BCL 解析器。字段集合如下，不能添加自定义模板或下载位置。

| 对象                        | 恰好允许的键及值约束                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 安装清单                    | `v=1`、`platform="win-x64"`、`recipeId="upscayl-4x-png-v1"`、`binaryVersion`、`entryPoint`、非空 `files`、非空 `models`         |
| 每个载荷条目                | `path`、`length`、`sha256`；声明全部引擎载荷/依赖，entryPoint 必须恰好命中一个条目                                              |
| 每个模型目录条目            | `modelId`、`modelVersion`、`modelDirectory`、`modelName`、`modelSetSha256`；modelId 按 ordinal 唯一，声明路径按大小写不敏感唯一 |
| 所选目录的 `model-set.json` | `v=1`、`modelName`、`files`；文件条目的键仍恰好为 `path`、`length`、`sha256`                                                    |

清单布局示例使用 `entryPoint="bin/upscayl-bin.exe"` 和 `modelDirectory="models/<modelId>"`；实际位置来自已批准清单中的规范相对路径。`modelName` 为安全的单文件 stem；此 ncnn 配方的文件集合恰好是 `modelName.bin`、`modelName.param`，各一次，顺序可交换。`length` 为实际长度的规范无符号十进制字符串；摘要均为 64 位小写十六进制。

外部 `expectedManifestSha256` 必须匹配安装清单**原始字节**，不得从同一清单取值后自行信任。entryPoint 的实际 SHA256 / 清单 binaryVersion 必须匹配冻结 `BinarySha256` / `BinaryVersion`。`ModelSha256` 在本片新冻结为所选 `model-set.json` **原始字节**的 SHA256，必须同时匹配目录条目的 `modelSetSha256` 及冻结选择；实际 `.bin/.param` 长度和 SHA256 仍独立核对。catalog 的 modelVersion 必须匹配 `ModelVersion`。不重排、重序列化或规范化后再哈希，不增加迁移或 schema 版本。

`ModelId` 沿用 `config.ts` 的 `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`；版本非空、JS `trim` 不变且无 U+0000–001F/U+007F。native 接受冻结后的小写摘要；现有 TypeScript 输入的大写摘要归一行为保持。`NativeScale=4`、`Tta=false`；Tile 是 0 或至少 32 的非负 JS safe integer，GpuId 为非负 JS safe integer。不得改选模型、使用默认 tile 或推断 GPU 能力；未选模型只验证目录元数据，不打开/哈希其字节。

相对路径只接受规范 `/` 分隔组件；拒绝绝对、UNC/device、反斜杠、冒号/ADS、`.`/`..`、空组件、尾点/空格、Windows 保留设备 basename（含扩展名）及非法文件名字符。固定 leaf/stem 还拒绝分隔符和 JS 边界空白。拒绝大小写冲突与 hardlink 别名；单一已批准路径的合法大小写拼写应以实际对象身份正向验证，不等同于重复声明同一文件。不附加任意文件数/字节/像素上限、重试或 fallback。

### 实际文件对象与租约

先验证 root、各所选文件的父目录链、普通文件及 GUID volume 的真实关系：本地 fixed NTFS、无 reparse、同卷、普通单 link、非 delete-pending、非继承句柄；目录和文件均为当前 SID owner、protected present DACL、恰好一个非继承 Allow `FILE_ALL_ACCESS` ACE。root 必须是实际 read pin，不能以 metadata-only pin、路径或 FileId 字符串代替保护。

保留安装清单、全部声明引擎文件、所选 model-set 和模型对的严格 read/shareREAD 文件句柄及目录 pins。原始 JSON 和流式 SHA256 均读取这些同一 retained 对象；返回前核完身份、长度、摘要与关系。原始字节、名称、创建时间及最后写入时间不变；只读访问可能更新系统管理的最后访问时间，不对此作不变性承诺，也不修改文件系统策略或恢复时间戳。任一失败按获取逆序释放全部句柄。可以只读复用现有 `JournalNativeMethods` / `JournalRoot` 实际接口；若不足，停止并报告缺失接口，不修改 journal 或放宽 sharing。

这只验证声明载荷和当前 SID 应用约束；完整包依赖、真实 DLL/self-helper 加载、安装器、服务身份、敌对同 SID/WORM/断电保护分别留后续验收。

### 唯一参数配方

input/output 必须为非空、无 NUL 的 fully-qualified 本地 Windows 路径；Unicode、空格和其他合法字符按字面保留。`CreateArguments` 返回只读数组，十进制数字用 invariant culture：

```text
-i inputPath -o outputPath -m Launch.ModelDirectory -n Launch.ModelName -z 4 -t EngineSelection.Tile -f png -g EngineSelection.GpuId
```

不提供 shell、任意 argv/template、TTA、target size、二次 4× 或执行入口。

## Task 1：独立 fixture 与真正行为 RED

**Files:** 主执行者创建上述 scaffold；测试作者只创建下表后三条 fixture/test 路径。

**Interfaces:** 消费冻结公共 API；产生 T0–T7 的真实 Windows 场景、原始 child close/双流 EOF 及清理回执。fixture 不调用生产验证 helper。

- [x] 创建 fixture 项目，以下为完整项目内容；生产程序集保持 ordinary surface。

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RuntimeFrameworkVersion>10.0.12</RuntimeFrameworkVersion>
    <RuntimeIdentifier>win-x64</RuntimeIdentifier>
    <SelfContained>true</SelfContained>
    <UseAppHost>true</UseAppHost>
    <PublishSingleFile>false</PublishSingleFile>
    <PublishTrimmed>false</PublishTrimmed>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <DefaultItemExcludes>$(DefaultItemExcludes);bin/**;obj/**;bin-test/**;obj-test/**</DefaultItemExcludes>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../windows-supervisor/WindowsSupervisor.csproj" AdditionalProperties="ZebNativeTestBuild=false" />
  </ItemGroup>
</Project>
```

- [x] 在 `Program.cs` 独立建立 fresh protected bundle，使用实际 kernel32/FileId/security/sharing 和原始 SHA256 探针。每个 mutation variant 使用新 bundle；可用 inert 载荷，任何场景均不启动引擎/子进程/Job/shell。反射 ordinary assembly，验证测试 hook 未引入。
- [x] 在 TS 中仅拥有这一个 original fixture child，持续严格 UTF-8 消费 stdout/stderr。执行与清理预算分别直接使用现有 `runnerLimits.executionTimeoutMs=60_000`、`cancelGraceMs=5_000`；实际 child close 后才精确清理本次 temp。清理未证明时保留证据；不得 sleep、retry、扫描旧 publish 或按进程名清理。
- [x] 为八组测试分别使用 `T0 ` 至 `T7 ` 名称前缀；以下表逐项实现，不能用 production helper、假 OS 成功、mock 文件属性或只有静态检查替代真实观察。

| 组  | 明确断言与独立观察                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0  | throw-only scaffold 下独立 protected bundle、UTF-8、raw hash、FileId/sharing 正控与 ordinary surface 成立；setup、原始 close、双流 EOF、精确 cleanup 健康                                            |
| T1  | 真正调用 `Open`；Unicode/空格路径、全部 selected pins/身份/摘要及唯一 frozen argv 正确。scaffold 只能因 expected opened=true / actual=false 且 stage=`installation_not_implemented` 失败             |
| T2  | 错误外部摘要、非法 UTF-8/JSON、重复/未知/缺失键、缺 entryPoint、大小写冲突及非规范 length 均拒绝；原件未改变、无 leaked pins                                                                         |
| T3  | 每个冻结 binary/model version/hash/id、nativeScale/TTA/tile/gpu 非法值；实际 CLI/依赖/model-set/模型对变化、缺失或截断；modelName/模型对错配均拒绝。需要深入内部边界的清单变体先独立冻结其新外部摘要 |
| T4  | 实际 root/parent/file extra ACE、文件换目录、hardlink、root/parent reparse，以及路径别名、dotdot、ADS、device/absolute 均拒绝；独立探针先证明各 mutation 已到达目标边界                              |
| T5  | leased 期间每个 retained selected file 及 root/parent 的实际 write/delete/rename 被拒绝，bytes/FileId/time 不变；双 Dispose 安全，释放后自己的 selected payload 可写，CreateArguments 拒绝已释放对象 |
| T6  | 第二个合法 catalog 元数据可不具备模型字节，所选模型仍成功；无 fallback，错误 selected model 拒绝。调用方数组/catalog 变更不改变快照；不同合法 JSON 字节顺序按各自 raw digest 保留                    |
| T7  | 在早期 pins 取得后的 selected pair hash 晚失败释放全部句柄，独立写/rename 全部原文件/目录成功；不对未返回对象调用 Dispose。非法 API 值先拒绝且无文件副作用；修正测试包后为新独立 Open，不是执行重试  |

下面给出可直接放入 fixture 的完整 T1 观察/配方断言示例。调用方将已由独立探针构造并验证的 bundle、外部摘要、冻结选择及字面 input/output 传入；`verifyHeld` 在租约仍存活时核对真实 pins。setup/cleanup 错误独立上报，不能变成业务 RED。

```csharp
using System;
using System.Globalization;
using System.Linq;
using System.Text.Json.Serialization;
using Zeb.WindowsSupervisor;

internal sealed record OpenProbe(
    [property: JsonPropertyName("opened")] bool Opened,
    [property: JsonPropertyName("stage")] string? Stage);

internal static class InstallationProbe
{
    internal static OpenProbe Observe(string root, string manifestSha256,
        EngineSelection engine, string inputPath, string outputPath,
        Action<TrustedInstallation> verifyHeld)
    {
        try
        {
            using var lease = TrustedInstallation.Open(root, manifestSha256, engine);
            string[] expected = ["-i", inputPath, "-o", outputPath,
                "-m", lease.Launch.ModelDirectory, "-n", lease.Launch.ModelName,
                "-z", "4", "-t", engine.Tile.ToString(CultureInfo.InvariantCulture),
                "-f", "png", "-g", engine.GpuId.ToString(CultureInfo.InvariantCulture)];
            if (!lease.CreateArguments(inputPath, outputPath).SequenceEqual(expected))
                throw new InvalidOperationException("recipe_mismatch");
            verifyHeld(lease);
            return new(true, null);
        }
        catch (InstallationException error)
        {
            return new(false, error.Diagnostic.Stage);
        }
    }
}
```

TS 对 fixture 实际 JSON 解码所得 `OpenProbe` 保留以下断言，不能将 stage 为 `installation_not_implemented` 当成功：

```typescript
import { expect } from "vitest";

export function assertOpened(probe: { opened: boolean; stage: string | null }) {
  expect(probe.opened).toBe(true);
  expect(probe.stage).toBeNull();
}
```

- [x] 测试作者完成静态自查后报告 READY/STOP；主执行者冻结四源码，完成严格 UTF-8/隐私/格式/差异检查、incremental CodeGraph 与普通/fixture publish、TS typecheck/build。以下命令从仓库根执行；主执行者在执行前补齐并核对实际 fixture 环境变量名及候选专用显式发布输出路径，禁止依赖默认目录发现产物，真实位置只留私有回执。

```sh
dotnet publish workers/image-enhancement/native/windows-supervisor/WindowsSupervisor.csproj -c Release -p:ZebNativeTestBuild=false
dotnet publish workers/image-enhancement/native/windows-installation-fixture/WindowsInstallationFixture.csproj -c Release
pnpm --dir workers/image-enhancement typecheck
pnpm --dir workers/image-enhancement build
pnpm --dir workers/image-enhancement exec vitest run tests/windows-installation.os.test.ts -t "T0 " --reporter=verbose --silent=false
pnpm --dir workers/image-enhancement exec vitest run tests/windows-installation.os.test.ts -t "T1 " --reporter=verbose --silent=false
```

预期顺序是先 T0 正向健康，再 T1 的实际行为 RED；编译、导入、setup、超时或 cleanup 错误均不满足 RED。记录同候选的实际源码/DLL 身份、日志与 receipt；两次 focused 运行分别记载，不合成完整八组轮次。

独立 T0 正控为 1 passed/7 filtered、2.51 秒；随后脚手架 T1 为真实行为 RED，1 failed/7 filtered、1.88 秒，仅 `installation_not_implemented`，setup 与清理健康。实现后 focused T1 为 1 passed/7 filtered、2.27 秒，修正后的 focused T6 为 1 passed/7 filtered、3.30 秒；单一合法大小写拼写正向验证，真正重复声明仍负向拒绝。首次完整轮保留为 7/8、54.33 秒、exit 1，T4 在独立夹具创建目录链接时被拒，未进入该项生产校验。安全软件拦截经用户确认并授权信任后，不变源码/DLL 的 focused T4 为 1 passed/7 filtered、11.71 秒，28 个实际负向变体全部完成；无原生缺陷修复、跳过、断言放宽或预算调整，旧失败轮不追认为通过。

## Task 2：验证并持有实际安装，取得 GREEN

**Files:** 原生实现作者仅修改 `workers/image-enhancement/native/windows-supervisor/TrustedInstallation.cs`。

**Interfaces:** 消费独立 T0/T1 真实回执与冻结 API；产生符合上述合同的只读租约及固定配方。

- [x] 主执行者核对健康 T0 和 T1 真 RED 后才授权原生作者实现；此前原生作者只读。先完成所有 API 参数的无 I/O 校验，再快照选择；只使用已有 proven 文件接口。
- [x] 按 root/父链 → 安装清单 pin/raw digest/严格 JSON → 全声明 engine pins/流式摘要 → selected catalog → selected model-set pin/raw digest/严格 JSON → pair pins/流式摘要的顺序建立关系。保持全部 pins 到 Dispose，失败逆序释放，错误固定脱敏；缺少所需内部接口即 STOP 并指出具体缺口。
- [x] 返回冻结 `Launch`，由 retained 选择生成只读固定 argv；实现幂等 Dispose 和 disposed 参数调用拒绝。禁止在此接入 Job prepare/authorize、wire/session 或业务 store。
- [x] 主执行者重新冻结上传、源码/DLL 摘要及发布产物，完成同样 typecheck/build，再先运行 focused T1，之后运行本片完整八组：

```sh
pnpm --dir workers/image-enhancement exec vitest run tests/windows-installation.os.test.ts -t "T1 " --reporter=verbose --silent=false
pnpm --dir workers/image-enhancement exec vitest run tests/windows-installation.os.test.ts --reporter=verbose --silent=false
```

最终同一不变候选完整轮次为 **T0–T7 恰好 8/8 passed，24.90 秒，无 skip/filter、exit 0、stderr 空**。八份实际 receipt 与对应 lifetime 一致，setup/scenario 无失败，原 child 实际 close、双 EOF、无强杀/活 pins/清理失败、每次精确目录删除一次；普通程序集无测试 hook。T1 的模型名/配方/倍率/格式由独立固定事实核对，T4 实际 root/parent junction 先证明 reparse 再拒绝，T6 合法大小写路径的十对象持有/释放真实证明均成立。条件 wrong-SID/remote/非 NTFS/other-volume 未执行并放在八组分母之外；旧 Job/control/journal/GPU 套件不重复或累加。

- [x] 对精确候选分别进行独立 native 与 fixture Spec/Quality 复审；只修已证实发现，修改后重跑受影响范围，最终完整八组必须对应同一不变候选。固定 native 与 fixture 源码均 Spec compliant / Quality Approved、C/I/M=0/0/0，最终四源码/八组证据整体独立复审同样通过、C/I/M=0/0/0；不得把普通文件绑定或 inert 载荷实测表述成真实 CLI/GPU 验收。

## Task 3：最小文档同步与本地里程碑

**Files:** 此计划及既有主 SOP、测试索引、Worker/安装规格、`todo.mdx`、`pending-test.mdx`、Worker README、CHANGELOG、backend-database 的增强相关段落。

**Interfaces:** 仅消费最终实际源码/DLL 身份、逐轮 receipt、清理事实与独立复审结论；不创造测试或部署结果。

- [x] 主 SOP 追加 B4-B2-1 的四源码、raw manifest/model-set 摘要定义、实际 lease 范围和本片分轮证据；索引登记 T0–T7 为技术组，不提高 86 项业务或 24 项 Worker/部署规格通过数。
- [x] Worker/安装规格只补 SR-M2-14 的声明载荷/所选模型绑定接缝；保留真实 loader/helper 包完整性、安装器/ACL 配置、服务身份及实际 GPU 全链路待验。
- [x] todo 仅移出已验证的绑定原语，pending-test 新增有界可测结果及未验项；README 用简洁能力边界加计划入口，CHANGELOG Unreleased 用版本级一条归纳。backend-database 只说明没有表/字段/迁移/schema 变化与 store 尚未消费；不添加数据库实现。
- [x] 此计划只勾选有回执证明的步骤；严格 UTF-8、隐私与链接检查及独立文稿复审已执行，最终文字增量纳入提交前复核。中文本地提交以 Git 历史记录为准。M1、增强关闭、readiness=false、OOM 重试暂缓及所有后续未验边界仍按真实状态记录。

后续独立 B2 切分继续处理 Job ACL、engine prepare/authorize、authorization/controllerLoss/terminal、session/wire、可信 reader 与 TS adapter；不得暴露可指定任意 executable/args 的独立 bootstrap。成功传输/receipt/清理、实际后台身份、安装/TLS、完整 Worker/GPU/API/ZEB 仍逐项验收。
