import { useEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";

type RectPayload = {
  // physical pixels in virtual-screen coordinates
  x: number;
  y: number;
  width: number;
  height: number;
};

export default function OcrOverlay() {
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById("root");

    // Apply overlay-specific class to neutralize app-wide backgrounds (prevents white screen).
    body.classList.add("overlay");
    // Ensure html/body are transparent even if global CSS sets them.
    const prev = {
      htmlBg: html.style.background,
      bodyBg: body.style.background,
    };
    html.style.background = "transparent";
    body.style.background = "transparent";

    return () => {
      body.classList.remove("overlay");
      html.style.background = prev.htmlBg;
      body.style.background = prev.bodyBg;
    };
  }, []);

  const [dragging, setDragging] = useState(false);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [cur, setCur] = useState<{ x: number; y: number } | null>(null);
  const scaleRef = useRef(1);
  const originRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    const w = getCurrentWebviewWindow();
    void (async () => {
      try {
        scaleRef.current = await w.scaleFactor();
      } catch {
        scaleRef.current = window.devicePixelRatio || 1;
      }
      try {
        const pos = await w.outerPosition();
        originRef.current = { x: pos.x, y: pos.y };
      } catch {
        originRef.current = { x: 0, y: 0 };
      }
      try {
        await w.outerSize();
      } catch {}
    })();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void getCurrentWindow().destroy();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const rect = useMemo(() => {
    if (!start || !cur) return null;
    const x1 = Math.min(start.x, cur.x);
    const y1 = Math.min(start.y, cur.y);
    const x2 = Math.max(start.x, cur.x);
    const y2 = Math.max(start.y, cur.y);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }, [start, cur]);

  const startDrag = (e: React.PointerEvent) => {
    // Right-click = immediate cancel (safety hatch)
    if (e.button === 2) {
      void getCurrentWindow().destroy();
      return;
    }
    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    setDragging(true);
    setStart({ x: e.clientX, y: e.clientY });
    setCur({ x: e.clientX, y: e.clientY });
  };

  const moveDrag = (e: React.PointerEvent) => {
    if (!dragging) return;
    setCur({ x: e.clientX, y: e.clientY });
  };

  const endDrag = async () => {
    setDragging(false);
    if (!rect) {
      await getCurrentWindow().destroy();
      return;
    }
    const minSize = 6;
    if (rect.w < minSize || rect.h < minSize) {
      await getCurrentWindow().destroy();
      return;
    }

    const scale = scaleRef.current || 1;
    const origin = originRef.current;
    const phys = {
      x: Math.floor(origin.x + rect.x * scale),
      y: Math.floor(origin.y + rect.y * scale),
      width: Math.floor(rect.w * scale),
      height: Math.floor(rect.h * scale),
    } satisfies RectPayload;

    await emit<RectPayload>("erudaite://ocr/selected", phys)
      .catch(() => {});
    await getCurrentWindow().destroy().catch(() => {});
  };

  return (
    <div
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={() => {
        void getCurrentWindow().destroy();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        void getCurrentWindow().destroy();
      }}
      style={{
        position: "fixed",
        inset: 0,
        // Transparent overlay (still captures pointer events)
        background: "rgba(0,0,0,0)",
        cursor: "crosshair",
        userSelect: "none",
      }}
    >
      {/* Selection box */}
      {rect && (
        <div
          style={{
            position: "absolute",
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            border: "2px solid #60a5fa",
            background: "rgba(96,165,250,0.15)",
            boxSizing: "border-box",
          }}
        />
      )}

      {/* Hint */}
      <div
        style={{
          position: "absolute",
          left: 16,
          top: 16,
          padding: "8px 10px",
          borderRadius: 10,
          background: "rgba(0,0,0,0.55)",
          color: "white",
          fontSize: 13,
        }}
      >
        ドラッグで範囲選択（Esc/右クリックでキャンセル）
      </div>

      {/* Always-visible close button (safety hatch) */}
      <button
        type="button"
        onClick={() => {
          void getCurrentWindow().destroy();
        }}
        aria-label="Close"
        title="Close (Esc / Right click)"
        style={{
          position: "absolute",
          right: 16,
          top: 16,
          width: 34,
          height: 34,
          borderRadius: 10,
          border: "none",
          background: "rgba(0,0,0,0.55)",
          color: "white",
          fontSize: 18,
          cursor: "pointer",
        }}
      >
        ×
      </button>
    </div>
  );
}


