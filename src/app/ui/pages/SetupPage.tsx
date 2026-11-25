import { useState } from "react";
import { Button, Input, Typography } from "antd";
import { sendJson } from "../lib/api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../lib/i18n.js";
import { PageHeading, Panel } from "../components/common.js";

interface Props {
  copy: Copy;
}

/** 首次安装向导：填写 GitLab OAuth Application，保存到本地 SQLite。 */
export function SetupPage({ copy }: Props) {
  const [baseUrl, setBaseUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      await sendJson("/api/setup/oauth", { baseUrl, clientId, clientSecret, redirectUri }, copy, "POST");
      window.location.href = "/auth/gitlab";
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  };

  return (
    <div className="setup-page">
      <PageHeading title={copy.setupTitle} description={copy.setupDescription} />
      <Panel title={copy.setupGuideTitle}>
        <ol className="setup-steps">
          <li>{copy.setupStep1}</li>
          <li>
            {copy.setupStep2}{" "}
            <code>{redirectUri || copy.setupRedirectPlaceholder}</code>
          </li>
          <li>{copy.setupStep3}</li>
          <li>{copy.setupStep4}</li>
        </ol>
      </Panel>
      <Panel title={copy.setupTitle}>
        <div className="setup-fields">
          <label className="setup-field">
            <Typography.Text strong>{copy.setupBaseUrl}</Typography.Text>
            <Input value={baseUrl} placeholder={copy.setupBaseUrlPlaceholder} onChange={(event) => setBaseUrl(event.target.value)} />
            <Typography.Text type="secondary">{copy.setupBaseUrlHint}</Typography.Text>
          </label>
          <label className="setup-field">
            <Typography.Text strong>{copy.setupClientId}</Typography.Text>
            <Input value={clientId} onChange={(event) => setClientId(event.target.value)} />
          </label>
          <label className="setup-field">
            <Typography.Text strong>{copy.setupClientSecret}</Typography.Text>
            <Input.Password value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} />
          </label>
          <label className="setup-field">
            <Typography.Text strong>{copy.setupRedirectUri}</Typography.Text>
            <Input value={redirectUri} placeholder={copy.setupRedirectPlaceholder} onChange={(event) => setRedirectUri(event.target.value)} />
            <Typography.Text type="secondary">{copy.setupRedirectHint}</Typography.Text>
          </label>
          {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
          <Button type="primary" loading={saving} onClick={() => void submit()}>
            {copy.setupSubmit}
          </Button>
        </div>
      </Panel>
    </div>
  );
}
