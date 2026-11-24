import { useEffect, useState, type ReactNode } from "react";
import { Button, Popover, Spin, Typography } from "antd";
import { SiGitlab } from "react-icons/si";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import type { RepositoryDetails } from "../types.js";

/** GitLab 返回的地址可能是内网或过期域名，只把 http(s) 链接渲染成可点击跳转。 */
export function safeRepositoryUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function InfoRow({ label, children, copy }: { label: string; children: ReactNode; copy: Copy }) {
  return (
    <div className="repository-info-row">
      <dt>{label}</dt>
      <dd>{children || copy.none}</dd>
    </div>
  );
}

/**
 * 点击仓库名打开的只读信息气泡：项目元数据来自 GitLab，
 * 另外带出当前对话绑定的分支、轮次快照与可推进的同步基线。气泡锚在按钮下方，不遮挡工作区。
 */
export function RepositoryInfoPopover({
  open,
  onOpenChange,
  children,
  projectId,
  copy,
  currentBranch,
  pinnedSha,
  baseSha,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  projectId: number;
  copy: Copy;
  currentBranch?: string;
  pinnedSha?: string;
  baseSha?: string;
}) {
  const [details, setDetails] = useState<RepositoryDetails>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 提前预取：点击时详情已在本地，气泡一次渲染到位，不会先小后大跳动。
    if (!projectId) {
      setDetails(undefined);
      setError("");
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    fetchJson<RepositoryDetails>(`/api/ops/projects/${projectId}`, copy)
      .then((value) => {
        if (active) {
          setDetails(value);
          setError("");
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setDetails(undefined);
          setError(errorMessage(cause));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, copy]);

  const webUrl = safeRepositoryUrl(details?.web_url);
  // 加载期间用固定高度占位，避免详情到达后气泡高度突变、位置二次调整。
  const content = (
    <div className="repository-info-popover-content">
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      {loading ? (
        <div className="repository-info-loading"><Spin size="small" /></div>
      ) : details ? (
        <>
          <dl className="repository-info-list">
            <InfoRow label={copy.conversationRepositoryPath} copy={copy}>
              {details.path_with_namespace ?? details.name}
            </InfoRow>
            <InfoRow label={copy.conversationRepositoryDescription} copy={copy}>
              {details.description}
            </InfoRow>
            <InfoRow label={copy.conversationRepositoryDefaultBranch} copy={copy}>
              {details.default_branch}
            </InfoRow>
            <InfoRow label={copy.conversationRepositoryCloneUrl} copy={copy}>
              <code>{details.http_url_to_repo}</code>
            </InfoRow>
            {currentBranch || pinnedSha ? (
              <InfoRow label={copy.conversationRepositoryCurrent} copy={copy}>
                {currentBranch ? <span>{currentBranch}</span> : null}
                {pinnedSha ? <code>{pinnedSha.slice(0, 12)}</code> : null}
              </InfoRow>
            ) : null}
            {baseSha ? (
              <InfoRow label={copy.conversationRepositoryBaseline} copy={copy}>
                <code>{baseSha.slice(0, 12)}</code>
              </InfoRow>
            ) : null}
          </dl>
          {webUrl ? (
            <Button
              type="primary"
              href={webUrl}
              target="_blank"
              rel="noopener noreferrer"
              icon={<SiGitlab aria-hidden="true" />}
            >
              {copy.conversationRepositoryOpen}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      placement="bottomRight"
      trigger="click"
      arrow={false}
      title={copy.conversationRepositoryInfo}
      content={content}
      classNames={{ root: "repository-info-popover" }}
      // 气泡 portal 到 body：直接绑定全局主题变量，浅色/深色都与控制台面板一致。
      styles={{
        root: { maxWidth: 340 },
        container: { background: "var(--bg-panel)", color: "var(--text)" },
        title: { color: "var(--text)" },
      }}
    >
      {children}
    </Popover>
  );
}
