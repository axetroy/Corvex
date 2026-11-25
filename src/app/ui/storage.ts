/** 存储管理页的纯展示逻辑：字节格式化与表格排序，不依赖 React / antd。 */

/** 管理页展示的存储条目（与后端 StorageEntry 对齐，前端只用需要的字段）。 */
export interface StorageRow {
  projectId: number;
  name: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  conversationId?: string;
  truncated: boolean;
}

/** 把字节数格式化为可读单位。镜像体积可达 GiB，因此扩展到 GiB/TiB。 */
export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

/** 按大小降序排序，相同大小时按名称稳定排序，避免测试与界面顺序抖动。 */
export function sortStorageRows(rows: readonly StorageRow[]): StorageRow[] {
  return [...rows].sort((a, b) =>
    b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name),
  );
}

/** 汇总条目总字节数；近似值在界面上以 truncated 标记提示。 */
export function totalStorageBytes(rows: readonly StorageRow[]): number {
  return rows.reduce((sum, row) => sum + row.sizeBytes, 0);
}
