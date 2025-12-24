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

// #region agent log helpers
const __agentLog = (hypothesisId: string, location: string, message: string, data: Record<string, unknown>) => {
  fetch("http://127.0.0.1:7242/ingest/71db1e77-df5f-480c-9275-0e41f17d2b1f", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "debug-session",
      runId: "lang-routing-pre-fix",
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
};
// #endregion

// Avoid logging raw text (may contain PII). Only log a script summary.
const __scriptSummary = (s: string) => {
  const text = s || "";
  const len = text.length;
  let latin = 0;
  let kana = 0;
  let han = 0;
  let hangul = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code <= 0x007a && code >= 0x0041) latin += 1;
    else if (code >= 0x3040 && code <= 0x30ff) kana += 1;
    else if (code >= 0x4e00 && code <= 0x9fff) han += 1;
    else if (code >= 0xac00 && code <= 0xd7af) hangul += 1;
  }
  return { len, latin, kana, han, hangul };
};

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
type LangOption = { code: string; label: string };

// 接続先（lightning_translation/web）の期待値は「英語のcode文字列」。
// UI表示は日本語label、保存/比較/API送信はcodeを使う（多言語で破綻しないため）。
const TARGET_LANG_OPTIONS: LangOption[] = [
  { code: "Japanese", label: "日本語" },
  { code: "English (US)", label: "英語（アメリカ）" },
  { code: "English (UK)", label: "英語（イギリス）" },
  { code: "Korean", label: "韓国語" },
  { code: "Chinese (Simplified)", label: "簡体字中国語" },
  { code: "Chinese (Traditional)", label: "繁体字中国語" },
  { code: "Thai", label: "タイ語" },
  { code: "Indonesian", label: "インドネシア語" },
  { code: "Khmer", label: "クメール語" },
  { code: "Tagalog", label: "タガログ語" },
  { code: "Vietnamese", label: "ベトナム語" },
  { code: "Standard Mongolian", label: "標準モンゴル語" },
  { code: "Khalkha Mongolian", label: "ハルハ・モンゴル語" },
  { code: "Tibetan", label: "チベット語" },
  { code: "Dzongkha", label: "ゾンカ語" },
  { code: "Hindi", label: "ヒンディー語" },
  { code: "Urdu", label: "ウルドゥー語" },
  { code: "Tamil", label: "タミル語" },
  { code: "Sinhala", label: "シンハラ語" },
  { code: "Nepali", label: "ネパール語" },
  { code: "Assamese", label: "アッサム語" },
  { code: "Arabic", label: "アラビア語" },
  { code: "Hebrew", label: "ヘブライ語" },
  { code: "Persian", label: "ペルシャ語（ファルシ語）" },
  { code: "Turkish", label: "トルコ語" },
  { code: "Spanish", label: "スペイン語" },
  { code: "Spanish (Mexico)", label: "スペイン語（メキシコ）" },
  { code: "French", label: "フランス語" },
  { code: "German", label: "ドイツ語" },
  { code: "Italian", label: "イタリア語" },
  { code: "Dutch", label: "オランダ語" },
  { code: "Swedish", label: "スウェーデン語" },
  { code: "Danish", label: "デンマーク語" },
  { code: "Norwegian", label: "ノルウェー語" },
  { code: "Portuguese (Portugal)", label: "ポルトガル語（ポルトガル）" },
  { code: "Portuguese (Brazil)", label: "ポルトガル語（ブラジル）" },
  { code: "Romanian", label: "ルーマニア語" },
  { code: "Polish", label: "ポーランド語" },
  { code: "Czech", label: "チェコ語" },
  { code: "Slovak", label: "スロバキア語" },
  { code: "Hungarian", label: "ハンガリー語" },
  { code: "Bulgarian", label: "ブルガリア語" },
  { code: "Macedonian", label: "マケドニア語" },
  { code: "Ukrainian", label: "ウクライナ語" },
  { code: "Russian", label: "ロシア語" },
  { code: "Serbian", label: "セルビア語" },
  { code: "Croatian", label: "クロアチア語" },
  { code: "Slovenian", label: "スロベニア語" },
  { code: "Greek", label: "ギリシャ語" },
  { code: "Lithuanian", label: "リトアニア語" },
  { code: "Latvian", label: "ラトビア語" },
  { code: "Irish", label: "アイルランド語" },
  { code: "Welsh", label: "ウェールズ語" },
  { code: "Finnish", label: "フィンランド語" },
  { code: "Estonian", label: "エストニア語" },
  { code: "Maltese", label: "マルタ語" },
  { code: "Amharic", label: "アムハラ語" },
  { code: "Tigrinya", label: "ティグリニャ語" },
  { code: "Oromo", label: "オロモ語" },
];

const DEFAULT_LANG_OPTIONS: LangOption[] = [
  { code: "Japanese", label: "日本語" },
  { code: "English (US)", label: "英語（アメリカ）" },
  { code: "Chinese (Traditional)", label: "繁体字中国語" },
  { code: "Chinese (Simplified)", label: "簡体字中国語" },
  { code: "Korean", label: "韓国語" },
  { code: "Indonesian", label: "インドネシア語" },
];

const LABEL_BY_CODE: Record<string, string> = Object.fromEntries(TARGET_LANG_OPTIONS.map((o) => [o.code, o.label]));
const CODE_BY_LABEL: Record<string, string> = Object.fromEntries(TARGET_LANG_OPTIONS.map((o) => [o.label, o.code]));

function labelOfLang(code: string): string {
  return LABEL_BY_CODE[code] ?? code;
}

function normalizeLangCode(maybeCodeOrLabel: string | undefined, fallbackCode: string): string {
  const raw = (maybeCodeOrLabel ?? "").trim();
  if (!raw) return fallbackCode;
  // Already a known code
  if (LABEL_BY_CODE[raw]) return raw;
  // Japanese label -> code
  if (CODE_BY_LABEL[raw]) return CODE_BY_LABEL[raw];
  // Common older values (EN name without region)
  const low = raw.toLowerCase();
  if (low === "english") return "English (US)";
  return fallbackCode;
}

const DEFAULT_SETTINGS: Settings = {
  // NOTE:
  // - Use a single, consistent default across Windows/macOS to reduce confusion.
  // - Avoid common app/browser conflicts by using 3 modifiers + a letter.
  hotkey: "CommandOrControl+Shift+Alt+Z",
  clipboardMode: "displayOnly",
  apiBaseUrl: "https://lighting-translation.vercel.app",
  defaultLanguage: "Japanese",
  secondaryLanguage: "English (US)",
  routingStrategy: "alwaysFixed",
  popupFocusOnOpen: true,
  fixedTargetLang: "Japanese",
  onboarded: false,
  favoritePairs: [
    { from: "English (US)", to: "Japanese" },
    { from: "Japanese", to: "English (US)" },
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

function canonLang(s: string): string {
  const key = (s || "").trim().toLowerCase();
  // Normalize common display-name variants (JP labels) and detect_language outputs (EN labels)
  // We only need strong correctness for the 6 "defaultLanguage" options, but include common variants.
  const map: Record<string, string> = {
    // Japanese
    "日本語": "ja",
    "japanese": "ja",
    // English (US)
    "英語（アメリカ）": "en-us",
    "英語(アメリカ)": "en-us",
    "english (us)": "en-us",
    "english (u.s.)": "en-us",
    "american english": "en-us",
    // English (UK)
    "英語（イギリス）": "en-gb",
    "英語(イギリス)": "en-gb",
    "english (uk)": "en-gb",
    "english (u.k.)": "en-gb",
    "british english": "en-gb",
    // Korean
    "韓国語": "ko",
    "korean": "ko",
    // Chinese (Simplified)
    "簡体字中国語": "zh-hans",
    "simplified chinese": "zh-hans",
    "chinese (simplified)": "zh-hans",
    // Chinese (Traditional)
    "繁体字中国語": "zh-hant",
    "traditional chinese": "zh-hant",
    "chinese (traditional)": "zh-hant",
    // Indonesian
    "インドネシア語": "id",
    "indonesian": "id",
  };
  return map[key] ?? key;
}

function isSameLanguage(a: string, b: string): boolean {
  // Prefer code-based comparison; fall back to canon when older values are present.
  const ac = normalizeLangCode(a, a);
  const bc = normalizeLangCode(b, b);
  return ac === bc || canonLang(a) === canonLang(b);
}

function containsHangul(text: string): boolean {
  return /[\uac00-\ud7af]/.test(text);
}

function containsHanNoKana(text: string): boolean {
  // Han (CJK Unified Ideographs) and NOT Hiragana/Katakana
  const hasHan = /[\u4e00-\u9fff]/.test(text);
  const hasKana = /[\u3040-\u30ff]/.test(text);
  return hasHan && !hasKana;
}

function guessDetectedLangHeuristic(text: string, defaultLanguage: string): "default" | "not_default" | "unknown" {
  const d = normalizeLangCode(defaultLanguage, defaultLanguage);
  if (d === "Japanese") return containsJapanese(text) ? "default" : "not_default";
  if (d.startsWith("English")) return isMostlyAscii(text) ? "default" : "not_default";
  if (d === "Korean") return containsHangul(text) ? "default" : "not_default";
  if (d === "Chinese (Simplified)" || d === "Chinese (Traditional)") return containsHanNoKana(text) ? "default" : "not_default";
  if (d === "Indonesian") return isMostlyAscii(text) ? "default" : "not_default";
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
      // Migrate old stored values (Japanese labels) to API codes.
      merged.defaultLanguage = normalizeLangCode(merged.defaultLanguage, DEFAULT_SETTINGS.defaultLanguage);
      merged.secondaryLanguage = normalizeLangCode(merged.secondaryLanguage, DEFAULT_SETTINGS.secondaryLanguage);
      merged.fixedTargetLang = normalizeLangCode(merged.fixedTargetLang, merged.defaultLanguage);
      if (merged.lastUsedTargetLang) {
        merged.lastUsedTargetLang = normalizeLangCode(merged.lastUsedTargetLang, merged.defaultLanguage);
      }
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

      // #region agent log (H1/H2/H3)
      __agentLog("H1", "desktop/src/App.tsx:handleHotkey", "picked text + settings snapshot", {
        pickedLen: picked.length,
        routingStrategy: settings.routingStrategy,
        defaultLanguage: settings.defaultLanguage,
        secondaryLanguage: settings.secondaryLanguage,
        fixedTargetLang: settings.fixedTargetLang,
        lastUsedTargetLang: settings.lastUsedTargetLang,
        apiBaseUrl: settings.apiBaseUrl,
      });
      // #endregion

      // Show popup near cursor immediately
      await ensurePopupAtCursor();
      emitPopupState({ status: "Translating…", source: picked, translation: "" });

      setSourceText(picked);
      // capture note removed
      setStatus("Translating…");

      const computeTargetDefaultBased = (detectedLang: string) => {
        return isSameLanguage(detectedLang, settings.defaultLanguage) ? settings.secondaryLanguage : settings.defaultLanguage;
      };

      const runTranslate = (target: string) => {
        const runId = ++translationRunIdRef.current;
        let full = "";

        // #region agent log (H1/H2/H3)
        __agentLog("H2", "desktop/src/App.tsx:runTranslate", "starting translate_sse", {
          runId,
          target,
          routingStrategy: settings.routingStrategy,
          defaultLanguage: settings.defaultLanguage,
          secondaryLanguage: settings.secondaryLanguage,
          fixedTargetLang: settings.fixedTargetLang,
        });
        // #endregion

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

            if (full.length === msg.content.length) {
              // first delta only
              __agentLog("H7", "desktop/src/App.tsx:channel", "first translation delta script summary", {
                runId,
                target,
                summary: __scriptSummary(full),
              });
            }

            // Resize popup loosely based on content length (best effort)
            const lines = full.split(/\r?\n/).length;
            const h = Math.min(300, Math.max(150, 140 + Math.min(8, lines) * 18));
            const w = Math.min(400, Math.max(300, 360));
            const p = popupRef.current;
            if (p) void p.setSize(new PhysicalSize(w, h)).catch(() => {});
          } else if (msg.type === "error") {
            setStatus(`Error: ${msg.message}`);
            emitPopupState({ status: `Error: ${msg.message}` });
          } else if (msg.type === "done") {
            __agentLog("H7", "desktop/src/App.tsx:channel", "translation done script summary", {
              runId,
              target,
              summary: __scriptSummary(full),
            });
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
        const target = normalizeLangCode(settings.fixedTargetLang, settings.defaultLanguage);
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
          // #region agent log (H1)
          __agentLog("H1", "desktop/src/App.tsx:detect_language", "detect_language result (alwaysFixed)", {
            detectedForUi,
            defaultLanguage: settings.defaultLanguage,
            secondaryLanguage: settings.secondaryLanguage,
          });
          // #endregion
          setDetectedLang(detectedForUi);
        })();
      } else if (settings.routingStrategy === "alwaysLastUsed") {
        const target = normalizeLangCode(settings.lastUsedTargetLang, settings.defaultLanguage);
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

        // #region agent log (H4)
        __agentLog("H4", "desktop/src/App.tsx:defaultBased", "heuristic decision", {
          kind,
          heuristicDetected,
          target0,
          defaultLanguage: settings.defaultLanguage,
          secondaryLanguage: settings.secondaryLanguage,
        });
        // #endregion

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
        // #region agent log (H1)
        __agentLog("H1", "desktop/src/App.tsx:detect_language", "detect_language result (defaultBased)", {
          detectedForUi,
          defaultLanguage: settings.defaultLanguage,
          secondaryLanguage: settings.secondaryLanguage,
          target0,
        });
        // #endregion
        setDetectedLang(detectedForUi);

        if (detectedForUi !== "Unknown") {
          const targetReal = computeTargetDefaultBased(detectedForUi);
          // #region agent log (H1)
          __agentLog("H1", "desktop/src/App.tsx:defaultBased", "targetReal computed", {
            detectedForUi,
            targetReal,
            defaultLanguage: settings.defaultLanguage,
            secondaryLanguage: settings.secondaryLanguage,
            activeTargetBefore: active.target,
          });
          // #endregion
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
                {DEFAULT_LANG_OPTIONS.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
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
                {TARGET_LANG_OPTIONS.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
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
                {DEFAULT_LANG_OPTIONS.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
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
                {TARGET_LANG_OPTIONS.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
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
                {TARGET_LANG_OPTIONS.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
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
            {labelOfLang(detectedLang)} → {labelOfLang(targetLang || settings.lastUsedTargetLang || settings.fixedTargetLang || "")}
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
