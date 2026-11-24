import { useEffect, useState } from "react";
import { Alert, Button, Input, InputNumber, Modal, Space, Table, Tag, Typography } from "antd";
import { fetchJson, sendJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import type { ModelProviderDetails, ProviderModel } from "../types.js";
import { Panel } from "./common.js";

interface ProviderDraft {
  name: string;
  baseUrl: string;
  apiKey: string;
}

interface ModelDraft {
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
}

interface TestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  status?: number;
  models?: number;
}

function emptyProvider(): ProviderDraft {
  return { name: "", baseUrl: "", apiKey: "" };
}

function emptyModel(): ModelDraft {
  return { name: "", contextWindow: 131_072, maxOutputTokens: 8_192 };
}

/**
 * 模型目录：供应商保存连接参数（Base URL、密钥），供应商下面挂模型。
 * 全局只有一个模型处于使用中；密钥不会被接口回显，编辑时留空表示保留原值。
 */
export function ModelManager({
  copy,
  onChanged,
  scope = "system",
}: {
  copy: Copy;
  onChanged: () => void;
  scope?: "system" | "user";
}) {
  const apiBase = scope === "user" ? "/api/ops/me/model-providers" : "/api/ops/model-providers";
  const [providers, setProviders] = useState<ModelProviderDetails[]>([]);
  const [editingProvider, setEditingProvider] = useState<ModelProviderDetails | "new" | undefined>();
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(emptyProvider());
  const [modelTarget, setModelTarget] = useState<{ provider: ModelProviderDetails; model?: ProviderModel } | undefined>();
  const [modelDraft, setModelDraft] = useState<ModelDraft>(emptyModel());
  const [saving, setSaving] = useState(false);
  const [testingProvider, setTestingProvider] = useState(false);
  const [testingModel, setTestingModel] = useState(false);
  const [providerTest, setProviderTest] = useState<TestResult | undefined>();
  const [modelTest, setModelTest] = useState<TestResult | undefined>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // 确认弹窗必须挂在 ConfigProvider 内，否则拿不到主题与 CSP nonce，样式会被浏览器拦掉。
  const [modal, modalContextHolder] = Modal.useModal();

  function renderTestResult(result: TestResult | undefined) {
    if (!result) return null;
    const detail = [
      copy.modelTestLatency.replace("{value}", String(result.latencyMs)),
      result.status ? `HTTP ${result.status}` : "",
      result.models !== undefined ? copy.modelTestModels.replace("{value}", String(result.models)) : "",
      result.ok ? "" : result.message,
    ].filter(Boolean).join(" · ");
    return (
      <Alert
        className="settings-alert"
        type={result.ok ? "success" : "error"}
        showIcon
        message={result.ok ? copy.modelTestSuccess : copy.modelTestFailed}
        description={detail}
      />
    );
  }

  async function refresh() {
    try {
      const response = await fetchJson<{ items: ModelProviderDetails[] }>(apiBase, copy);
      setProviders(response.items);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  useEffect(() => {
    void refresh();
  }, [copy]);

  function resetMessages() {
    setError("");
    setNotice("");
  }

  function openProvider(provider?: ModelProviderDetails) {
    resetMessages();
    setProviderTest(undefined);
    setEditingProvider(provider ?? "new");
    setProviderDraft(provider ? { name: provider.name, baseUrl: provider.baseUrl, apiKey: "" } : emptyProvider());
  }

  async function testProviderDraft() {
    setTestingProvider(true);
    setProviderTest(undefined);
    try {
      const result = await sendJson<TestResult>(
        `${apiBase}/test`,
        {
          baseUrl: providerDraft.baseUrl,
          apiKey: providerDraft.apiKey,
          ...(editingProvider && editingProvider !== "new" ? { providerId: editingProvider.id } : {}),
        },
        copy,
        "POST",
      );
      setProviderTest(result);
    } catch (cause) {
      setProviderTest({ ok: false, message: errorMessage(cause), latencyMs: 0 });
    } finally {
      setTestingProvider(false);
    }
  }

  async function saveProvider() {
    setSaving(true);
    setError("");
    try {
      const body: Record<string, unknown> = { ...providerDraft };
      if (!body.apiKey) delete body.apiKey;
      if (editingProvider === "new") {
        await sendJson(apiBase, body, copy, "POST");
      } else if (editingProvider) {
        await sendJson(`${apiBase}/${encodeURIComponent(editingProvider.id)}`, body, copy, "PUT");
      }
      setEditingProvider(undefined);
      setNotice(copy.modelManagerSaved);
      await refresh();
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function removeProvider(provider: ModelProviderDetails) {
    modal.confirm({
      title: copy.modelManagerDeleteProviderConfirm,
      okType: "danger",
      onOk: async () => {
        resetMessages();
        try {
          await sendJson(`${apiBase}/${encodeURIComponent(provider.id)}`, {}, copy, "DELETE");
          await refresh();
          onChanged();
        } catch (cause) {
          setError(errorMessage(cause));
        }
      },
    });
  }

  function openModel(provider: ModelProviderDetails, model?: ProviderModel) {
    resetMessages();
    setModelTest(undefined);
    setModelTarget({ provider, model });
    setModelDraft(model
      ? { name: model.name, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens }
      : emptyModel());
  }

  async function testModelDraft() {
    if (!modelTarget) return;
    setTestingModel(true);
    setModelTest(undefined);
    try {
      const result = await sendJson<TestResult>(
        `${apiBase}/${encodeURIComponent(modelTarget.provider.id)}/models/test`,
        { name: modelDraft.name },
        copy,
        "POST",
      );
      setModelTest(result);
    } catch (cause) {
      setModelTest({ ok: false, message: errorMessage(cause), latencyMs: 0 });
    } finally {
      setTestingModel(false);
    }
  }

  async function saveModel() {
    if (!modelTarget) return;
    setSaving(true);
    setError("");
    try {
      const base = `${apiBase}/${encodeURIComponent(modelTarget.provider.id)}/models`;
      if (modelTarget.model) {
        await sendJson(`${base}/${encodeURIComponent(modelTarget.model.id)}`, modelDraft, copy, "PUT");
      } else {
        await sendJson(base, modelDraft, copy, "POST");
      }
      setModelTarget(undefined);
      setNotice(copy.modelManagerSaved);
      await refresh();
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function activate(provider: ModelProviderDetails, model: ProviderModel) {
    resetMessages();
    try {
      const path = `${apiBase}/${encodeURIComponent(provider.id)}/models/${encodeURIComponent(model.id)}/activate`;
      await sendJson(path, {}, copy, "POST");
      await refresh();
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function removeModel(provider: ModelProviderDetails, model: ProviderModel) {
    modal.confirm({
      title: copy.modelManagerDeleteModelConfirm,
      okType: "danger",
      onOk: async () => {
        resetMessages();
        try {
          const path = `${apiBase}/${encodeURIComponent(provider.id)}/models/${encodeURIComponent(model.id)}`;
          await sendJson(path, {}, copy, "DELETE");
          await refresh();
          onChanged();
        } catch (cause) {
          setError(errorMessage(cause));
        }
      },
    });
  }

  const active = providers.flatMap((provider) => provider.models).find((model) => model.active);
  const activeProvider = active ? providers.find((provider) => provider.id === active.providerId) : undefined;

  return (
    <Panel title={copy.modelManagerTitle}>
      {modalContextHolder}
      {error ? <Alert className="settings-alert" type="error" showIcon message={error} /> : null}
      {notice ? <Alert className="settings-alert" type="success" showIcon message={notice} /> : null}
      <div className="model-manager-head">
        <Typography.Text type="secondary">
          {active && activeProvider
            ? `${copy.modelManagerCurrent}: ${activeProvider.name} / ${active.name}`
            : copy.modelManagerNoActive}
        </Typography.Text>
        <Button type="primary" onClick={() => openProvider()}>{copy.modelManagerAddProvider}</Button>
      </div>
      {providers.length === 0 ? (
        <Typography.Paragraph type="secondary">{copy.modelManagerEmpty}</Typography.Paragraph>
      ) : (
        providers.map((provider) => (
          <div className="model-provider" key={provider.id}>
            <div className="model-provider-head">
              <div className="model-provider-meta">
                <Typography.Text strong>{provider.name}</Typography.Text>
                <Typography.Text type="secondary" className="model-provider-url">{provider.baseUrl}</Typography.Text>
                {provider.ownerUserId === "" ? <Tag className="model-provider-system">{copy.systemProviderBadge}</Tag> : null}
                {provider.apiKey ? <Tag className="model-provider-key">{copy.modelManagerKeyConfigured}</Tag> : null}
              </div>
              <Space size={4} wrap>
                {scope === "user" && provider.ownerUserId !== "" ? (
                  <>
                    <Button size="small" onClick={() => openModel(provider)}>{copy.modelManagerAddModel}</Button>
                    <Button size="small" onClick={() => openProvider(provider)}>{copy.modelManagerEdit}</Button>
                    <Button size="small" danger onClick={() => removeProvider(provider)}>{copy.modelManagerDelete}</Button>
                  </>
                ) : scope === "system" ? (
                  <>
                    <Button size="small" onClick={() => openModel(provider)}>{copy.modelManagerAddModel}</Button>
                    <Button size="small" onClick={() => openProvider(provider)}>{copy.modelManagerEdit}</Button>
                    <Button size="small" danger onClick={() => removeProvider(provider)}>{copy.modelManagerDelete}</Button>
                  </>
                ) : null}
              </Space>
            </div>
            {provider.models.length === 0 ? (
              <Typography.Paragraph type="secondary" className="model-provider-empty">
                {copy.modelManagerEmptyModels}
              </Typography.Paragraph>
            ) : (
              <Table
                className="model-manager-table"
                rowKey="id"
                size="small"
                pagination={false}
                // 固定列宽：系统供应商与用户供应商各自渲染独立表格，自动布局会按
                // 其内容分配宽度（操作列按钮有无差异很大），导致两处列不对齐。
                tableLayout="fixed"
                dataSource={provider.models}
                columns={[
                  { title: copy.modelManagerName, dataIndex: "name", key: "name", width: "24%" },
                  {
                    title: copy.settingsContextWindow,
                    dataIndex: "contextWindow",
                    key: "contextWindow",
                    width: "16%",
                    render: (value: number) => value.toLocaleString("en-US"),
                  },
                  {
                    title: copy.settingsMaxOutputTokens,
                    dataIndex: "maxOutputTokens",
                    key: "maxOutputTokens",
                    width: "20%",
                    render: (value: number) => value.toLocaleString("en-US"),
                  },
                  {
                    title: copy.modelManagerActive,
                    key: "active",
                    width: "13%",
                    render: (_: unknown, model: ProviderModel) =>
                      model.active ? <span className="settings-badge">{copy.modelManagerActive}</span> : null,
                  },
                  {
                    title: "",
                    key: "actions",
                    width: "27%",
                    render: (_: unknown, model: ProviderModel) => (
                      <Space size={4}>
                        {scope === "system" || provider.ownerUserId !== "" ? (
                          <>
                            <Button type="link" size="small" onClick={() => openModel(provider, model)}>{copy.modelManagerEdit}</Button>
                            <Button type="link" size="small" danger onClick={() => removeModel(provider, model)}>{copy.modelManagerDelete}</Button>
                          </>
                        ) : null}
                        {model.active ? null : (
                          <Button type="link" size="small" onClick={() => void activate(provider, model)}>{copy.modelManagerActivate}</Button>
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
            )}
          </div>
        ))
      )}
      <Modal
        open={Boolean(editingProvider)}
        title={editingProvider === "new" ? copy.modelManagerAddProvider : copy.modelManagerEditProvider}
        onCancel={() => setEditingProvider(undefined)}
        onOk={() => void saveProvider()}
        confirmLoading={saving}
      >
        <div className="settings-fields">
          <div className="settings-field">
            <Typography.Text strong>{copy.modelManagerProviderName}</Typography.Text>
            <Input
              value={providerDraft.name}
              maxLength={200}
              onChange={(event) => setProviderDraft({ ...providerDraft, name: event.target.value })}
            />
          </div>
          <div className="settings-field">
            <Typography.Text strong>{copy.settingsModelBaseUrl}</Typography.Text>
            <Input
              value={providerDraft.baseUrl}
              maxLength={500}
              onChange={(event) => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })}
            />
            <Typography.Text type="secondary" className="settings-field-hint">{copy.settingsModelBaseUrlHint}</Typography.Text>
          </div>
          <div className="settings-field">
            <Typography.Text strong>{copy.settingsModelApiKey}</Typography.Text>
            <Input.Password
              value={providerDraft.apiKey}
              placeholder={copy.settingsSecretConfigured}
              maxLength={2_000}
              autoComplete="new-password"
              onChange={(event) => setProviderDraft({ ...providerDraft, apiKey: event.target.value })}
            />
            <Typography.Text type="secondary" className="settings-field-hint">{copy.settingsModelApiKeyHint}</Typography.Text>
          </div>
        </div>
        <div className="settings-test-row">
          <Button loading={testingProvider} onClick={() => void testProviderDraft()}>{copy.modelTestConnection}</Button>
          {renderTestResult(providerTest)}
        </div>
      </Modal>
      <Modal
        open={Boolean(modelTarget)}
        title={modelTarget?.model ? copy.modelManagerEditModel : copy.modelManagerAddModel}
        onCancel={() => setModelTarget(undefined)}
        onOk={() => void saveModel()}
        confirmLoading={saving}
      >
        <div className="settings-fields">
          <div className="settings-field">
            <Typography.Text strong>{copy.modelManagerName}</Typography.Text>
            <Input
              value={modelDraft.name}
              maxLength={200}
              onChange={(event) => setModelDraft({ ...modelDraft, name: event.target.value })}
            />
            <Typography.Text type="secondary" className="settings-field-hint">{copy.modelManagerModelNameHint}</Typography.Text>
          </div>
          <div className="settings-field">
            <Typography.Text strong>{copy.settingsContextWindow}</Typography.Text>
            <InputNumber
              min={1024}
              max={10_000_000}
              step={1024}
              value={modelDraft.contextWindow}
              onChange={(value) => setModelDraft({ ...modelDraft, contextWindow: Number(value) || 131_072 })}
            />
            <Typography.Text type="secondary" className="settings-field-hint">{copy.settingsContextWindowHint}</Typography.Text>
          </div>
          <div className="settings-field">
            <Typography.Text strong>{copy.settingsMaxOutputTokens}</Typography.Text>
            <InputNumber
              min={1}
              max={Math.max(1, modelDraft.contextWindow - 1)}
              step={256}
              value={modelDraft.maxOutputTokens}
              onChange={(value) => setModelDraft({ ...modelDraft, maxOutputTokens: Number(value) || 1 })}
            />
            <Typography.Text type="secondary" className="settings-field-hint">{copy.settingsMaxOutputTokensHint}</Typography.Text>
          </div>
        </div>
        <div className="settings-test-row">
          <Button loading={testingModel} onClick={() => void testModelDraft()}>{copy.modelTestModel}</Button>
          {renderTestResult(modelTest)}
        </div>
      </Modal>
    </Panel>
  );
}
