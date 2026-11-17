import { useEffect, useMemo, useRef, useState } from "react";
import type { UIEvent } from "react";
import { Button, Select, Spin, Typography } from "antd";
import "./RemotePicker.css";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import { formatRelativeTime } from "../format.js";
import {
  branchPageSize,
  mergeBranches,
  toBranchSelectOption,
  type BranchOption,
  type BranchSelectOption,
} from "../branchPicker.js";

interface Props {
  copy: Copy;
  /** 已选分支名；由父组件持有，受控组件。 */
  value?: string;
  /** 所属仓库 ID；为空时禁用。 */
  projectId?: number;
  disabled?: boolean;
  onChange: (branch: string) => void;
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
 * 分支选择器：远程搜索仓库分支，选项分两行展示分支名与最近提交（短 SHA · 标题），
 * 右侧显示提交的相对时间；支持无限滚动、防抖搜索、清空与错误重试。
 */
export function BranchPicker({ copy, value, projectId, disabled, onChange }: Props) {
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const requestId = useRef(0);
  const debounceTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(debounceTimer.current), []);

  async function loadBranches(search: string, targetPage: number, append: boolean) {
    if (!projectId) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    if (!append) setError("");
    try {
      const params = new URLSearchParams({ search: search.trim(), page: String(targetPage) });
      const result = await fetchJson<BranchOption[]>(`/api/ops/projects/${projectId}/branches?${params}`, copy);
      if (currentRequest !== requestId.current) return;
      setBranches((current) => (append ? mergeBranches(current, result) : result));
      setPage(targetPage);
      setHasMore(result.length >= branchPageSize);
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
    debounceTimer.current = window.setTimeout(() => void loadBranches(next, 1, false), searchDebounceMs);
  }

  function retry() {
    void loadBranches(query, 1, false);
  }

  // 切换仓库时重置并重新加载分支列表；语言切换只需重算相对时间，无需重新请求。
  useEffect(() => {
    setBranches([]);
    setQuery("");
    setPage(0);
    setHasMore(false);
    setError("");
    if (projectId) void loadBranches("", 1, false);
  }, [projectId]);

  const options = useMemo(
    () => branches.map((branch) => toBranchSelectOption(branch, formatRelativeTime(branch.commit.committed_date, copy))),
    [branches, copy],
  );
  const selected = branches.find((branch) => branch.name === value);
  const selectedOption = selected ? toBranchSelectOption(selected, formatRelativeTime(selected.commit.committed_date, copy)) : undefined;

  const notFoundContent = (() => {
    if (loading) return <div className="remote-picker-status"><Spin size="small" /> {copy.pickerSearching}</div>;
    if (error) {
      return (
        <div className="remote-picker-status remote-picker-status-error">
          <Typography.Text type="danger" className="remote-picker-status-text">{error}</Typography.Text>
          <Button size="small" onClick={retry}>{copy.pickerRetry}</Button>
        </div>
      );
    }
    return (
      <div className="remote-picker-status">
        {query.trim() ? copy.noBranches : copy.branchPickerHint}
      </div>
    );
  })();

  return (
    <Select<string, BranchSelectOption>
      className="remote-picker"
      aria-label={copy.branch}
      showSearch={{
        filterOption: false,
        onSearch: scheduleSearch,
      }}
      placeholder={copy.branchSearchPlaceholder}
      value={value || undefined}
      allowClear={{ label: copy.pickerClear }}
      disabled={disabled || !projectId}
      loading={loading}
      options={options}
      notFoundContent={notFoundContent}
      popupMatchSelectWidth={420}
      onClear={() => onChange("")}
      onChange={(branch) => onChange(branch)}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && branches.length === 0 && !loading) void loadBranches("", 1, false);
      }}
      onPopupScroll={(event) => {
        if (!open || !hasMore || loading || !atListBottom(event)) return;
        void loadBranches(query, page + 1, true);
      }}
      optionRender={(option) => (
        <div className="remote-picker-option">
          <div className="remote-picker-option-main">
            <span className="remote-picker-option-title">{option.data.title}</span>
            <span className="remote-picker-option-subtitle">{option.data.subtitle}</span>
          </div>
          {option.data.meta ? <span className="remote-picker-option-meta">{option.data.meta}</span> : null}
        </div>
      )}
      labelRender={() => (
        <div className="remote-picker-value">
          <span className="remote-picker-value-title">{value}</span>
          {selectedOption ? <span className="remote-picker-value-subtitle">{selectedOption.subtitle}</span> : null}
        </div>
      )}
      popupRender={(menu) => (
        <>
          {menu}
          {hasMore && branches.length > 0 ? (
            <div className="remote-picker-more">
              {error
                ? <><span className="remote-picker-status-text">{error}</span><Button size="small" onClick={retry}>{copy.pickerRetry}</Button></>
                : loading ? <><Spin size="small" /> {copy.pickerLoadingMore}</> : copy.pickerLoadMoreHint}
            </div>
          ) : null}
        </>
      )}
    />
  );
}
