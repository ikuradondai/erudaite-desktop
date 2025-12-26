#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  use tauri::Manager;
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
      "location": "src-tauri/src/lib.rs",
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

  tauri::Builder::default()
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .plugin(tauri_plugin_store::Builder::new().build())
    .invoke_handler(tauri::generate_handler![
      commands::translate_sse,
      commands::capture_selected_text,
      commands::detect_language,
      commands::get_cursor_position,
      commands::capture_screen_region,
      commands::detect_tesseract_path,
      commands::tesseract_list_langs,
      commands::download_tessdata,
      commands::ocr_tesseract,
      commands::download_tesseract_installer,
      commands::launch_installer
    ])
    .on_window_event(|window, event| {
      // Safety: if the main window is closed/destroyed while OCR overlay is open,
      // force-close other windows so the user never gets stuck with an overlay.
      let label = window.label().to_string();
      let should_cleanup = matches!(event, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed);
      if label == "main" && should_cleanup {
        // #region agent log
        agent_log("K", "main close -> cleanup", serde_json::json!({ "event": format!("{:?}", event) }));
        // #endregion agent log
        // Best-effort cleanup
        if let Some(w) = window.app_handle().get_webview_window("ocr-overlay") {
          let _ = w.close();
          // #region agent log
          agent_log("K", "closed ocr-overlay", serde_json::json!({}));
          // #endregion agent log
        }
        if let Some(w) = window.app_handle().get_webview_window("popup") {
          let _ = w.close();
          // #region agent log
          agent_log("K", "closed popup", serde_json::json!({}));
          // #endregion agent log
        }
      }
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

mod commands;
