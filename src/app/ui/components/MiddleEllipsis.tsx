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
    // 媒体查询改变 max-width 时元素宽度未必变化（父级同样按内容收缩），
    // 额外监听窗口 resize 强制重算一次。
    window.addEventListener("resize", update);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [text]);

  return (
    <span className={`middle-ellipsis${className ? ` ${className}` : ""}`} ref={ref} title={text}>
      {/* 隐藏的完整文本撑出「未被截断时」的宽度，避免截断后变窄导致 ResizeObserver 不再放大。 */}
      <span className="middle-ellipsis-sizer" aria-hidden="true">{text}</span>
      <span className="middle-ellipsis-content">
        <span className="middle-ellipsis-head">{parts.head}</span>
        {parts.tail ? (
          <>
            <span className="middle-ellipsis-ellipsis">...</span>
            <span className="middle-ellipsis-tail">{parts.tail}</span>
          </>
        ) : null}
      </span>
    </span>
  );
});
