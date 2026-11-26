import { describe, expect, it } from "vitest";
import { buildUploadContext, maxUploadBytes, sanitizeUploadFilename, uploadUrl, validateUpload } from "../../src/app/upload.js";
import { detectUploadKind } from "../../src/app/upload-magic.js";
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
  it("respects the configured byte limit", () => {
    const payload = Buffer.alloc(2_000, 0x61);
    expect(validateUpload({ filename: "big.txt", mime: "text/plain", bytes: payload, maxBytes: 1_000 })).toMatchObject({ ok: false });
    expect(validateUpload({ filename: "big.txt", mime: "text/plain", bytes: payload, maxBytes: 4_000 })).toEqual({ ok: true });
  });

  it("rejects disguised binaries even when declared as plain text", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(validateUpload({ filename: "notes.txt", mime: "text/plain", bytes: png })).toMatchObject({ ok: false, error: "image uploads are not supported yet" });
    expect(validateUpload({ filename: "run.txt", mime: "text/plain", bytes: bytes("#!/bin/sh\necho hi") })).toMatchObject({ ok: false, error: "executable or script content is not allowed" });
  });
});

describe("upload magic bytes", () => {
  it("detects text and rejects known non-text signatures", () => {
    expect(detectUploadKind(bytes("hello 世界"))).toBe("text");
    expect(detectUploadKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image");
    expect(detectUploadKind(Buffer.from("%PDF-1.7"))).toBe("pdf");
    expect(detectUploadKind(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe("archive");
    expect(detectUploadKind(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBe("executable");
    expect(detectUploadKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image");
    expect(detectUploadKind(Buffer.from([0x00, 0x01, 0x02]))).toBe("binary");
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
    expect(buildUploadContext([], "/storage", "en")).toEqual({ uploads: [], manifest: "" });
  });

  it("returns internal roots but only virtual URIs in the manifest", () => {
    const result = buildUploadContext([upload()], "/storage", "en");
    expect(result.uploads).toEqual([{ id: "u1", path: "/storage/uploads/c1/u1" }]);
    expect(result.manifest).toContain("untrusted data");
    expect(result.manifest).toContain("upload://u1/notes.txt");
    expect(result.manifest).not.toContain("/storage/");
    expect(result.manifest).toContain("12 bytes");
  });

  it("uses Chinese guidance and redacts token-like filenames", () => {
    const result = buildUploadContext([upload({ filename: "token=supersecret.txt" })], "/storage", "zh-CN");
    expect(result.manifest).toContain("不可信数据");
    expect(result.manifest).not.toContain("supersecret");
  });
});
