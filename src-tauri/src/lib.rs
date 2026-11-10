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
    /// Android: the `content://` URI of the open document.
    #[cfg(target_os = "android")]
    pub uri: Mutex<Option<String>>,
}

/// List sub-folders and Markdown files in a directory (for the file explorer).
/// If `path` is a file, its parent directory is listed.
///
/// On Android `path` is a `content://` document URI and the listing is limited
/// to what the SAF grant allows us to see.
#[tauri::command]
fn list_dir(app: tauri::AppHandle, path: String) -> Result<DirListing, String> {
    #[cfg(target_os = "android")]
    {
        return android::list_dir(&app, &path);
    }

    #[cfg(not(target_os = "android"))]
    {
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

/// Returns the file path (desktop) or `content://` URI (Android) the app was
/// opened with, if any.
#[tauri::command]
fn get_initial_path(state: State<'_, AppState>) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        return state.uri.lock().ok().and_then(|g| g.clone());
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
/// Desktop: a filesystem path. Android: a `content://` URI from the SAF picker.
#[tauri::command]
fn read_md(app: tauri::AppHandle, state: State<'_, AppState>, path: String) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let text = android::read_text(&app, &path)?;
        if let Ok(mut current) = state.uri.lock() {
            *current = Some(path);
        }
        Ok(text)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &state);
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {path}: {e}"))
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
#[tauri::command]
fn write_md(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        return android::write_text(&app, &path, &content);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        std::fs::write(&path, content).map_err(|e| format!("Failed to write {path}: {e}"))
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
            open_new_window,
            watch_file
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
