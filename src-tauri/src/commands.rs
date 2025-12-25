use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
// (no hashing needed)
#[cfg(windows)]
use windows_sys::Win32::Foundation::POINT;
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
#[cfg(windows)]
use windows_sys::Win32::Foundation::HWND;
#[cfg(windows)]
use windows_sys::Win32::Graphics::Gdi::{
  BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC,
  SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP, HDC, SRCCOPY,
};
#[cfg(target_os = "macos")]
use core_graphics::event::CGEvent;
#[cfg(target_os = "macos")]
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

// #region agent log
fn agent_log(hypothesis_id: &str, message: &str, data: serde_json::Value) {
  use std::io::Write;
  let ts = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0);
  let payload = serde_json::json!({
    "sessionId": "debug-session",
    "runId": "run1",
    "hypothesisId": hypothesis_id,
    "location": "src-tauri/src/commands.rs",
    "message": message,
    "data": data,
    "timestamp": ts
  });
  let path = r"c:\Users\kuran\OneDrive\Desktop\App_dev\.cursor\debug.log";
  if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
    let _ = writeln!(f, "{}", payload.to_string());
  }
}
// #endregion agent log

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type")]
pub enum StreamEvent {
  #[serde(rename = "delta")]
  Delta { content: String },
  #[serde(rename = "done")]
  Done,
  #[serde(rename = "error")]
  Error { message: String },
}

#[derive(Debug, Serialize, Clone)]
pub struct DetectResult {
  pub detected_lang: String,
  pub confidence: f64,
  pub is_mixed: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct CursorPosition {
  pub x: i32,
  pub y: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CaptureRect {
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
}

#[tauri::command]
pub fn get_cursor_position() -> Result<CursorPosition, String> {
  #[cfg(windows)]
  unsafe {
    let mut pt = POINT { x: 0, y: 0 };
    let ok = GetCursorPos(&mut pt as *mut POINT);
    if ok == 0 {
      return Err("GetCursorPos failed".to_string());
    }
    return Ok(CursorPosition { x: pt.x, y: pt.y });
  }

  #[cfg(target_os = "macos")]
  {
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
      .map_err(|_| "CGEventSource::new failed".to_string())?;
    let ev = CGEvent::new(source).map_err(|_| "CGEvent::new failed".to_string())?;
    let loc = ev.location();
    return Ok(CursorPosition {
      x: loc.x as i32,
      y: loc.y as i32,
    });
  }

  #[cfg(not(any(windows, target_os = "macos")))]
  {
    Err("cursor position not supported on this platform".to_string())
  }
}

fn normalize_base_url(base_url: &str) -> String {
  let trimmed = base_url.trim().trim_end_matches('/');
  trimmed.to_string()
}

#[tauri::command]
pub async fn capture_selected_text(timeout_ms: Option<u64>) -> Result<String, String> {
  // Strategy: save clipboard text -> simulate Ctrl/Cmd+C -> poll clipboard -> restore.
  // NOTE: This only preserves text clipboard (v0). Non-text clipboard formats are not preserved yet.
  let timeout_ms = timeout_ms.unwrap_or(1200);

  let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("clipboard init failed: {e}"))?;
  let prev_text = clipboard.get_text().ok();
  agent_log("H4", "capture_selected_text entry", serde_json::json!({}));

  // Give the user time to release the hotkey modifiers (e.g. Alt) so that Ctrl+C isn't affected.
  std::thread::sleep(std::time::Duration::from_millis(180));

  // Put a sentinel into clipboard so we can reliably detect changes even if the copied text equals previous clipboard.
  let sentinel = format!(
    "__ERUDAITE_SENTINEL__{}__",
    std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_millis())
      .unwrap_or(0)
  );
  let _ = clipboard.set_text(sentinel.clone());
  // Wait until the sentinel is actually observable (Windows clipboard can lag).
  let mut sentinel_observed = false;
  {
    let started = std::time::Instant::now();
    while started.elapsed().as_millis() < 300 {
      if let Ok(cur) = clipboard.get_text() {
        if cur.trim() == sentinel {
          sentinel_observed = true;
          break;
        }
      }
      std::thread::sleep(std::time::Duration::from_millis(20));
    }
  }
  agent_log("H5", "sentinel set", serde_json::json!({ "observed": sentinel_observed }));

  // simulate copy
  #[cfg(target_os = "windows")]
  {
    use enigo::{
      Direction::{Click, Press, Release},
      Enigo, Key, Keyboard, Settings,
    };
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init failed: {e}"))?;
    // Best-effort: release other modifiers first so they don't interfere (especially Alt).
    let _ = enigo.key(Key::Alt, Release);
    let _ = enigo.key(Key::Shift, Release);
    let _ = enigo.key(Key::Meta, Release);
    // Attempt #1: Ctrl+C (no Esc; Esc can clear selection on some pages)
    let _ = enigo.key(Key::Control, Press);
    let _ = enigo.key(Key::Unicode('c'), Click);
    let _ = enigo.key(Key::Control, Release);
    agent_log("H9", "copy attempt 1 sent (Ctrl+C)", serde_json::json!({}));
  }
  #[cfg(target_os = "macos")]
  {
    use enigo::{
      Direction::{Click, Press, Release},
      Enigo, Key, Keyboard, Settings,
    };
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init failed: {e}"))?;
    // Meta is Command on macOS
    enigo.key(Key::Meta, Press).map_err(|e| format!("enigo key failed: {e}"))?;
    enigo
      .key(Key::Unicode('c'), Click)
      .map_err(|e| format!("enigo key failed: {e}"))?;
    enigo.key(Key::Meta, Release).map_err(|e| format!("enigo key failed: {e}"))?;
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos")))]
  {
    // no-op
  }
  agent_log("H8", "after key simulation clipboard sample", serde_json::json!({}));

  // poll clipboard for updated selection
  let started = std::time::Instant::now();
  let mut picked: Option<String> = None;
  let mut polls: u32 = 0;
  let mut last_kind: &'static str = "none";
  let mut tried_alt_copy: bool = false;
  while started.elapsed().as_millis() < timeout_ms as u128 {
    std::thread::sleep(std::time::Duration::from_millis(90));
    let cur = clipboard.get_text().ok();
    if let Some(cur_s) = cur {
      polls += 1;
      let cur_t = cur_s.trim().to_string();
      last_kind = if cur_t.is_empty() {
        "empty"
      } else if cur_t == sentinel {
        "sentinel"
      } else if cur_t.contains("__ERUDAITE_SENTINEL__") {
        "sentinel_like"
      } else if let Some(prev) = &prev_text {
        if prev.trim() == cur_t {
          "prev"
        } else {
          "other"
        }
      } else {
        "other"
      };
      if cur_t.is_empty() || cur_t == sentinel || cur_t.contains("__ERUDAITE_SENTINEL__") {
        // If still sentinel after a few polls, try an alternate copy sequence.
        // This stays within the same capture window and avoids relying on extra delays.
        if !tried_alt_copy && polls >= 3 {
          tried_alt_copy = true;
          #[cfg(target_os = "windows")]
          {
            use enigo::{
              Direction::{Click, Press, Release},
              Enigo, Key, Keyboard, Settings,
            };
            if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
              // Attempt #2: Ctrl+Insert (common alternate copy)
              let _ = enigo.key(Key::Alt, Release);
              let _ = enigo.key(Key::Shift, Release);
              let _ = enigo.key(Key::Control, Press);
              let _ = enigo.key(Key::Insert, Click);
              let _ = enigo.key(Key::Control, Release);
              // Attempt #3: Esc then Ctrl+C (in case Alt focused menus)
              let _ = enigo.key(Key::Escape, Click);
              let _ = enigo.key(Key::Control, Press);
              let _ = enigo.key(Key::Unicode('c'), Click);
              let _ = enigo.key(Key::Control, Release);
              agent_log("H9", "copy attempt 2/3 sent (Ctrl+Insert, Esc+Ctrl+C)", serde_json::json!({}));
            } else {
              agent_log("H9", "alt copy attempts skipped (enigo init failed)", serde_json::json!({ "pollsAt": polls }));
            }
          }
        }
        continue;
      }
      // If clipboard reverted to previous content without a successful copy, treat as failure.
      if let Some(prev) = &prev_text {
        if prev.trim() == cur_t {
          continue;
        }
      }
      picked = Some(cur_t);
      break;
    }
  }

  // restore clipboard text (best effort)
  if let Some(prev) = prev_text {
    let _ = clipboard.set_text(prev);
  }

  agent_log("H6", "capture_selected_text exit", serde_json::json!({ "polls": polls, "lastKind": last_kind }));

  Ok(picked.unwrap_or_default())
}

#[tauri::command]
pub async fn detect_language(base_url: String, text: String) -> Result<DetectResult, String> {
  let base = normalize_base_url(&base_url);
  let url = format!("{}/api/detect-language", base);

  let body = serde_json::json!({ "text": text });
  let client = reqwest::Client::new();
  let res = client
    .post(url)
    .header("Content-Type", "application/json")
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("request failed: {e}"))?;

  let v: serde_json::Value = res.json().await.map_err(|e| format!("invalid json: {e}"))?;
  let detected_lang = v
    .get("detected_lang")
    .and_then(|x| x.as_str())
    .unwrap_or("Unknown")
    .to_string();
  let confidence = v.get("confidence").and_then(|x| x.as_f64()).unwrap_or(0.0);
  let is_mixed = v.get("is_mixed").and_then(|x| x.as_bool()).unwrap_or(true);

  Ok(DetectResult {
    detected_lang,
    confidence,
    is_mixed,
  })
}

#[tauri::command]
pub async fn translate_sse(
  base_url: String,
  text: String,
  target_lang: String,
  mode: String,
  explanation_lang: String,
  is_reverse: Option<bool>,
  on_event: Channel<StreamEvent>,
) -> Result<(), String> {
  // (debug logging removed)
  let base = normalize_base_url(&base_url);
  let url = format!("{}/api/translate", base);

  let mut body = serde_json::json!({
    "text": text,
    "target_lang": target_lang,
    "mode": mode,
    "explanation_lang": explanation_lang,
    "skip_points": true
  });
  if is_reverse.unwrap_or(false) {
    body["is_reverse"] = serde_json::Value::Bool(true);
  }

  let client = reqwest::Client::new();
  let res = client
    .post(url)
    .header("Content-Type", "application/json")
    .header("Accept", "text/event-stream")
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("request failed: {e}"))?;

  if !res.status().is_success() {
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    let _ = on_event.send(StreamEvent::Error {
      message: format!("api error {status}: {text}"),
    });
    return Err(format!("api error {status}"));
  }

  use futures_util::StreamExt;
  let mut buffer = String::new();
  let mut stream = res.bytes_stream();
  while let Some(item) = stream.next().await {
    let chunk = match item {
      Ok(b) => b,
      Err(e) => {
        let _ = on_event.send(StreamEvent::Error {
          message: format!("stream error: {e}"),
        });
        return Err(format!("stream error: {e}"));
      }
    };

    let s = String::from_utf8_lossy(&chunk);
    buffer.push_str(&s);

    // process by lines; keep trailing partial line in buffer
    while let Some(pos) = buffer.find('\n') {
      let line = buffer[..pos].to_string();
      buffer = buffer[pos + 1..].to_string();

      let line = line.trim_end_matches('\r').to_string();
      if !line.starts_with("data: ") {
        continue;
      }
      let data = line.trim_start_matches("data: ").trim();
      if data == "[DONE]" {
        let _ = on_event.send(StreamEvent::Done);
        return Ok(());
      }
      if data.is_empty() {
        continue;
      }

      let v: serde_json::Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => continue,
      };
      if let Some(content) = v.get("content").and_then(|x| x.as_str()) {
        if !content.is_empty() {
          let _ = on_event.send(StreamEvent::Delta {
            content: content.to_string(),
          });
        }
      } else if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
        let _ = on_event.send(StreamEvent::Error {
          message: err.to_string(),
        });
        return Err(err.to_string());
      }
    }
  }

  let _ = on_event.send(StreamEvent::Done);
  Ok(())
}

#[tauri::command]
pub async fn capture_screen_region(rect: CaptureRect) -> Result<String, String> {
  #[cfg(windows)]
  {
    if rect.width == 0 || rect.height == 0 {
      return Err("invalid rect".to_string());
    }

    unsafe {
      let screen_dc: HDC = GetDC(0 as HWND);
      if screen_dc.is_null() {
        return Err("GetDC failed".to_string());
      }
      let mem_dc: HDC = CreateCompatibleDC(screen_dc);
      if mem_dc.is_null() {
        let _ = ReleaseDC(0 as HWND, screen_dc);
        return Err("CreateCompatibleDC failed".to_string());
      }
      let bmp: HBITMAP = CreateCompatibleBitmap(screen_dc, rect.width as i32, rect.height as i32);
      if bmp.is_null() {
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(0 as HWND, screen_dc);
        return Err("CreateCompatibleBitmap failed".to_string());
      }

      let old = SelectObject(mem_dc, bmp as _);
      if old.is_null() {
        let _ = DeleteObject(bmp as _);
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(0 as HWND, screen_dc);
        return Err("SelectObject failed".to_string());
      }

      let ok = BitBlt(
        mem_dc,
        0,
        0,
        rect.width as i32,
        rect.height as i32,
        screen_dc,
        rect.x,
        rect.y,
        SRCCOPY | CAPTUREBLT,
      );
      if ok == 0 {
        let _ = SelectObject(mem_dc, old);
        let _ = DeleteObject(bmp as _);
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(0 as HWND, screen_dc);
        return Err("BitBlt failed".to_string());
      }

      // Prepare 32-bit BGRA DIB
      let mut bmi: BITMAPINFO = std::mem::zeroed();
      bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: rect.width as i32,
        biHeight: -(rect.height as i32), // top-down
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
      };

      let mut bgra = vec![0u8; rect.width as usize * rect.height as usize * 4];
      let lines = GetDIBits(
        mem_dc,
        bmp,
        0,
        rect.height as u32,
        bgra.as_mut_ptr() as *mut _,
        &mut bmi as *mut _,
        DIB_RGB_COLORS,
      );
      // cleanup GDI
      let _ = SelectObject(mem_dc, old);
      let _ = DeleteObject(bmp as _);
      let _ = DeleteDC(mem_dc);
      let _ = ReleaseDC(0 as HWND, screen_dc);

      if lines == 0 {
        return Err("GetDIBits failed".to_string());
      }

      // Convert BGRA -> RGBA
      for px in bgra.chunks_exact_mut(4) {
        let b = px[0];
        let r = px[2];
        px[0] = r;
        px[2] = b;
      }

      let mut out_path = std::env::temp_dir();
      let name = format!(
        "erudaite-ocr-{}.png",
        std::time::SystemTime::now()
          .duration_since(std::time::UNIX_EPOCH)
          .map(|d| d.as_millis())
          .unwrap_or(0)
      );
      out_path.push(name);

      let file = std::fs::File::create(&out_path).map_err(|e| format!("create png failed: {e}"))?;
      let w = std::io::BufWriter::new(file);
      let mut encoder = png::Encoder::new(w, rect.width, rect.height);
      encoder.set_color(png::ColorType::Rgba);
      encoder.set_depth(png::BitDepth::Eight);
      let mut writer = encoder
        .write_header()
        .map_err(|e| format!("png header failed: {e}"))?;
      writer
        .write_image_data(&bgra)
        .map_err(|e| format!("png write failed: {e}"))?;

      return Ok(out_path.to_string_lossy().to_string());
    }
  }

  #[cfg(not(windows))]
  {
    let _ = rect;
    Err("capture_screen_region not supported on this platform".to_string())
  }
}

#[tauri::command]
pub async fn detect_tesseract_path() -> Result<Option<String>, String> {
  #[cfg(windows)]
  {
    let candidates = [
      r"C:\Program Files\Tesseract-OCR\tesseract.exe",
      r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ];
    for p in candidates {
      if std::path::Path::new(p).exists() {
        return Ok(Some(p.to_string()));
      }
    }

    // Try PATH via `where`
    if let Ok(out) = std::process::Command::new("where").arg("tesseract").output() {
      if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout);
        if let Some(line) = s.lines().map(|l| l.trim()).find(|l| !l.is_empty()) {
          if std::path::Path::new(line).exists() {
            return Ok(Some(line.to_string()));
          }
        }
      }
    }
    Ok(None)
  }

  #[cfg(not(windows))]
  {
    Ok(None)
  }
}

#[tauri::command]
pub async fn ocr_tesseract(image_path: String, lang: Option<String>, tesseract_path: Option<String>) -> Result<String, String> {
  let lang = lang.unwrap_or_else(|| "jpn+eng".to_string());
  // #region agent log
  agent_log("G", "ocr_tesseract enter", serde_json::json!({
    "lang": lang,
    "hasExplicitTesseractPath": tesseract_path.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false),
    "imagePath": image_path
  }));
  // #endregion agent log

  let exe = if let Some(p) = tesseract_path.filter(|s| !s.trim().is_empty()) {
    p
  } else {
    detect_tesseract_path().await?.ok_or_else(|| "TESSERACT_NOT_FOUND".to_string())?
  };

  let output = std::process::Command::new(exe)
    .arg(image_path)
    .arg("stdout")
    .arg("-l")
    .arg(lang)
    .output()
    .map_err(|e| format!("failed to run tesseract: {e}"))?;

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr);
    // #region agent log
    agent_log("G", "ocr_tesseract exit error", serde_json::json!({ "stderrLen": stderr.trim().len() }));
    // #endregion agent log
    return Err(format!("tesseract failed: {}", stderr.trim()));
  }
  let stdout = String::from_utf8_lossy(&output.stdout).to_string();
  // #region agent log
  agent_log("G", "ocr_tesseract exit ok", serde_json::json!({ "stdoutLen": stdout.trim().len() }));
  // #endregion agent log
  Ok(stdout.trim().to_string())
}

#[tauri::command]
pub async fn download_tesseract_installer() -> Result<String, String> {
  #[cfg(windows)]
  {
    // NOTE: Try multiple known URL patterns (the official distribution changes occasionally).
    // We pin a known filename but keep fallbacks.
    let urls = [
      "https://digi.bib.uni-mannheim.de/tesseract/tesseract-ocr-w64-setup-5.5.0.20241111.exe",
      "https://digi.bib.uni-mannheim.de/tesseract/tesseract-ocr-w64-setup-v5.5.0.20241111.exe",
    ];

    let mut last_err = None;
    for url in urls {
      let res = reqwest::get(url).await;
      let res = match res {
        Ok(r) => r,
        Err(e) => {
          last_err = Some(format!("download failed: {e}"));
          continue;
        }
      };
      if !res.status().is_success() {
        last_err = Some(format!("download failed: http {}", res.status()));
        continue;
      }
      let bytes = res.bytes().await.map_err(|e| format!("download read failed: {e}"))?;

      let mut out_path = std::env::temp_dir();
      out_path.push("erudaite-tesseract-installer.exe");
      std::fs::write(&out_path, &bytes).map_err(|e| format!("write installer failed: {e}"))?;
      return Ok(out_path.to_string_lossy().to_string());
    }
    Err(last_err.unwrap_or_else(|| "download failed".to_string()))
  }

  #[cfg(not(windows))]
  {
    Err("download_tesseract_installer not supported on this platform".to_string())
  }
}

#[tauri::command]
pub async fn launch_installer(path: String) -> Result<(), String> {
  #[cfg(windows)]
  {
    std::process::Command::new(path)
      .spawn()
      .map_err(|e| format!("failed to launch installer: {e}"))?;
    Ok(())
  }

  #[cfg(not(windows))]
  {
    let _ = path;
    Err("launch_installer not supported on this platform".to_string())
  }
}


