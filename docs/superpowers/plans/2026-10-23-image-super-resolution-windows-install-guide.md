# Windows 内网图像增强 Worker 安装与维护

适用于管理员维护的 Windows x64 GPU 电脑，默认通过内网 HTTP 和 API Token 接入。运行包自带 Node 和生产依赖；GPU 驱动、Upscayl 引擎及模型由目标机提供。M3 内网安装与实机阶段已经收口，安装包、来源材料及准确摘要见 [M3 交付清单](2026-10-23-image-super-resolution-m3-delivery.md)。

新候选使用普通 Windows 服务启动、进程与认证 HTTP 检查，不启用额外启动证明握手。服务固定为 `ZebImageEnhancement`，启动类型为自动。每次服务重新启动后，GPU 自检单独执行。

## 推荐：简化安装入口

使用配套 `ZEB-ImageEnhancement-Windows.zip`，解压后双击 `Install-ZEB.cmd`，确认自动检测的内网 IP／端口。入口自动查找 Upscayl、准备引擎清单与校验值、生成配置和 Token、创建目录并安装自动启动服务；重复运行不重新初始化。安装完成后通过 `Copy-Token.cmd` 复制密钥，再在管理员后台保存连接、检查连接／样图并启用。详细步骤和适用范围见[简化安装说明](../../../workers/image-enhancement/deployment/windows/INSTALL-WINDOWS-EASY.md)。

运行包字节保持不变，简化入口只准备输入并调用原安装器。后台开关、网络可达性和 GPU 自检仍需实际确认。其他目录已有服务、目标非空、引擎不匹配或维护结果未知时保留原状态，不自动覆盖。以下参数式操作继续用于升级、保留卸载和恢复。

## 模型发现与选择

安装时自动扫描 Upscayl `resources/models` 中完整的 `*-4x.bin` 与同名 `.param` 文件对，并注册为远程能力列表。后台填写地址和 Token 后可直接检查连接，自动保存当前修改并采用默认请求超时，随后从可搜索的“默认增强模型”下拉中选择并保存。列表只显示实际导入模型，不能仅凭磁盘存在文件宣称运行服务已加载。

已有安装新增模型时，双击同版整合包内的 `Refresh-Models.cmd`，也可先用 `Refresh-Models.ps1 -CheckOnly` 零写入预检查。模型变化后按既有维护流程等待任务收尾、备份、更新模型与配置并重启本服务；保留原 Token、身份和持久任务，未变化时不重启。已导入模型的原文件缺失时明确拒绝，不隐式删除或重新初始化；维护结果不明时保留现场先查记录。

固定样图用于当前启动实例的 GPU 校准，业务任务独立冻结管理员所选模型。样图仍校验其实际注册模型、版本、摘要及执行参数，不要求与业务模型同名；检查结束再次确认两者未变化。选择其他模型不重复触发本轮已合格的校准。升级或模型刷新后的新启动实例仍需一次自检。

## 参数式安装前准备

用管理员身份打开 64 位 Windows PowerShell 5.1，解压完整运行包，并准备：

- 程序目录、数据目录、备份目录，三者互不覆盖。
- 本机监听 IP 与端口。
- `engine-import.json`：所用 Upscayl 引擎及模型的本机路径、目标相对路径、长度和摘要。
- 同版配置模板：`port`、HTTP `host`、`selfTestModelId`、`workerConfig`、`submissionLimits`、`runnerLimits`、`transportLimits`、`execution`。安装器会填入服务身份和数据目录等运行字段，不要直接使用安装后的配置作为首次安装输入。
- 一个尚不存在的凭据文件路径，供安装器保存 API Token。后续维护继续使用该文件，不要把 Token 写进命令、日志或截图。

HTTP 不需要 PFX，也不需要安装证书。已支持的 HTTPS 部署仍可使用，不影响上述默认方式。

## 首次安装

以下路径和摘要均为占位符，需按实际材料填写：

```powershell
.\deployment\windows\Install-Worker.ps1 -Action Install `
  -PayloadRoot '<运行包解压目录>' `
  -ExpectedInventorySha256 '<package.inventory.json 的 SHA256>' `
  -ProgramRoot '<程序目录>' -DataRoot '<数据目录>' `
  -EngineImportManifest '<engine-import.json 路径>' `
  -ExpectedEngineImportSha256 '<engine-import.json 的 SHA256>' `
  -ConfigFile '<首次安装配置 JSON 路径>' `
  -CredentialFile '<新凭据文件路径>' `
  -TimeoutSeconds '180'
```

安装器创建服务、保存配置和任务数据，并设置自动启动。进程退出 0、返回 `worker_operation_complete` / `outcome=known` 表示本次安装完成。安装记录位于 `<数据目录>\installation\receipt.json`。

服务能响应 HTTP 与 GPU 能接单是两项检查。使用凭据文件中的 Token 调用一次 `POST /v1/self-test`，通过 `GET /v1/self-test` 查询；当前启动实例达到 `qualification=qualified` 后，再确认 `GET /v1/capabilities` 为 `ready=true`。不要重复提交同一启动实例的自检。

## 升级与恢复

升级先关闭新任务入口，等待正在执行的任务收尾，保留队列中的任务，再生成完整健康备份并切换版本：

```powershell
.\deployment\windows\Install-Worker.ps1 -Action Upgrade `
  -PayloadRoot '<新运行包解压目录>' `
  -ExpectedInventorySha256 '<新清单 SHA256>' `
  -Receipt '<原 receipt.json 路径>' `
  -BackupRoot '<新备份目录>' `
  -CredentialFile '<已有凭据文件路径>' `
  -TimeoutSeconds '180'
```

`worker_not_quiescent` 表示维护已受理、旧任务尚未结束。保留同一动作和目标，稍后查询或继续该次维护，不要更换目标或重复提交图像任务。

升级启动失败时，按 [五参数恢复说明](2026-10-23-image-super-resolution-explicit-recovery.md) 恢复健康旧版本。恢复会保留失败数据与健康备份；当前完整数据和备份不一致时拒绝覆盖。正常主动回退可使用 `-Action Rollback`，提供原 `Receipt`、所选 `BackupReceipt`、`CredentialFile` 和 `TimeoutSeconds`。

## 卸载与保留重装

默认卸载保留任务、图片、配置、引擎和凭据：

```powershell
.\deployment\windows\Remove-Worker.ps1 -Action Uninstall `
  -Receipt '<receipt.json 路径>' `
  -CredentialFile '<已有凭据文件路径>' `
  -TimeoutSeconds '180'
```

保留数据重装使用 `Install-Worker.ps1 -Action Install`，提供新包及摘要、原 `Receipt`、原 `CredentialFile` 和期限；不再指定新数据目录、配置或引擎，不重新初始化数据库。

彻底删除数据是单独的 `Remove-Worker.ps1 -Action DeleteData` 操作，仅在保留卸载完成后使用，并显式提供 `Receipt`、`ExpectedDataRoot` 和期限。它会删除该安装拥有的数据；请先确认备份。普通卸载不会自动执行它。

## 定位错误

普通安装维护在取得本次操作记录后发生失败，会在 `<程序目录>\installation-diagnostics\operation-<操作ID>-error.json` 保存操作阶段、异常类型和 Windows 数值错误码，不写异常文本或凭据。日志独立于业务数据，恢复、保留卸载和显式删数据后仍可查阅。参数或包等前置检查拒绝时，直接查看命令返回错误，不保证创建该文件。恢复另保留 `recovery-receipt.json` 和原失败归档。

认证 `GET /v1/maintenance` 用于观察队列、执行和恢复状态；生成准备失败还可查看 `runtime.adapter.prepareDiagnostic`。`runtime.startupRecovery=settled` 表示启动恢复阶段已收敛，仍须单独查询原任务终态和执行槽、引用是否空闲，不能直接当作全部任务完成。遇到未知结果先看服务与记录，保留现场，不要删库、重新初始化或盲目重复上次写操作。
