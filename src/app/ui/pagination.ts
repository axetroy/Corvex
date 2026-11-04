import { pageSize } from "./types.js";

/**
 * 把分页偏移钳制到有效范围：历史数据被保留策略清理后，偏移可能越过总数，
 * 此时回退到最后一页，避免出现空页与倒序的区间计数。
 */
export function clampPageOffset(total: number, offset: number, size = pageSize): number {
  if (total <= 0) return 0;
  const lastOffset = Math.floor((total - 1) / size) * size;
  return Math.min(Math.max(0, offset), lastOffset);
}

/** 计算当前页在总数中的显示区间；没有条目时返回 0-0。 */
export function pageRange(
  total: number,
  offset: number,
  itemCount: number,
  size = pageSize,
): { start: number; end: number } {
  if (itemCount === 0 || total <= 0) return { start: 0, end: 0 };
  const effectiveOffset = clampPageOffset(total, offset, size);
  return { start: effectiveOffset + 1, end: Math.min(effectiveOffset + itemCount, total) };
}
