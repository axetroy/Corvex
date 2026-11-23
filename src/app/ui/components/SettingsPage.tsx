import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, InputNumber, Select, Switch, Typography } from "antd";
import "./SettingsPage.css";
import { fetchJson, sendJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy, CopyTextKey, Locale } from "../i18n.js";
import { settingGroups } from "../types.js";
import { buildSettingsPayload } from "../settingsPayload.js";
import type { SettingField, SettingValue, SettingsResponse } from "../types.js";
import { ErrorBanner, Loading, PageHeading, Panel } from "./common.js";
import { StorageCleanupPanel } from "./StorageCleanupPanel.js";
import { ModelManager } from "./ModelManager.js";

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

/** 按字段单位格式化数字；token 用千分位，字节用可读单位，列表用逗号连接。 */
function formatFieldValue(field: SettingField, value: SettingValue): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (field.unit === "byte") return formatBytes(value);
  return value.toLocaleString("en-US");
}

export type SettingsSection = "basic" | "model" | "gitlab" | "workflow" | "storage" | "advanced";

/** 每个设置分组用侧栏同名标签作为页头标题，避免六个页面都显示「Agent 设置」。 */
const sectionTitleKeys: Record<SettingsSection, CopyTextKey> = {
  basic: "settingsTabBasic",
  model: "settingsTabModel",
  gitlab: "settingsTabGitLab",
  workflow: "settingsTabWorkflow",
  storage: "settingsTabStorage",
  advanced: "settingsTabAdvanced",
};

/** 页头描述复用对应设置分组的说明，避免所有页面都显示同一段上下文预算文案。 */
const sectionDescriptionKeys: Record<SettingsSection, CopyTextKey> = {
  basic: "settingsGroupBudgetHint",
  model: "settingsGroupModelHint",
  gitlab: "settingsGroupGitLabHint",
  workflow: "settingsGroupToolsHint",
  storage: "settingsGroupStorageHint",
  advanced: "settingsGroupAdvancedHint",
};

/** 每个设置分区实际渲染的字段分组；校验只对当前可见字段生效，避免其他分区的隐藏字段禁用保存按钮。 */
export const sectionGroups: Record<SettingsSection, readonly string[]> = {
  basic: ["settingsGroupBudget"],
  model: ["settingsGroupModel", "settingsGroupQuota"],
  gitlab: ["settingsGroupGitLab"],
  workflow: ["settingsGroupTools"],
  storage: ["settingsGroupStorage"],
  advanced: ["settingsGroupRuntime", "settingsGroupAdvanced"],
};

interface Props {
  copy: Copy;
  locale: Locale;
  section?: SettingsSection;
  onUpdated: (value: string) => void;
  onRefresh: () => void;
}

/** 可编辑的草稿值：数字、布尔、字符串或字符串列表，键与设置键一致。 */
type Draft = Record<string, SettingValue>;

/** 比较两份草稿是否完全一致，用于判断是否有未保存修改。 */
function sameDraft(a: Draft, b: Draft): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  return true;
}

/** 校验单个字段；合法返回错误信息为空。 */
function fieldError(field: SettingField, value: SettingValue | undefined, copy: Copy): string {
  if (field.kind === "boolean") return "";
  if (field.kind === "list") {
    if (!Array.isArray(value)) return copy.settingsInvalidText;
    if (value.some((item) => !item.trim())) return copy.settingsInvalidText;
    if (field.item === "integer" && value.some((item) => !/^[1-9][0-9]*$/.test(item.trim()))) {
      return copy.settingsInvalidNumber
        .replace("{min}", String(field.min ?? 0))
        .replace("{max}", String(field.max ?? 0));
    }
    return "";
  }
  if (field.kind === "string") {
    if (typeof value !== "string" || (!field.secret && !field.allowEmpty && !value.trim())) return copy.settingsInvalidText;
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
export function SettingsPage({ copy, locale, section = "basic", onUpdated, onRefresh }: Props) {
  const [data, setData] = useState<SettingsResponse>();
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [settingsToken, setSettingsToken] = useState(0);

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
    // 设置页不跟随全局的 15 秒轮询刷新：那会用服务端值覆盖用户正在填写的表单。
    // 模型目录变更会通过 settingsToken 显式触发重新读取。
  }, [copy, onUpdated, settingsToken]);

  const editable = data?.editable ?? false;
  const serverKeys = new Set(Object.keys(data?.settings ?? {}));
  const dirty = useMemo(
    () => (data ? !sameDraft(draft, data.settings) : false),
    [data, draft],
  );

  if (error && !data) return <ErrorBanner message={error} />;
  if (!data) return <Loading>{copy.loading}</Loading>;

  const setValue = (key: string, value: SettingValue) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice("");
  };

  const save = async () => {
    if (!dirty) {
      setNotice(copy.settingsNoChanges);
      return;
    }
    // 只提交服务端实际管理的键；前端比服务端新时跳过新键，避免 unknown setting。
    const payload = buildSettingsPayload(settingGroups, draft, serverKeys);
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

  const visibleGroups = settingGroups.filter((group) => sectionGroups[section].includes(group.titleKey));
  const problems = visibleGroups.flatMap((group) =>
    group.fields
      // 与保存负载保持一致：服务端不管理的键（前端较新时）不参与校验，也不能禁用保存。
      .filter((field) => serverKeys.has(field.key))
      // 与输入框展示的值保持一致：草稿缺失时用字段默认值，避免产生不可见的校验错误。
      .map((field) => fieldError(field, draft[field.key] ?? field.defaultValue, copy))
      .filter(Boolean),
  );

  /** 渲染一组字段；高级分组复用同一套控件。 */
  const renderFields = (fields: readonly SettingField[]) => (
    <div className="settings-fields">
      {fields.map((field) => {
        const value = draft[field.key] ?? field.defaultValue;
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
              ) : field.kind === "list" ? (
                <Select
                  className="settings-select settings-select-tags"
                  mode="tags"
                  tokenSeparators={[",", " ", "\n"]}
                  value={Array.isArray(value) ? value : []}
                  options={[]}
                  disabled={!editable}
                  status={invalid ? "error" : undefined}
                  onChange={(next: string[]) => setValue(field.key, next)}
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
                    placeholder={copy.settingsSecretConfigured}
                    maxLength={field.maxLength}
                    disabled={!editable}
                    status={invalid ? "error" : undefined}
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
                  {field.unit === "byte"
                    ? copy.settingsUnitBytes
                    : field.unit === "second"
                      ? copy.settingsUnitSeconds
                      : field.unit === "%"
                        ? copy.settingsUnitPercent
                        : copy.settingsUnitTokens}
                </span>
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
  const renderGroup = (titleKey: string) => {
    const group = groupsByTitle.get(titleKey);
    if (!group) return null;
    return (
      <Panel key={titleKey} title={text(copy, group.titleKey)}>
        <Typography.Paragraph type="secondary" className="settings-group-hint">
          {text(copy, group.hintKey)}
        </Typography.Paragraph>
        {renderFields(group.fields)}
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
        title={copy[sectionTitleKeys[section]]}
        description={copy[sectionDescriptionKeys[section]]}
        actions={(
          <div className="settings-actions">
            <Button type="primary" loading={saving} disabled={!editable || !dirty || problems.length > 0} onClick={() => void save()}>
              {saving ? copy.settingsSaving : copy.settingsSave}
            </Button>
          </div>
        )}
      />
      {editable && data.configPath ? (
        <p className="settings-config-path">
          {copy.settingsConfigPath}: <code>{data.configPath}</code>
        </p>
      ) : null}
      {notice ? <Alert className="settings-alert" type="success" showIcon message={notice} /> : null}
      {dirty && !notice ? <Alert className="settings-alert" type="info" showIcon message={copy.settingsDirty} /> : null}

      {section === "basic" ? renderGroup("settingsGroupBudget") : null}
      {section === "model" ? (
        <>
          <Typography.Paragraph type="secondary" className="settings-group-hint">
            {copy.settingsModelConnectionHint}
          </Typography.Paragraph>
          <ModelManager copy={copy} onChanged={() => setSettingsToken((value) => value + 1)} />
          {derivedPanel}
          {renderGroup("settingsGroupModel")}
          {renderGroup("settingsGroupQuota")}
        </>
      ) : null}
      {section === "gitlab" ? renderGroup("settingsGroupGitLab") : null}
      {section === "workflow" ? (
        <>
          {renderGroup("settingsGroupTools")}
          {renderGroup("settingsGroupReview")}
          {renderGroup("settingsGroupWorkflow")}
        </>
      ) : null}
      {section === "storage" ? (
        <>
          {renderGroup("settingsGroupStorage")}
          <StorageCleanupPanel
            copy={copy}
            locale={locale}
            retentionDays={Number(data.effective.storage_retention_days ?? 30)}
          />
        </>
      ) : null}
      {section === "advanced" ? (
        <>
          {renderGroup("settingsGroupRuntime")}
          {renderGroup("settingsGroupAdvanced")}
        </>
      ) : null}
    </>
  );
}
