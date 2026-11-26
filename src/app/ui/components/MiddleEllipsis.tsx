import { memo, useEffect, useRef, useState } from "react";
import { fitMiddleEllipsis, splitForMiddleEllipsis } from "../lib/truncate.js";

/**
 * 按真实字宽把长文本切成「开头...结尾」，完整文本留在 title。
 * 宽度由外部 CSS 决定，ResizeObserver 负责在容器变化时重新计算。
 */
export const MiddleEllipsis = memo(function MiddleEllipsis({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [parts, setParts] = useState(() => splitForMiddleEllipsis(text));

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      const context = document.createElement("canvas").getContext("2d");
      if (!context) return;
      context.font = getComputedStyle(node).font;
      if (node.clientWidth <= 0) return;
      const next = fitMiddleEllipsis(text, (value) => context.measureText(value).width, node.clientWidth);
      setParts((current) =>
        current.head === next.head && current.tail === next.tail ? current : next,
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span className={className} ref={ref} title={text}>
      <span className="middle-ellipsis-head">{parts.head}</span>
      {parts.tail ? (
        <>
          <span className="middle-ellipsis-ellipsis">...</span>
          <span className="middle-ellipsis-tail">{parts.tail}</span>
        </>
      ) : null}
    </span>
  );
});
