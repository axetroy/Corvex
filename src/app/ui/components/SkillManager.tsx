import { lazy, Suspense, useEffect, useState } from "react";
import { Button, Modal, Space, Switch, Table, Typography } from "antd";
import { fetchJson, sendJson } from "../lib/api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../lib/i18n.js";
import type { ConversationSkill, SkillPack } from "../lib/types.js";
import { SkillImportDialog } from "./SkillImportDialog.js";

// Monaco 体积很大，只在打开编辑弹窗时加载。
const SkillEditor = lazy(() => import("./SkillEditor.js").then((module) => ({ default: module.SkillEditor })));

/** 技能格式遵循的规范地址，管理端与文档都指向这里。 */
const AGENT_SKILLS_SPEC_URL = "https://agentskills.io/specification";

const blankDocument = `---
name: my-skill
description: What this skill does and when to use it.
metadata:
  corvex-quick-action: "true"
  corvex-quick-label: "My skill"
---

Instructions for the model. Use $ARGUMENTS for the user's text.
`;

/** 管理员维护对话技能：每个技能就是一份 SKILL.md，用 Monaco 编辑。 */
export function SkillManager({ copy }: { copy: Copy }) {
  const [skills, setSkills] = useState<ConversationSkill[]>([]);
  const [packs, setPacks] = useState<SkillPack[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<ConversationSkill | undefined>();
  const [document, setDocument] = useState(blankDocument);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, modalContextHolder] = Modal.useModal();

  useEffect(() => {
    let active = true;
    fetchJson<{ items: ConversationSkill[] }>("/api/ops/admin/skills", copy)
      .then((result) => { if (active) setSkills(result.items ?? []); })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause)); });
    fetchJson<{ items: SkillPack[] }>("/api/ops/admin/skills/packs", copy)
      .then((result) => { if (active) setPacks(result.items ?? []); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [copy, notice]);

  function openCreate() {
    setEditing(undefined);
    setDocument(blankDocument);
    setError("");
    setModalOpen(true);
  }

  function openEdit(skill: ConversationSkill) {
    setEditing(skill);
    setDocument(skill.document);
    setError("");
    setModalOpen(true);
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      if (editing) {
        await sendJson(`/api/ops/admin/skills/${encodeURIComponent(editing.id)}`, { document }, copy);
      } else {
        await sendJson("/api/ops/admin/skills", { document }, copy, "POST");
      }
      setModalOpen(false);
      setNotice(copy.skillManagerSaved);
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
        } catch (cause) {
          setError(errorMessage(cause));
        }
      },
    });
  }

  async function togglePack(pack: SkillPack, enabled: boolean) {
    try {
      await sendJson(`/api/ops/admin/skills/packs/${encodeURIComponent(pack.id)}`, { enabled }, copy);
      setNotice(copy.skillManagerSaved);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function confirmDeletePack(pack: SkillPack) {
    modal.confirm({
      title: copy.skillPackDeleteConfirm,
      okText: copy.skillPackDelete,
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await sendJson(`/api/ops/admin/skills/packs/${encodeURIComponent(pack.id)}`, {}, copy, "DELETE");
          setNotice(copy.skillManagerSaved);
        } catch (cause) {
          setError(errorMessage(cause));
        }
      },
    });
  }

  const columns = [
    { title: copy.skillManagerName, dataIndex: "name", width: "18%" },
    {
      title: copy.skillManagerDescription,
      dataIndex: "description",
      width: "32%",
      render: (value: string) => (
        <span title={value}>{value.length > 90 ? `${value.slice(0, 90)}…` : value}</span>
      ),
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
      render: (system: boolean) => (system ? <span className="skill-manager-system-tag">{copy.skillManagerSystem}</span> : null),
    },
    {
      title: "",
      key: "actions",
      width: "26%",
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
      <Typography.Paragraph type="secondary">
        {copy.skillManagerSpecHint}{" "}
        <a href={AGENT_SKILLS_SPEC_URL} target="_blank" rel="noreferrer">{copy.skillManagerSpecLink}</a>
      </Typography.Paragraph>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      {notice ? <Typography.Text type="success">{notice}</Typography.Text> : null}
      <Space>
        <Button type="primary" onClick={openCreate}>{copy.skillManagerAdd}</Button>
        <Button onClick={() => setImportOpen(true)}>{copy.skillManagerImport}</Button>
      </Space>
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
      <Typography.Title level={5} style={{ marginTop: 24 }}>{copy.skillPackTitle}</Typography.Title>
      <Table
        rowKey="id"
        dataSource={packs}
        size="small"
        pagination={false}
        locale={{ emptyText: copy.skillPackEmpty }}
        columns={[
          { title: copy.skillManagerName, dataIndex: "name", width: "28%" },
          { title: copy.skillPackSource, dataIndex: "source", width: "14%" },
          { title: copy.skillPackSkills, dataIndex: "skillCount", width: "12%" },
          {
            title: copy.skillPackSize,
            dataIndex: "size",
            width: "12%",
            render: (value: number) => `${Math.round(value / 1024)} KiB`,
          },
          {
            title: copy.skillManagerEnabled,
            dataIndex: "enabled",
            width: "12%",
            render: (enabled: boolean, pack: SkillPack) => (
              <Switch checked={enabled} onChange={(next) => void togglePack(pack, next)} />
            ),
          },
          {
            title: "",
            key: "actions",
            width: "22%",
            render: (_: unknown, pack: SkillPack) => (
              <Button size="small" danger onClick={() => confirmDeletePack(pack)}>{copy.skillPackDelete}</Button>
            ),
          },
        ]}
      />
      <SkillImportDialog
        open={importOpen}
        copy={copy}
        onClose={() => setImportOpen(false)}
        onImported={() => setNotice(copy.skillManagerSaved)}
      />
      <Modal
        open={modalOpen}
        title={editing ? copy.skillManagerEdit : copy.skillManagerAdd}
        onCancel={() => setModalOpen(false)}
        onOk={() => void save()}
        okText={copy.skillManagerSaved}
        confirmLoading={saving}
        width={760}
      >
        <Typography.Paragraph type="secondary">{copy.skillManagerDocumentHint}</Typography.Paragraph>
        <Suspense fallback={<div className="skill-manager-editor-loading">…</div>}>
          {modalOpen ? <SkillEditor value={document} onChange={setDocument} /> : null}
        </Suspense>
      </Modal>
      {modalContextHolder}
    </div>
  );
}
