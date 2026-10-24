"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Card, Form, Input, InputNumber, Select, Space, Switch, Tag, Typography } from "antd";
import type { ImageEnhancementSettings, ImageEnhancementUpdate } from "@/lib/image-enhancement-contract";
import { DEFAULT_ENHANCEMENT_TIMEOUT_MS, ENHANCEMENT_REASONS } from "@/lib/image-enhancement-contract";
import { checkImageEnhancementSettings, getImageEnhancementSettings, saveImageEnhancementSettings } from "@/services/api/image-enhancement";

export function AdminImageEnhancement() {
    const { message, modal } = App.useApp();
    const [form] = Form.useForm<ImageEnhancementUpdate>();
    const trust = Form.useWatch("trust", form);
    const endpoint = Form.useWatch("endpoint", form);
    const token = Form.useWatch("token", form);
    const [settings, setSettings] = useState<ImageEnhancementSettings | null>(null);
    const [busy, setBusy] = useState(true);
    const [dirty, setDirty] = useState(false);
    const [error, setError] = useState("");
    const pending = useRef(false);
    useEffect(() => {
        let active = true;
        getImageEnhancementSettings()
            .then((data) => {
                if (!active) return;
                setSettings(data);
                form.setFieldsValue({ endpoint: data.endpoint, trust: data.trust, timeoutMs: data.timeoutMs ?? DEFAULT_ENHANCEMENT_TIMEOUT_MS, modelId: data.modelId });
            })
            .catch((failure) => {
                if (active) setError(failure instanceof Error ? failure.message : "配置读取失败");
            })
            .finally(() => {
                if (active) setBusy(false);
            });
        return () => {
            active = false;
        };
    }, [form]);

    async function run(operation: () => Promise<ImageEnhancementSettings>) {
        if (pending.current) return;
        pending.current = true;
        setBusy(true);
        setError("");
        try {
            const data = await operation();
            setSettings(data);
            form.setFieldsValue({ endpoint: data.endpoint, trust: data.trust, timeoutMs: data.timeoutMs ?? DEFAULT_ENHANCEMENT_TIMEOUT_MS, modelId: data.modelId, token: "", caPem: "" });
            setDirty(false);
        } catch (failure) {
            if (!(failure && typeof failure === "object" && "errorFields" in failure)) {
                const text = failure instanceof Error ? failure.message : "配置操作失败";
                setError(text);
                void message.error(text);
            }
        } finally {
            pending.current = false;
            setBusy(false);
        }
    }
    async function saveForm() {
        const data = await saveImageEnhancementSettings({ ...(await form.validateFields()), revision: settings!.revision, mode: "remote_api" });
        setSettings(data);
        return data;
    }
    const check = settings?.check;
    return (
        <Card>
            <div className="mb-6 flex items-start justify-between gap-6">
                <div>
                    <Typography.Title level={3}>AI 高清增强</Typography.Title>
                    <Typography.Text type="secondary">连接已部署的增强服务。关闭时也可配置和检查，无需重启应用。</Typography.Text>
                </div>
                <Space>
                    <Tag color={settings?.enabled ? "blue" : undefined}>{settings?.enabled ? "已开启" : "已关闭"}</Tag>
                    <Switch
                        aria-label="启用 AI 高清增强"
                        checked={settings?.enabled ?? false}
                        loading={busy}
                        disabled={!settings || dirty || (!settings.enabled && !settings.ready)}
                        onChange={(enabled) => void run(() => saveImageEnhancementSettings({ revision: settings!.revision, enabled }))}
                    />
                </Space>
            </div>
            {error ? <Alert className="mb-5" style={{ backgroundColor: "var(--muted)", borderColor: "var(--border)" }} type="error" showIcon title={error} /> : null}
            <Form form={form} layout="vertical" disabled={busy || !settings} onValuesChange={() => setDirty(true)}>
                <div className="grid grid-cols-2 gap-x-6" data-testid="enhancement-connection-grid">
                    <Form.Item label="调用方式">
                        <Select value="remote_api" options={[{ value: "remote_api", label: "远程 Worker API" }]} />
                    </Form.Item>
                    <Form.Item name="timeoutMs" label="请求超时（毫秒）" rules={[{ type: "integer", min: 1, max: 2 ** 31 - 1, message: "请输入有效的正整数超时" }]}>
                        <InputNumber className="!w-full" precision={0} placeholder={String(DEFAULT_ENHANCEMENT_TIMEOUT_MS)} />
                    </Form.Item>
                </div>
                <Form.Item name="endpoint" label="服务地址" extra="填写 HTTP 或 HTTPS 服务根地址；访问密钥单独配置。">
                    <Input placeholder="完整服务根地址" autoComplete="off" />
                </Form.Item>
                <Form.Item name="token" label="专用访问密钥" extra={<span>{settings?.hasToken ? "访问密钥已配置" : "尚未配置访问密钥"}；留空保留原值，输入新值替换。</span>}>
                    <Input.Password autoComplete="new-password" />
                </Form.Item>
                {settings?.hasToken ? (
                    <Button
                        className="mb-5"
                        danger
                        disabled={busy || dirty}
                        onClick={() =>
                            modal.confirm({
                                title: "清除访问密钥？",
                                content: "清除后旧就绪结果失效，已开启意图保留。",
                                okText: "确认清除",
                                cancelText: "取消",
                                onOk: () => run(() => saveImageEnhancementSettings({ revision: settings.revision, clearToken: true })),
                            })
                        }
                    >
                        清除访问密钥
                    </Button>
                ) : null}
                <div className="grid grid-cols-2 gap-x-6">
                    <Form.Item name="trust" label="HTTPS 信任">
                        <Select
                            options={[
                                { value: "system", label: "系统证书信任" },
                                { value: "custom_ca", label: "专用 CA 证书" },
                            ]}
                        />
                    </Form.Item>
                    <Form.Item name="modelId" label="默认增强模型" normalize={(value) => value ?? ""} extra="检查连接后显示远程 Worker 已导入的 Upscayl 模型，选择后保存。">
                        <Select allowClear showSearch optionFilterProp="label" disabled={busy || !settings?.models.length} placeholder="请先检查连接以获取模型" notFoundContent="远程 Worker 暂未返回可用模型" options={settings?.models.map((model) => ({ value: model.id, label: `${model.id} · 原生 ×${model.nativeScale}`, title: model.modelVersion })) ?? []} />
                    </Form.Item>
                </div>
                {trust === "custom_ca" ? (
                    <Form.Item name="caPem" label="CA 证书（PEM）" extra={settings?.hasCa ? "证书已配置；留空保留原值。" : "仅填写 CA 公共证书，不填写私钥。"}>
                        <Input.TextArea autoComplete="off" rows={4} />
                    </Form.Item>
                ) : null}
                <Space wrap>
                    <Button aria-label="保存配置" type="primary" loading={busy} onClick={() => void run(saveForm)}>
                        保存配置
                    </Button>
                    <Button
                        aria-label="检查连接"
                        disabled={busy || !endpoint?.trim() || (!token?.trim() && !settings?.hasToken)}
                        onClick={() => void run(async () => {
                            const current = dirty || !settings!.timeoutMs ? await saveForm() : settings!;
                            return checkImageEnhancementSettings({ revision: current.revision, action: "connection" });
                        })}
                    >
                        检查连接
                    </Button>
                    <Button
                        aria-label={check?.reason === "sample_pending" ? "刷新自检状态" : "样图自检"}
                        disabled={busy || dirty || !settings?.hasToken || !settings.modelId || !settings.models.length}
                        onClick={() => void run(() => checkImageEnhancementSettings({ revision: settings!.revision, action: "sample" }))}
                    >
                        {check?.reason === "sample_pending" ? "刷新自检状态" : "样图自检"}
                    </Button>
                    <Typography.Text type="secondary">检查连接会先保存修改并获取模型列表；样图自检验证 GPU 服务。</Typography.Text>
                </Space>
            </Form>
            <div className="mt-6 border-t border-[var(--border)] pt-5">
                <Space className="mb-3">
                    <Typography.Text strong>执行就绪</Typography.Text>
                    <Tag color={settings?.ready ? "success" : check?.state === "unavailable" ? "warning" : undefined}>{settings?.ready ? "检查通过" : check?.state === "unavailable" ? "不可用" : "待检测"}</Tag>
                </Space>
                <Alert
                    style={{ backgroundColor: "var(--muted)", borderColor: "var(--border)" }}
                    showIcon
                    type={settings?.ready ? "success" : check?.state === "unavailable" ? "warning" : "info"}
                    title={check ? (ENHANCEMENT_REASONS[check.reason] ?? "请重新检查增强配置。") : "保存配置后，依次检查连接和样图；通过前无法首次开启。"}
                    description={
                        check
                            ? `最近检测：${new Date(check.checkedAt).toLocaleString()} · 阶段：${{ configuration: "配置", connection: "连接", authentication: "认证", capabilities: "能力", engine: "引擎与 GPU", sample: "样图", output: "完整结果" }[check.stage]}`
                            : undefined
                    }
                />
                {check?.sample ? (
                    <Typography.Paragraph className="!mb-0 !mt-3" type="secondary">
                        原图 {check.sample.input.width}×{check.sample.input.height} → 原生推理 {check.sample.inference.width}×{check.sample.inference.height} → 下载解码 {check.sample.output.width}×{check.sample.output.height}
                    </Typography.Paragraph>
                ) : null}
                <Typography.Paragraph className="!mb-0 !mt-3" type="secondary">
                    开关影响后续任务，不停止远端服务或取消已有任务。暂时不可用时保留开启意图，原图仍可交付。已完成的当前启动实例自检会复用，不重复推理。
                </Typography.Paragraph>
            </div>
        </Card>
    );
}
