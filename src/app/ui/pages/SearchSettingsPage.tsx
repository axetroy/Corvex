import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, InputNumber, Modal, Select, Switch, Tag, Typography } from "antd";
import { fetchJson, sendJson } from "../lib/api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../lib/i18n.js";
import type { SettingsResponse } from "../lib/types.js";
import { AdminPage } from "../components/AdminPage.js";
import { Panel } from "../components/common.js";
import { searchBackendIds, type SearchBackendId } from "../../../search-backends.js";
import { previewScore, type BackendScore } from "../../../agent/search-health.js";
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
  exaKey: string;
  youKey: string;
  searxngUrl: string;
}

/** 有可选 key 的后端；在列表行内直接编辑。 */
const keyedBackends = new Set<SearchBackendId>(["tavily", "exa", "you"]);
const backendKeyHintKeys: Partial<Record<SearchBackendId, keyof Copy>> = {
  tavily: "settingsTavilyApiKeyHint",
  exa: "settingsExaApiKeyHint",
  you: "settingsYouApiKeyHint",
};

function draftFrom(settings: Record<string, unknown>): Draft {
  const configured = Array.isArray(settings.web_search_backends)
    ? settings.web_search_backends.filter((item): item is SearchBackendId =>
        typeof item === "string" && (searchBackendIds as readonly string[]).includes(item))
    : [];
  const enabled = [...new Set(configured)];
  const order = [...enabled, ...searchBackendIds.filter((id) => !enabled.includes(id))];
  return {
    webEnabled: settings.web_enabled === true,
    webSearchEnabled: settings.web_search_enabled === true,
    blockedHosts: Array.isArray(settings.web_blocked_hosts) ? settings.web_blocked_hosts.map(String) : [],
    maxQueries: typeof settings.web_search_max_queries === "number" ? settings.web_search_max_queries : 5,
    order,
    enabled,
    tavilyKey: typeof settings.tavily_api_key === "string" ? settings.tavily_api_key : "",
    exaKey: typeof settings.exa_api_key === "string" ? settings.exa_api_key : "",
    youKey: typeof settings.you_api_key === "string" ? settings.you_api_key : "",
    searxngUrl: typeof settings.searxng_base_url === "string" ? settings.searxng_base_url : "",
  };
}

/** 搜索专用设置页：沿用 AdminPage 外壳，后端按用户排序 + 启停，保存只提交本页的键。 */
export function SearchSettingsPage({ copy, onUpdated }: { copy: Copy; onUpdated: (value: string) => void }) {
  const [initial, setInitial] = useState<Draft>();
  const [draft, setDraft] = useState<Draft>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingBackend, setEditingBackend] = useState<SearchBackendId | null>(null);
  const [scores, setScores] = useState<BackendScore[]>([]);
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

  const loadScores = useCallback(() => {
    fetchJson<{ items: BackendScore[] }>("/api/ops/search/scores", copy)
      .then((result) => setScores(result.items ?? []))
      .catch(() => undefined);
  }, [copy]);

  useEffect(() => {
    loadScores();
    const timer = window.setInterval(loadScores, 15_000);
    return () => window.clearInterval(timer);
  }, [loadScores]);

  const scoreById = useMemo(
    () => new Map(scores.map((entry) => [entry.id, entry])),
    [scores],
  );

  const dirty = useMemo(() => Boolean(initial && draft && JSON.stringify(initial) !== JSON.stringify(draft)), [initial, draft]);

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
    const chosen = enabled
      ? [...draft.enabled.filter((item) => item !== id), id]
      : draft.enabled.filter((item) => item !== id);
    patch({ enabled: draft.order.filter((item) => chosen.includes(item)) });
  }

  function hasBackendOptions(id: SearchBackendId): boolean {
    return keyedBackends.has(id) || id === "searxng";
  }

  /** 弹窗里的字段直接改 draft，由页面顶部的保存按钮统一提交。 */
  function renderBackendOptions(id: SearchBackendId) {
    if (id === "searxng") {
      return (
        <>
          <div className="search-setting-hint">{copy.settingsSearxngBaseUrlHint}</div>
          <Input
            value={draft?.searxngUrl ?? ""}
            onChange={(event) => patch({ searxngUrl: event.target.value })}
            placeholder="https://searx.example.com"
          />
        </>
      );
    }
    const hint = backendKeyHintKeys[id];
    if (!hint) return null;
    const label = id === "tavily" ? copy.settingsTavilyApiKey
      : id === "exa" ? copy.settingsExaApiKey : copy.settingsYouApiKey;
    return (
      <>
        <div className="search-setting-hint">{copy[hint] as string}</div>
        <Input.Password
          value={keyFor(id)}
          onChange={(event) => {
            if (id === "tavily") patch({ tavilyKey: event.target.value });
            else if (id === "exa") patch({ exaKey: event.target.value });
            else if (id === "you") patch({ youKey: event.target.value });
          }}
          placeholder={label as string}
          autoComplete="new-password"
        />
      </>
    );
  }

  function keyFor(id: SearchBackendId): string {
    if (id === "tavily") return draft?.tavilyKey ?? "";
    if (id === "exa") return draft?.exaKey ?? "";
    if (id === "you") return draft?.youKey ?? "";
    return "";
  }

  async function save() {
    if (!draft || !dirty) {
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
          exa_api_key: draft.exaKey,
          you_api_key: draft.youKey,
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

  if (error && !draft) return <AdminPage title={copy.settingsGroupSearch}><Alert type="error" showIcon message={error} /></AdminPage>;
  if (!draft) return <AdminPage title={copy.settingsGroupSearch}>{copy.loading}</AdminPage>;

  return (
    <AdminPage
      title={copy.settingsGroupSearch}
      description={copy.settingsGroupSearchHint}
      actions={(
        <span className="search-settings-actions">
          <Button onClick={loadScores}>{copy.searchSettingsRefresh}</Button>
          <Button type="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
            {copy.settingsSave}
          </Button>
        </span>
      )}
    >
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {notice ? <Alert type="success" showIcon message={notice} /> : null}

      <Panel title={copy.searchSettingsNetworkTitle}>
        <div className="search-setting-row">
          <div>
            <div className="search-setting-label">{copy.settingsWebEnabled}</div>
            <div className="search-setting-hint">{copy.settingsWebEnabledHint}</div>
          </div>
          <Switch checked={draft.webEnabled} onChange={(value) => patch({ webEnabled: value })} aria-label={copy.settingsWebEnabled} />
        </div>
        <div className="search-setting-row">
          <div>
            <div className="search-setting-label">{copy.settingsWebBlockedHosts}</div>
            <div className="search-setting-hint">{copy.settingsWebBlockedHostsHint}</div>
            <Select
              mode="tags"
              className="search-settings-blocked"
              value={draft.blockedHosts}
              onChange={(values) => patch({ blockedHosts: values.map(String) })}
              placeholder={copy.settingsWebBlockedHosts}
              tokenSeparators={[",", " "]}
            />
          </div>
        </div>
        <div className="search-setting-row">
          <div>
            <div className="search-setting-label">{copy.settingsWebSearchEnabled}</div>
            <div className="search-setting-hint">{copy.settingsWebSearchEnabledHint}</div>
          </div>
          <Switch checked={draft.webSearchEnabled} onChange={(value) => patch({ webSearchEnabled: value })} aria-label={copy.settingsWebSearchEnabled} />
        </div>
        <div className="search-setting-row">
          <div>
            <div className="search-setting-label">{copy.settingsWebSearchMaxQueries}</div>
            <div className="search-setting-hint">{copy.settingsWebSearchMaxQueriesHint}</div>
          </div>
          <InputNumber min={1} max={50} value={draft.maxQueries} onChange={(value) => patch({ maxQueries: Number(value ?? 1) })} />
        </div>
      </Panel>

      <Panel title={copy.settingsWebSearchBackends}>
        <Typography.Paragraph type="secondary" className="search-backend-hint">{copy.searchSettingsOrder}</Typography.Paragraph>
        <div className="search-backend-head">
          <span>#</span>
          <span>{copy.searchBackendColumn}</span>
          <span className="search-backend-head-spacer" />
          <span>{copy.searchSettingsScore}</span>
          <span />
        </div>
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
                <Switch size="small" checked={enabled} onChange={(value) => toggle(id, value)} aria-label={`${copy.searchSettingsEnable} ${id}`} />
                <div className="search-backend-body">
                  <div className="search-backend-name">
                    <code>{id}</code>
                    {keyedBackends.has(id) && keyFor(id).trim()
                      ? <Tag color="blue">key</Tag>
                      : <Tag>keyless</Tag>}
                  </div>
                  <div className="search-backend-desc">{copy[backendCopyKeys[id]] as string}</div>
                </div>
                {(() => {
                  const entry = scoreById.get(id);
                  const title = entry
                    ? copy.searchSettingsScoreHint
                        .replace("{success}", String(entry.successes))
                        .replace("{failure}", String(entry.failures))
                        .replace("{latency}", String(entry.latencyMs))
                    : copy.searchSettingsScoreEstimate;
                  const value = entry?.score ?? previewScore(id);
                  return (
                    <span className="search-backend-score" title={title}>
                      <span className="search-backend-score-label">{copy.searchSettingsScore}</span>
                      {value < 0 ? "—" : value.toFixed(2)}
                    </span>
                  );
                })()}
                <div className="search-backend-actions">
                  <Button
                    type="text"
                    size="small"
                    disabled={!hasBackendOptions(id)}
                    onClick={() => setEditingBackend(id)}
                    aria-label={`${copy.searchSettingsConfigure} ${id}`}
                    title={copy.searchSettingsConfigure}
                  >
                    ⚙
                  </Button>
                  <Button type="text" size="small" disabled={index === 0} onClick={() => move(index, index - 1)} aria-label={copy.searchSettingsMoveUp}>↑</Button>
                  <Button type="text" size="small" disabled={index === draft.order.length - 1} onClick={() => move(index, index + 1)} aria-label={copy.searchSettingsMoveDown}>↓</Button>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      <Modal
        open={editingBackend !== null}
        title={editingBackend === "searxng"
          ? copy.settingsSearxngBaseUrl
          : `${copy.searchSettingsConfigure} ${editingBackend ?? ""}`}
        okText={copy.settingsSave}
        cancelText={copy.skillImportClose}
        onOk={() => setEditingBackend(null)}
        onCancel={() => setEditingBackend(null)}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          {editingBackend ? copy[backendCopyKeys[editingBackend]] as string : ""}
        </Typography.Paragraph>
        {editingBackend ? renderBackendOptions(editingBackend) : null}
        <Typography.Paragraph type="secondary" className="search-settings-modal-hint">
          {copy.searchSettingsModalHint}
        </Typography.Paragraph>
      </Modal>
    </AdminPage>
  );
}
