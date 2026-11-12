use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, State};

#[cfg(not(target_os = "android"))]
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

#[cfg(target_os = "android")]
mod android;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct DirListing {
    pub dir: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
}

/// Result of importing a `content://` document into app storage (Android).
///
/// `path` is an absolute path inside the app sandbox, usable by `read_md`,
/// `write_md` and `list_dir` exactly like a desktop path.
#[derive(Serialize)]
pub struct ImportedDoc {
    pub path: String,
    pub name: String,
    /// False when the source changed and had to be copied again.
    pub cached: bool,
}

/// Holds the file we are currently viewing plus the live filesystem watcher.
#[derive(Default)]
pub struct AppState {
    pub current: Mutex<Option<PathBuf>>,
    #[cfg(not(target_os = "android"))]
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    /// True once the webview has registered its event listeners.
    pub ready: Mutex<bool>,
    /// macOS file-open requests received before the frontend was ready.
    pub pending: Mutex<Vec<String>>,
    /// True once the initial window has been given a document. On macOS (which
    /// is single-instance) every *subsequent* file-open opens its own window
    /// instead of replacing the current document — matching Windows/Linux.
    pub claimed: Mutex<bool>,
}

/// List sub-folders and Markdown files in a directory (for the file explorer).
/// If `path` is a file, its parent directory is listed.
///
/// On Android `path` is an ordinary path inside the app sandbox once the
/// document has been imported, so the same code serves both platforms.
#[tauri::command]
fn list_dir(app: tauri::AppHandle, path: String) -> Result<DirListing, String> {
    #[cfg(target_os = "android")]
    {
        // An empty target means "everything imported so far".
        if path.is_empty() {
            return android::list_imported(&app);
        }
    }

    let _ = app;
    let p = PathBuf::from(&path);
    let dir = if p.is_dir() {
        p
    } else {
        p.parent().map(Path::to_path_buf).unwrap_or(p)
    };

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue; // skip hidden
        }
        let ep = entry.path();
        let is_dir = ep.is_dir();
        let is_md = ep
            .extension()
            .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
            .unwrap_or(false);
        if is_dir || is_md {
            entries.push(DirEntry {
                name,
                path: ep.to_string_lossy().into_owned(),
                is_dir,
            });
        }
    }
    // Folders first, then files; alphabetical, case-insensitive.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListing {
        dir: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
    })
}

/// Route a file-open request: the first file loads into the existing (empty)
/// window; any later file spawns a new instance so it gets its own window.
#[cfg(not(target_os = "android"))]
fn route_open(app: &tauri::AppHandle, state: &AppState, path: String) {
    let mut claimed = state.claimed.lock().unwrap();
    if !*claimed {
        *claimed = true;
        let _ = app.emit("open-file", path);
    } else if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).arg(path).spawn();
    }
}

/// Pull a markdown file path out of the process arguments (set when the OS
/// launches us via a `.md` file association on Windows / Linux).
#[cfg(not(target_os = "android"))]
fn path_from_args() -> Option<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|p| p.extension().map(|e| e.eq_ignore_ascii_case("md")).unwrap_or(false) && p.exists())
}

/// Whether the app was launched with `--edit` (open straight into edit mode).
#[tauri::command]
fn start_in_edit() -> bool {
    #[cfg(target_os = "android")]
    {
        false
    }
    #[cfg(not(target_os = "android"))]
    {
        std::env::args().any(|a| a == "--edit")
    }
}

/// Optional `--zoom=<factor>` launch flag (0.0 means "not set").
#[tauri::command]
fn start_zoom() -> f64 {
    #[cfg(target_os = "android")]
    {
        0.0
    }
    #[cfg(not(target_os = "android"))]
    {
        std::env::args()
            .find_map(|a| a.strip_prefix("--zoom=").and_then(|v| v.parse::<f64>().ok()))
            .unwrap_or(0.0)
    }
}

/// Called by the webview once its event listeners are registered. Flushes any
/// file-open requests that arrived during cold start (macOS drops events that
/// are emitted before the frontend is listening).
#[tauri::command]
fn frontend_ready(app: tauri::AppHandle, state: State<'_, AppState>) {
    *state.ready.lock().unwrap() = true;
    let pending: Vec<String> = state.pending.lock().unwrap().drain(..).collect();
    for path in pending {
        #[cfg(not(target_os = "android"))]
        route_open(&app, state.inner(), path);
        #[cfg(target_os = "android")]
        {
            let _ = &app;
            let _ = path;
        }
    }
}

/// Returns the file path the app was launched with, if any.
///
/// Android always returns `None`: documents arrive through the SAF picker
/// rather than as launch arguments, and the intent hand-off is not wired up.
#[tauri::command]
fn get_initial_path(state: State<'_, AppState>) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        let _ = &state;
        None
    }
    #[cfg(not(target_os = "android"))]
    {
        state
            .current
            .lock()
            .unwrap()
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
    }
}

/// Read a markdown file's raw text.
///
/// Both platforms take an ordinary filesystem path: on Android the document has
/// already been imported into app storage by `import_document`.
#[tauri::command]
fn read_md(app: tauri::AppHandle, state: State<'_, AppState>, path: String) -> Result<String, String> {
    let _ = (&app, &state);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    // Desktop keeps the raw text verbatim; Android drops the BOM because an
    // imported document often comes from an editor that writes one.
    #[cfg(target_os = "android")]
    {
        return Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(text)
    }
}

/// Open a file in a brand-new application window (spawns another instance).
///
/// Desktop only: Android has no process-per-window model, so this is a no-op
/// there and the UI hides the entry point.
#[tauri::command]
fn open_new_window(path: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = path;
        Err("Not supported on Android".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        std::process::Command::new(exe)
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Write text back to a markdown file.
///
/// On Android this writes the imported copy inside app storage, never the
/// user's original document — exporting is a separate, explicit step.
#[tauri::command]
fn write_md(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    let _ = app;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write {path}: {e}"))
}

/// Import a `content://` document into app storage (Android only).
///
/// Returns the absolute path inside the sandbox, which the rest of the app then
/// treats exactly like a desktop file path.
#[tauri::command]
fn import_document(app: tauri::AppHandle, uri: String) -> Result<ImportedDoc, String> {
    #[cfg(target_os = "android")]
    {
        return android::import_document(&app, &uri);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &uri);
        Err("Not supported on desktop".into())
    }
}

/// Ask the OS for storage access.
///
/// Android 11+ needs nothing for SAF-picked documents, and the call resolves
/// immediately with `true`. Android 9 and below really does gate public-storage
/// access behind READ/WRITE_EXTERNAL_STORAGE, which the
/// `legacy_storage_permission` feature declares in the merged manifest — this is
/// what shows the system permission dialog there.
#[tauri::command]
fn request_storage_permission(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_android_fs::AndroidFsExt;
        return app
            .android_fs()
            .public_storage()
            .request_permission()
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        // No concept of a runtime storage permission on desktop.
        let _ = app;
        Ok(true)
    }
}

/// Whether storage access is already granted, so the UI can decide whether to
/// show a "grant access" affordance.
#[tauri::command]
fn has_storage_permission(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_android_fs::AndroidFsExt;
        return app
            .android_fs()
            .public_storage()
            .check_permission()
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(true)
    }
}

/// Begin watching `path`; emits `md-changed` whenever the file is modified.
/// We watch the *parent directory* (non-recursive) because many editors save
/// by replacing the file, which breaks a watch placed directly on the file.
///
/// Android's SAF has no inotify equivalent for `content://` documents, so this
/// is a no-op there and the UI simply doesn't live-reload.
#[tauri::command]
fn watch_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = (&app, &state, &path);
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let target = PathBuf::from(&path);
        let parent = target
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "File has no parent directory".to_string())?;

        *state.current.lock().unwrap() = Some(target.clone());

        let watched = target.clone();
        let handle = app.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                if matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_) | EventKind::Any
                ) && event.paths.iter().any(|p| p == &watched)
                {
                    let _ = handle.emit("md-changed", watched.to_string_lossy().into_owned());
                }
            }
        })
        .map_err(|e| e.to_string())?;

        watcher
            .watch(&parent, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;

        // Keep the watcher alive by stashing it in state (replacing any previous one).
        *state.watcher.lock().unwrap() = Some(watcher);
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState::default();
    #[cfg(not(target_os = "android"))]
    if let Some(p) = path_from_args() {
        *state.current.lock().unwrap() = Some(p);
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    // Android needs the SAF-backed filesystem plugin; desktop has no such thing.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_fs::init());

    builder
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_initial_path,
            frontend_ready,
            start_in_edit,
            start_zoom,
            read_md,
            write_md,
            list_dir,
            import_document,
            open_new_window,
            watch_file,
            request_storage_permission,
            has_storage_permission
        ])
        .setup(|_app| {
            #[cfg(target_os = "android")]
            {
                // Nothing to do yet: the intent URI arrives via the frontend.
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS delivers file-association opens as a runtime event. During
            // cold start this can fire before the webview is listening, so we
            // buffer until `frontend_ready` flushes the queue.
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager as _;
                if let tauri::RunEvent::Opened { urls } = &event {
                    let state = app.state::<AppState>();
                    let ready = *state.ready.lock().unwrap();
                    for url in urls {
                        if let Ok(p) = url.to_file_path() {
                            let s = p.to_string_lossy().into_owned();
                            if ready {
                                route_open(app, state.inner(), s);
                            } else {
                                state.pending.lock().unwrap().push(s);
                            }
                        }
                    }
                }
            }
            let _ = (app, &event);
        });
}
