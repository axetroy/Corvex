import { describe, expect, it } from "vitest";
import { buildUploadContext, maxUploadBytes, sanitizeUploadFilename, uploadUrl, validateUpload } from "../../src/app/upload.js";
import { detectUploadKind } from "../../src/app/upload-magic.js";
import type { ConversationUpload } from "../../src/model.js";

const bytes = (value: string) => Buffer.from(value, "utf8");

describe("upload validation", () => {
  it("accepts any UTF-8 text regardless of extension or declared MIME", () => {
    expect(validateUpload({ filename: "notes.txt", mime: "text/plain", bytes: bytes("hello 世界") })).toEqual({ ok: true, mime: "text/plain" });
    expect(validateUpload({ filename: "report.json", mime: "application/json", bytes: bytes("{}") })).toEqual({ ok: true, mime: "application/json" });
    // 浏览器对源码文件常给出空 MIME 或 text/x-*；字节是文本就应放行。
    expect(validateUpload({ filename: "main.py", mime: "", bytes: bytes("#!/usr/bin/env python\nprint('hi')\n") })).toEqual({ ok: true, mime: expect.any(String) });
    expect(validateUpload({ filename: "index.html", mime: "text/html", bytes: bytes("<!doctype html><html></html>") })).toEqual({ ok: true, mime: expect.any(String) });
    expect(validateUpload({ filename: "app.ts", mime: "text/x-typescript", bytes: bytes("export const x: number = 1;") })).toEqual({ ok: true, mime: expect.any(String) });
    expect(validateUpload({ filename: "run.sh", mime: "application/octet-stream", bytes: bytes("#!/bin/sh\necho hi\n") })).toEqual({ ok: true, mime: expect.any(String) });
    expect(validateUpload({ filename: "weird.png", mime: "image/png", bytes: bytes("not really a png") })).toEqual({ ok: true, mime: expect.any(String) });
  });

  it("accepts supported images with a byte-detected MIME", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    expect(validateUpload({ filename: "shot.png", mime: "text/plain", bytes: png })).toEqual({ ok: true, mime: "image/png" });
    expect(validateUpload({ filename: "photo.jpg", mime: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]) })).toEqual({ ok: true, mime: "image/jpeg" });
    expect(validateUpload({ filename: "bmp.txt", mime: "image/bmp", bytes: Buffer.from([0x42, 0x4d, 0x00, 0x01]) })).toMatchObject({ ok: false });
  });

  it("rejects empty content, NUL, invalid UTF-8 and oversized content", () => {
    expect(validateUpload({ filename: "a.txt", mime: "text/plain", bytes: bytes("") })).toMatchObject({ ok: false });
    expect(validateUpload({ filename: "a.txt", mime: "text/plain", bytes: Buffer.from([0x61, 0x00, 0x62]) })).toMatchObject({ ok: false, error: "binary content is not allowed" });
    expect(validateUpload({ filename: "a.txt", mime: "text/plain", bytes: Buffer.from([0xff, 0xfe]) })).toMatchObject({ ok: false, error: "binary content is not allowed" });
    expect(validateUpload({ filename: "a.txt", mime: "text/plain", bytes: Buffer.alloc(maxUploadBytes + 1, 0x61) })).toMatchObject({ ok: false });
  });

  it("rejects binary executable filenames and strips path components", () => {
    expect(validateUpload({ filename: "setup.exe", mime: "text/plain", bytes: bytes("x") })).toMatchObject({ ok: false, error: "executable filenames are not allowed" });
    expect(sanitizeUploadFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeUploadFilename("dir\\sub\\notes.txt")).toBe("notes.txt");
    expect(sanitizeUploadFilename("bad\u0000name.md")).toBe("badname.md");
    expect(sanitizeUploadFilename("..")).toBe("");
  });
  it("respects the configured byte limit", () => {
    const payload = Buffer.alloc(2_000, 0x61);
    expect(validateUpload({ filename: "big.txt", mime: "text/plain", bytes: payload, maxBytes: 1_000 })).toMatchObject({ ok: false });
    expect(validateUpload({ filename: "big.txt", mime: "text/plain", bytes: payload, maxBytes: 4_000 })).toEqual({ ok: true, mime: expect.any(String) });
  });

  it("rejects disguised binaries even when declared as plain text", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(validateUpload({ filename: "notes.txt", mime: "text/plain", bytes: png })).toMatchObject({ ok: false, error: "unsupported or mismatched image format; use PNG, JPEG, GIF or WebP" });
    // shebang 是纯文本脚本文本，作为上下文读取不会执行，应放行。
    expect(validateUpload({ filename: "run.sh", mime: "", bytes: bytes("#!/bin/sh\necho hi") })).toEqual({ ok: true, mime: expect.any(String) });
  });
});

describe("upload magic bytes", () => {
  it("detects text and rejects known non-text signatures", () => {
    expect(detectUploadKind(bytes("hello 世界"))).toBe("text");
    expect(detectUploadKind(bytes("#!/usr/bin/env python\nprint(1)\n"))).toBe("text");
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
    expect(result.uploads).toEqual([{
      id: "u1", mime: "text/plain", filename: "notes.txt",
      rootPath: "/storage/uploads/c1/u1", filePath: "/storage/uploads/c1/u1/notes.txt",
    }]);
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
