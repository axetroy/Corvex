import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendText } from "./respond.js";

/** 构建后的 Agent 控制台目录；开发与生产都从包根目录的 dist/app/ui 读取。 */
const operationsUiDirectory = new URL("../../../dist/app/ui/", import.meta.url);

/** Agent 控制台允许提供的静态资源扩展名与对应响应类型。 */
const operationsUiContentTypes: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
};

/** 校验 `/ops/assets/<file>` 相对路径，拒绝目录穿越与非白名单扩展名。 */
function operationsUiAsset(relativePath: string): { file: string; contentType: string } | undefined {
  if (!/^assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(relativePath)) return undefined;
  const extension = relativePath.slice(relativePath.lastIndexOf(".") + 1).toLowerCase();
  const contentType = operationsUiContentTypes[extension];
  return contentType ? { file: relativePath, contentType } : undefined;
}

/** 静态资源响应的公共安全头。 */
function uiHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
  };
}

/** 控制台页面的 CSP：脚本仅同源；index 的内联样式在构建产物中带 nonce。 */
function contentSecurityPolicy(nonce?: string): string {
  const styleSource = nonce ? `'self' 'nonce-${nonce}'` : "'self'";
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src ${styleSource}`,
    `style-src-elem ${styleSource}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

async function readUiFile(
  reply: FastifyReply,
  file: string,
  contentType: string,
  render?: (contents: Buffer, nonce: string) => string,
): Promise<void> {
  let contents: Buffer;
  try {
    contents = await readFile(new URL(file, operationsUiDirectory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    sendText(reply, 503, "agent console assets are not built; run pnpm run ui:build\n");
    return;
  }
  const nonce = render ? randomBytes(18).toString("base64url") : undefined;
  reply
    .code(200)
    .headers({
      ...uiHeaders(contentType),
      "content-security-policy": contentSecurityPolicy(nonce),
    })
    .send(nonce && render ? render(contents, nonce) : contents);
}

/**
 * 提供控制台构建产物：`/ops` 与 `/ops/` 返回带 nonce 的 index.html，
 * `/ops/assets/*` 只返回白名单扩展名；其余 `/ops/*` 一律 404。
 * 单独的 `/ops/*` 路由同时承担未匹配 UI 路径的兜底，避免与资源路由重复声明。
 */
export function registerOperationsUi(app: FastifyInstance): void {
  const serveIndex = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await readUiFile(reply, "index.html", "text/html; charset=utf-8", (contents, nonce) =>
      contents.toString("utf8").replaceAll("__CORVEX_CSP_NONCE__", nonce),
    );
  };
  const servePath = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const relativePath = (request.params as { "*"?: string })["*"] ?? "";
    const target = operationsUiAsset(relativePath);
    if (!target) {
      sendText(reply, 404, "not found\n");
      return;
    }
    await readUiFile(reply, target.file, target.contentType);
  };

  app.get("/ops", serveIndex);
  app.head("/ops", serveIndex);
  app.get("/ops/", serveIndex);
  app.head("/ops/", serveIndex);
  app.get("/ops/*", servePath);
  app.head("/ops/*", servePath);
  // 安装向导复用同一份控制台构建产物，由前端按 pathname 渲染。
  app.get("/setup", serveIndex);
  app.head("/setup", serveIndex);
}
