import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, InputNumber, Select, Switch, Tabs, Typography } from "antd";
import "./SettingsPage.css";
import { fetchJson, sendJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy, CopyTextKey, Locale } from "../i18n.js";
import { settingGroups } from "../types.js";
import type { SettingField, SettingsResponse } from "../types.js";
import { ErrorBanner, Loading, PageHeading, Panel } from "./common.js";
import { StorageCleanupPanel } from "./StorageCleanupPanel.js";

/** 设置元数据里的文案键是普通字符串，查表时收窄为 Copy 的文案键。 */
function text(copy: Copy, key: string): string {
  return copy[key as CopyTextKey] ?? key;
}

/** 把字节数格式化为 KiB/MiB，避免生效值出现七位数字。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(bytes % (1 << 20) === 0 ? 0 : 1)} MiB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(bytes % (1 << 10) === 0 ? 0 : 1)} KiB`;
  return `${bytes} B`;
}

/** 按字段单位格式化数字；token 用千分位，字节用可读单位，字符串原样返回。 */
function formatFieldValue(field: SettingField, value: number | boolean | string): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (field.unit === "byte") return formatBytes(value);
  return value.toLocaleString("en-US");
}

interface Props {
  copy: Copy;
  locale: Locale;
  refreshToken: number;
  onUpdated: (value: string) => void;
  onRefresh: () => void;
}

/** 可编辑的草稿值：数字、布尔或字符串，键与设置键一致。 */
type Draft = Record<string, number | boolean | string>;

/** 比较两份草稿是否完全一致，用于判断是否有未保存修改。 */
function sameDraft(a: Draft, b: Draft): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** 校验单个字段；合法返回错误信息为空。 */
function fieldError(field: SettingField, value: number | boolean | string | undefined, copy: Copy): string {
  if (field.kind === "boolean") return "";
  if (field.kind === "string") {
    if (typeof value !== "string" || !value.trim()) return copy.settingsInvalidText;
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      return copy.settingsInvalidTextMax.replace("{max}", String(field.maxLength));
    }
    return "";
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return copy.settingsInvalidNumber
      .replace("{min}", String(field.min ?? 0))
      .replace("{max}", String(field.max ?? 0));
  }
  if (field.min !== undefined && value < field.min) {
    return copy.settingsInvalidNumber
      .replace("{min}", String(field.min))
      .replace("{max}", String(field.max ?? 0));
  }
  if (field.max !== undefined && value > field.max) {
    return copy.settingsInvalidNumber
      .replace("{min}", String(field.min ?? 0))
      .replace("{max}", String(field.max));
  }
  return "";
}

/** 设置页：调整上下文预算、工具开关、审查上限与修复权限。 */
export function SettingsPage({ copy, locale, refreshToken, onUpdated, onRefresh }: Props) {
  const [data, setData] = useState<SettingsResponse>();
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState("basic");

  useEffect(() => {
    let active = true;
    fetchJson<SettingsResponse>("/api/ops/settings", copy)
      .then((response) => {
        if (!active) return;
        setData(response);
        setDraft({ ...response.settings });
        setError("");
        onUpdated(new Date().toISOString());
      })
      .catch((cause: unknown) => active && setError(errorMessage(cause)));
    return () => {
      active = false;
    };
  }, [copy, refreshToken, onUpdated]);

  const editable = data?.editable ?? false;
  const base = data?.base ?? null;
  const dirty = useMemo(
    () => (data ? !sameDraft(draft, data.settings) : false),
    [data, draft],
  );

  if (error && !data) return <ErrorBanner message={error} />;
  if (!data) return <Loading>{copy.loading}</Loading>;

  const setValue = (key: string, value: number | boolean | string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice("");
  };

  // 恢复单个字段到配置文件的值；base 缺失（读盘失败）时禁用该按钮。
  const resetField = (field: SettingField) => {
    if (!base) return;
    setValue(field.key, base[field.key] as number | boolean | string);
  };

  const resetAll = () => {
    if (base) setDraft({ ...base });
    else setDraft({ ...data.settings });
    setNotice("");
  };

  const save = async () => {
    if (!dirty) {
      setNotice(copy.settingsNoChanges);
      return;
    }
    // 只提交与配置文件不同的键：相同即视为「无覆盖」，服务端据此删除旧覆盖项。
    const payload: Draft = {};
    for (const group of settingGroups) {
      for (const field of group.fields) {
        const value = draft[field.key];
        const baseline = base ? base[field.key] : undefined;
        if (base && value === baseline) continue;
        payload[field.key] = value;
      }
    }
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const response = await sendJson<SettingsResponse>("/api/ops/settings", { settings: payload }, copy);
      setData(response);
      setDraft({ ...response.settings });
      setNotice(copy.settingsSaved);
      onUpdated(new Date().toISOString());
      onRefresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  // 只校验将要提交的字段：与配置文件基线相同的字段不会写入覆盖项，
  // 例如未启用 Agent 时留空的模型名不应阻塞其它设置的保存。
  const problems = settingGroups.flatMap((group) =>
    group.fields
      .filter((field) => !(base && draft[field.key] === base[field.key]))
      .map((field) => fieldError(field, draft[field.key], copy))
      .filter(Boolean),
  );

  /** 渲染一组字段；hideReset 用于完全由 Web 管理的分组（如模型连接信息）。 */
  const renderFields = (fields: readonly SettingField[], hideReset = false) => (
    <div className="settings-fields">
      {fields.map((field) => {
        const value = draft[field.key];
        const overridden = Boolean(data.overrides[field.key]);
        const meta = data.overrideMeta[field.key];
        const invalid = fieldError(field, value, copy);
        const effective = data.effective[field.key];
        const saved = data.settings[field.key];
        const adjusted = data.adjusted.includes(field.key) && effective !== saved;
        return (
          <div className="settings-field" key={field.key}>
            <div className="settings-field-label">
              <Typography.Text strong>{text(copy, field.labelKey)}</Typography.Text>
              {overridden ? <span className="settings-badge">{copy.settingsOverridden}</span> : null}
              {adjusted ? <span className="settings-badge settings-badge-adjusted">{copy.settingsAutoAdjusted}</span> : null}
            </div>
            <div className="settings-field-control">
              {field.kind === "boolean" ? (
                <Switch
                  checked={value === true}
                  disabled={!editable}
                  onChange={(checked) => setValue(field.key, checked)}
                />
              ) : field.kind === "string" ? (
                field.values ? (
                  <Select
                    className="settings-select"
                    value={typeof value === "string" ? value : undefined}
                    options={field.values.map((option) => ({ value: option, label: option }))}
                    disabled={!editable}
                    status={invalid ? "error" : undefined}
                    onChange={(next) => setValue(field.key, next)}
                  />
                ) : field.secret ? (
                  <Input.Password
                    className="settings-text"
                    value={typeof value === "string" ? value : ""}
                    placeholder={data.overrides[field.key] ? copy.settingsSecretConfigured : undefined}
                    maxLength={field.maxLength}
                    disabled={!editable}
                    status={invalid ? "error" : undefined}
                    autoComplete="new-password"
                    onChange={(event) => setValue(field.key, event.target.value)}
                  />
                ) : (
                  <Input
                    className="settings-text"
                    value={typeof value === "string" ? value : ""}
                    maxLength={field.maxLength}
                    disabled={!editable}
                    status={invalid ? "error" : undefined}
                    onChange={(event) => setValue(field.key, event.target.value)}
                  />
                )
              ) : (
                <InputNumber
                  className="settings-number"
                  value={typeof value === "number" ? value : undefined}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  disabled={!editable}
                  status={invalid ? "error" : undefined}
                  onChange={(next) => {
                    if (typeof next === "number") setValue(field.key, next);
                  }}
                />
              )}
              {field.unit ? (
                <span className="settings-unit">
                  {field.unit === "byte" ? copy.settingsUnitBytes : copy.settingsUnitTokens}
                </span>
              ) : null}
              {base && !hideReset && !field.secret ? (
                <Button type="link" size="small" disabled={!editable} onClick={() => resetField(field)}>
                  {copy.settingsReset}
                </Button>
              ) : null}
            </div>
            {adjusted ? (
              <Typography.Text className="settings-effective">
                {copy.settingsEffective.replace("{value}", formatFieldValue(field, effective))}
              </Typography.Text>
            ) : null}
            <Typography.Text type="secondary" className="settings-field-hint">
              {text(copy, field.hintKey)}
            </Typography.Text>
            {meta ? (
              <Typography.Text type="secondary" className="settings-field-meta">
                {copy.settingsOverrideBy
                  .replace("{actor}", meta.updatedBy || "ops-console")
                  .replace("{time}", new Date(meta.updatedAt).toLocaleString())}
              </Typography.Text>
            ) : null}
            {invalid ? <Typography.Text type="danger" className="settings-field-error">{invalid}</Typography.Text> : null}
          </div>
        );
      })}
    </div>
  );

  const groupsByTitle = new Map(settingGroups.map((group) => [group.titleKey, group]));
  const renderGroup = (titleKey: string, hideReset = false) => {
    const group = groupsByTitle.get(titleKey);
    if (!group) return null;
    return (
      <Panel key={titleKey} title={text(copy, group.titleKey)}>
        <Typography.Paragraph type="secondary" className="settings-group-hint">
          {text(copy, group.hintKey)}
        </Typography.Paragraph>
        {renderFields(group.fields, hideReset)}
      </Panel>
    );
  };
  const derivedPanel = (
    <Panel title={copy.settingsDerivedTitle}>
      <ul className="settings-derived">
        <li>{copy.settingsDerivedCompaction
          .replace("{value}", data.derived.compactionTriggerTokens.toLocaleString("en-US"))
          .replace("{keep}", data.derived.compactionKeepRecentTokens.toLocaleString("en-US"))}</li>
        <li>{copy.settingsDerivedTools
          .replace("{call}", formatBytes(data.derived.toolCallBytes))
          .replace("{round}", formatBytes(data.derived.toolRoundBytes))}</li>
      </ul>
    </Panel>
  );

  return (
    <>
      {error ? <ErrorBanner message={error} /> : null}
      <PageHeading
        title={copy.settingsTitle}
        description={copy.settingsDescription}
        actions={(
          <div className="settings-actions">
            <Button onClick={resetAll} disabled={!editable || !dirty}>{copy.settingsResetAll}</Button>
            <Button type="primary" loading={saving} disabled={!editable || !dirty || problems.length > 0} onClick={() => void save()}>
              {saving ? copy.settingsSaving : copy.settingsSave}
            </Button>
          </div>
        )}
      />
      {!editable ? <Alert className="settings-alert" type="warning" showIcon message={copy.settingsReadOnly} /> : null}
      {editable && data.configPath ? (
        <p className="settings-config-path">
          {copy.settingsConfigPath}: <code>{data.configPath}</code>
        </p>
      ) : null}
      {notice ? <Alert className="settings-alert" type="success" showIcon message={notice} /> : null}
      {dirty && !notice ? <Alert className="settings-alert" type="info" showIcon message={copy.settingsDirty} /> : null}

      <Tabs
        className="settings-tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: "basic",
            label: copy.settingsTabBasic,
            children: renderGroup("settingsGroupBudget"),
          },
          {
            key: "model",
            label: copy.settingsTabModel,
            children: (
              <>
                <Typography.Paragraph type="secondary" className="settings-group-hint">
                  {copy.settingsModelConnectionHint}
                </Typography.Paragraph>
                {derivedPanel}
                {renderGroup("settingsGroupModel", true)}
                {renderGroup("settingsGroupQuota", true)}
              </>
            ),
          },
          {
            key: "workflow",
            label: copy.settingsTabWorkflow,
            children: (
              <>
                {renderGroup("settingsGroupTools")}
                {renderGroup("settingsGroupReview")}
                {renderGroup("settingsGroupWorkflow")}
              </>
            ),
          },
          {
            key: "storage",
            label: copy.settingsTabStorage,
            children: (
              <>
                {renderGroup("settingsGroupStorage")}
                <StorageCleanupPanel
                  copy={copy}
                  locale={locale}
                  retentionDays={Number(data.effective.storage_retention_days ?? 30)}
                />
              </>
            ),
          },
          {
            key: "advanced",
            label: copy.settingsTabAdvanced,
            children: renderGroup("settingsGroupAdvanced"),
          },
        ]}
      />
    </>
  );
}
