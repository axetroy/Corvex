import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Input, InputNumber, Select, Space, Switch, Tag, Typography } from "antd";
import { fetchJson, sendJson } from "../lib/api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../lib/i18n.js";
import type { SettingsResponse } from "../lib/types.js";
import { searchBackendIds, type SearchBackendId } from "../../../search-backends.js";
import "./SearchSettingsPage.css";

const backendCopyKeys: Record<SearchBackendId, keyof Copy> = {
  tavily: "searchBackendTavily",
  exa: "searchBackendExa",
  you: "searchBackendYou",
  wikipedia: "searchBackendWikipedia",
  hackernews: "searchBackendHackerNews",
  duckduckgo: "searchBackendDuckduckgo",
  searxng: "searchBackendSearxng",
};

interface Draft {
  webEnabled: boolean;
  webSearchEnabled: boolean;
  blockedHosts: string[];
  maxQueries: number;
  order: SearchBackendId[];
  enabled: SearchBackendId[];
  tavilyKey: string;
  searxngUrl: string;
}

function draftFrom(settings: Record<string, unknown>): Draft {
  const configured = Array.isArray(settings.web_search_backends)
    ? settings.web_search_backends.filter((item): item is SearchBackendId =>
        typeof item === "string" && (searchBackendIds as readonly string[]).includes(item))
    : [];
  const enabled = [...new Set(configured)];
  const order = [
    ...enabled,
    ...searchBackendIds.filter((id) => !enabled.includes(id)),
  ];
  return {
    webEnabled: settings.web_enabled === true,
    webSearchEnabled: settings.web_search_enabled === true,
    blockedHosts: Array.isArray(settings.web_blocked_hosts)
      ? settings.web_blocked_hosts.map(String)
      : [],
    maxQueries: typeof settings.web_search_max_queries === "number" ? settings.web_search_max_queries : 5,
    order,
    enabled,
    tavilyKey: typeof settings.tavily_api_key === "string" ? settings.tavily_api_key : "",
    searxngUrl: typeof settings.searxng_base_url === "string" ? settings.searxng_base_url : "",
  };
}

function sameDraft(left: Draft, right: Draft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 搜索专用设置页：后端按用户排序 + 启停，标签页保存只提交本页负责的键。 */
export function SearchSettingsPage({ copy, onUpdated }: { copy: Copy; onUpdated: (value: string) => void }) {
  const [initial, setInitial] = useState<Draft>();
  const [draft, setDraft] = useState<Draft>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const dragIndex = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    fetchJson<SettingsResponse>("/api/ops/settings", copy)
      .then((response) => {
        if (!active) return;
        const next = draftFrom(response.settings as Record<string, unknown>);
        setInitial(next);
        setDraft(next);
        setError("");
      })
      .catch((cause: unknown) => active && setError(errorMessage(cause)));
    return () => { active = false; };
  }, [copy]);

  const dirty = useMemo(() => Boolean(initial && draft && !sameDraft(initial, draft)), [initial, draft]);

  function patch(next: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...next } : current));
    setNotice("");
  }

  function move(from: number, to: number) {
    if (!draft || to < 0 || to >= draft.order.length || from === to) return;
    const order = [...draft.order];
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item!);
    patch({ order });
  }

  function toggle(id: SearchBackendId, enabled: boolean) {
    if (!draft) return;
    const enabledList = enabled
      ? [...draft.enabled.filter((item) => item !== id), id]
      : draft.enabled.filter((item) => item !== id);
    // 保持 order 顺序，只按启用集合筛选，避免勾选改变排序。
    patch({ enabled: draft.order.filter((item) => enabledList.includes(item)) });
  }

  async function save() {
    if (!draft) return;
    if (!dirty) {
      setNotice(copy.settingsNoChanges);
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await sendJson<SettingsResponse>("/api/ops/settings/patch", {
        settings: {
          web_enabled: draft.webEnabled,
          web_search_enabled: draft.webSearchEnabled,
          web_blocked_hosts: draft.blockedHosts,
          web_search_max_queries: draft.maxQueries,
          web_search_backends: draft.order.filter((id) => draft.enabled.includes(id)),
          tavily_api_key: draft.tavilyKey,
          searxng_base_url: draft.searxngUrl,
        },
      }, copy, "POST");
      const next = draftFrom(response.settings as Record<string, unknown>);
      setInitial(next);
      setDraft(next);
      setNotice(copy.settingsSaved);
      onUpdated(new Date().toISOString());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  if (error && !draft) return <div className="search-settings-page"><Typography.Text type="danger">{error}</Typography.Text></div>;
  if (!draft) return <div className="search-settings-page">{copy.loading}</div>;

  return (
    <div className="search-settings-page">
      <div className="search-settings-head">
        <div>
          <Typography.Title level={3}>{copy.settingsGroupSearch}</Typography.Title>
          <Typography.Paragraph type="secondary">{copy.settingsGroupSearchHint}</Typography.Paragraph>
        </div>
        <Button type="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
          {copy.settingsSave}
        </Button>
      </div>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      {notice ? <Typography.Text type="success">{notice}</Typography.Text> : null}

      <div className="search-settings-grid">
        <Card title={copy.settingsGroupTools} size="small">
          <div className="search-setting-row">
            <div>
              <div className="search-setting-label">{copy.settingsWebEnabled}</div>
              <div className="search-setting-hint">{copy.settingsWebEnabledHint}</div>
            </div>
            <Switch
              checked={draft.webEnabled}
              onChange={(value) => patch({ webEnabled: value })}
              aria-label={copy.settingsWebEnabled}
            />
          </div>
          <div className="search-setting-row">
            <div>
              <div className="search-setting-label">{copy.settingsWebBlockedHosts}</div>
              <div className="search-setting-hint">{copy.settingsWebBlockedHostsHint}</div>
            </div>
          </div>
          <Select
            mode="tags"
            className="search-settings-blocked"
            value={draft.blockedHosts}
            onChange={(values) => patch({ blockedHosts: values.map(String) })}
            placeholder={copy.settingsWebBlockedHosts}
            tokenSeparators={[",", " "]}
          />

          <div className="search-setting-row">
            <div>
              <div className="search-setting-label">{copy.settingsWebSearchEnabled}</div>
              <div className="search-setting-hint">{copy.settingsWebSearchEnabledHint}</div>
            </div>
            <Switch
              checked={draft.webSearchEnabled}
              onChange={(value) => patch({ webSearchEnabled: value })}
              aria-label={copy.settingsWebSearchEnabled}
            />
          </div>
          <div className="search-setting-row">
            <div>
              <div className="search-setting-label">{copy.settingsWebSearchMaxQueries}</div>
              <div className="search-setting-hint">{copy.settingsWebSearchMaxQueriesHint}</div>
            </div>
            <InputNumber
              min={1}
              max={50}
              value={draft.maxQueries}
              onChange={(value) => patch({ maxQueries: Number(value ?? 1) })}
            />
          </div>
        </Card>

        <Card title={copy.settingsWebSearchBackends} size="small">
          <Typography.Paragraph type="secondary" className="search-backend-hint">
            {copy.searchSettingsOrder}
          </Typography.Paragraph>
          <div className="search-backend-list">
            {draft.order.map((id, index) => {
              const enabled = draft.enabled.includes(id);
              return (
                <div
                  key={id}
                  className={`search-backend-row${enabled ? " is-enabled" : ""}`}
                  draggable
                  onDragStart={() => { dragIndex.current = index; }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragIndex.current !== null) move(dragIndex.current, index);
                    dragIndex.current = null;
                  }}
                >
                  <span className="search-backend-drag" aria-hidden="true">⠿</span>
                  <span className="search-backend-index">{index + 1}</span>
                  <Switch
                    size="small"
                    checked={enabled}
                    onChange={(value) => toggle(id, value)}
                    aria-label={`${copy.searchSettingsEnable} ${id}`}
                  />
                  <div className="search-backend-body">
                    <div className="search-backend-name">
                      <code>{id}</code>
                      {id === "tavily" && draft.tavilyKey ? <Tag color="blue">key</Tag> : <Tag>keyless</Tag>}
                    </div>
                    <div className="search-backend-desc">{copy[backendCopyKeys[id]] as string}</div>
                  </div>
                  <Space size={0} className="search-backend-actions">
                    <Button type="text" size="small" disabled={index === 0} onClick={() => move(index, index - 1)}
                      aria-label={copy.searchSettingsMoveUp}>↑</Button>
                    <Button type="text" size="small" disabled={index === draft.order.length - 1}
                      onClick={() => move(index, index + 1)} aria-label={copy.searchSettingsMoveDown}>↓</Button>
                  </Space>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title={copy.settingsSearxngBaseUrl} size="small" className="search-settings-credentials">
          <div className="search-setting-label">{copy.settingsTavilyApiKey}</div>
          <div className="search-setting-hint">{copy.settingsTavilyApiKeyHint}</div>
          <Input.Password
            value={draft.tavilyKey}
            onChange={(event) => patch({ tavilyKey: event.target.value })}
            placeholder={copy.settingsTavilyApiKey}
            autoComplete="new-password"
          />
          <div className="search-setting-label search-settings-spaced">{copy.settingsSearxngBaseUrl}</div>
          <div className="search-setting-hint">{copy.settingsSearxngBaseUrlHint}</div>
          <Input
            value={draft.searxngUrl}
            onChange={(event) => patch({ searxngUrl: event.target.value })}
            placeholder="https://searx.example.com"
          />
        </Card>
      </div>
    </div>
  );
}
