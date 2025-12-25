import { useEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";

// #region agent log
function dbg(hypothesisId: string, location: string, message: string, data: Record<string, unknown> = {}) {
  fetch("http://127.0.0.1:7242/ingest/71db1e77-df5f-480c-9275-0e41f17d2b1f", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "debug-session", runId: "run1", hypothesisId, location, message, data, timestamp: Date.now() }),
  }).catch(() => {});
}
// #endregion agent log

type RectPayload = {
  // physical pixels in virtual-screen coordinates
  x: number;
  y: number;
  width: number;
  height: number;
};

export default function OcrOverlay() {
  useEffect(() => {
    dbg("D", "src/OcrOverlay.tsx:mount", "overlay mounted", { href: window.location.href });
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
      dbg("D", "src/OcrOverlay.tsx:endDrag", "no rect -> destroy", {});
      await getCurrentWindow().destroy();
      return;
    }
    const minSize = 6;
    if (rect.w < minSize || rect.h < minSize) {
      dbg("D", "src/OcrOverlay.tsx:endDrag", "too small -> destroy", { rect });
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

    dbg("D", "src/OcrOverlay.tsx:endDrag", "emit rect", { rect, phys, scale, origin });
    await emit<RectPayload>("erudaite://ocr/selected", phys).catch(() => {});
    await getCurrentWindow().destroy().catch(() => {});
  };

  return (
    <div
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
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
        ドラッグで範囲選択（Escでキャンセル）
      </div>
    </div>
  );
}


