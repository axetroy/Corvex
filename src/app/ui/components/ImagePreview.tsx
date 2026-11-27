import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Typography } from "antd";
import type { Copy } from "../lib/i18n.js";

interface Props {
  src: string;
  alt: string;
  copy: Copy;
}

interface Size {
  width: number;
  height: number;
}

interface View {
  zoom: number;
  x: number;
  y: number;
}

const minZoom = 0.1;
const maxZoom = 8;
/** 每像素滚轮位移对应的缩放系数；触控板小增量会平滑缩放，鼠标滚轮也不会突变。 */
const zoomPerPixel = 0.0015;
const initialView: View = { zoom: 1, x: 0, y: 0 };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * 独立的图片预览：默认等比缩放到刚好放进当前容器（最大尺寸即容器尺寸），
 * 滚轮以光标为锚点缩放，按住拖拽平移，双击或按钮复位。图片只来自会话鉴权端点。
 */
export function ImagePreview({ src, alt, copy }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; view: View } | null>(null);
  const [failed, setFailed] = useState(false);
  const [natural, setNatural] = useState<Size | null>(null);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [view, setView] = useState<View>(initialView);
  const [dragging, setDragging] = useState(false);
  const previousSrc = useRef(src);

  // 只在切换图片时复位；首次挂载不能覆盖已经触发的 onLoad（缓存图片会同步加载）。
  useEffect(() => {
    if (previousSrc.current === src) return;
    previousSrc.current = src;
    setFailed(false);
    setNatural(null);
    setView(initialView);
  }, [src]);

  // 容器尺寸决定「适应」比例；面板可拖动，缩放比例要跟着新尺寸走。
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    // 先同步量一次，避免 ResizeObserver 首次回调前的全尺寸闪现。
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width && height) setViewport({ width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = useMemo(() => {
    if (!natural || !viewport.width || !viewport.height) return 1;
    return Math.min(viewport.width / natural.width, viewport.height / natural.height);
  }, [natural, viewport]);

  // React 的 onWheel 是被动监听，无法 preventDefault；用原生监听才能阻止页面滚动。
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!natural) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const pointerX = event.clientX - rect.left - rect.width / 2;
      const pointerY = event.clientY - rect.top - rect.height / 2;
      // 不同设备的 deltaMode 差异很大，先统一成像素再按位移比例缩放。
      const pixels = event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * rect.height
          : event.deltaY;
      const factor = clamp(Math.exp(-pixels * zoomPerPixel), 0.8, 1.25);
      setView((current) => {
        const zoom = clamp(current.zoom * factor, minZoom, maxZoom);
        const ratio = zoom / current.zoom;
        return {
          zoom,
          x: pointerX - (pointerX - current.x) * ratio,
          y: pointerY - (pointerY - current.y) * ratio,
        };
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [natural]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !natural) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView((current) => ({
      ...current,
      x: drag.view.x + event.clientX - drag.x,
      y: drag.view.y + event.clientY - drag.y,
    }));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (failed) {
    return <Typography.Text type="danger" className="conversation-image-error">{copy.filePanelImageError}</Typography.Text>;
  }

  return (
    <div className="conversation-image-preview">
      <div
        ref={viewportRef}
        className={`conversation-image-viewport${dragging ? " is-dragging" : ""}`}
        title={copy.filePanelImageHint}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setView(initialView)}
      >
        <img
          className="conversation-image-canvas"
          src={src}
          alt={alt}
          draggable={false}
          style={{
            width: natural?.width,
            height: natural?.height,
            visibility: natural && viewport.width && viewport.height ? "visible" : "hidden",
            // 先以视口中心为原点居中，再叠加拖拽偏移与缩放；不依赖 Grid 的溢出对齐。
            transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${fit * view.zoom})`,
          }}
          onLoad={(event) => setNatural({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          })}
          onError={() => setFailed(true)}
        />
      </div>
      <div className="conversation-image-meta">
        {natural ? <span>{natural.width} × {natural.height}</span> : null}
        <span>{Math.round(fit * view.zoom * 100)}%</span>
        <button type="button" className="conversation-image-fit" onClick={() => setView(initialView)}>
          {copy.filePanelImageFit}
        </button>
        <a href={src} target="_blank" rel="noopener noreferrer">{copy.filePanelImageOpen}</a>
      </div>
    </div>
  );
}
