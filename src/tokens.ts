import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** 用户令牌的对称加密器；密钥由部署密钥派生，密文只写入本地 SQLite。 */
export interface TokenCipher {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

/**
 * 用 AES-256-GCM 加密 GitLab 令牌。空字符串直接放行，避免把「未配置」写成密文。
 * 未提供主密钥时生成进程内随机密钥：重启后旧令牌不可解密，部署应显式配置密钥。
 */
export function createTokenCipher(secret: string): TokenCipher {
  const key = createHash("sha256").update(secret || randomBytes(32).toString("hex")).digest();
  return {
    encrypt(value: string): string {
      if (!value) return "";
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
    },
    decrypt(value: string): string {
      if (!value) return "";
      const parts = value.split(".");
      if (parts.length !== 3) return "";
      try {
        const [iv, tag, data] = parts as [string, string, string];
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
      } catch {
        // 密钥轮换或数据损坏时只让该用户的令牌失效，不影响其他用户。
        return "";
      }
    },
  };
}
