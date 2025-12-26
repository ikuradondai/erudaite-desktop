import { useEffect, useRef, useState } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css"; // For popup-animate animation

// #region agent log
function dbg(hypothesisId: string, location: string, message: string, data: Record<string, unknown> = {}) {
  fetch("http://127.0.0.1:7242/ingest/71db1e77-df5f-480c-9275-0e41f17d2b1f", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "debug-session", runId: "run1", hypothesisId, location, message, data, timestamp: Date.now() }),
  }).catch(() => {});
}
// #endregion agent log

type PopupState = {
  status?: string;
  source?: string;
  translation?: string;
  action?: "enable_ocr" | "recheck_ocr";
};

export default function Popup() {
  const [state, setState] = useState<PopupState>({ status: "Translating…", translation: "" });
  const hasFocusedRef = useRef(false);
  const [isFocused, setIsFocused] = useState(true);
  const [showSource, setShowSource] = useState(false);
  const dragInProgressRef = useRef(false);

  const closeSelf = (_reason: string) => {
    // #region agent log
    dbg("N", "src/Popup.tsx:closeSelf", "close requested", { reason: _reason, dragInProgress: dragInProgressRef.current });
    // #endregion agent log
    const w = getCurrentWebviewWindow();
    // IMPORTANT: `close()` can resolve even if the window stays visible (close-request accepted but not applied).
    // To guarantee UX, hide first (disappear), then close/destroy for cleanup.
    w.hide()
      .catch(() => {});

    // Force destroy to avoid leaving a hidden zombie window with the same label (breaks reopen).
    getCurrentWindow()
      .destroy()
      .catch(() => {
        // Best-effort fallback
        w.close().catch(() => {});
      });
  };

  useEffect(() => {
    const w = getCurrentWebviewWindow();
    // If the popup is focused immediately on open, we can miss the initial focusChanged(true)
    // event depending on timing. In that case, document.hasFocus() will already be true.
    // Mark as "has focused" so the very first outside click (blur) closes immediately.
    if (typeof document !== "undefined" && document.hasFocus()) {
      hasFocusedRef.current = true;
      setIsFocused(true);
    }
    const unlistenDestroyedP = w.listen("tauri://destroyed", () => {});
    const unlistenCloseReqP = w.listen("tauri://close-requested", () => {});
    void emit("erudaite://popup/ready", { label: getCurrentWebviewWindow().label }).catch(() => {});
    const unlistenPromise = listen<PopupState>("erudaite://popup/state", (e) => {
      setState((s) => ({ ...s, ...e.payload }));
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
      void unlistenDestroyedP.then((u) => u()).catch(() => {});
      void unlistenCloseReqP.then((u) => u()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Some platforms don't emit focusChanged(true) reliably.
      // If we receive any key events, the popup is effectively focused.
      hasFocusedRef.current = true;
      if (e.key === "Escape") {
        closeSelf("esc");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    // If the user clicks inside the popup, treat it as focused for the purpose of blur-to-close.
    const onPointerDown = () => {
      hasFocusedRef.current = true;
    };
    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => window.removeEventListener("pointerdown", onPointerDown, { capture: true } as any);
  }, []);

  useEffect(() => {
    // Close when clicking outside (approximated by window blur).
    // Guard: only close on blur after we have successfully received focus at least once.
    const w = getCurrentWebviewWindow();
    const unsubPromise = w.onFocusChanged(({ payload }) => {
      setIsFocused(payload === true);
      if (payload === true) {
        hasFocusedRef.current = true;
        // Drag end heuristic: focus regained -> allow blur-to-close again
        if (dragInProgressRef.current) {
          // #region agent log
          dbg("N", "src/Popup.tsx:focus", "focus regained; clear drag flag", {});
          // #endregion agent log
          dragInProgressRef.current = false;
        }
        return;
      }
      if (payload === false && hasFocusedRef.current) {
        if (dragInProgressRef.current) {
          // #region agent log
          dbg("N", "src/Popup.tsx:focus", "blur while dragging -> ignore", {});
          // #endregion agent log
          return;
        }
        closeSelf("blur");
      }
    });
    return () => {
      void unsubPromise.then((unsub) => unsub()).catch(() => {});
    };
  }, []);

  // Make focus state obvious WITHOUT drawing an inner border around the text area.
  const chrome = isFocused
    ? { opacity: 1, background: "#ffffff" }
    : { opacity: 0.85, background: "#fafafa" };

  return (
    <div
      className="popup-animate"
      style={{
        width: "100%",
        height: "100%",
        padding: 14,
        boxSizing: "border-box",
        background: chrome.background,
        borderRadius: 0,
        boxShadow: "none",
        border: "none",
        opacity: chrome.opacity,
        overflow: "auto",
        userSelect: "text",
        position: "relative",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        transition: "opacity 0.15s ease, background 0.15s ease",
      }}
    >
      {/* Drag handle (because decorations=false) */}
      <div
        onPointerDown={(e) => {
          // Only left button drags
          if (e.button !== 0) return;
          dragInProgressRef.current = true;
          // #region agent log
          dbg("N", "src/Popup.tsx:drag", "startDragging", {});
          // #endregion agent log
          void getCurrentWindow()
            .startDragging()
            .then(() => {
              // #region agent log
              dbg("N", "src/Popup.tsx:drag", "startDragging resolved", {});
              // #endregion agent log
            })
            .catch((err) => {
              // #region agent log
              dbg("N", "src/Popup.tsx:drag", "startDragging failed", { error: err instanceof Error ? err.message : String(err) });
              // #endregion agent log
              dragInProgressRef.current = false;
            });
        }}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          right: 0,
          height: 28,
          cursor: "move",
          userSelect: "none",
          WebkitUserSelect: "none",
          background: "transparent",
        }}
        title="ドラッグして移動"
      />

      {/* Close button */}
      <button
        onClick={() => closeSelf("button")}
        aria-label="Close"
        title="Close (Esc)"
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          width: 24,
          height: 24,
          padding: 0,
          borderRadius: 6,
          border: "none",
          background: isFocused ? "rgba(0,0,0,0.06)" : "rgba(0,0,0,0.04)",
          cursor: "pointer",
          lineHeight: "24px",
          fontSize: 14,
          color: "#6b7280",
          transition: "background 0.12s ease, color 0.12s ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(239, 68, 68, 0.1)";
          e.currentTarget.style.color = "#dc2626";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = isFocused ? "rgba(0,0,0,0.06)" : "rgba(0,0,0,0.04)";
          e.currentTarget.style.color = "#6b7280";
        }}
      >
        ×
      </button>

      {/* Translation content */}
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "#1f2937",
          paddingRight: 28, // space for close button
        }}
      >
        {state.status && (
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
            {state.status}
          </div>
        )}

        {state.translation || (
          <span style={{ color: "#9ca3af", fontStyle: "italic" }}>Translating…</span>
        )}

        {state.source && (
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              onClick={() => setShowSource((v) => !v)}
              style={{
                fontSize: 12,
                padding: "6px 8px",
                borderRadius: 8,
                border: "1px solid rgba(0,0,0,0.12)",
                background: "rgba(0,0,0,0.02)",
                cursor: "pointer",
              }}
            >
              {showSource ? "原文を隠す" : "原文を表示"}
            </button>
            {showSource && (
              <div
                style={{
                  marginTop: 8,
                  padding: 10,
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.08)",
                  background: "rgba(0,0,0,0.02)",
                  fontSize: 12,
                  color: "#374151",
                  whiteSpace: "pre-wrap",
                }}
              >
                {state.source}
              </div>
            )}
          </div>
        )}

        {(state.action === "enable_ocr" || state.action === "recheck_ocr") && (
          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {state.action === "enable_ocr" && (
              <button
                type="button"
                onClick={() => {
                  // #region agent log
                  dbg("I", "src/Popup.tsx:actions", "click enable_ocr", {});
                  // #endregion agent log
                  void emit("erudaite://ocr/enable", {}).catch(() => {});
                }}
                style={{
                  fontSize: 12,
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "none",
                  background: "#2a6478",
                  color: "white",
                  cursor: "pointer",
                }}
              >
                OCRを有効化（推奨）
              </button>
            )}
            {state.action === "recheck_ocr" && (
              <button
                type="button"
                onClick={() => {
                  // #region agent log
                  dbg("I", "src/Popup.tsx:actions", "click recheck_ocr", {});
                  // #endregion agent log
                  void emit("erudaite://ocr/recheck", {}).catch(() => {});
                }}
                style={{
                  fontSize: 12,
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "white",
                  color: "#111827",
                  cursor: "pointer",
                }}
              >
                再検出
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


