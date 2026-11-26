import { describe, expect, it } from "vitest";
import { buildUploadContext, maxUploadBytes, sanitizeUploadFilename, uploadUrl, validateUpload } from "../../src/app/upload.js";
import type { ConversationUpload } from "../../src/model.js";

const bytes = (value: string) => Buffer.from(value, "utf8");

describe("upload validation", () => {
  it("accepts valid UTF-8 text with a safe filename", () => {
    expect(validateUpload({ filename: "notes.txt", mime: "text/plain", bytes: bytes("hello 世界") })).toEqual({ ok: true });
    expect(validateUpload({ filename: "report.json", mime: "application/json", bytes: bytes("{}") })).toEqual({ ok: true });
  });

  it("rejects unsupported MIME, empty content, NUL, invalid UTF-8 and oversized content", () => {
    expect(validateUpload({ filename: "a.png", mime: "image/png", bytes: bytes("x") })).toMatchObject({ ok: false });
    expect(validateUpload({ filename: "a.txt", mime: "text/plain", bytes: bytes("") })).toMatchObject({ ok: false });
    expect(validateUpload({ filename: "a.txt", mime: "text/plain", bytes: Buffer.from([0x61, 0x00, 0x62]) })).toMatchObject({ ok: false });
    expect(validateUpload({ filename: "a.txt", mime: "text/plain", bytes: Buffer.from([0xff, 0xfe]) })).toMatchObject({ ok: false });
    expect(validateUpload({ filename: "a.txt", mime: "text/plain", bytes: Buffer.alloc(maxUploadBytes + 1, 0x61) })).toMatchObject({ ok: false });
  });

  it("rejects executable/script filenames and strips path components", () => {
    expect(validateUpload({ filename: "run.sh", mime: "text/plain", bytes: bytes("x") })).toMatchObject({ ok: false });
    expect(sanitizeUploadFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeUploadFilename("dir\\sub\\notes.txt")).toBe("notes.txt");
    expect(sanitizeUploadFilename("bad\u0000name.md")).toBe("badname.md");
    expect(sanitizeUploadFilename("..")).toBe("");
  });
});

describe("uploadUrl", () => {
  it("encodes the conversation id, filename and MIME as query parameters", () => {
    expect(uploadUrl("a/b", "report 2026.txt", "text/plain")).toBe(
      "/api/ops/conversations/a%2Fb/uploads?filename=report+2026.txt&mime=text%2Fplain",
    );
  });
});

describe("buildUploadContext", () => {
  const upload = (overrides: Partial<ConversationUpload> = {}): ConversationUpload => ({
    id: "u1", conversationId: "c1", ownerUserId: "user1", filename: "notes.txt",
    mime: "text/plain", sizeBytes: 12, storagePath: "uploads/c1/u1/notes.txt", sha256: "abc",
    createdAt: "2026-01-01T00:00:00.000Z", ...overrides,
  });

  it("returns empty context when there are no uploads", () => {
    expect(buildUploadContext([], "/storage", "en")).toEqual({ roots: [], paths: [], manifest: "" });
  });

  it("builds per-upload roots and a bounded, labelled manifest", () => {
    const result = buildUploadContext([upload()], "/storage", "en");
    expect(result.roots).toEqual(["/storage/uploads/c1/u1"]);
    expect(result.paths).toEqual(["/storage/uploads/c1/u1/notes.txt"]);
    expect(result.manifest).toContain("untrusted data");
    expect(result.manifest).toContain("/storage/uploads/c1/u1/notes.txt");
    expect(result.manifest).toContain("12 bytes");
  });

  it("uses Chinese guidance and redacts token-like filenames", () => {
    const result = buildUploadContext([upload({ filename: "token=supersecret.txt" })], "/storage", "zh-CN");
    expect(result.manifest).toContain("不可信数据");
    expect(result.manifest).not.toContain("supersecret");
  });
});
