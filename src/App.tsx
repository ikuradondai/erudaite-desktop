import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { load } from "@tauri-apps/plugin-store";
import { Channel, invoke } from "@tauri-apps/api/core";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo } from "@tauri-apps/api/event";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { monitorFromPoint } from "@tauri-apps/api/window";
import "./App.css";

type ClipboardMode = "displayOnly" | "displayAndCopy" | "copyOnly";

type RoutingStrategy = "defaultBased" | "alwaysLastUsed" | "alwaysFixed";

type Settings = {
  hotkey: string; // e.g. "CommandOrControl+Shift+E"
  clipboardMode: ClipboardMode;
  apiBaseUrl: string; // e.g. "https://lighting-translation.vercel.app"
  defaultLanguage: string; // e.g. "Japanese"
  secondaryLanguage: string; // e.g. "English (US)"
  routingStrategy: RoutingStrategy;
  lastUsedTargetLang?: string;
  fixedTargetLang?: string;
  onboarded?: boolean;
  favoritePairs?: Array<{ from: string; to: string }>;
};

const DEFAULT_SETTINGS: Settings = {
  // NOTE:
  // - Use a single, consistent default across Windows/macOS to reduce confusion.
  // - Avoid common app/browser conflicts by using 3 modifiers + a letter.
  hotkey: "CommandOrControl+Shift+Alt+Z",
  clipboardMode: "displayOnly",
  apiBaseUrl: "https://lighting-translation.vercel.app",
  defaultLanguage: "Japanese",
  secondaryLanguage: "English (US)",
  routingStrategy: "defaultBased",
  onboarded: false,
  favoritePairs: [
    { from: "English (US)", to: "Japanese" },
    { from: "Japanese", to: "English (US)" },
  ],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FALLBACK_HOTKEY = "CommandOrControl+Shift+Alt+Q";

function agentLog(..._args: unknown[]): void {
  // (debug logging removed)
}

function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<string>("");
  const [sourceText, setSourceText] = useState<string>("");
  const [translatedText, setTranslatedText] = useState<string>("");
  const [reverseText, setReverseText] = useState<string>("");
  const [detectedLang, setDetectedLang] = useState<string>("");
  const [targetLang, setTargetLang] = useState<string>(""); // computed per strategy; shown in UI
  const [showWizard, setShowWizard] = useState<boolean>(false);
  const [lastCaptureNote, setLastCaptureNote] = useState<string>("");
  const hotkeyInFlightRef = useRef(false);
  const lastHotkeyAtRef = useRef(0);
  const popupRef = useRef<WebviewWindow | null>(null);
  const lastPopupStateRef = useRef<{ status?: string; source?: string; translation?: string }>({
    status: "Translating…",
    source: "",
    translation: "",
  });
  const storePromise = useMemo(
    () =>
      load("settings.json", {
        autoSave: true,
        defaults: {
          settings: DEFAULT_SETTINGS,
        },
      }),
    [],
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      const store = await storePromise;
      const s = (await store.get<Settings>("settings")) ?? DEFAULT_SETTINGS;
      if (!mounted) return;
      const merged = { ...DEFAULT_SETTINGS, ...s };
      setSettings(merged);
      if (!merged.onboarded) setShowWizard(true);
    })().catch(() => {
      // ignore
    });
    return () => {
      mounted = false;
    };
  }, [storePromise]);

  useEffect(() => {
    (async () => {
      const store = await storePromise;
      await store.set("settings", settings);
    })().catch(() => {
      // ignore
    });
  }, [settings, storePromise]);

  const emitPopupState = useCallback(
    (partial: { status?: string; source?: string; translation?: string }) => {
      lastPopupStateRef.current = { ...lastPopupStateRef.current, ...partial };
      const payload = lastPopupStateRef.current;
      // #region agent log
      agentLog("H12", "emitTo popup state", {
        status: payload.status ?? null,
        sourceLen: (payload.source ?? "").length,
        translationLen: (payload.translation ?? "").length,
      });
      // #endregion
      void emitTo("popup", "erudaite://popup/state", payload)
        .then(() => {
          // #region agent log
          agentLog("H12", "emitTo popup ok", {});
          // #endregion
        })
        .catch((e) => {
          // #region agent log
          agentLog("H12", "emitTo popup failed", { err: e instanceof Error ? e.message : String(e) });
          // #endregion
        });
    },
    [],
  );

  const closePopupIfOpen = useCallback(async () => {
    const w = popupRef.current ?? (await WebviewWindow.getByLabel("popup"));
    if (!w) return false;
    try {
      await w.close();
    } catch {
      // ignore
    }
    popupRef.current = null;
    return true;
  }, []);

  const ensurePopupAtCursor = useCallback(async () => {
    // If already open, just move + focus
    const existing = popupRef.current ?? (await WebviewWindow.getByLabel("popup"));
    if (existing) {
      popupRef.current = existing;
      try {
        await existing.show();
        await existing.setFocus();
      } catch {
        // ignore
      }
      return existing;
    }

    const cursor = (await invoke("get_cursor_position")) as { x: number; y: number };
    const initialW = 360;
    const initialH = 220;
    const offsetY = 18;

    // Clamp to current monitor bounds (best effort)
    let x = Math.floor(cursor.x - initialW / 2);
    let y = Math.floor(cursor.y + offsetY);
    try {
      const m = await monitorFromPoint(cursor.x, cursor.y);
      if (m) {
        const mx = m.position.x;
        const my = m.position.y;
        const mw = m.size.width;
        const mh = m.size.height;
        x = Math.max(mx, Math.min(x, mx + mw - initialW));
        // If not enough space below cursor, show above
        if (y + initialH > my + mh) {
          y = Math.max(my, Math.min(cursor.y - initialH - 12, my + mh - initialH));
        } else {
          y = Math.max(my, Math.min(y, my + mh - initialH));
        }
      }
    } catch {
      // ignore clamp failures
    }

    // In dev, Vite serves on http://localhost:5173; in prod it's a file URL.
    const popupUrl = window.location.protocol.startsWith("http")
      ? `${window.location.origin}/#/popup`
      : "index.html#/popup";

    // #region agent log
    agentLog("H11", "creating popup window", { popupUrl, x, y, initialW, initialH });
    // #endregion

    const popup = new WebviewWindow("popup", {
      url: popupUrl,
      width: initialW,
      height: initialH,
      x,
      y,
      resizable: false,
      decorations: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focus: true,
      visible: true,
      shadow: false,
    });
    popupRef.current = popup;

    popup.once("tauri://created", () => {
      // #region agent log
      agentLog("H11", "popup created", {});
      // #endregion
      void popup.show().catch(() => {});
      void popup.setFocus().catch(() => {});
      emitPopupState({}); // flush latest state after creation
    });
    popup.once("tauri://error", (e) => {
      // #region agent log
      agentLog("H11", "popup create error", { e });
      // #endregion
    });

    popup.once("tauri://destroyed", () => {
      popupRef.current = null;
    });

    // Ensure content starts in "Translating…" state (best effort; may be re-sent on created/ready)
    emitPopupState({ status: "Translating…", source: "", translation: "" });

    return popup;
  }, [emitPopupState]);

  const handleHotkey = useCallback(async () => {
    const now = Date.now();
    const deltaMs = lastHotkeyAtRef.current ? now - lastHotkeyAtRef.current : null;
    lastHotkeyAtRef.current = now;

    // Toggle behavior: if popup is open, close it and stop.
    if (await closePopupIfOpen()) {
      return;
    }

    if (hotkeyInFlightRef.current) {
      // #region agent log
      agentLog("H7", "hotkey ignored (in-flight)", { deltaMs });
      // #endregion
      return;
    }

    hotkeyInFlightRef.current = true;
    setStatus("Capturing selected text…");
    setTranslatedText("");
    try {
      // OS全体の選択取得（擬似Ctrl/Cmd+C→復元）をRust側で実施
      let picked = "";
      // #region agent log
      agentLog("H1", "hotkey handler start", {
        deltaMs,
        hotkey: settings.hotkey,
        apiBaseUrl: settings.apiBaseUrl,
        routingStrategy: settings.routingStrategy,
        clipboardMode: settings.clipboardMode,
      });
      // #endregion
      try {
        // NOTE: Tauri invoke側はcamelCaseで渡す（Rustのtimeout_msにマッピングされる）
        const args = { timeoutMs: 1600 };
        // #region agent log
        agentLog("H2", "invoke capture_selected_text", { argsKeys: Object.keys(args) });
        // #endregion
        picked = String(await invoke("capture_selected_text", args)).trim();
        // #region agent log
        agentLog("H3", "capture_selected_text returned", { pickedLen: picked.length });
        // #endregion
      } catch (e) {
        // Do NOT fallback to clipboard here; it can silently translate stale clipboard content.
        // Instead, surface an actionable error to the user.
        // #region agent log
        agentLog("H2", "capture_selected_text threw", { err: e instanceof Error ? e.message : String(e) });
        // #endregion
        try {
          const w = getCurrentWebviewWindow();
          await w.show();
          await w.setFocus();
        } catch {
          // ignore
        }
        const msg = e instanceof Error ? e.message : String(e);
        setLastCaptureNote(`Capture: failed (${msg})`);
        setStatus("Capture failed. Keep Chrome focused, select text, then press hotkey again.");
        return;
      }
      if (!picked) {
        // Bring the window forward so the user sees the failure reason.
        // #region agent log
        agentLog("H3", "picked is empty", {});
        // #endregion
        try {
          const w = getCurrentWebviewWindow();
          await w.show();
          await w.setFocus();
        } catch {
          // ignore
        }
        setLastCaptureNote("Capture: empty (make sure Chrome is focused, select text, then press hotkey again).");
        setStatus("No selected text detected. Select text and press the hotkey again.");
        return;
      }

      // Show popup near cursor immediately
      await ensurePopupAtCursor();
      emitPopupState({ status: "Translating…", source: picked, translation: "" });

      setSourceText(picked);
      setLastCaptureNote(`Capture: ${picked.length} chars`);
      setStatus("Translating…");

      // detect language (for routing)
      let detected = "Unknown";
      try {
        const r = (await invoke("detect_language", { baseUrl: settings.apiBaseUrl, text: picked })) as {
          detected_lang?: string;
        };
        detected = String(r?.detected_lang ?? "Unknown");
      } catch {
        // ignore; keep Unknown
      }
      setDetectedLang(detected);
      // #region agent log
      agentLog("H1", "detected language", { detected });
      // #endregion

      let target = settings.defaultLanguage;
      if (settings.routingStrategy === "alwaysFixed") {
        target = settings.fixedTargetLang?.trim() || settings.defaultLanguage;
      } else if (settings.routingStrategy === "alwaysLastUsed") {
        target = settings.lastUsedTargetLang?.trim() || settings.defaultLanguage;
      } else {
        // defaultBased
        if (detected === settings.defaultLanguage) {
          target = settings.secondaryLanguage;
        } else {
          target = settings.defaultLanguage;
        }
      }
      setTargetLang(target);

      // CORS回避のため、翻訳実行はRust側でSSEを中継する
      let full = "";
      const ch = new Channel<{ type: "delta"; content: string } | { type: "done" } | { type: "error"; message: string }>();
      ch.onmessage = (msg) => {
        if (msg.type === "delta") {
          full += msg.content;
          setTranslatedText(full);
          emitPopupState({ status: "Translating…", translation: full });

          // Resize popup loosely based on content length (best effort)
          const lines = full.split(/\r?\n/).length;
          const h = Math.min(300, Math.max(150, 140 + Math.min(8, lines) * 18));
          const w = Math.min(400, Math.max(300, 360));
          const p = popupRef.current;
          if (p) {
            void p.setSize(new PhysicalSize(w, h)).catch(() => {});
          }
        } else if (msg.type === "error") {
          setStatus(`Error: ${msg.message}`);
          emitPopupState({ status: `Error: ${msg.message}` });
        }
      };

      await invoke("translate_sse", {
        baseUrl: settings.apiBaseUrl,
        text: picked,
        targetLang: target,
        mode: "standard",
        explanationLang: "ja",
        isReverse: false,
        onEvent: ch,
      });

      // remember last used target for alwaysLastUsed
      setSettings((s) => ({ ...s, lastUsedTargetLang: target }));

      if (settings.clipboardMode === "displayAndCopy" || settings.clipboardMode === "copyOnly") {
        await writeText(full || translatedText || "");
      }

      if (settings.clipboardMode === "copyOnly") {
        setStatus("Copied translation to clipboard.");
      } else {
        setStatus("Done.");
      }
      emitPopupState({ status: "Done." });
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
      emitPopupState({ status: `Error: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      hotkeyInFlightRef.current = false;
      await sleep(50);
    }
  }, [
    closePopupIfOpen,
    ensurePopupAtCursor,
    emitPopupState,
    settings.apiBaseUrl,
    settings.clipboardMode,
    settings.hotkey,
    settings.routingStrategy,
    translatedText,
    targetLang,
  ]);

  useEffect(() => {
    const unlistenPromise = (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      return await listen<{ label: string }>("erudaite://popup/ready", (e) => {
        // #region agent log
        agentLog("H12", "popup ready received", { label: e.payload?.label ?? null });
        // #endregion
        emitPopupState({});
      });
    })();
    return () => {
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [emitPopupState]);

  const handleCopy = useCallback(async () => {
    const text = translatedText.trim();
    if (!text) return;
    await writeText(text);
    setStatus("Copied translation to clipboard.");
  }, [translatedText]);

  const handleReverse = useCallback(async () => {
    const src = translatedText.trim();
    if (!src) return;
    const to = detectedLang.trim();
    if (!to || to === "Unknown") {
      setStatus("Cannot reverse-translate: detected language is Unknown.");
      return;
    }
    setStatus("Reverse translating…");
    setReverseText("");
    let full = "";
    const ch = new Channel<{ type: "delta"; content: string } | { type: "done" } | { type: "error"; message: string }>();
    ch.onmessage = (msg) => {
      if (msg.type === "delta") {
        full += msg.content;
        setReverseText(full);
      } else if (msg.type === "error") {
        setStatus(`Error: ${msg.message}`);
      }
    };
    await invoke("translate_sse", {
      baseUrl: settings.apiBaseUrl,
      text: src,
      targetLang: to,
      mode: "literal",
      explanationLang: "ja",
      isReverse: true,
      onEvent: ch,
    });
    setStatus("Done.");
  }, [detectedLang, settings.apiBaseUrl, translatedText]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isCopy = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c";
      if (!isCopy) return;
      // When popup focused: Ctrl/Cmd+C copies translation
      if (!translatedText.trim()) return;
      e.preventDefault();
      void handleCopy();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleCopy, translatedText]);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        await unregisterAll();
      } catch {
        // ignore
      }
      if (disposed) return;
      try {
        await register(settings.hotkey, () => {
          // fire-and-forget; we keep UI responsive
          void handleHotkey();
        });
        setStatus(`Hotkey registered: ${settings.hotkey}`);
      } catch (e) {
        // fallback
        if (settings.hotkey !== FALLBACK_HOTKEY) {
          try {
            await register(FALLBACK_HOTKEY, () => void handleHotkey());
            setStatus(`Hotkey fallback registered: ${FALLBACK_HOTKEY}`);
            setSettings((s) => ({ ...s, hotkey: FALLBACK_HOTKEY }));
            return;
          } catch {
            // ignore
          }
        }
        setStatus(`Failed to register hotkey: ${e instanceof Error ? e.message : String(e)}`);
      }
    })().catch((e) => {
      setStatus(`Failed to register hotkey: ${e instanceof Error ? e.message : String(e)}`);
    });
    return () => {
      disposed = true;
      void unregisterAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.hotkey, handleHotkey]);

  return (
    <div style={{ padding: 16, maxWidth: 720, margin: "0 auto" }}>
      <h2 style={{ margin: "8px 0" }}>ErudAite Shortcut Translator (v0 scaffold)</h2>

      {showWizard && (
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 10,
            padding: 14,
            margin: "12px 0",
            background: "rgba(255,255,255,0.95)",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Welcome to ErudAite</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 12 }}>
            Set your native language (Default) and a frequently-used Secondary language. Shortcut translation will route
            automatically.
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              Default
              <input
                value={settings.defaultLanguage}
                onChange={(e) => setSettings((s) => ({ ...s, defaultLanguage: e.target.value }))}
                style={{ width: 160 }}
              />
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              Secondary
              <input
                value={settings.secondaryLanguage}
                onChange={(e) => setSettings((s) => ({ ...s, secondaryLanguage: e.target.value }))}
                style={{ width: 180 }}
              />
            </label>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                setSettings((s) => ({ ...s, onboarded: true }));
                setShowWizard(false);
              }}
              style={{ padding: "8px 12px" }}
            >
              Next
            </button>
            <button
              onClick={() => {
                setSettings((s) => ({ ...s, onboarded: true }));
                setShowWizard(false);
              }}
              style={{ padding: "8px 12px", opacity: 0.8 }}
            >
              Skip
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          Hotkey
          <input
            value={settings.hotkey}
            onChange={(e) => setSettings((s) => ({ ...s, hotkey: e.target.value }))}
            style={{ width: 280 }}
          />
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          Clipboard
          <select
            value={settings.clipboardMode}
            onChange={(e) => setSettings((s) => ({ ...s, clipboardMode: e.target.value as ClipboardMode }))}
          >
            <option value="displayOnly">Display only</option>
            <option value="displayAndCopy">Display + auto copy</option>
            <option value="copyOnly">Auto copy only</option>
          </select>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          API
          <input
            value={settings.apiBaseUrl}
            onChange={(e) => setSettings((s) => ({ ...s, apiBaseUrl: e.target.value }))}
            style={{ width: 260 }}
          />
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          Routing
          <select
            value={settings.routingStrategy}
            onChange={(e) => setSettings((s) => ({ ...s, routingStrategy: e.target.value as RoutingStrategy }))}
          >
            <option value="defaultBased">Default-based</option>
            <option value="alwaysLastUsed">Always last used</option>
            <option value="alwaysFixed">Always fixed</option>
          </select>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          Default
          <input
            value={settings.defaultLanguage}
            onChange={(e) => setSettings((s) => ({ ...s, defaultLanguage: e.target.value }))}
            style={{ width: 140 }}
          />
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          Secondary
          <input
            value={settings.secondaryLanguage}
            onChange={(e) => setSettings((s) => ({ ...s, secondaryLanguage: e.target.value }))}
            style={{ width: 160 }}
          />
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          Target
          <input
            value={
              settings.routingStrategy === "alwaysFixed"
                ? settings.fixedTargetLang ?? ""
                : targetLang || settings.lastUsedTargetLang || ""
            }
            readOnly={settings.routingStrategy === "defaultBased"}
            onChange={(e) => {
              const v = e.target.value;
              if (settings.routingStrategy === "alwaysFixed") {
                setSettings((s) => ({ ...s, fixedTargetLang: v }));
              } else {
                setTargetLang(v);
                setSettings((s) => ({ ...s, lastUsedTargetLang: v }));
              }
            }}
            style={{ width: 180 }}
          />
        </label>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, opacity: 0.8 }}>{status}</div>
      {detectedLang ? (
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
          Detected: {detectedLang} → Target: {targetLang || settings.lastUsedTargetLang || ""}
        </div>
      ) : null}
      {lastCaptureNote ? <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>{lastCaptureNote}</div> : null}

      <div style={{ marginTop: 14 }}>
        <button onClick={() => void handleHotkey()} style={{ padding: "8px 12px" }}>
          Test capture/translate (current focused window)
        </button>
        <button
          onClick={() => void handleCopy()}
          disabled={!translatedText.trim()}
          style={{ padding: "8px 12px", marginLeft: 8, opacity: translatedText.trim() ? 1 : 0.5 }}
        >
          Copy translation
        </button>
        <button
          onClick={() => void handleReverse()}
          disabled={!translatedText.trim() || !detectedLang.trim() || detectedLang.trim() === "Unknown"}
          style={{
            padding: "8px 12px",
            marginLeft: 8,
            opacity: translatedText.trim() && detectedLang.trim() && detectedLang.trim() !== "Unknown" ? 1 : 0.5,
          }}
        >
          Reverse
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 12, opacity: 0.8 }}>Source</div>
        <textarea value={sourceText} readOnly style={{ width: "100%", minHeight: 120 }} />
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 12, opacity: 0.8 }}>Translation</div>
        <textarea value={translatedText} readOnly style={{ width: "100%", minHeight: 140 }} />
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 12, opacity: 0.8 }}>Reverse</div>
        <textarea value={reverseText} readOnly style={{ width: "100%", minHeight: 120 }} />
      </div>
    </div>
  );
}

export default App
