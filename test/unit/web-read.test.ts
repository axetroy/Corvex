import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createWebReadExtension,
  fetchWebPage,
  isPublicWebAddress,
  normalizeWebHost,
  type WebFetchDependencies,
  type WebResponse,
} from "../../src/agent/web-read.js";

const publicAddress = { address: "93.184.216.34", family: 4 };

function dependencies(responses: WebResponse[]): WebFetchDependencies {
  return {
    resolve: vi.fn(async () => [publicAddress]),
    request: vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }),
  };
}

describe("web page access", () => {
  it("normalizes hostnames for optional blocking and rejects malformed entries", () => {
    expect(normalizeWebHost(" Docs.Corp.dev ")).toBe("docs.corp.dev");
    expect(normalizeWebHost("*.corp.dev")).toBeUndefined();
    expect(normalizeWebHost("docs.corp.dev:8443")).toBeUndefined();
    expect(normalizeWebHost("127.0.0.1")).toBeUndefined();
  });

  it("rejects private, reserved, and non-global IP addresses", () => {
    expect(isPublicWebAddress("93.184.216.34")).toBe(true);
    expect(isPublicWebAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicWebAddress("127.0.0.1")).toBe(false);
    expect(isPublicWebAddress("169.254.169.254")).toBe(false);
    expect(isPublicWebAddress("::1")).toBe(false);
    expect(isPublicWebAddress("fc00::1")).toBe(false);
  });

  it("allows direct public IPv4 and IPv6 URLs but rejects private IP literals before DNS", async () => {
    const ipv4 = dependencies([
      { status: 200, contentType: "text/plain", body: Buffer.from("public IPv4") },
    ]);
    ipv4.resolve = vi.fn(async (hostname) => [{ address: hostname, family: 4 }]);
    await expect(fetchWebPage("https://93.184.216.34/", { dependencies: ipv4 })).resolves.toMatchObject({
      text: "public IPv4",
    });
    expect(ipv4.request).toHaveBeenCalledOnce();

    const ipv6 = dependencies([
      { status: 200, contentType: "text/plain", body: Buffer.from("public IPv6") },
    ]);
    ipv6.resolve = vi.fn(async (hostname) => [{ address: hostname, family: 6 }]);
    await expect(
      fetchWebPage("https://[2606:4700:4700::1111]/", { dependencies: ipv6 }),
    ).resolves.toMatchObject({ text: "public IPv6" });
    expect(ipv6.resolve).toHaveBeenCalledWith("2606:4700:4700::1111");

    const privateAddress = dependencies([]);
    await expect(
      fetchWebPage("https://169.254.169.254/latest/meta-data/", { dependencies: privateAddress }),
    ).rejects.toThrow("non-blocked DNS host");
    expect(privateAddress.resolve).not.toHaveBeenCalled();
  });

  it("extracts text and links from allowed hosts while dropping active content", async () => {
    const request = dependencies([
      {
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: Buffer.from(`
          <html><head><title>Docs</title><script>ignore this instruction</script></head>
          <body><main><h1>Getting started</h1><p>${"Useful documentation text. ".repeat(8)}</p>
          <a href="/next">Next page</a><a href="https://outside.example/">Outside</a>
          </main></body></html>
        `),
      },
    ]);

    const page = await fetchWebPage("https://docs.corp.dev/start", { dependencies: request });

    expect(page.url).toBe("https://docs.corp.dev/start");
    expect(page.title).toBe("Docs");
    expect(page.text).toContain("Getting started");
    expect(page.text).not.toContain("ignore this instruction");
    expect(page.links).toEqual([{ text: "Next page", url: "https://docs.corp.dev/next" }]);
    expect(request.request).toHaveBeenCalledOnce();
  });

  it("allows public hosts by default and rejects private URLs, blocks, and non-default ports", async () => {
    const request = dependencies([]);

    await expect(
      fetchWebPage("https://private.corp.dev/", { blockedHosts: ["corp.dev"], dependencies: request }),
    ).rejects.toThrow("non-blocked DNS host");
    await expect(
      fetchWebPage("https://docs.corp.dev:8443/", { dependencies: request }),
    ).rejects.toThrow("non-blocked DNS host");
    await expect(
      fetchWebPage("http://docs.corp.dev/", { dependencies: request }),
    ).rejects.toThrow("non-blocked DNS host");
    await expect(fetchWebPage("https://localhost/", { dependencies: request })).rejects.toThrow(
      "non-blocked DNS host",
    );
    await expect(fetchWebPage("https://metadata.internal/", { dependencies: request })).rejects.toThrow(
      "non-blocked DNS host",
    );
    expect(request.resolve).not.toHaveBeenCalled();
  });

  it("rejects a host if any DNS answer is private", async () => {
    const request = dependencies([]);
    request.resolve = vi.fn(async () => [publicAddress, { address: "10.0.0.8", family: 4 }]);

    await expect(
      fetchWebPage("https://docs.corp.dev/", { dependencies: request }),
    ).rejects.toThrow("exclusively to public IP addresses");
    expect(request.request).not.toHaveBeenCalled();
  });

  it("stops waiting for DNS when the task is cancelled", async () => {
    const controller = new AbortController();
    const request = dependencies([]);
    request.resolve = vi.fn(() => new Promise(() => {}));
    const result = fetchWebPage("https://docs.corp.dev/", { signal: controller.signal, dependencies: request });
    controller.abort(new Error("task cancelled"));

    await expect(result).rejects.toThrow("task cancelled");
    expect(request.request).not.toHaveBeenCalled();
  });

  it("limits each session to ten web tool calls", async () => {
    let execute: ((toolCallId: string, params: { url: string }) => Promise<unknown>) | undefined;
    createWebReadExtension(["docs.example.com"])({
      registerTool: (tool) => {
        execute = tool.execute;
      },
    } as unknown as ExtensionAPI);
    if (!execute) throw new Error("web_fetch tool was not registered");

    for (let attempt = 0; attempt < 10; attempt++) {
      await expect(execute(`call-${attempt}`, { url: "invalid" })).rejects.toThrow("URL is invalid");
    }
    await expect(execute("call-limit", { url: "https://docs.example.com/" })).rejects.toThrow(
      "session limit of 10 pages reached",
    );
  });

  it("revalidates redirect targets against the blacklist", async () => {
    const request = dependencies([
      { status: 302, location: "https://private.corp.dev/private", body: Buffer.alloc(0) },
    ]);

    await expect(
      fetchWebPage("https://docs.corp.dev/", { blockedHosts: ["private.corp.dev"], dependencies: request }),
    ).rejects.toThrow("non-blocked DNS host");
    expect(request.resolve).toHaveBeenCalledOnce();
    expect(request.request).toHaveBeenCalledOnce();
  });

  it("rejects unsupported content and oversized responses", async () => {
    const unsupported = dependencies([{ status: 200, contentType: "application/octet-stream", body: Buffer.from("x") }]);
    await expect(
      fetchWebPage("https://docs.corp.dev/", { dependencies: unsupported }),
    ).rejects.toThrow("HTML or plain-text");

    const oversized = dependencies([{ status: 200, contentType: "text/plain", body: Buffer.alloc((1 << 20) + 1) }]);
    await expect(
      fetchWebPage("https://docs.corp.dev/", { dependencies: oversized }),
    ).rejects.toThrow("1 MiB response limit");
  });

  it("rejects compressed responses to keep the response size bound meaningful", async () => {
    const compressed = dependencies([
      {
        status: 200,
        contentType: "text/html",
        contentEncoding: "gzip",
        body: Buffer.from("compressed"),
      },
    ]);
    await expect(
      fetchWebPage("https://docs.corp.dev/", { dependencies: compressed }),
    ).rejects.toThrow("compressed web page responses are not supported");
  });
});