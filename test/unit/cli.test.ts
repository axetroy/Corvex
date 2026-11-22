import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("CLI environment file", () => {
  it("loads --env before validating the configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "corvex-cli-env-"));
    const configPath = join(root, "config.yaml");
    const envPath = join(root, ".env");
    try {
      await writeFile(configPath, JSON.stringify({
        gitlab: { base_url: "https://gitlab.example.com" },
        storage: { root, database: join(root, "state.db") },
      }));
      await writeFile(envPath, "CORVEX_GITLAB_READ_TOKEN=from-file\nCORVEX_GITLAB_TOKEN=from-file\n");
      const env = { ...process.env };
      delete env.CORVEX_GITLAB_READ_TOKEN;
      delete env.CORVEX_GITLAB_TOKEN;
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          join(process.cwd(), "src", "cli.ts"),
          "--config",
          configPath,
          "check-config",
          "--env",
          envPath,
        ],
        { encoding: "utf8", env },
        { timeout: 20_000 },
      );
      expect(output).toContain("Configuration is valid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects the removed worker command", () => {
    let output = "";
    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), "worker"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      output = `${failure.stderr ?? ""}${failure.message}`;
    }
    expect(output).toContain("usage: corvex");
  }, 20_000);
});
