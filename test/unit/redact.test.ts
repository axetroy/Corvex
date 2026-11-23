import { describe, expect, it } from "vitest";
import {
  redactSensitiveText,
  sanitizeSensitiveText,
  sanitizeSensitiveValue,
} from "../../src/redact.ts";

describe("credential redaction", () => {
  it("redacts bearer tokens and known token prefixes", () => {
    expect(redactSensitiveText("Authorization: Bearer abc.def-123")).not.toContain("abc.def-123");
    expect(redactSensitiveText("glpat-abcdefghijklmnopqrstuvwx")).toBe("[REDACTED]");
    expect(redactSensitiveText("sk-abcdefghijklmnopqrstuvwx")).toBe("[REDACTED]");
  });

  it("redacts key=value credentials in free text", () => {
    const text = "connect with password: hunter2 and token=abc123";
    const result = redactSensitiveText(text);
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("abc123");
  });

  it("redacts JSON string fields even when the caller stringified them", () => {
    const text = '{"before":{"messages":[{"role":"toolResult","text":"{\\"api_key\\":\\"sk-abcdefghijklmnopqrstuvwx\\"}"}]}}';
    const result = sanitizeSensitiveText(text);
    expect(result).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts sensitive field names recursively in structured data", () => {
    const value = sanitizeSensitiveValue({
      ok: "keep me",
      nested: [{ authorization: "Bearer secret", label: "visible" }],
    });
    expect(value).toEqual({
      ok: "keep me",
      nested: [{ authorization: "[REDACTED]", label: "visible" }],
    });
  });

  it("falls back to text redaction when the string is not JSON", () => {
    expect(sanitizeSensitiveText("token=abc123 and more text")).not.toContain("abc123");
  });

  it("redacts credentials embedded in URLs", () => {
    expect(sanitizeSensitiveText("https://user:pass@gitlab.example.com/repo")).toContain("[REDACTED]@");
    expect(sanitizeSensitiveText("https://api.example.com/?access_token=abc123")).not.toContain("abc123");
  });
});
