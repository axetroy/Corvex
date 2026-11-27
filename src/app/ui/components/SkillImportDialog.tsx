import { useRef, useState } from "react";
import { Alert, Button, Checkbox, Input, Modal, Segmented, Space, Switch, Typography } from "antd";
import "./SkillImportDialog.css";
import { sendBinary, sendJson } from "../lib/api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../lib/i18n.js";

type Channel = "upload" | "url" | "github" | "gitlab";

interface PreviewSkill {
  name: string;
  description: string;
  document: string;
  sourcePath: string;
  issues: string[];
}

interface Preview {
  token: string;
  skills: PreviewSkill[];
  issues: Array<{ path: string; message: string }>;
}

interface ImportResult {
  created: string[];
  skipped: string[];
  errors: string[];
}

interface Props {
  open: boolean;
  copy: Copy;
  onClose: () => void;
  onImported: () => void;
  /** 管理端或个人端的技能路由前缀。 */
  basePath?: string;
}

/** ZIP 上限在服务端也有同样的硬限制；这里提前拦截，避免无谓上传。 */
const maxZipBytes = 10 * 1024 * 1024;

/** 导入技能：先解析来源并列出全部技能，默认全选，再按勾选结果写入。 */
export function SkillImportDialog({ open, copy, onClose, onImported, basePath = "/api/ops/admin/skills" }: Props) {
  const [channel, setChannel] = useState<Channel>("upload");
  const [file, setFile] = useState<File | undefined>();
  const [value, setValue] = useState("");
  const [ref, setRef] = useState("");
  const [path, setPath] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [preview, setPreview] = useState<Preview | undefined>();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportResult | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);

  const hint = {
    upload: copy.skillImportFileHint,
    url: copy.skillImportUrlHint,
    github: copy.skillImportGithubHint,
    gitlab: copy.skillImportGitlabHint,
  }[channel];

  function reset() {
    setPreview(undefined);
    setSelected([]);
    setResult(undefined);
    setError("");
  }

  async function runPreview() {
    setBusy(true);
    setError("");
    setPreview(undefined);
    setResult(undefined);
    try {
      let next: Preview;
      if (channel === "upload") {
        if (!file) throw new Error(copy.skillImportFileHint);
        if (file.size > maxZipBytes) throw new Error("ZIP exceeds 10 MiB");
        const buffer = await file.arrayBuffer();
        next = await sendBinary<Preview>(
          `${basePath}/import/preview?filename=${encodeURIComponent(file.name)}`,
          buffer, "application/zip", copy,
        );
      } else {
        if (!value.trim()) throw new Error(hint);
        next = await sendJson<Preview>(`${basePath}/import/preview`, {
          channel, value: value.trim(), ref: ref.trim(), path: path.trim(),
        }, copy, "POST");
      }
      setPreview(next);
      setSelected(next.skills.map((skill) => skill.sourcePath));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const next = await sendJson<ImportResult>(`${basePath}/import`, {
        token: preview.token, selected, overwrite,
      }, copy, "POST");
      setResult(next);
      onImported();
      reset();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={copy.skillImportTitle}
      width={720}
      onCancel={onClose}
      footer={<Button onClick={onClose}>{copy.skillImportClose}</Button>}
      destroyOnClose
    >
      <Segmented<Channel>
        value={channel}
        onChange={(next) => { setChannel(next); reset(); }}
        options={[
          { label: copy.skillImportUpload, value: "upload" },
          { label: copy.skillImportUrl, value: "url" },
          { label: copy.skillImportGithub, value: "github" },
          { label: copy.skillImportGitlab, value: "gitlab" },
        ]}
      />
      <Typography.Paragraph type="secondary">{hint}</Typography.Paragraph>
      {channel === "upload" ? (
        <>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            style={{ display: "none" }}
            onChange={(event) => { setFile(event.target.files?.[0]); reset(); }}
          />
          <Button onClick={() => fileInput.current?.click()}>{file?.name ?? copy.skillImportUpload}</Button>
        </>
      ) : (
        <>
          <Input value={value} onChange={(event) => { setValue(event.target.value); reset(); }} placeholder={channel === "github" ? "owner/repo" : copy.skillImportUrlHint} />
          {channel !== "url" ? (
            <Input style={{ marginTop: 8 }} value={ref} onChange={(event) => { setRef(event.target.value); reset(); }} placeholder={copy.skillImportRef} />
          ) : null}
          {channel !== "gitlab" ? (
            <Input style={{ marginTop: 8 }} value={path} onChange={(event) => { setPath(event.target.value); reset(); }} placeholder={copy.skillImportPath} />
          ) : null}
        </>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
        <Switch checked={overwrite} onChange={setOverwrite} />
        <Typography.Text>{copy.skillImportOverwrite}</Typography.Text>
      </div>
      <Button loading={busy} onClick={() => void runPreview()} style={{ marginTop: 12 }}>
        {copy.skillImportPreview}
      </Button>
      {preview ? (
        <div className="skill-import-results" style={{ marginTop: 12 }}>
          <div className="skill-import-results-head">
            <Checkbox
              checked={preview.skills.length > 0 && selected.length === preview.skills.length}
              indeterminate={selected.length > 0 && selected.length < preview.skills.length}
              onChange={(event) => setSelected(event.target.checked
                ? preview.skills.map((skill) => skill.sourcePath)
                : [])}
            >
              <span className="skill-import-selected-count">
                {copy.skillImportSelectedTemplate
                  .replace("{selected}", String(selected.length))
                  .replace("{total}", String(preview.skills.length))}
              </span>
            </Checkbox>
            <Space size={4}>
              <Button
                size="small"
                type="link"
                disabled={selected.length === preview.skills.length}
                onClick={() => setSelected(preview.skills.map((skill) => skill.sourcePath))}
              >
                {copy.skillImportSelectAll}
              </Button>
              <Button
                size="small"
                type="link"
                disabled={selected.length === 0}
                onClick={() => setSelected([])}
              >
                {copy.skillImportSelectNone}
              </Button>
            </Space>
          </div>
          <Typography.Paragraph type="secondary" className="skill-import-results-hint">
            {copy.skillImportFound.replace("{count}", String(preview.skills.length))}
          </Typography.Paragraph>
          <div className="skill-import-list">
            {preview.skills.map((skill) => {
              const checked = selected.includes(skill.sourcePath);
              return (
                <div
                  key={skill.sourcePath}
                  className={`skill-import-item${checked ? " is-checked" : ""}`}
                  onClick={() => setSelected((current) => checked
                    ? current.filter((item) => item !== skill.sourcePath)
                    : [...current, skill.sourcePath])}
                >
                  <Checkbox
                    checked={checked}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setSelected((current) => event.target.checked
                      ? [...new Set([...current, skill.sourcePath])]
                      : current.filter((item) => item !== skill.sourcePath))}
                  />
                  <div className="skill-import-item-body">
                    <div className="skill-import-item-name">{skill.name}</div>
                    <div className="skill-import-item-desc" title={skill.description || skill.sourcePath}>
                      {skill.description || skill.sourcePath}
                    </div>
                    {skill.issues.length ? (
                      <div className="skill-import-item-issues">{skill.issues.join("; ")}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          <Button type="primary" loading={busy} disabled={selected.length === 0} onClick={() => void runImport()} style={{ marginTop: 12 }}>
            {copy.skillImportConfirmSelected}
          </Button>
        </div>
      ) : null}
      {error ? <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} /> : null}
      {result ? (
        <Alert
          type="success"
          showIcon
          style={{ marginTop: 12 }}
          message={copy.skillImportSuccess
            .replace("{created}", String(result.created.length))
            .replace("{skipped}", String(result.skipped.length))
            .replace("{errors}", String(result.errors.length))}
        />
      ) : null}
    </Modal>
  );
}
