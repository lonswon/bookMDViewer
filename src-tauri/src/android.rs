//! Android-specific file access.
//!
//! Android 10+ uses scoped storage: a plain `/sdcard/foo.md` path can no longer
//! be opened by an arbitrary app. Files reach us as `content://` URIs granted
//! through the Storage Access Framework (SAF) picker, or handed to us by another
//! app via an `ACTION_VIEW` intent.
//!
//! The desktop builds keep using `std::fs`; this module provides the same
//! operations (`read_md`, `write_md`, `list_dir`) for the Android target on top
//! of the `tauri-plugin-android-fs` crate.
//!
//! Written against tauri-plugin-android-fs 29.0.0, whose `Entry` is an enum and
//! whose `FsUri` has no `Display` impl (use the `.uri` field).

use tauri::Runtime;
use tauri_plugin_android_fs::{AndroidFsExt, Entry, FsUri};

use crate::{DirEntry, DirListing};

/// A single document's grant is all we get from the SAF picker, so cap reads at
/// a size the phone can comfortably hold in memory as a JS string.
const MAX_DOC_BYTES: u64 = 64 * 1024 * 1024;

/// Read a document back as text.
pub fn read_text<R: Runtime>(app: &tauri::AppHandle<R>, uri: &str) -> Result<String, String> {
    let fs = app.android_fs();
    let fs_uri = FsUri::from_uri(uri);

    if let Ok(len) = fs.get_len(&fs_uri) {
        if len > MAX_DOC_BYTES {
            return Err(format!(
                "File is too large to open ({} MB)",
                len / (1024 * 1024)
            ));
        }
    }

    let text = fs
        .read_to_string(&fs_uri)
        .map_err(|e| format!("Failed to read {uri}: {e}"))?;
    // Strip a UTF-8 BOM so it doesn't show up as a stray glyph.
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// Overwrite a document with new text.
pub fn write_text<R: Runtime>(
    app: &tauri::AppHandle<R>,
    uri: &str,
    content: &str,
) -> Result<(), String> {
    let fs = app.android_fs();
    let fs_uri = FsUri::from_uri(uri);
    fs.write(&fs_uri, content.as_bytes())
        .map_err(|e| format!("Failed to write {uri}: {e}"))
}

/// List sibling documents in the folder that contains `uri`.
///
/// A `content://` URI that came from the *file* picker grants access to exactly
/// one document, so there are no siblings to enumerate. In that case we return a
/// listing that contains only the document itself, and the UI falls back to
/// showing the file without a browsable tree.
pub fn list_dir<R: Runtime>(app: &tauri::AppHandle<R>, uri: &str) -> Result<DirListing, String> {
    let fs = app.android_fs();
    let fs_uri = FsUri::from_uri(uri);

    // Resolve the containing folder. If the URI is a tree/document id we can
    // walk up; a bare document grant usually fails here, which is fine.
    let dir_uri = fs.resolve_dir_uri(&fs_uri, "").ok();

    let mut entries: Vec<DirEntry> = Vec::new();

    if let Some(dir_uri) = dir_uri.as_ref() {
        if let Ok(children) = fs.read_dir(dir_uri) {
            for entry in children.iter() {
                push_if_browsable(&mut entries, entry);
            }
        }
    }

    // Always make sure the open document itself is present, even when the
    // parent folder was not readable.
    if entries.is_empty() {
        entries.push(DirEntry {
            name: name_from_uri(uri),
            path: uri.to_string(),
            is_dir: false,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListing {
        dir: dir_uri
            .as_ref()
            .map(|u| u.uri.clone())
            .unwrap_or_else(|| uri.to_string()),
        parent: dir_uri
            .as_ref()
            .and_then(|u| fs.resolve_dir_uri(u, "..").ok())
            .map(|u| u.uri),
        entries,
    })
}

/// Keep folders and Markdown documents; drop everything else.
fn push_if_browsable(entries: &mut Vec<DirEntry>, entry: &Entry) {
    let name = entry.name();
    if name.starts_with('.') {
        return;
    }
    let is_dir = entry.is_dir();
    let is_md = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false);
    if !is_dir && !is_md {
        return;
    }
    entries.push(DirEntry {
        name: name.to_string(),
        path: entry.uri().uri.clone(),
        is_dir,
    });
}

/// Decode the human-readable file name out of a `content://` document URI.
///
/// The last segment is a percent-encoded document id such as
/// `primary%3ANotes%2Ftodo.md`, so the name is everything after the last `/`.
fn name_from_uri(uri: &str) -> String {
    let last = uri.rsplit('/').next().unwrap_or(uri);
    let decoded = percent_decode(last);
    let tail = decoded.rsplit(':').next().unwrap_or(&decoded);
    tail.rsplit('/').next().unwrap_or(tail).to_string()
}

/// Minimal percent-decoder for URI path segments.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &s[i + 1..i + 3];
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
