import { useEffect, useState } from "react";
import { Alert, Button, Input, InputNumber, Modal, Select, Space, Table, Typography } from "antd";
import { fetchJson, sendJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import type { ModelProfile } from "../types.js";
import { Panel } from "./common.js";

interface Draft {
  name: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  maxOutputTokens: number;
}

function emptyDraft(): Draft {
  return { name: "", baseUrl: "", apiKey: "", contextWindow: 131_072, maxOutputTokens: 8_192 };
}

/** 模型列表：新增/编辑/删除模型，选择当前使用项；密钥不会被接口回显。 */
export function ModelManager({ copy, onChanged }: { copy: Copy; onChanged: () => void }) {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [editing, setEditing] = useState<ModelProfile | "new" | undefined>();
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    try {
      const response = await fetchJson<{ items: ModelProfile[] }>("/api/ops/models", copy);
      setProfiles(response.items);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  useEffect(() => {
    void refresh();
  }, [copy]);

  function openEditor(profile?: ModelProfile) {
    setError("");
    setNotice("");
    setEditing(profile ?? "new");
    setDraft(profile
      ? {
          name: profile.name,
          baseUrl: profile.baseUrl,
          apiKey: "",
          contextWindow: profile.contextWindow,
          maxOutputTokens: profile.maxOutputTokens,
        }
      : emptyDraft());
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const body: Record<string, unknown> = { ...draft };
      if (!body.apiKey) delete body.apiKey;
      if (editing === "new") {
        await sendJson("/api/ops/models", body, copy, "POST");
      } else if (editing) {
        await sendJson(`/api/ops/models/${encodeURIComponent(editing.id)}`, body, copy, "PUT");
      }
      setEditing(undefined);
      setNotice(copy.modelManagerSaved);
      await refresh();
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function activate(profile: ModelProfile) {
    setError("");
    try {
      await sendJson(`/api/ops/models/${encodeURIComponent(profile.id)}/activate`, {}, copy, "POST");
      await refresh();
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function remove(profile: ModelProfile) {
    Modal.confirm({
      title: copy.modelManagerDeleteConfirm,
      okType: "danger",
      onOk: async () => {
        setError("");
        try {
          await sendJson(`/api/ops/models/${encodeURIComponent(profile.id)}`, {}, copy, "DELETE");
          await refresh();
          onChanged();
        } catch (cause) {
          setError(errorMessage(cause));
        }
      },
    });
  }

  const active = profiles.find((profile) => profile.active);
  return (
    <Panel title={copy.modelManagerTitle}>
      {error ? <Alert className="settings-alert" type="error" showIcon message={error} /> : null}
      {notice ? <Alert className="settings-alert" type="success" showIcon message={notice} /> : null}
      <Space wrap className="settings-cleanup-controls">
        <Select
          className="settings-select"
          style={{ minWidth: 260 }}
          placeholder={copy.modelManagerSelect}
          value={active?.id}
          options={profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
          onChange={(id) => {
            const target = profiles.find((profile) => profile.id === id);
            if (target) void activate(target);
          }}
        />
        <Button type="primary" onClick={() => openEditor()}>{copy.modelManagerAdd}</Button>
      </Space>
      {profiles.length === 0 ? (
        <Typography.Paragraph type="secondary">{copy.modelManagerEmpty}</Typography.Paragraph>
      ) : (
        <Table
          className="model-manager-table"
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={profiles}
          columns={[
            { title: copy.modelManagerName, dataIndex: "name", key: "name" },
            { title: copy.settingsModelBaseUrl, dataIndex: "baseUrl", key: "baseUrl" },
            {
              title: copy.settingsContextWindow,
              dataIndex: "contextWindow",
              key: "contextWindow",
              render: (value: number) => value.toLocaleString("en-US"),
            },
            {
              title: copy.modelManagerActive,
              key: "active",
              render: (_: unknown, profile: ModelProfile) => profile.active ? <span className="settings-badge">{copy.modelManagerActive}</span> : null,
            },
            {
              title: "",
              key: "actions",
              render: (_: unknown, profile: ModelProfile) => (
                <Space size={4}>
                  <Button type="link" size="small" onClick={() => openEditor(profile)}>{copy.modelManagerEdit}</Button>
                  {profile.active ? null : (
                    <Button type="link" size="small" onClick={() => void activate(profile)}>{copy.modelManagerActivate}</Button>
                  )}
                  <Button type="link" size="small" danger onClick={() => remove(profile)}>{copy.modelManagerDelete}</Button>
                </Space>
              ),
            },
          ]}
        />
      )}
      <Modal
        open={Boolean(editing)}
        title={editing === "new" ? copy.modelManagerAdd : copy.modelManagerEdit}
        onCancel={() => setEditing(undefined)}
        onOk={() => void save()}
        confirmLoading={saving}
      >
        <div className="settings-fields">
          <div className="settings-field">
            <Typography.Text strong>{copy.modelManagerName}</Typography.Text>
            <Input
              value={draft.name}
              maxLength={200}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </div>
          <div className="settings-field">
            <Typography.Text strong>{copy.settingsModelBaseUrl}</Typography.Text>
            <Input
              value={draft.baseUrl}
              maxLength={500}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
            <Typography.Text type="secondary" className="settings-field-hint">{copy.settingsModelBaseUrlHint}</Typography.Text>
          </div>
          <div className="settings-field">
            <Typography.Text strong>{copy.settingsModelApiKey}</Typography.Text>
            <Input.Password
              value={draft.apiKey}
              placeholder={copy.settingsSecretConfigured}
              maxLength={2_000}
              autoComplete="new-password"
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            />
            <Typography.Text type="secondary" className="settings-field-hint">{copy.settingsModelApiKeyHint}</Typography.Text>
          </div>
          <div className="settings-field">
            <Typography.Text strong>{copy.settingsContextWindow}</Typography.Text>
            <InputNumber
              min={1024}
              max={10_000_000}
              step={1024}
              value={draft.contextWindow}
              onChange={(value) => setDraft({ ...draft, contextWindow: Number(value) || 131_072 })}
            />
            <Typography.Text type="secondary" className="settings-field-hint">{copy.settingsContextWindowHint}</Typography.Text>
          </div>
          <div className="settings-field">
            <Typography.Text strong>{copy.settingsMaxOutputTokens}</Typography.Text>
            <InputNumber
              min={1}
              max={8192}
              step={256}
              value={draft.maxOutputTokens}
              onChange={(value) => setDraft({ ...draft, maxOutputTokens: Number(value) || 8192 })}
            />
            <Typography.Text type="secondary" className="settings-field-hint">{copy.settingsMaxOutputTokensHint}</Typography.Text>
          </div>
        </div>
      </Modal>
    </Panel>
  );
}
