# ErudAite Desktop (Tauri)

Global-hotkey “shortcut translation” desktop app for **ErudAite / Lightning Translation**.

## Features (v0)
- Global hotkey: **Ctrl+Shift+Space** (Windows) / **⌃⌘+Shift+Space** (macOS; `CommandOrControl+Shift+Space`)
- Captures selected text via **Ctrl/Cmd+C → clipboard read → clipboard restore** (text-only restore)
- Calls Lightning Translation:
  - `POST /api/detect-language` (routing)
  - `POST /api/translate` with `skip_points:true` (translation only, SSE streaming)
- Routing strategies:
  - Default-based (recommended)
  - Always last used
  - Always fixed
- Clipboard modes:
  - Display only
  - Display + auto copy
  - Auto copy only
- Reverse translation (on demand)

## Requirements

### Windows
- Node.js
- Rust (rustup)
- Visual Studio 2022 (Community) with **Desktop development with C++**
  - Needed for `link.exe`.

### macOS
- Node.js
- Rust (rustup)
- Xcode Command Line Tools
- Accessibility permission may be required to simulate Cmd+C.

## Dev

```bash
cd lightning_translation/desktop
npm install
npm run tauri dev
```

Notes:
- This repo may live under OneDrive on Windows; Cargo builds can fail there.
  If you hit OneDrive write/lock issues, set a local target dir via env var (recommended):
  - PowerShell:
    - `$env:CARGO_TARGET_DIR = \"C:\\cargo-target\\erudaite-desktop\"`
  Then run `npm run tauri dev` / `npm run tauri build`.

## Build

```bash
cd lightning_translation/desktop
npm run tauri build
```


