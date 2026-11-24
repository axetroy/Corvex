/** 过程块里可合并的展示段；只需 kind/key/text/count 这几个字段。 */
export interface MergeableSegment {
  kind: string;
  key: string;
  text?: string;
  count?: number;
}

/**
 * 同类上下文提示共用一个段：微压缩通知会随每次新增裁剪反复出现，
 * 合并后只显示一条并带次数，既不刷屏也不丢失「发生了多次」的信息。
 */
export function contextSegmentKey(id: string): string {
  return id.startsWith("microcompact-") ? "microcompact" : `context-${id}`;
}

export function mergeContextNotice<T extends MergeableSegment>(
  segments: T[],
  id: string,
  text: string,
  make: (key: string, text: string) => T,
): void {
  const key = contextSegmentKey(id);
  const existing = segments.find((segment) => segment.kind === "context" && segment.key === key);
  if (existing) {
    existing.count = (existing.count ?? 1) + 1;
    existing.text = text;
    return;
  }
  segments.push(make(key, text));
}
