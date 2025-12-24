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
  popupFocusOnOpen: boolean;
  lastUsedTargetLang?: string;
  fixedTargetLang?: string;
  onboarded?: boolean;
  favoritePairs?: Array<{ from: string; to: string }>;
};

// デフォルト言語として選択可能な6言語
const DEFAULT_LANGUAGES = [
  "日本語",
  "英語（アメリカ）",
  "繁体字中国語",
  "簡体字中国語",
  "韓国語",
  "インドネシア語",
];

// ターゲット言語として選択可能な59言語
const ALL_LANGUAGES = [
  "日本語",
  "英語（アメリカ）",
  "英語（イギリス）",
  "韓国語",
  "簡体字中国語",
  "繁体字中国語",
  "タイ語",
  "インドネシア語",
  "クメール語",
  "タガログ語",
  "ベトナム語",
  "標準モンゴル語",
  "ハルハ・モンゴル語",
  "チベット語",
  "ゾンカ語",
  "ヒンディー語",
  "ウルドゥー語",
  "タミル語",
  "シンハラ語",
  "ネパール語",
  "アッサム語",
  "アラビア語",
  "ヘブライ語",
  "ペルシャ語（ファルシ語）",
  "トルコ語",
  "スペイン語",
  "フランス語",
  "ドイツ語",
  "イタリア語",
  "オランダ語",
  "スウェーデン語",
  "デンマーク語",
  "ノルウェー語",
  "ポルトガル語（ポルトガル）",
  "ルーマニア語",
  "ポーランド語",
  "チェコ語",
  "セルビア語",
  "クロアチア語",
  "リトアニア語",
  "ラトビア語",
  "アイルランド語",
  "ウェールズ語",
  "フィンランド語",
  "エストニア語",
  "ハンガリー語",
  "スロバキア語",
  "ギリシャ語",
  "スロベニア語",
  "ブルガリア語",
  "マケドニア語",
  "マルタ語",
  "ウクライナ語",
  "ロシア語",
  "アムハラ語",
  "ティグリニャ語",
  "オロモ語",
  "ポルトガル語（ブラジル）",
  "スペイン語（メキシコ）",
];

const DEFAULT_SETTINGS: Settings = {
  // NOTE:
  // - Use a single, consistent default across Windows/macOS to reduce confusion.
  // - Avoid common app/browser conflicts by using 3 modifiers + a letter.
  hotkey: "CommandOrControl+Shift+Alt+Z",
  clipboardMode: "displayOnly",
  apiBaseUrl: "https://lighting-translation.vercel.app",
  defaultLanguage: "日本語",
  secondaryLanguage: "英語（アメリカ）",
  routingStrategy: "alwaysFixed",
  popupFocusOnOpen: true,
  fixedTargetLang: "日本語",
  onboarded: false,
  favoritePairs: [
    { from: "英語（アメリカ）", to: "日本語" },
    { from: "日本語", to: "英語（アメリカ）" },
  ],
};

function isMostlyAscii(text: string): boolean {
  if (!text) return true;
  let ascii = 0;
  let total = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code === 0) continue;
    // ignore whitespace
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") continue;
    total += 1;
    if (code <= 0x7f) ascii += 1;
  }
  if (total === 0) return true;
  return ascii / total >= 0.9;
}

function containsJapanese(text: string): boolean {
  // Hiragana, Katakana, CJK Unified Ideographs (common Kanji range)
  return /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
}

function guessDetectedLangHeuristic(text: string, defaultLanguage: string): "default" | "not_default" | "unknown" {
  const d = defaultLanguage.toLowerCase();
  // Handle both English and Japanese language names
  if (d.includes("japanese") || d.includes("日本語")) {
    return containsJapanese(text) ? "default" : "not_default";
  }
  if (d.includes("english") || d.includes("英語")) {
    return isMostlyAscii(text) ? "default" : "not_default";
  }
  return "unknown";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FALLBACK_HOTKEY = "CommandOrControl+Shift+Alt+Q";

// (popup-close instrumentation removed)

function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<string>("");
  const [sourceText, setSourceText] = useState<string>("");
  const [translatedText, setTranslatedText] = useState<string>("");
  const [detectedLang, setDetectedLang] = useState<string>("");
  const [targetLang, setTargetLang] = useState<string>(""); // computed per strategy; shown in UI
  const [showWizard, setShowWizard] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showAutoRouteHelp, setShowAutoRouteHelp] = useState<boolean>(false);
  const hotkeyInFlightRef = useRef(false);
  const lastHotkeyAtRef = useRef(0);
  const translationRunIdRef = useRef(0);
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

  // Close help pop when clicking outside (settings panel)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest?.(".help")) return;
      setShowAutoRouteHelp(false);
    };
    window.addEventListener("mousedown", onDown, { capture: true });
    return () => window.removeEventListener("mousedown", onDown, { capture: true } as any);
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const store = await storePromise;
      const s = (await store.get<Settings>("settings")) ?? DEFAULT_SETTINGS;
      if (!mounted) return;
      const merged = { ...DEFAULT_SETTINGS, ...s };
      if (!merged.fixedTargetLang) merged.fixedTargetLang = merged.defaultLanguage;
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
      void emitTo("popup", "erudaite://popup/state", payload)
        .catch(() => {});
    },
    [],
  );

  const closePopupIfOpen = useCallback(async () => {
    let w: WebviewWindow | null = popupRef.current;
    if (!w) {
      try {
        w = await WebviewWindow.getByLabel("popup");
      } catch (e) {
        return false;
      }
    }
    if (!w) return false;
    try {
      const vis = await w.isVisible();
      // Only treat as "open" if it's actually visible. Hidden/closed windows should NOT short-circuit hotkey.
      if (!vis) {
        popupRef.current = null;
        return false;
      }
    } catch (e) {
      void e;
    }
    try {
      // Force-destroy to avoid leaving a hidden zombie window with the same label.
      await w.destroy();
    } catch {
      // ignore
    }
    popupRef.current = null;
    return true;
  }, []);

  const ensurePopupAtCursor = useCallback(async () => {
    // If already open, just move + focus
    let existing: WebviewWindow | null = popupRef.current;
    if (!existing) {
      try {
        existing = await WebviewWindow.getByLabel("popup");
      } catch (e) {
        existing = null;
      }
    }
    if (existing) {
      popupRef.current = existing;
      try {
        const vis = await existing.isVisible();
        if (!vis) {
          // A hidden/stale window with the same label can stick around and refuse to show.
          try {
            await existing.destroy();
          } catch (e) {
            void e;
          }
          popupRef.current = null;
          existing = null;
        }
      } catch (e) {
        void e;
      }
      if (existing) {
        try {
          // NOTE: show() may focus on some platforms; we log to verify.
          await existing.show();
          if (settings.popupFocusOnOpen) await existing.setFocus();
          try {
            const vis2 = await existing.isVisible();
            if (!vis2) {
              await existing.destroy().catch(() => {});
              popupRef.current = null;
              existing = null;
            }
          } catch {
            // ignore
          }
        } catch (e) {
          void e;
          try {
            await existing.destroy();
          } catch (e2) {
            void e2;
          }
          popupRef.current = null;
          existing = null;
        }
      }
      if (existing) return existing;
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
      focus: settings.popupFocusOnOpen,
      visible: true,
      shadow: true,
    });
    popupRef.current = popup;

    popup.once("tauri://created", () => {
      // NOTE: show() may focus on some platforms; we log to verify.
      void (async () => {
        try {
          await popup.show();
        } catch {
          // ignore
        }
        if (settings.popupFocusOnOpen) {
          try {
            await popup.setFocus();
          } catch {
            // ignore
          }
        }
      })();
      emitPopupState({}); // flush latest state after creation
    });

    popup.once("tauri://destroyed", () => {
      popupRef.current = null;
    });

    // Ensure content starts in "Translating…" state (best effort; may be re-sent on created/ready)
    emitPopupState({ status: "Translating…", source: "", translation: "" });

    return popup;
  }, [emitPopupState, settings.popupFocusOnOpen]);

  const handleHotkey = useCallback(async () => {
    const now = Date.now();
    lastHotkeyAtRef.current = now;
    // Toggle behavior: if popup is open, close it and stop.
    let closed = false;
    try {
      closed = await closePopupIfOpen();
    } catch (e) {
      void e;
      closed = false;
    }
    if (closed) {
      return;
    }

    if (hotkeyInFlightRef.current) {
      return;
    }

    hotkeyInFlightRef.current = true;
    setStatus("Capturing selected text…");
    setTranslatedText("");
    try {
      // OS全体の選択取得（擬似Ctrl/Cmd+C→復元）をRust側で実施
      let picked = "";
      try {
        // NOTE: Tauri invoke側はcamelCaseで渡す（Rustのtimeout_msにマッピングされる）
        const args = { timeoutMs: 1600 };
        picked = String(await invoke("capture_selected_text", args)).trim();
      } catch (e) {
        // Do NOT fallback to clipboard here; it can silently translate stale clipboard content.
        // Instead, surface an actionable error to the user.
        try {
          const w = getCurrentWebviewWindow();
          await w.show();
          await w.setFocus();
        } catch {
          // ignore
        }
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(`Capture failed: ${msg}`);
        setStatus("Capture failed. Keep Chrome focused, select text, then press hotkey again.");
        return;
      }
      if (!picked) {
        // Bring the window forward so the user sees the failure reason.
        try {
          const w = getCurrentWebviewWindow();
          await w.show();
          await w.setFocus();
        } catch {
          // ignore
        }
        // status already set above
        setStatus("No selected text detected. Select text and press the hotkey again.");
        return;
      }

      // Show popup near cursor immediately
      await ensurePopupAtCursor();
      emitPopupState({ status: "Translating…", source: picked, translation: "" });

      setSourceText(picked);
      // capture note removed
      setStatus("Translating…");

      const computeTargetDefaultBased = (detectedLang: string) => {
        return detectedLang === settings.defaultLanguage ? settings.secondaryLanguage : settings.defaultLanguage;
      };

      const runTranslate = (target: string) => {
        const runId = ++translationRunIdRef.current;
        let full = "";

        setTargetLang(target);
        setTranslatedText("");
        // Popup shows only translation text; use a lightweight placeholder immediately.
        emitPopupState({ status: "Translating…", source: picked, translation: "…" });

        const ch = new Channel<
          { type: "delta"; content: string } | { type: "done" } | { type: "error"; message: string }
        >();

        ch.onmessage = (msg) => {
          if (runId !== translationRunIdRef.current) return; // ignore stale streams
          if (msg.type === "delta") {
            full += msg.content;
            setTranslatedText(full);
            emitPopupState({ status: "Translating…", translation: full });

            // Resize popup loosely based on content length (best effort)
            const lines = full.split(/\r?\n/).length;
            const h = Math.min(300, Math.max(150, 140 + Math.min(8, lines) * 18));
            const w = Math.min(400, Math.max(300, 360));
            const p = popupRef.current;
            if (p) void p.setSize(new PhysicalSize(w, h)).catch(() => {});
          } else if (msg.type === "error") {
            setStatus(`Error: ${msg.message}`);
            emitPopupState({ status: `Error: ${msg.message}` });
          }
        };

        const donePromise = (async () => {
          await invoke("translate_sse", {
            baseUrl: settings.apiBaseUrl,
            text: picked,
            targetLang: target,
            mode: "standard",
            explanationLang: "ja",
            isReverse: false,
            onEvent: ch,
          });
          return full;
        })();

        return { runId, target, donePromise };
      };

      // Fast routing:
      // - alwaysFixed/alwaysLastUsed: skip detect_language; start translation immediately.
      // - defaultBased: heuristic first; run detect_language in parallel; if mismatch, re-run.
      let detectedForUi = "Unknown";
      let active = { runId: 0, target: "", donePromise: Promise.resolve("") as Promise<string> };

      if (settings.routingStrategy === "alwaysFixed") {
        const target = settings.fixedTargetLang?.trim() || settings.defaultLanguage;
        active = runTranslate(target);
        // detect in background for UI only
        void (async () => {
          try {
            const r = (await invoke("detect_language", { baseUrl: settings.apiBaseUrl, text: picked })) as {
              detected_lang?: string;
            };
            detectedForUi = String(r?.detected_lang ?? "Unknown");
          } catch {
            // ignore
          }
          setDetectedLang(detectedForUi);
        })();
      } else if (settings.routingStrategy === "alwaysLastUsed") {
        const target = settings.lastUsedTargetLang?.trim() || settings.defaultLanguage;
        active = runTranslate(target);
        void (async () => {
          try {
            const r = (await invoke("detect_language", { baseUrl: settings.apiBaseUrl, text: picked })) as {
              detected_lang?: string;
            };
            detectedForUi = String(r?.detected_lang ?? "Unknown");
          } catch {
            // ignore
          }
          setDetectedLang(detectedForUi);
        })();
      } else {
        // defaultBased (fast path): heuristic -> start; detect -> maybe restart
        const kind = guessDetectedLangHeuristic(picked, settings.defaultLanguage);
        const heuristicDetected = kind === "default" ? settings.defaultLanguage : "Unknown";
        const target0 =
          kind === "default"
            ? settings.secondaryLanguage
            : settings.defaultLanguage;

        active = runTranslate(target0);

        // detect_language in parallel; potentially restart.
        try {
          const r = (await invoke("detect_language", { baseUrl: settings.apiBaseUrl, text: picked })) as {
            detected_lang?: string;
          };
          detectedForUi = String(r?.detected_lang ?? heuristicDetected ?? "Unknown");
        } catch {
          detectedForUi = heuristicDetected ?? "Unknown";
        }
        setDetectedLang(detectedForUi);

        if (detectedForUi !== "Unknown") {
          const targetReal = computeTargetDefaultBased(detectedForUi);
          if (targetReal !== active.target) {
            active = runTranslate(targetReal);
          }
        }
      }

      const full = await active.donePromise;

      // remember last used target for alwaysLastUsed
      setSettings((s) => ({ ...s, lastUsedTargetLang: active.target }));

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
    settings.defaultLanguage,
    settings.secondaryLanguage,
    settings.fixedTargetLang,
    settings.hotkey,
    settings.lastUsedTargetLang,
    settings.routingStrategy,
    translatedText,
  ]);

  useEffect(() => {
    const unlistenPromise = (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      return await listen<{ label: string }>("erudaite://popup/ready", () => {
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

  const isAutoRouting = settings.routingStrategy === "defaultBased";
  const activeLabelColor = "#374151";
  const inactiveLabelColor = "#9ca3af";

  // Status badge styling
  const statusBadgeClass = status.toLowerCase().includes("error")
    ? "status-badge error"
    : status.toLowerCase().includes("translating") || status.toLowerCase().includes("capturing")
      ? "status-badge loading"
      : "status-badge";

  return (
    <div>
      {/* ====== Header ====== */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: "#1f2937" }}>
            Welcome to ErudAite Desktop Application
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "#6b7280" }}>
            <strong style={{ color: "#4f46e5" }}>{settings.hotkey}</strong> で選択テキストを翻訳
          </p>
        </div>
        <button
          className="btn-icon"
          onClick={() => setShowSettings((v) => !v)}
          title={showSettings ? "設定を隠す" : "設定を表示"}
        >
          ⚙️
        </button>
      </div>

      {/* ====== Welcome Wizard ====== */}
      {showWizard && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8, color: "#1f2937" }}>
            Welcome to ErudAite Desktop Application
          </div>
          <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 16 }}>
            母国語とよく使う言語を設定してください。ショートカット翻訳が自動でルーティングされます。
          </p>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              <span style={{ fontWeight: 500, color: "#374151" }}>母国語</span>
              <select
                className="input"
                value={settings.defaultLanguage}
                onChange={(e) => setSettings((s) => ({ ...s, defaultLanguage: e.target.value }))}
                style={{ width: 180 }}
              >
                {DEFAULT_LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>{lang}</option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              <span style={{ fontWeight: 500, color: "#374151" }}>よく使う言語</span>
              <select
                className="input"
                value={settings.secondaryLanguage}
                onChange={(e) => setSettings((s) => ({ ...s, secondaryLanguage: e.target.value }))}
                style={{ width: 180 }}
              >
                {ALL_LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>{lang}</option>
                ))}
              </select>
            </label>
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
            <button
              className="btn"
              onClick={() => {
                setSettings((s) => ({ ...s, onboarded: true }));
                setShowWizard(false);
              }}
            >
              はじめる
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setSettings((s) => ({ ...s, onboarded: true }));
                setShowWizard(false);
              }}
            >
              スキップ
            </button>
          </div>
        </div>
      )}

      {/* ====== Collapsible Settings Panel ====== */}
      <div className={`settings-panel card ${showSettings ? "expanded" : "collapsed"}`} style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 14, color: "#374151" }}>設定</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <span style={{ fontWeight: 500, color: "#374151" }}>ホットキー</span>
            <input
              className="input"
              value={settings.hotkey}
              onChange={(e) => setSettings((s) => ({ ...s, hotkey: e.target.value }))}
              style={{ maxWidth: 300 }}
            />
          </label>

          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={settings.popupFocusOnOpen}
                onChange={(e) => setSettings((s) => ({ ...s, popupFocusOnOpen: e.target.checked }))}
                style={{ width: 16, height: 16 }}
              />
              <span>ポップアップを自動フォーカス</span>
            </label>

            <div className="help">
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={isAutoRouting}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      routingStrategy: e.target.checked ? "defaultBased" : "alwaysFixed",
                    }))
                  }
                  style={{ width: 16, height: 16 }}
                />
                <span>自動ルーティング（言語検出）</span>
              </label>
              <button
                type="button"
                className="help-btn"
                aria-label="自動ルーティングの説明"
                onClick={() => setShowAutoRouteHelp((v) => !v)}
              >
                ?
              </button>
              {showAutoRouteHelp && (
                <div className="help-pop">
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>自動ルーティングとは？</div>
                  <div style={{ marginBottom: 6 }}>
                    ONにすると、原文が<strong>母国語</strong>なら<strong>よく使う言語</strong>へ、母国語以外なら<strong>母国語</strong>へ翻訳します。
                  </div>
                  <div style={{ color: "#6b7280" }}>
                    ※ ONのときは「強制翻訳先言語」は使いません（固定先ではなく自動決定）。
                  </div>
                </div>
              )}
            </div>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <span style={{ fontWeight: 500, color: "#374151" }}>クリップボード</span>
            <select
              className="input"
              value={settings.clipboardMode}
              onChange={(e) => setSettings((s) => ({ ...s, clipboardMode: e.target.value as ClipboardMode }))}
              style={{ maxWidth: 220 }}
            >
              <option value="displayOnly">表示のみ</option>
              <option value="displayAndCopy">表示＋自動コピー</option>
              <option value="copyOnly">自動コピーのみ</option>
            </select>
          </label>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              <span style={{ fontWeight: 500, color: isAutoRouting ? activeLabelColor : inactiveLabelColor }}>
                母国語
              </span>
              <select
                className="input"
                value={settings.defaultLanguage}
                onChange={(e) => setSettings((s) => ({ ...s, defaultLanguage: e.target.value }))}
                style={{ width: 180 }}
              >
                {DEFAULT_LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>{lang}</option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              <span style={{ fontWeight: 500, color: isAutoRouting ? activeLabelColor : inactiveLabelColor }}>
                よく使う言語
              </span>
              <select
                className="input"
                value={settings.secondaryLanguage}
                onChange={(e) => setSettings((s) => ({ ...s, secondaryLanguage: e.target.value }))}
                style={{ width: 180 }}
              >
                {ALL_LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>{lang}</option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              <span style={{ fontWeight: 500, color: isAutoRouting ? inactiveLabelColor : activeLabelColor }}>
                強制翻訳先言語
              </span>
              <select
                className="input"
                value={
                  settings.routingStrategy === "alwaysFixed"
                    ? settings.fixedTargetLang ?? ""
                    : targetLang || settings.lastUsedTargetLang || ""
                }
                disabled={isAutoRouting}
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
              >
                {ALL_LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>{lang}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>

      {/* ====== Status Bar ====== */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        {status && <div className={statusBadgeClass}>{status}</div>}
        {detectedLang && detectedLang !== "Unknown" && (
          <div style={{ fontSize: 12, color: "#6b7280" }}>
            {detectedLang} → {targetLang || settings.lastUsedTargetLang || settings.fixedTargetLang || ""}
          </div>
        )}
      </div>

      {/* ====== Action Buttons ====== */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        <button
          className="btn btn-secondary"
          onClick={() => void handleCopy()}
          disabled={!translatedText.trim()}
        >
          📋 コピー
        </button>
      </div>

      {/* ====== Source Text ====== */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: "#6b7280", marginBottom: 6 }}>原文</div>
        <textarea
          className="textarea"
          value={sourceText}
          readOnly
          placeholder="選択したテキストがここに表示されます..."
        />
      </div>

      {/* ====== Translation Text ====== */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 500, color: "#6b7280", marginBottom: 6 }}>翻訳</div>
        <textarea
          className="textarea"
          value={translatedText}
          readOnly
          placeholder="翻訳結果がここに表示されます..."
          style={{ minHeight: 140 }}
        />
      </div>
    </div>
  );
}

export default App
