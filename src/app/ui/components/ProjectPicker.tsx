import { useEffect, useMemo, useRef, useState } from "react";
import type { UIEvent } from "react";
import { Button, Select, Spin, Typography } from "antd";
import "./ProjectPicker.css";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import {
  mergeProjects,
  projectPageSize,
  toProjectSelectOption,
  type ProjectOption,
  type ProjectSelectOption,
} from "../projectPicker.js";

interface Props {
  copy: Copy;
  /** 已选仓库；由父组件持有，受控组件。 */
  value?: ProjectOption;
  disabled?: boolean;
  onChange: (project: ProjectOption | undefined) => void;
}

/** 输入防抖时长：避免每次按键都打一次 GitLab 搜索。 */
const searchDebounceMs = 300;
/** 距列表底部多少像素时预取下一页。 */
const prefetchThreshold = 48;

function atListBottom(event: UIEvent<HTMLDivElement>): boolean {
  const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
  return scrollTop + clientHeight >= scrollHeight - prefetchThreshold;
}

/**
 * 仓库选择器：远程搜索可见项目，选项分两行展示仓库全路径与描述，
 * 支持无限滚动、防抖搜索、清空与错误重试。
 */
export function ProjectPicker({ copy, value, disabled, onChange }: Props) {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const requestId = useRef(0);
  const debounceTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(debounceTimer.current), []);

  async function loadProjects(search: string, targetPage: number, append: boolean) {
    const currentRequest = ++requestId.current;
    setLoading(true);
    if (!append) setError("");
    try {
      const params = new URLSearchParams({ search: search.trim(), page: String(targetPage) });
      const result = await fetchJson<ProjectOption[]>(`/api/ops/projects?${params}`, copy);
      if (currentRequest !== requestId.current) return;
      setProjects((current) => (append ? mergeProjects(current, result) : result));
      setPage(targetPage);
      setHasMore(result.length >= projectPageSize);
      setError("");
    } catch (cause) {
      if (currentRequest === requestId.current) setError(errorMessage(cause));
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }

  function scheduleSearch(next: string) {
    setQuery(next);
    window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => void loadProjects(next, 1, false), searchDebounceMs);
  }

  function retry() {
    void loadProjects(query, 1, false);
  }

  const options = useMemo(() => projects.map(toProjectSelectOption), [projects]);

  const notFoundContent = (() => {
    if (loading) return <div className="project-picker-status"><Spin size="small" /> {copy.projectPickerSearching}</div>;
    if (error) {
      return (
        <div className="project-picker-status project-picker-status-error">
          <Typography.Text type="danger" className="project-picker-status-text">{error}</Typography.Text>
          <Button size="small" onClick={retry}>{copy.projectPickerRetry}</Button>
        </div>
      );
    }
    return (
      <div className="project-picker-status">
        {query.trim() ? copy.noProjects : copy.projectPickerHint}
      </div>
    );
  })();

  return (
    <Select<number, ProjectSelectOption>
      className="project-picker"
      aria-label={copy.projectSearch}
      showSearch={{
        filterOption: false,
        onSearch: scheduleSearch,
      }}
      placeholder={copy.projectSearchPlaceholder}
      value={value?.id}
      allowClear={{ label: copy.projectPickerClear }}
      disabled={disabled}
      loading={loading}
      options={options}
      notFoundContent={notFoundContent}
      popupMatchSelectWidth={420}
      onClear={() => onChange(undefined)}
      onChange={(id) => onChange(projects.find((item) => item.id === id))}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && projects.length === 0 && !loading) void loadProjects("", 1, false);
      }}
      onPopupScroll={(event) => {
        if (!open || !hasMore || loading || !atListBottom(event)) return;
        void loadProjects(query, page + 1, true);
      }}
      optionRender={(option) => (
        <div className="project-picker-option">
          <span className="project-picker-option-title">{option.data.title}</span>
          <span className="project-picker-option-subtitle">{option.data.subtitle}</span>
        </div>
      )}
      labelRender={() => (
        <div className="project-picker-value">
          <span className="project-picker-value-title">{value ? toProjectSelectOption(value).title : ""}</span>
          <span className="project-picker-value-subtitle">{value ? toProjectSelectOption(value).subtitle : ""}</span>
        </div>
      )}
      popupRender={(menu) => (
        <>
          {menu}
          {hasMore && projects.length > 0 ? (
            <div className="project-picker-more">
              {loading ? <><Spin size="small" /> {copy.projectPickerLoadingMore}</> : copy.projectPickerLoadMoreHint}
            </div>
          ) : null}
        </>
      )}
    />
  );
}
