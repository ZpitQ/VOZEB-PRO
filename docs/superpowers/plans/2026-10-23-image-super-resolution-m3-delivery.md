# M3 Windows 内网部署交付

M3 的内网 Windows 安装、实际服务 GPU、恢复维护及安装材料交付已完成。适用场景是管理员维护、常在线的 GPU 机器，使用 HTTP＋Token 与普通 Windows 服务；用户最终使用验收单独登记，不表示已完成 M4 后台接线或全部高清增强 SOP。

## 安装材料

本次工作区交付目录为 `artifacts/image-enhancement-worker-m3-windows`。包含运行 ZIP、257 份项目源码、386 份第三方来源归档及原通知、两份补充 Sharp 构建输入、完整配置／引擎导入示例、安装维护说明与 SHA256SUMS。

| 材料 | 文件或摘要 |
| --- | --- |
| 安装包 | `image-enhancement-worker-candidate.zip` |
| 安装包 SHA-256 | `1a7ce8a44ce1b1342a3280c20442d75f868512a9ce5a18d4f7c72ac5ac3f1386` |
| 安装器所需 inventory SHA-256 | `5027bdd4a89917b28b1839a3d0cc1a13edcf1ede7784a3364a6f845364229a1a` |
| 项目源码 | `vozeb-worker-source-snapshot-m3-candidate-v13.zip` |
| 第三方来源 | `vozeb-worker-source-materials-v1.zip`、`SOURCE-INDEX-v2.json` |
| 补充构建输入 | `sharp-build-inputs-1.3.4.zip` |
| 当前关联／状态 | `RELEASE-BINDING.json`、`SOURCE-DELIVERY.json` |
| 操作说明 | `INSTALL-WINDOWS-CURRENT.md`、`LIBRARY-AND-SOURCES.md` |

运行包文件名和内部版本 `m3-candidate-v13` 保留原实测身份，交付集合版本为 `m3-windows-internal-v1`。没有为改名称重编译或改动运行字节；两项最终交付标记在新外层清单为 true，历史候选清单和来源附件中的 false 原字节保留，不改写旧证据。

目标机仍须备齐匹配的 GPU 驱动、Upscayl CLI／DLL／模型及本机配置。HTTP 不要求证书。每个新服务实例只执行一次 GPU 自检；安装成功和 `ready=true` 分开检查。正常卸载保留数据，DeleteData 需明确准确目标。

## M3 逐项收口

| 用例 | 当前判定与证据范围 |
| --- | --- |
| SR-M3-01 | 按用户决定移出本期；没有把未执行的干净机离线安装计为通过。 |
| SR-M3-02 | 已通过真实 Windows 服务账户／Session0／Auto、后台调用与完整图像验收；1254×1254 输入经真实 GPU 得到 5016×5016 PNG。 |
| SR-M3-03 | Windows 实际重启后的已有任务、配置和结果保持；独立服务另验排队任务与运行中任务恢复，沿用任务、首次执行时间及原截止，没有重建生图。没有外推为突然断电或强制杀机恢复。 |
| SR-M3-04 | 真实接口拒绝、上传超时、下载中断与执行期间调用方响应断连及同任务恢复分轮通过。响应断连没有被称为切断引擎网络。常在线部署不纳入睡眠／注销／整机断网。 |
| SR-M3-05 | 标准升级、完整健康备份、包损坏拒绝、只读不兼容数据拒绝、一次升级启动失败后的直接恢复及显式回退均有实际或对应隔离证据；不声称支持任意 schema 自动迁移。 |
| SR-M3-06 | 忙时卸载先拒绝，任务排空后同一操作完成；保留重装沿用身份和任务；独立 retained 副本 DeleteData 保持原安装。没有全局结束 Upscayl 或删除用户外部目录。 |
| SR-M3-07 | 包／权重／配置／端口的既有预检、原生准备诊断、Token 与失败日志保留；已取消扩展权限兼容、系统 SID 证明、历史 caller 追认及额外启动握手。HTTP 部署不将 TLS 作为门槛。 |
| SR-M3-08 | 本期未选择 Linux，登记不适用。 |

完整功能边界见 [M3 实机验收](2026-10-23-image-super-resolution-m3-acceptance.md)。最终重装样本保留 25 个任务和 157 份原始记录；大快照回传失败的原轮继续 Unknown，维护完成由独立读取的原落盘结果证明，未重放操作。

## 来源材料交付

原始来源附件及当前三份 Sharp native 文件的长度／摘要绑定保持，补齐同一上游 commit 的 `@img/sharp-libvips-dev` 与 `@img/sharp-libvips-win32-x64` 1.3.4 原始归档，按发布 SRI 校验，保留头文件、GLib 配置、导入库与构建元数据。

共享库替换在独立副本验证：修改 DLL 字符串后原清单拒绝，部署者更新清单后原包校验器通过全部 1037 文件；实际调用修改库取得测试字符串，包内 Node／Sharp 的 PNG 编码、解码及逐像素检查通过。它仅验证兼容修改库加载与清单重新批准，不是源码重建或图像算法／GPU 验收。首次探针的错误返回值断言及首次清单装配的许可路径误判保留为失败轮；后续分别更正测试契约及运行包／源码附件位置映射。

历史 MXE commit、OCI digest、实际编译来源继续 Unknown；librsvg 官方 Git 源替代不改称原 release-tar 字节。内部材料交付完成不等于逐位重建、法律审核或公网分发批准。运行服务和原始安装包未因上述检查被修改。

## 下一阶段

M4 才接入 ZEB 管理员增强开关、远程地址／Token 配置、后端就绪检测与普通生图自动增强／失败原图回退。M3 不提前开启业务增强，不需要重新运行未失效 GPU／安装矩阵，也不创建 PR 或发布生产。
