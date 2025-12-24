import { useEffect, useRef, useState } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

type PopupState = {
  status?: string;
  translation?: string;
};

export default function Popup() {
  const [state, setState] = useState<PopupState>({ status: "Translating…", translation: "" });
  const hasFocusedRef = useRef(false);

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
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void getCurrentWebviewWindow().close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    // Close when clicking outside (approximated by window blur).
    // Guard: only close on blur after we have successfully received focus at least once.
    const w = getCurrentWebviewWindow();
    const unsubPromise = w.onFocusChanged(({ payload }) => {
      if (payload === true) {
        hasFocusedRef.current = true;
        return;
      }
      if (payload === false && hasFocusedRef.current) {
        void w.close();
      }
    });
    return () => {
      void unsubPromise.then((unsub) => unsub()).catch(() => {});
    };
  }, []);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        padding: 10,
        boxSizing: "border-box",
        background: "rgba(255,255,255,0.95)",
        borderRadius: 10,
        boxShadow: "0 14px 40px rgba(0,0,0,0.18)",
        border: "none",
        overflow: "hidden",
        userSelect: "text",
      }}
    >
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.4,
          maxHeight: "30vh",
          minHeight: 90,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {state.translation || ""}
      </div>
    </div>
  );
}


