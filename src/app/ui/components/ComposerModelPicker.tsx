import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Select, Tag, Tooltip, Typography } from "antd";
import { fetchJson, sendJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import type { ModelProviderDetails } from "../types.js";
import {
  activeModelSelection,
  findModelSelection,
  formatContextWindowK,
  modelOptionValue,
  modelSelectGroups,
  thinkingLevelOptions,
  defaultThinkingLevel,
} from "../modelPicker.js";

interface Props {
  copy: Copy;
  /** 有轮次正在执行时禁止切换，避免改变本轮后续请求使用的模型。 */
  disabled?: boolean;
}

/**
 * 输入框内的模型切换器：读取全局模型目录，选中后立即把该模型设为使用中。
 *
 * 模型只保存在服务端（一份全局配置），所以这里调用 `activate` 接口而不是本地状态；
 * 切换成功后同步更新本地列表，失败时重新读取目录以还原真实状态。
 */
export function ComposerModelPicker({ copy, disabled }: Props) {
  const [providers, setProviders] = useState<ModelProviderDetails[]>([]);
  const [thinkingLevel, setThinkingLevel] = useState<string>(defaultThinkingLevel);
  const [reasoningEnabled, setReasoningEnabled] = useState(true);
  const [switchingThinking, setSwitchingThinking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchJson<{ items: ModelProviderDetails[]; thinkingLevel?: string; reasoningEnabled?: boolean }>("/api/ops/me/model-providers", copy)
      .then((response) => {
        if (!active) return;
        setProviders(response.items);
        setThinkingLevel(response.thinkingLevel ?? defaultThinkingLevel);
        setReasoningEnabled(response.reasoningEnabled ?? true);
        setError("");
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [copy, reloadToken]);

  const groups = useMemo(() => modelSelectGroups(providers), [providers]);
  const active = useMemo(() => activeModelSelection(providers), [providers]);
  const activeValue = active ? modelOptionValue(active.provider.id, active.model.id) : undefined;
  const hasModels = groups.length > 0;

  // 分组标题标出系统级供应商；选项同时展示上下文窗口（K）。
  const selectGroups: Array<{ label: ReactNode; options: Array<{ label: ReactNode; value: string }> }> = groups.map((group) => ({
    label: (
      <span className="composer-model-group">
        <span>{group.label}</span>
        {group.system ? <Tag className="composer-model-system">{copy.systemProviderBadge}</Tag> : null}
      </span>
    ),
    options: group.options.map((option) => ({
      value: option.value,
      label: (
        <span className="composer-model-option">
          <span className="composer-model-option-name">{option.label}</span>
          <span className="composer-model-option-context">{option.context}</span>
        </span>
      ),
    })),
  }));

  const thinkingLabelKey = thinkingLevelOptions.find((option) => option.value === thinkingLevel)?.labelKey ?? "thinkingLevelMedium";

  const activeLabel: ReactNode = active ? (
    <span className="conversation-composer-model-value">
      {active.provider.name} / {active.model.name}
      <span className="composer-model-option-context">{formatContextWindowK(active.model.contextWindow)}</span>
      {active.provider.ownerUserId === "" ? (
        <Tag className="composer-model-system">{copy.systemProviderBadge}</Tag>
      ) : null}
    </span>
  ) : copy.composerModelEmpty;

  async function switchThinking(value: string) {
    const previous = thinkingLevel;
    setThinkingLevel(value);
    setSwitchingThinking(true);
    setError("");
    try {
      await sendJson("/api/ops/me/thinking-level", { thinkingLevel: value }, copy, "POST");
    } catch (cause) {
      setThinkingLevel(previous);
      setError(errorMessage(cause));
    } finally {
      setSwitchingThinking(false);
    }
  }

  async function switchModel(value: string) {
    const target = findModelSelection(providers, value);
    if (!target || target.model.active) return;
    setSwitching(true);
    setError("");
    try {
      const path = `/api/ops/me/model-providers/${encodeURIComponent(target.provider.id)}/models/${encodeURIComponent(target.model.id)}/activate`;
      await sendJson(path, {}, copy, "POST");
      setProviders((current) =>
        current.map((provider) => ({
          ...provider,
          models: provider.models.map((model) => ({
            ...model,
            active: provider.id === target.provider.id && model.id === target.model.id,
          })),
        })),
      );
    } catch (cause) {
      setError(errorMessage(cause));
      // 失败后重新读取，避免本地列表与服务端的实际使用项不一致。
      setReloadToken((token) => token + 1);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="conversation-composer-model">
      <Tooltip title={copy.composerModelHint}>
        <span className="conversation-composer-model-label">{copy.composerModel}</span>
      </Tooltip>
      <Select<string>
        className="conversation-composer-model-select"
        aria-label={copy.composerModel}
        variant="borderless"
        size="small"
        popupMatchSelectWidth={false}
        value={hasModels ? activeValue : undefined}
        placeholder={copy.composerModelEmpty}
        options={selectGroups}
        loading={loading || switching}
        disabled={disabled || switching || !hasModels}
        labelRender={() => activeLabel}
        onChange={(value) => void switchModel(value)}
      />
      <Tooltip title={reasoningEnabled ? copy.composerThinkingHint : copy.composerThinkingDisabled}>
        <span className="conversation-composer-model-label">{copy.composerThinking}</span>
      </Tooltip>
      <Select<string>
        className="conversation-composer-thinking-select"
        aria-label={copy.composerThinking}
        variant="borderless"
        size="small"
        // 弹层不跟随选择器宽度（选择器被压到只显示当前值），否则选项文字被挤成单字。
        popupMatchSelectWidth={false}
        value={thinkingLevel}
        options={thinkingLevelOptions.map((option) => ({ value: option.value, label: copy[option.labelKey] }))}
        loading={switchingThinking}
        disabled={disabled || switchingThinking || !reasoningEnabled}
        labelRender={() => (
          <span className="conversation-composer-thinking-value">
            {copy[thinkingLabelKey]}
            {thinkingLevel === defaultThinkingLevel ? (
              <span className="conversation-composer-thinking-default">{copy.composerThinkingDefault}</span>
            ) : null}
          </span>
        )}
        onChange={(value) => void switchThinking(value)}
      />
      {error ? (
        <Typography.Text type="danger" ellipsis className="conversation-composer-model-error" title={error}>
          {error}
        </Typography.Text>
      ) : null}
    </div>
  );
}
