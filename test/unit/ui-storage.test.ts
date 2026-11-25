import { describe, expect, it } from "vitest";
import { formatStorageBytes, sortStorageRows, totalStorageBytes, type StorageRow } from "../../src/app/ui/storage.js";

function row(overrides: Partial<StorageRow>): StorageRow {
  return {
    projectId: 7,
    name: "7.git",
    relativePath: "mirrors/7.git",
    sizeBytes: 0,
    modifiedAt: "2026-11-25T00:00:00.000Z",
    truncated: false,
    ...overrides,
  };
}

describe("operations UI storage helpers", () => {
  it("formats byte sizes up to TiB", () => {
    expect(formatStorageBytes(0)).toBe("0 B");
    expect(formatStorageBytes(512)).toBe("512 B");
    expect(formatStorageBytes(2048)).toBe("2.0 KiB");
    expect(formatStorageBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(formatStorageBytes(1024 * 1024 * 1024)).toBe("1.0 GiB");
    expect(formatStorageBytes(-1)).toBe("0 B");
  });

  it("sorts rows by size descending with a stable name tiebreak", () => {
    const sorted = sortStorageRows([
      row({ name: "small", sizeBytes: 10 }),
      row({ name: "large", sizeBytes: 100 }),
      row({ name: "equal-a", sizeBytes: 50 }),
      row({ name: "equal-b", sizeBytes: 50 }),
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual(["large", "equal-a", "equal-b", "small"]);
  });

  it("sums total bytes", () => {
    expect(totalStorageBytes([row({ sizeBytes: 10 }), row({ sizeBytes: 20 })])).toBe(30);
  });
});
