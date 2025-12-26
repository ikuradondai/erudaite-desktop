#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  use tauri::Manager;
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
        // Best-effort cleanup
        if let Some(w) = window.app_handle().get_webview_window("ocr-overlay") {
          let _ = w.close();
        }
        if let Some(w) = window.app_handle().get_webview_window("popup") {
          let _ = w.close();
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
