import { useEffect, useState } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";

type PopupState = {
  status?: string;
  translation?: string;
};

export default function Popup() {
  const [state, setState] = useState<PopupState>({ status: "Translating…", translation: "" });
  const [copied, setCopied] = useState(false);

  // #region agent log
  function agentLog(message: string, data: Record<string, unknown>) {
    fetch("http://127.0.0.1:7242/ingest/71db1e77-df5f-480c-9275-0e41f17d2b1f", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "debug-session",
        runId: "popup-pre-fix",
        hypothesisId: "P1",
        location: "desktop/src/Popup.tsx",
        message,
        data,
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  }
  // #endregion

  useEffect(() => {
    agentLog("popup mounted", { label: getCurrentWebviewWindow().label });
    void emit("erudaite://popup/ready", { label: getCurrentWebviewWindow().label }).catch(() => {});
    const unlistenPromise = listen<PopupState>("erudaite://popup/state", (e) => {
      agentLog("popup received state", {
        status: e.payload?.status ?? null,
        translationLen: (e.payload?.translation ?? "").length,
      });
      setState((s) => ({ ...s, ...e.payload }));
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 900);
    return () => window.clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void getCurrentWebviewWindow().close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    // NOTE: "close on blur" is intentionally disabled for now.
    // Some environments can emit a blur immediately after creation, which makes the popup appear to "not show".
  }, []);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        padding: 10,
        boxSizing: "border-box",
        background: "rgba(255,255,255,0.98)",
        borderRadius: 8,
        boxShadow: "none",
        border: "1px solid rgba(0,0,0,0.15)",
        overflow: "hidden",
        userSelect: "text",
      }}
    >
      <div
        data-tauri-drag-region
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          // Explicit dragging: works more reliably than drag-region in some environments.
          void getCurrentWindow().startDragging();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          cursor: "move",
          paddingBottom: 8,
        }}
        title="Drag to move"
      >
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            onClick={() => {
              const t = state.translation?.trim() ?? "";
              if (!t) return;
              void writeText(t).then(() => setCopied(true)).catch(() => {});
            }}
            style={{
              height: 26,
              padding: "0 10px",
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.12)",
              background: "rgba(255,255,255,0.9)",
              cursor: state.translation?.trim() ? "pointer" : "not-allowed",
              opacity: state.translation?.trim() ? 1 : 0.45,
              fontSize: 12,
            }}
            aria-label="Copy translation"
            title="Copy"
          >
            {copied ? "✓" : "📋"}
          </button>
          <button
            onClick={() => void getCurrentWebviewWindow().close()}
            style={{
              width: 26,
              height: 26,
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.12)",
              background: "rgba(255,255,255,0.9)",
              cursor: "pointer",
              lineHeight: "24px",
            }}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.35,
            maxHeight: "30vh",
            minHeight: 90,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            padding: "8px 10px",
            borderRadius: 6,
            background: "transparent",
            border: "1px solid rgba(0,0,0,0.10)",
          }}
        >
          {state.translation || ""}
        </div>
      </div>
    </div>
  );
}


