import { useEffect, useMemo, useState } from "react";
import { Alert, Button, InputNumber, Switch, Typography } from "antd";
import "./SettingsPage.css";
import { fetchJson, sendJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy, CopyTextKey } from "../i18n.js";
import { settingGroups } from "../types.js";
import type { SettingsResponse, SettingField } from "../types.js";
import { ErrorBanner, Loading, PageHeading, Panel } from "./common.js";

/** 设置元数据里的文案键是普通字符串，查表时收窄为 Copy 的文案键。 */
function text(copy: Copy, key: string): string {
  return copy[key as CopyTextKey] ?? key;
}

interface Props {
  copy: Copy;
  refreshToken: number;
  onUpdated: (value: string) => void;
  onRefresh: () => void;
}

/** 可编辑的草稿值：数字或布尔，键与设置键一致。 */
type Draft = Record<string, number | boolean>;

/** 比较两份草稿是否完全一致，用于判断是否有未保存修改。 */
function sameDraft(a: Draft, b: Draft): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** 校验单个数字字段；合法返回错误信息为空。 */
function fieldError(field: SettingField, value: number | boolean | undefined, copy: Copy): string {
  if (field.kind === "boolean") return "";
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

/** 设置页：在界面上调整模型上下文窗口、提示词预算与压缩阈值。 */
export function SettingsPage({ copy, refreshToken, onUpdated, onRefresh }: Props) {
  const [data, setData] = useState<SettingsResponse>();
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

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

  const setValue = (key: string, value: number | boolean) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice("");
  };

  // 恢复单个字段到配置文件的值；base 缺失（读盘失败）时禁用该按钮。
  const resetField = (field: SettingField) => {
    if (!base) return;
    setValue(field.key, base[field.key] as number | boolean);
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

  const problems = settingGroups.flatMap((group) =>
    group.fields.map((field) => fieldError(field, draft[field.key], copy)).filter(Boolean),
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

      {settingGroups.map((group) => (
        <Panel key={group.titleKey} title={text(copy, group.titleKey)}>
          <Typography.Paragraph type="secondary" className="settings-group-hint">
            {text(copy, group.hintKey)}
          </Typography.Paragraph>
          <div className="settings-fields">
            {group.fields.map((field) => {
              const value = draft[field.key];
              const overridden = Boolean(data.overrides[field.key]);
              const invalid = fieldError(field, value, copy);
              return (
                <div className="settings-field" key={field.key}>
                  <div className="settings-field-label">
                    <Typography.Text strong>{text(copy, field.labelKey)}</Typography.Text>
                    {overridden ? <span className="settings-badge">{copy.settingsOverridden}</span> : null}
                  </div>
                  <div className="settings-field-control">
                    {field.kind === "boolean" ? (
                      <Switch
                        checked={value === true}
                        disabled={!editable}
                        onChange={(checked) => setValue(field.key, checked)}
                      />
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
                    {base ? (
                      <Button type="link" size="small" disabled={!editable} onClick={() => resetField(field)}>
                        {copy.settingsReset}
                      </Button>
                    ) : null}
                  </div>
                  <Typography.Text type="secondary" className="settings-field-hint">
                    {text(copy, field.hintKey)}
                  </Typography.Text>
                  {invalid ? <Typography.Text type="danger" className="settings-field-error">{invalid}</Typography.Text> : null}
                </div>
              );
            })}
          </div>
        </Panel>
      ))}
    </>
  );
}
