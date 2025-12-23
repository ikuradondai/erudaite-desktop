use serde::Serialize;
use tauri::ipc::Channel;
use std::io::Write;
use std::hash::{Hash, Hasher};

// #region agent log
fn agent_log(hypothesis_id: &str, message: &str, data: serde_json::Value) {
  let path = r"c:\Users\kuran\OneDrive\Desktop\App_dev\.cursor\debug.log";
  if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
    let v = serde_json::json!({
      "sessionId": "debug-session",
      "runId": "pre-fix",
      "hypothesisId": hypothesis_id,
      "location": "desktop/src-tauri/src/commands.rs",
      "message": message,
      "data": data,
      "timestamp": std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
    });
    let _ = writeln!(f, "{}", v.to_string());
    // Also print to stdout so we can see logs even if file writing is blocked.
    println!("[ERUDAITE_DEBUG] {}", v.to_string());
  }
}
// #endregion

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
  // #region agent log
  agent_log("H4", "capture_selected_text entry", serde_json::json!({
    "timeoutMs": timeout_ms,
    "prevLen": prev_text.as_ref().map(|s| s.trim().len()).unwrap_or(0)
  }));
  // #endregion

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
  // #region agent log
  agent_log("H5", "sentinel set", serde_json::json!({
    "sentinelObserved": sentinel_observed
  }));
  // #endregion

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
    // #region agent log
    agent_log("H9", "copy attempt 1 sent (Ctrl+C)", serde_json::json!({}));
    // #endregion
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
  // #region agent log
  {
    let sample = clipboard.get_text().ok().map(|s| s.trim().to_string());
    let kind = match &sample {
      None => "none",
      Some(s) if s.is_empty() => "empty",
      Some(s) if *s == sentinel => "sentinel",
      Some(s) if s.contains("__ERUDAITE_SENTINEL__") => "sentinel_like",
      Some(s) => {
        if let Some(prev) = &prev_text {
          if prev.trim() == s {
            "prev"
          } else {
            "other"
          }
        } else {
          "other"
        }
      }
    };
    agent_log("H8", "after key simulation clipboard sample", serde_json::json!({
      "kind": kind,
      "len": sample.as_ref().map(|x| x.len()).unwrap_or(0)
    }));
  }
  // #endregion

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
              // #region agent log
              agent_log("H9", "copy attempt 2/3 sent (Ctrl+Insert, Esc+Ctrl+C)", serde_json::json!({ "pollsAt": polls }));
              // #endregion
              // #region agent log
              let sample2 = clipboard.get_text().ok().map(|s| s.trim().to_string());
              let kind2 = match &sample2 {
                None => "none",
                Some(s) if s.is_empty() => "empty",
                Some(s) if *s == sentinel => "sentinel",
                Some(s) if s.contains("__ERUDAITE_SENTINEL__") => "sentinel_like",
                Some(s) => {
                  if let Some(prev) = &prev_text {
                    if prev.trim() == s { "prev" } else { "other" }
                  } else {
                    "other"
                  }
                }
              };
              agent_log("H8", "after retry attempts clipboard sample", serde_json::json!({
                "kind": kind2,
                "len": sample2.as_ref().map(|x| x.len()).unwrap_or(0)
              }));
              // #endregion
            } else {
              // #region agent log
              agent_log("H9", "alt copy attempts skipped (enigo init failed)", serde_json::json!({ "pollsAt": polls }));
              // #endregion
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

  // #region agent log
  agent_log("H6", "capture_selected_text exit", serde_json::json!({
    "polls": polls,
    "pickedLen": picked.as_ref().map(|s| s.len()).unwrap_or(0),
    "lastKind": last_kind
  }));
  // #endregion

  // #region agent log
  if let Some(p) = &picked {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    p.hash(&mut h);
    let hash64 = h.finish();
    agent_log("H10", "picked summary", serde_json::json!({
      "bytes": p.len(),
      "chars": p.chars().count(),
      "isAscii": p.is_ascii(),
      "hasNewline": p.contains('\n'),
      "hash64": format!("{:016x}", hash64)
    }));
  } else {
    agent_log("H10", "picked summary", serde_json::json!({
      "bytes": 0,
      "chars": 0,
      "isAscii": null,
      "hasNewline": null,
      "hash64": null
    }));
  }
  // #endregion

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


