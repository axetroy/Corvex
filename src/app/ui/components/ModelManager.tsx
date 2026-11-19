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
export function ModelManager({ copy, onChanged }: { copy: Copy; onChanged: () => void }) {
  const [providers, setProviders] = useState<ModelProviderDetails[]>([]);
  const [editingProvider, setEditingProvider] = useState<ModelProviderDetails | "new" | undefined>();
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(emptyProvider());
  const [modelTarget, setModelTarget] = useState<{ provider: ModelProviderDetails; model?: ProviderModel } | undefined>();
  const [modelDraft, setModelDraft] = useState<ModelDraft>(emptyModel());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    try {
      const response = await fetchJson<{ items: ModelProviderDetails[] }>("/api/ops/model-providers", copy);
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
    setEditingProvider(provider ?? "new");
    setProviderDraft(provider ? { name: provider.name, baseUrl: provider.baseUrl, apiKey: "" } : emptyProvider());
  }

  async function saveProvider() {
    setSaving(true);
    setError("");
    try {
      const body: Record<string, unknown> = { ...providerDraft };
      if (!body.apiKey) delete body.apiKey;
      if (editingProvider === "new") {
        await sendJson("/api/ops/model-providers", body, copy, "POST");
      } else if (editingProvider) {
        await sendJson(`/api/ops/model-providers/${encodeURIComponent(editingProvider.id)}`, body, copy, "PUT");
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
    Modal.confirm({
      title: copy.modelManagerDeleteProviderConfirm,
      okType: "danger",
      onOk: async () => {
        resetMessages();
        try {
          await sendJson(`/api/ops/model-providers/${encodeURIComponent(provider.id)}`, {}, copy, "DELETE");
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
    setModelTarget({ provider, model });
    setModelDraft(model
      ? { name: model.name, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens }
      : emptyModel());
  }

  async function saveModel() {
    if (!modelTarget) return;
    setSaving(true);
    setError("");
    try {
      const base = `/api/ops/model-providers/${encodeURIComponent(modelTarget.provider.id)}/models`;
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
      const path = `/api/ops/model-providers/${encodeURIComponent(provider.id)}/models/${encodeURIComponent(model.id)}/activate`;
      await sendJson(path, {}, copy, "POST");
      await refresh();
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function removeModel(provider: ModelProviderDetails, model: ProviderModel) {
    Modal.confirm({
      title: copy.modelManagerDeleteModelConfirm,
      okType: "danger",
      onOk: async () => {
        resetMessages();
        try {
          const path = `/api/ops/model-providers/${encodeURIComponent(provider.id)}/models/${encodeURIComponent(model.id)}`;
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
                {provider.apiKey ? <Tag className="model-provider-key">{copy.modelManagerKeyConfigured}</Tag> : null}
              </div>
              <Space size={4} wrap>
                <Button size="small" onClick={() => openModel(provider)}>{copy.modelManagerAddModel}</Button>
                <Button size="small" onClick={() => openProvider(provider)}>{copy.modelManagerEdit}</Button>
                <Button size="small" danger onClick={() => removeProvider(provider)}>{copy.modelManagerDelete}</Button>
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
                dataSource={provider.models}
                columns={[
                  { title: copy.modelManagerName, dataIndex: "name", key: "name" },
                  {
                    title: copy.settingsContextWindow,
                    dataIndex: "contextWindow",
                    key: "contextWindow",
                    render: (value: number) => value.toLocaleString("en-US"),
                  },
                  {
                    title: copy.settingsMaxOutputTokens,
                    dataIndex: "maxOutputTokens",
                    key: "maxOutputTokens",
                    render: (value: number) => value.toLocaleString("en-US"),
                  },
                  {
                    title: copy.modelManagerActive,
                    key: "active",
                    render: (_: unknown, model: ProviderModel) =>
                      model.active ? <span className="settings-badge">{copy.modelManagerActive}</span> : null,
                  },
                  {
                    title: "",
                    key: "actions",
                    render: (_: unknown, model: ProviderModel) => (
                      <Space size={4}>
                        <Button type="link" size="small" onClick={() => openModel(provider, model)}>{copy.modelManagerEdit}</Button>
                        {model.active ? null : (
                          <Button type="link" size="small" onClick={() => void activate(provider, model)}>{copy.modelManagerActivate}</Button>
                        )}
                        <Button type="link" size="small" danger onClick={() => removeModel(provider, model)}>{copy.modelManagerDelete}</Button>
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
              max={8192}
              step={256}
              value={modelDraft.maxOutputTokens}
              onChange={(value) => setModelDraft({ ...modelDraft, maxOutputTokens: Number(value) || 8192 })}
            />
            <Typography.Text type="secondary" className="settings-field-hint">{copy.settingsMaxOutputTokensHint}</Typography.Text>
          </div>
        </div>
      </Modal>
    </Panel>
  );
}
