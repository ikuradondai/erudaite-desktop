import { useEffect, useRef, useState } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";

type PopupState = {
  status?: string;
  translation?: string;
};

export default function Popup() {
  const [state, setState] = useState<PopupState>({ status: "Translating…", translation: "" });
  const hasFocusedRef = useRef(false);
  const [isFocused, setIsFocused] = useState(true);

  // #region agent log
  function agentLog(message: string, data: Record<string, unknown>) {
    fetch("http://127.0.0.1:7242/ingest/71db1e77-df5f-480c-9275-0e41f17d2b1f", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "debug-session",
        runId: "popup-focus-flag",
        hypothesisId: "F2",
        location: "desktop/src/Popup.tsx",
        message,
        data,
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  }
  // #endregion

  const closeSelf = (_reason: string) => {
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
    agentLog("mounted", { label: w.label, href: window.location.href });
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
      agentLog("focusChanged", { focused: payload });
      if (payload === true) {
        hasFocusedRef.current = true;
        return;
      }
      if (payload === false && hasFocusedRef.current) {
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
    : { opacity: 0.72, background: "#f2f2f2" };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        padding: 12,
        boxSizing: "border-box",
        background: chrome.background,
        borderRadius: 0,
        boxShadow: "none",
        border: "none",
        opacity: chrome.opacity,
        overflow: "auto",
        userSelect: "text",
        position: "relative",
      }}
    >
      <button
        onClick={() => closeSelf("button")}
        aria-label="Close"
        title="Close"
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          width: 22,
          height: 22,
          padding: 0,
          borderRadius: 6,
          border: "1px solid rgba(0,0,0,0.18)",
          background: "rgba(255,255,255,0.9)",
          cursor: "pointer",
          lineHeight: "20px",
          fontSize: 14,
        }}
      >
        ×
      </button>
      <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {state.translation || ""}
      </div>
    </div>
  );
}


