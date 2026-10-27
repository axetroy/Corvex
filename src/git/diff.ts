import type { DiffResult, Workspace, Change } from "./types.js";

const maxTotalDiffBytes = 16 << 20;

type GitRun = (
  workspace: Workspace,
  args: string[],
  input: Buffer | undefined,
  limit: number,
  signal?: AbortSignal,
) => Promise<{ stdout: Buffer; truncated: boolean }>;

interface FileStat {
  added: number;
  removed: number;
  binary: boolean;
}

export class DiffEngine {
  constructor(private readonly run: GitRun) {}

  async diff(
    workspace: Workspace,
    baseSha: string,
    maxFiles: number,
    maxFileDiffBytes: number,
    signal?: AbortSignal,
  ): Promise<DiffResult> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseSha) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(workspace.headSha)) {
      throw new Error("diff requires full commit SHAs");
    }
    if (maxFiles <= 0 || maxFiles > 1000) throw new Error("maxFiles must be between 1 and 1000");
    if (maxFileDiffBytes <= 0 || maxFileDiffBytes > maxTotalDiffBytes) {
      throw new Error(`maxFileDiffBytes must be between 1 and ${maxTotalDiffBytes}`);
    }

    const names = await this.run(
      workspace,
      ["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", baseSha, workspace.headSha, "--"],
      undefined,
      maxTotalDiffBytes,
      signal,
    );
    if (names.truncated) throw new Error("changed file list exceeds output limit");
    const files = parseNameStatus(names.stdout);
    const statsOutput = await this.run(
      workspace,
      ["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", baseSha, workspace.headSha, "--"],
      undefined,
      maxTotalDiffBytes,
      signal,
    );
    if (statsOutput.truncated) throw new Error("diff statistics exceed output limit");
    const stats = parseNumstat(statsOutput.stdout);
    const result: DiffResult = {
      baseSha,
      headSha: workspace.headSha,
      changes: [],
      skippedFiles: 0,
    };
    let totalBytes = 0;
    for (const [index, file] of files.entries()) {
      if (index >= maxFiles) {
        result.skippedFiles++;
        continue;
      }
      const stat = stats.get(file.path);
      if (!stat) throw new Error(`Git returned no statistics for changed file "${file.path}"`);
      if (stat.binary) {
        result.changes.push({
          ...file,
          addedLines: 0,
          removedLines: 0,
          skipped: "binary file",
          patch: "",
        });
        result.skippedFiles++;
        continue;
      }
      const remaining = maxTotalDiffBytes - totalBytes;
      const fileLimit = Math.min(maxFileDiffBytes, remaining);
      if (fileLimit <= 0) {
        result.changes.push({ ...file, addedLines: stat.added, removedLines: stat.removed, skipped: "total diff size limit exceeded", patch: "" });
        result.skippedFiles++;
        continue;
      }
      const patch = await this.run(
        workspace,
        ["diff", "--no-ext-diff", "--unified=3", baseSha, workspace.headSha, "--", file.path],
        undefined,
        fileLimit,
        signal,
      );
      if (patch.truncated) {
        result.changes.push({ ...file, addedLines: stat.added, removedLines: stat.removed, skipped: "file diff size limit exceeded", patch: "" });
        result.skippedFiles++;
        continue;
      }
      result.changes.push({
        ...file,
        addedLines: stat.added,
        removedLines: stat.removed,
        skipped: "",
        patch: patch.stdout.toString(),
      });
      totalBytes += patch.stdout.length;
    }
    return result;
  }
}

function parseNameStatus(output: Buffer): Array<Omit<Change, "addedLines" | "removedLines" | "patch" | "skipped">> {
  const fields = output.toString().split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) throw new Error("Git returned malformed changed file status");
  const changes: Array<Omit<Change, "addedLines" | "removedLines" | "patch" | "skipped">> = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index]!;
    const name = fields[index + 1]!;
    if (!/^[AMDTUXB]$/.test(status) || !validPath(name)) {
      throw new Error("Git returned an invalid changed file status or path");
    }
    changes.push({ path: name, status });
  }
  return changes;
}

function parseNumstat(output: Buffer): Map<string, FileStat> {
  const fields = output.toString().split("\0");
  if (fields.at(-1) === "") fields.pop();
  const stats = new Map<string, FileStat>();
  for (const entry of fields) {
    const firstTab = entry.indexOf("\t");
    const secondTab = entry.indexOf("\t", firstTab + 1);
    if (firstTab < 1 || secondTab < 0) throw new Error("Git returned malformed diff statistics");
    const added = entry.slice(0, firstTab);
    const removed = entry.slice(firstTab + 1, secondTab);
    const name = entry.slice(secondTab + 1);
    if (!validPath(name)) throw new Error("Git returned an invalid path in diff statistics");
    const binary = added === "-" && removed === "-";
    if (!binary && (!/^\d+$/.test(added) || !/^\d+$/.test(removed))) {
      throw new Error("Git returned invalid line counts in diff statistics");
    }
    stats.set(name, { added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary });
  }
  return stats;
}

function validPath(value: string): boolean {
  return (
    value !== "" &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
