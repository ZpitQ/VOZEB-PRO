# M3 内网 HTTP 安装与维护

## 决定

内部服务调用使用 HTTP，不要求 PFX、证书签发或客户端信任导入。API Token 鉴权、任务归属、预算、原实例核验及 Unknown 收口继续沿用。HTTPS 保留兼容；不自动切换协议或重发维护写请求。此决定替代旧 M3 文档中强制 HTTPS 的安装前置。

## 配置合同

- HTTP：配置材料使用具体本机数值 `host`、非零 `port`，不传 `tls` 或 `TlsPfx`。
- HTTPS：继续使用 `tls: { host }` 和 `TlsPfx`；安装器填入 `pfxPath`。两种传输互斥。
- 程序化调用省略 host/tls 时保留旧回环兼容；正式安装要求显式传输。监听器未传 host 时保持 127.0.0.1。
- HTTP 的安装及备份记录保留 `tlsSha256` 字段并明确为 null；空 `tls/` 目录保留，无占位 PFX。
- 维护请求绑定原实例的 scheme/host/port；代际协议改变直接拒绝。实际 API 的 `code/data/msg` envelope 必须验证后再取 bootId，不接受裸 snapshot 或错误 code。

## 验证与交付

先验证显式 IP 的 HTTP 监听和未认证 401/认证成功，再检查无 PFX 安装、保留卸载重装及凭据不变。真实编译入口分别覆盖 HTTP/HTTPS；备份回退分别覆盖空 TLS hash 和原 HTTPS hash，数据/ACL/稳定身份与原备份不变。错误 envelope 必须只发送一次维护请求并停止后续步骤。

旧 TLS 候选包不可直接用作 HTTP 新版本；重新构建、固定清单与源码配对后才能开展真实固定服务安装。SCM 身份、Session0/GPU、固定 F01 及系统生命周期逐项验收；专项测试不代表 M3 全部完成。当前仍属开发验收阶段。
