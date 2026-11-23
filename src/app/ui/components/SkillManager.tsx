import { useEffect, useState } from "react";
import { Button, Input, Modal, Space, Switch, Table, Typography } from "antd";
import { fetchJson, sendJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import type { ConversationSkill, ConversationSkillInput } from "../types.js";

function emptySkill(): ConversationSkillInput {
  return {
    name: "",
    description: "",
    descriptionZh: "",
    content: "",
    contentZh: "",
    argumentHint: "",
    license: "",
    compatibility: "",
    metadata: {},
    allowedTools: "",
    enabled: true,
  };
}

function toInput(skill: ConversationSkill): ConversationSkillInput {
  return {
    name: skill.name,
    description: skill.description,
    descriptionZh: skill.descriptionZh,
    content: skill.content,
    contentZh: skill.contentZh,
    argumentHint: skill.argumentHint,
    license: skill.license,
    compatibility: skill.compatibility,
    metadata: skill.metadata,
    allowedTools: skill.allowedTools,
    enabled: skill.enabled,
  };
}

function metadataToText(metadata: Record<string, string>): string {
  return Object.entries(metadata).map(([key, value]) => `${key}=${value}`).join("\n");
}

function metadataFromText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

/** 管理员维护对话技能：斜杠命令的名称、菜单说明与提示词模板。 */
export function SkillManager({ copy, onChanged }: { copy: Copy; onChanged?: () => void }) {
  const [skills, setSkills] = useState<ConversationSkill[]>([]);
  const [editing, setEditing] = useState<ConversationSkill | undefined>();
  const [draft, setDraft] = useState<ConversationSkillInput>(emptySkill());
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, modalContextHolder] = Modal.useModal();

  useEffect(() => {
    let active = true;
    fetchJson<{ items: ConversationSkill[] }>("/api/ops/admin/skills", copy)
      .then((result) => {
        if (active) setSkills(result.items ?? []);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => { active = false; };
  }, [copy, notice]);

  function openCreate() {
    setEditing(undefined);
    setDraft(emptySkill());
    setError("");
    setModalOpen(true);
  }

  function openEdit(skill: ConversationSkill) {
    setEditing(skill);
    setDraft(toInput(skill));
    setError("");
    setModalOpen(true);
  }

  function change<K extends keyof ConversationSkillInput>(key: K, value: ConversationSkillInput[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      if (editing) {
        await sendJson(`/api/ops/admin/skills/${encodeURIComponent(editing.id)}`, draft, copy);
      } else {
        await sendJson("/api/ops/admin/skills", draft, copy, "POST");
      }
      setModalOpen(false);
      setNotice(copy.skillManagerSaved);
      onChanged?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(skill: ConversationSkill) {
    if (skill.isSystem) {
      setError(copy.skillManagerSystemProtected);
      return;
    }
    modal.confirm({
      title: copy.skillManagerDeleteConfirm,
      okText: copy.skillManagerDelete,
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await sendJson(`/api/ops/admin/skills/${encodeURIComponent(skill.id)}`, {}, copy, "DELETE");
          setNotice(copy.skillManagerSaved);
          onChanged?.();
        } catch (cause) {
          setError(errorMessage(cause));
        }
      },
    });
  }

  const columns = [
    { title: copy.skillManagerName, dataIndex: "name", width: "20%" },
    {
      title: copy.skillManagerDescription,
      key: "description",
      width: "28%",
      render: (_: unknown, skill: ConversationSkill) => skill.description || skill.descriptionZh,
    },
    {
      title: copy.skillManagerEnabled,
      dataIndex: "enabled",
      width: "12%",
      render: (enabled: boolean) => <Switch checked={enabled} disabled />,
    },
    {
      title: copy.skillManagerSystem,
      dataIndex: "isSystem",
      width: "12%",
      render: (system: boolean) => (system ? <TagColor>{copy.skillManagerSystem}</TagColor> : null),
    },
    {
      title: "",
      key: "actions",
      width: "28%",
      render: (_: unknown, skill: ConversationSkill) => (
        <Space size="small">
          <Button size="small" onClick={() => openEdit(skill)}>{copy.skillManagerEdit}</Button>
          <Button size="small" danger onClick={() => confirmDelete(skill)}>{copy.skillManagerDelete}</Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="skill-manager">
      <Typography.Title level={5}>{copy.skillManagerTitle}</Typography.Title>
      <Typography.Paragraph type="secondary">{copy.skillManagerHint}</Typography.Paragraph>
      <Typography.Paragraph type="secondary">{copy.skillManagerSpecHint}</Typography.Paragraph>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      {notice ? <Typography.Text type="success">{notice}</Typography.Text> : null}
      <Button type="primary" onClick={openCreate}>{copy.skillManagerAdd}</Button>
      <Table
        rowKey="id"
        dataSource={skills}
        columns={columns}
        pagination={false}
        size="small"
        locale={{ emptyText: copy.skillManagerEmpty }}
        tableLayout="fixed"
        style={{ marginTop: 12 }}
      />
      <Modal
        open={modalOpen}
        title={editing ? copy.skillManagerEdit : copy.skillManagerAdd}
        onCancel={() => setModalOpen(false)}
        onOk={() => void save()}
        okText={copy.skillManagerSaved}
        confirmLoading={saving}
        width={640}
      >
        <div className="skill-manager-form">
          <label>
            {copy.skillManagerName}
            <Input value={draft.name} onChange={(event) => change("name", event.target.value)} />
            <Typography.Text type="secondary">{copy.skillManagerNameHint}</Typography.Text>
          </label>
          <label>
            {copy.skillManagerDescription}
            <Input value={draft.description} onChange={(event) => change("description", event.target.value)} />
          </label>
          <label>
            {copy.skillManagerDescriptionZh}
            <Input value={draft.descriptionZh} onChange={(event) => change("descriptionZh", event.target.value)} />
          </label>
          <label>
            {copy.skillManagerArgumentHint}
            <Input value={draft.argumentHint} onChange={(event) => change("argumentHint", event.target.value)} />
          </label>
          <label>
            {copy.skillManagerContent}
            <Input.TextArea rows={4} value={draft.content} onChange={(event) => change("content", event.target.value)} />
            <Typography.Text type="secondary">{copy.skillManagerContentHint}</Typography.Text>
          </label>
          <label>
            {copy.skillManagerContentZh}
            <Input.TextArea rows={4} value={draft.contentZh} onChange={(event) => change("contentZh", event.target.value)} />
          </label>
          <label>
            {copy.skillManagerLicense}
            <Input value={draft.license} onChange={(event) => change("license", event.target.value)} />
          </label>
          <label>
            {copy.skillManagerCompatibility}
            <Input value={draft.compatibility} onChange={(event) => change("compatibility", event.target.value)} />
          </label>
          <label>
            {copy.skillManagerAllowedTools}
            <Input value={draft.allowedTools} onChange={(event) => change("allowedTools", event.target.value)} />
          </label>
          <label>
            {copy.skillManagerMetadata}
            <Input.TextArea
              rows={2}
              value={metadataToText(draft.metadata)}
              onChange={(event) => change("metadata", metadataFromText(event.target.value))}
            />
          </label>
          <label className="skill-manager-form-switch">
            {copy.skillManagerEnabled}
            <Switch checked={draft.enabled} onChange={(value) => change("enabled", value)} />
          </label>
        </div>
      </Modal>
      {modalContextHolder}
    </div>
  );
}

function TagColor({ children }: { children: React.ReactNode }) {
  return <span className="skill-manager-system-tag">{children}</span>;
}
