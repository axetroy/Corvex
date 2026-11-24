import { useRef, useState } from "react";
import { Alert, Button, Input, Modal, Segmented, Switch, Typography } from "antd";
import { sendBinary, sendJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";

type Channel = "upload" | "url" | "github" | "gitlab";

interface ImportResult {
  pack: { id: string; name: string };
  created: string[];
  skipped: string[];
  errors: string[];
  issues: Array<{ path: string; message: string }>;
}

interface Props {
  open: boolean;
  copy: Copy;
  onClose: () => void;
  onImported: () => void;
}

/** ZIP 上限在服务端也有同样的硬限制；这里提前拦截，避免无谓上传。 */
const maxZipBytes = 10 * 1024 * 1024;

export function SkillImportDialog({ open, copy, onClose, onImported }: Props) {
  const [channel, setChannel] = useState<Channel>("upload");
  const [file, setFile] = useState<File | undefined>();
  const [value, setValue] = useState("");
  const [ref, setRef] = useState("");
  const [path, setPath] = useState("");
  const [overwrite, setOverwrite] = useState(false);
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

  async function runImport() {
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      let next: ImportResult;
      if (channel === "upload") {
        if (!file) throw new Error(copy.skillImportFileHint);
        if (file.size > maxZipBytes) throw new Error(`ZIP exceeds 10 MiB`);
        const buffer = await file.arrayBuffer();
        next = await sendBinary<ImportResult>(
          `/api/ops/admin/skills/import?filename=${encodeURIComponent(file.name)}`,
          buffer,
          "application/zip",
          copy,
        );
      } else {
        if (!value.trim()) throw new Error(hint);
        next = await sendJson<ImportResult>("/api/ops/admin/skills/import", {
          channel,
          value: value.trim(),
          ref: ref.trim(),
          path: path.trim(),
          overwrite,
        }, copy, "POST");
      }
      setResult(next);
      onImported();
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
      onCancel={onClose}
      footer={<Button onClick={onClose}>{copy.skillImportClose}</Button>}
      destroyOnClose
    >
      <Segmented<Channel>
        value={channel}
        onChange={(next) => { setChannel(next); setError(""); setResult(undefined); }}
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
            onChange={(event) => setFile(event.target.files?.[0])}
          />
          <Button onClick={() => fileInput.current?.click()}>{file?.name ?? copy.skillImportUpload}</Button>
        </>
      ) : (
        <>
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={channel === "github" ? "owner/repo" : copy.skillImportUrlHint}
          />
          {channel !== "url" ? (
            <Input
              style={{ marginTop: 8 }}
              value={ref}
              onChange={(event) => setRef(event.target.value)}
              placeholder={copy.skillImportRef}
            />
          ) : null}
          {channel !== "gitlab" ? (
            <Input
              style={{ marginTop: 8 }}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={copy.skillImportPath}
            />
          ) : null}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
            <Switch checked={overwrite} onChange={setOverwrite} />
            <Typography.Text>{copy.skillImportOverwrite}</Typography.Text>
          </div>
        </>
      )}
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
          description={(
            <>
              {result.created.length ? <div>{result.created.join(", ")}</div> : null}
              {result.issues.length ? (
                <div>{copy.skillImportIssues}: {result.issues.map((item) => item.path).join(", ")}</div>
              ) : null}
            </>
          )}
        />
      ) : null}
      <Button type="primary" loading={busy} onClick={() => void runImport()} style={{ marginTop: 12 }}>
        {copy.skillImportConfirm}
      </Button>
    </Modal>
  );
}
