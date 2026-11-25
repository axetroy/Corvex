import { useEffect, useState } from "react";
import { Alert, Button, Input, InputNumber, Select, Switch, Tag, Typography } from "antd";
import { fetchJson, sendJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import { ErrorBanner, Loading, PageHeading, Panel } from "./common.js";
import "./ExecutionConfigPanel.css";

interface ExecutionConfig {
  enabled: boolean;
  backend: "local" | "sandbox";
  sandbox: {
    runtime: "docker" | "podman";
    image: string;
    socket: string;
    memory: string;
    cpus: number;
    pids_limit: number;
    tmpfs_size_mb: number;
    network: "none" | "bridge";
    read_only_mounts: string[];
    timeout_ms: number;
    max_output_bytes: number;
  };
  local: {
    allow_unsafe: boolean;
    timeout_ms: number;
    max_output_bytes: number;
  };
}

interface Payload {
  config: ExecutionConfig;
  source: "database" | "file";
  updatedAt?: string;
  updatedBy?: string;
  effectiveImmediately: boolean;
}

/** 一行设置：左侧标签与说明，右侧控件。 */
function Field({
  label,
  hint,
  badge,
  children,
}: {
  label: string;
  hint?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="execution-config-field">
      <div className="execution-config-field-text">
        <div className="execution-config-field-label">
          <Typography.Text strong>{label}</Typography.Text>
          {badge}
        </div>
        {hint ? <Typography.Text type="secondary" className="execution-config-field-hint">{hint}</Typography.Text> : null}
      </div>
      <div className="execution-config-field-control">{children}</div>
    </div>
  );
}

/** 管理员执行环境配置面板：保存前服务端走完整 fail-closed 校验。 */
export function ExecutionConfigPanel({ copy, onUpdated }: { copy: Copy; onUpdated: (value: string) => void }) {
  const [payload, setPayload] = useState<Payload>();
  const [draft, setDraft] = useState<ExecutionConfig>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  const applyPayload = (value: Payload) => {
    setPayload(value);
    setDraft({
      ...value.config,
      sandbox: { ...value.config.sandbox, read_only_mounts: [...value.config.sandbox.read_only_mounts] },
      local: { ...value.config.local },
    });
    setError("");
    onUpdated(new Date().toISOString());
  };

  useEffect(() => {
    let active = true;
    fetchJson<Payload>("/api/ops/admin/execution", copy)
      .then((value) => { if (active) applyPayload(value); })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [copy]);

  if (error && !payload) return <ErrorBanner message={error} />;
  if (!payload || !draft) return <Loading>{copy.loading}</Loading>;

  const set = (patch: Partial<ExecutionConfig>) => setDraft((current) => current ? { ...current, ...patch } : current);
  const setSandbox = (patch: Partial<ExecutionConfig["sandbox"]>) => setDraft((current) => current
    ? { ...current, sandbox: { ...current.sandbox, ...patch } } : current);
  const setLocal = (patch: Partial<ExecutionConfig["local"]>) => setDraft((current) => current
    ? { ...current, local: { ...current.local, ...patch } } : current);

  const save = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      applyPayload(await sendJson<Payload>("/api/ops/admin/execution", draft, copy, "PUT"));
      setNotice(copy.executionConfigSaved);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      applyPayload(await sendJson<Payload>("/api/ops/admin/execution", {}, copy, "DELETE"));
      setNotice(copy.executionConfigReset);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const sourceTag = payload.source === "database"
    ? <Tag color="blue">{copy.executionConfigSourceDb}</Tag>
    : <Tag>{copy.executionConfigSourceFile}</Tag>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(payload.config);

  return (
    <div className="execution-config-panel">
      <PageHeading
        title={copy.executionConfigTitle}
        description={copy.executionConfigHint}
        actions={
          <div className="execution-config-actions">
            <Button onClick={() => applyPayload(payload)} disabled={!dirty || saving}>{copy.executionConfigCancel}</Button>
            <Button type="primary" loading={saving} onClick={() => void save()} disabled={!dirty}>{copy.settingsSave}</Button>
          </div>
        }
      />

      <div className="execution-config-meta">
        <span>{copy.executionConfigSource}</span>{sourceTag}
        {payload.updatedAt ? (
          <Typography.Text type="secondary" className="execution-config-meta-time">{payload.updatedAt}{payload.updatedBy ? ` · ${payload.updatedBy}` : ""}</Typography.Text>
        ) : null}
      </div>

      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError("")} /> : null}
      {notice ? <Alert type="success" showIcon message={notice} closable onClose={() => setNotice("")} /> : null}

      <Panel title={copy.executionConfigGeneral}>
        <Field label={copy.executionConfigEnabled} hint={copy.executionConfigEnabledHint}>
          <Switch checked={draft.enabled} onChange={(value) => set({ enabled: value })} />
        </Field>
        <Field label={copy.executionConfigBackend} hint={copy.executionConfigBackendHint}>
          <Select
            className="execution-config-control"
            value={draft.backend}
            onChange={(value) => set({ backend: value })}
            options={[
              { value: "sandbox", label: copy.executionConfigBackendSandbox },
              { value: "local", label: copy.executionConfigBackendLocal },
            ]}
          />
        </Field>
      </Panel>

      {draft.backend === "sandbox" ? (
        <Panel title={copy.executionConfigSandbox}>
          <Field label={copy.executionConfigRuntime}>
            <Select
              className="execution-config-control"
              value={draft.sandbox.runtime}
              onChange={(value) => setSandbox({ runtime: value })}
              options={[{ value: "docker", label: "Docker" }, { value: "podman", label: "Podman" }]}
            />
          </Field>
          <Field label={copy.executionConfigImage} hint={copy.executionConfigImageHint}>
            <Input
              className="execution-config-control"
              value={draft.sandbox.image}
              placeholder="corvex-exec:latest"
              onChange={(event) => setSandbox({ image: event.target.value })}
            />
          </Field>
          <Field label={copy.executionConfigSocket} hint={copy.executionConfigSocketHint}>
            <Input
              className="execution-config-control"
              value={draft.sandbox.socket}
              placeholder="/var/run/docker.sock"
              onChange={(event) => setSandbox({ socket: event.target.value })}
            />
          </Field>
          <Field label={copy.executionConfigNetwork} hint={copy.executionConfigNetworkHint}>
            <Select
              className="execution-config-control"
              value={draft.sandbox.network}
              onChange={(value) => setSandbox({ network: value })}
              options={[
                { value: "bridge", label: copy.executionConfigNetworkBridge },
                { value: "none", label: copy.executionConfigNetworkNone },
              ]}
            />
          </Field>
          <Field label={copy.executionConfigMemory}>
            <Input
              className="execution-config-control"
              value={draft.sandbox.memory}
              placeholder="2g"
              onChange={(event) => setSandbox({ memory: event.target.value })}
            />
          </Field>
          <Field label={copy.executionConfigCpus}>
            <InputNumber min={1} className="execution-config-control" value={draft.sandbox.cpus} onChange={(value) => value && setSandbox({ cpus: value })} />
          </Field>
          <Field label={copy.executionConfigPids}>
            <InputNumber min={1} className="execution-config-control" value={draft.sandbox.pids_limit} onChange={(value) => value && setSandbox({ pids_limit: value })} />
          </Field>
          <Field label={copy.executionConfigTmpfs} hint={copy.executionConfigTmpfsHint}>
            <InputNumber min={16} max={4096} addonAfter="MiB" className="execution-config-control" value={draft.sandbox.tmpfs_size_mb} onChange={(value) => value && setSandbox({ tmpfs_size_mb: value })} />
          </Field>
          <Field label={copy.executionConfigTimeout} hint={copy.executionConfigTimeoutHint}>
            <InputNumber min={1} addonAfter="ms" className="execution-config-control" value={draft.sandbox.timeout_ms} onChange={(value) => value && setSandbox({ timeout_ms: value })} />
          </Field>
          <Field label={copy.executionConfigMaxOutput} hint={copy.executionConfigMaxOutputHint}>
            <InputNumber min={1} addonAfter="B" className="execution-config-control" value={draft.sandbox.max_output_bytes} onChange={(value) => value && setSandbox({ max_output_bytes: value })} />
          </Field>
        </Panel>
      ) : (
        <Panel title={copy.executionConfigLocal}>
          <Alert type="warning" showIcon message={copy.executionConfigLocalWarning} className="execution-config-local-warning" />
          <Field label={copy.executionConfigAllowUnsafe}>
            <Switch checked={draft.local.allow_unsafe} onChange={(value) => setLocal({ allow_unsafe: value })} />
          </Field>
          <Field label={copy.executionConfigTimeout} hint={copy.executionConfigTimeoutHint}>
            <InputNumber min={1} addonAfter="ms" className="execution-config-control" value={draft.local.timeout_ms} onChange={(value) => value && setLocal({ timeout_ms: value })} />
          </Field>
          <Field label={copy.executionConfigMaxOutput} hint={copy.executionConfigMaxOutputHint}>
            <InputNumber min={1} addonAfter="B" className="execution-config-control" value={draft.local.max_output_bytes} onChange={(value) => value && setLocal({ max_output_bytes: value })} />
          </Field>
        </Panel>
      )}

      <div className="execution-config-footer">
        <Button type="primary" loading={saving} onClick={() => void save()} disabled={!dirty}>{copy.settingsSave}</Button>
        <Button onClick={() => void reset()} disabled={saving || payload.source === "file"}>{copy.executionConfigResetButton}</Button>
      </div>
    </div>
  );
}
