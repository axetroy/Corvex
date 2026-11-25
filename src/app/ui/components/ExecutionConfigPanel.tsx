import { useEffect, useState } from "react";
import { Button, InputNumber, Select, Space, Tag, Typography } from "antd";
import { fetchJson, sendJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import { ErrorBanner, Loading, PageHeading, Panel } from "./common.js";

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

/** 管理员执行环境配置面板：保存前服务端走完整 fail-closed 校验。 */
export function ExecutionConfigPanel({ copy, onUpdated }: { copy: Copy; onUpdated: (value: string) => void }) {
  const [payload, setPayload] = useState<Payload>();
  const [draft, setDraft] = useState<ExecutionConfig>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () => {
    fetchJson<Payload>("/api/ops/admin/execution", copy)
      .then((value) => {
        setPayload(value);
        setDraft({
          ...value.config,
          sandbox: { ...value.config.sandbox, read_only_mounts: [...value.config.sandbox.read_only_mounts] },
          local: { ...value.config.local },
        });
        setError("");
        onUpdated(new Date().toISOString());
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  };

  useEffect(load, [copy]);

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
      const result = await sendJson<Payload>("/api/ops/admin/execution", draft, copy, "PUT");
      setPayload(result);
      setDraft({
        ...result.config,
        sandbox: { ...result.config.sandbox, read_only_mounts: [...result.config.sandbox.read_only_mounts] },
        local: { ...result.config.local },
      });
      setNotice(copy.executionConfigSaved);
      onUpdated(new Date().toISOString());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError("");
    try {
      const result = await sendJson<Payload>("/api/ops/admin/execution", {}, copy, "DELETE");
      setPayload(result);
      setDraft({
        ...result.config,
        sandbox: { ...result.config.sandbox, read_only_mounts: [...result.config.sandbox.read_only_mounts] },
        local: { ...result.config.local },
      });
      setNotice(copy.executionConfigReset);
      onUpdated(new Date().toISOString());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const sourceTag = payload.source === "database"
    ? <Tag color="blue">{copy.executionConfigSourceDb}</Tag>
    : <Tag>{copy.executionConfigSourceFile}</Tag>;

  return (
    <div className="execution-config-panel">
      <PageHeading title={copy.executionConfigTitle} description={copy.executionConfigHint} />
      <div className="execution-config-source">
        <Typography.Text type="secondary">{copy.executionConfigSource}: </Typography.Text>{sourceTag}
        {payload.updatedAt ? (
          <Typography.Text type="secondary"> · {formatUpdated(payload.updatedAt, payload.updatedBy)}</Typography.Text>
        ) : null}
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      {notice ? <div className="execution-config-notice">{notice}</div> : null}

      <Panel title={copy.executionConfigGeneral}>
        <label className="execution-config-field">
          <span>{copy.executionConfigEnabled}</span>
          <Select
            value={draft.enabled}
            onChange={(value) => set({ enabled: value })}
            options={[
              { value: false, label: copy.executionConfigOff },
              { value: true, label: copy.executionConfigOn },
            ]}
          />
        </label>
        <label className="execution-config-field">
          <span>{copy.executionConfigBackend}</span>
          <Select
            value={draft.backend}
            onChange={(value) => set({ backend: value })}
            options={[
              { value: "sandbox", label: copy.executionConfigBackendSandbox },
              { value: "local", label: copy.executionConfigBackendLocal },
            ]}
          />
        </label>
      </Panel>

      {draft.backend === "sandbox" ? (
        <Panel title={copy.executionConfigSandbox}>
          <label className="execution-config-field">
            <span>{copy.executionConfigRuntime}</span>
            <Select
              value={draft.sandbox.runtime}
              onChange={(value) => setSandbox({ runtime: value })}
              options={[{ value: "docker", label: "docker" }, { value: "podman", label: "podman" }]}
            />
          </label>
          <label className="execution-config-field">
            <span>{copy.executionConfigImage}</span>
            <input value={draft.sandbox.image} onChange={(e) => setSandbox({ image: e.target.value })} />
          </label>
          <label className="execution-config-field">
            <span>{copy.executionConfigSocket}</span>
            <input value={draft.sandbox.socket} onChange={(e) => setSandbox({ socket: e.target.value })} />
          </label>
          <label className="execution-config-field">
            <span>{copy.executionConfigNetwork}</span>
            <Select
              value={draft.sandbox.network}
              onChange={(value) => setSandbox({ network: value })}
              options={[
                { value: "bridge", label: copy.executionConfigNetworkBridge },
                { value: "none", label: copy.executionConfigNetworkNone },
              ]}
            />
          </label>
          <label className="execution-config-field">
            <span>{copy.executionConfigMemory}</span>
            <input value={draft.sandbox.memory} onChange={(e) => setSandbox({ memory: e.target.value })} />
          </label>
          <label className="execution-config-field">
            <span>{copy.executionConfigCpus}</span>
            <InputNumber min={1} value={draft.sandbox.cpus} onChange={(v) => v && setSandbox({ cpus: v })} />
          </label>
          <label className="execution-config-field">
            <span>{copy.executionConfigPids}</span>
            <InputNumber min={1} value={draft.sandbox.pids_limit} onChange={(v) => v && setSandbox({ pids_limit: v })} />
          </label>
          <label className="execution-config-field">
            <span>{copy.executionConfigTimeout}</span>
            <InputNumber min={1} value={draft.sandbox.timeout_ms} onChange={(v) => v && setSandbox({ timeout_ms: v })} />
          </label>
          <label className="execution-config-field">
            <span>{copy.executionConfigMaxOutput}</span>
            <InputNumber min={1} value={draft.sandbox.max_output_bytes} onChange={(v) => v && setSandbox({ max_output_bytes: v })} />
          </label>
        </Panel>
      ) : (
        <Panel title={copy.executionConfigLocal}>
          <div className="execution-config-warning">{copy.executionConfigLocalWarning}</div>
          <label className="execution-config-field">
            <span>{copy.executionConfigAllowUnsafe}</span>
            <Select
              value={draft.local.allow_unsafe}
              onChange={(value) => setLocal({ allow_unsafe: value })}
              options={[
                { value: false, label: copy.executionConfigOff },
                { value: true, label: copy.executionConfigOn },
              ]}
            />
          </label>
          <label className="execution-config-field">
            <span>{copy.executionConfigTimeout}</span>
            <InputNumber min={1} value={draft.local.timeout_ms} onChange={(v) => v && setLocal({ timeout_ms: v })} />
          </label>
          <label className="execution-config-field">
            <span>{copy.executionConfigMaxOutput}</span>
            <InputNumber min={1} value={draft.local.max_output_bytes} onChange={(v) => v && setLocal({ max_output_bytes: v })} />
          </label>
        </Panel>
      )}

      <Space>
        <Button type="primary" loading={saving} onClick={() => void save()}>{copy.settingsSave}</Button>
        <Button disabled={saving || payload.source === "file"} onClick={() => void reset()}>{copy.executionConfigResetButton}</Button>
      </Space>
    </div>
  );
}

function formatUpdated(at: string, by?: string): string {
  return `${at}${by ? ` · ${by}` : ""}`;
}
