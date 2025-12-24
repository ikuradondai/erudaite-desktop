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
        runId: "popup-close",
        hypothesisId: "C1",
        location: "desktop/src/Popup.tsx",
        message,
        data,
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  }
  // #endregion

  const closeSelf = (reason: string) => {
    const w = getCurrentWebviewWindow();
    agentLog("closeSelf called", { reason, label: w.label });
    w.close()
      .then(() => agentLog("closeSelf close() resolved", { reason }))
      .catch((e) => {
        agentLog("closeSelf close() rejected", { reason, err: e instanceof Error ? e.message : String(e) });
        // Fallback: hide (in case close is blocked by permissions/policy)
        w.hide()
          .then(() => agentLog("closeSelf hide() resolved", { reason }))
          .catch((e2) =>
            agentLog("closeSelf hide() rejected", { reason, err: e2 instanceof Error ? e2.message : String(e2) }),
          );
      });
  };

  useEffect(() => {
    const w = getCurrentWebviewWindow();
    agentLog("mounted", { label: w.label });
    const unlistenDestroyedP = w.listen("tauri://destroyed", () => agentLog("tauri destroyed", {}));
    const unlistenCloseReqP = w.listen("tauri://close-requested", () => agentLog("tauri close-requested", {}));
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
      agentLog("keydown", { key: e.key });
      // Some platforms don't emit focusChanged(true) reliably.
      // If we receive any key events, the popup is effectively focused.
      hasFocusedRef.current = true;
      if (e.key === "Escape") {
        agentLog("close via esc", {});
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
      agentLog("focusChanged", { focused: payload, hasFocused: hasFocusedRef.current });
      if (payload === true) {
        hasFocusedRef.current = true;
        return;
      }
      if (payload === false && hasFocusedRef.current) {
        agentLog("close via blur", {});
        closeSelf("blur");
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
        padding: 12,
        boxSizing: "border-box",
        background: "#ffffff",
        borderRadius: 0,
        boxShadow: "none",
        border: "none",
        overflow: "auto",
        userSelect: "text",
      }}
    >
      <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {state.translation || ""}
      </div>
    </div>
  );
}


