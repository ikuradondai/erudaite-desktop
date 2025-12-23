import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

type PopupState = {
  status?: string;
  source?: string;
  translation?: string;
};

export default function Popup() {
  const [state, setState] = useState<PopupState>({ status: "Translating…", source: "", translation: "" });

  const header = useMemo(() => {
    return state.status || "Translating…";
  }, [state.status]);

  useEffect(() => {
    const unlistenPromise = listen<PopupState>("erudaite://popup/state", (e) => {
      setState((s) => ({ ...s, ...e.payload }));
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

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
        padding: 12,
        boxSizing: "border-box",
        background: "rgba(255,255,255,0.95)",
        borderRadius: 14,
        boxShadow: "0 14px 40px rgba(0,0,0,0.25)",
        border: "1px solid rgba(0,0,0,0.10)",
        overflow: "hidden",
        userSelect: "text",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 12, opacity: 0.7 }}>{header}</div>
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

      <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>Source</div>
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.35,
              maxHeight: 72,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              padding: "8px 10px",
              borderRadius: 10,
              background: "rgba(0,0,0,0.03)",
              border: "1px solid rgba(0,0,0,0.06)",
            }}
          >
            {state.source || ""}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>Translation</div>
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.35,
              maxHeight: "30vh",
              minHeight: 72,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              padding: "8px 10px",
              borderRadius: 10,
              background: "rgba(0,0,0,0.02)",
              border: "1px solid rgba(0,0,0,0.06)",
            }}
          >
            {state.translation || ""}
          </div>
        </div>
      </div>
    </div>
  );
}


