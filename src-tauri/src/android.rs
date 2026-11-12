//! Android-specific file access.
//!
//! Android 10+ scoped storage hands documents to us as `content://` URIs that
//! `std::fs` cannot open. Rather than threading SAF URIs through the whole
//! frontend, we import the document into app-private storage when it is opened
//! and work with an ordinary path from then on:
//!
//! ```text
//! <app files>/mdviewer-documents/<sha256(source uri)>/<original name>
//! ```
//!
//! Everything downstream — reading, editing, the folder browser and relative
//! `![](pics/x.png)` resolution — then becomes plain filesystem work, which is
//! why those features work on Android again.
//!
//! Trade-off: the copy lives inside the app sandbox, so editing it does not
//! touch the original document. Saving writes the private copy and the UI
//! offers "save as" to export the result wherever the user wants it. This is
//! the same model markview uses.
//!
//! Written against tauri-plugin-android-fs 29.0.0, where `Entry` is an enum and
//! `FsUri` has no `Display` impl (use the `.uri` field).

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use sha2::{Digest, Sha256};
use tauri::Runtime;
use tauri_plugin_android_fs::{AndroidFsExt, FsUri, PrivateDir};

use crate::{DirEntry, DirListing, ImportedDoc};

/// Cap the import at a size the phone can comfortably hold as a JS string.
const MAX_DOC_BYTES: u64 = 64 * 1024 * 1024;

/// Subdirectory of the app's private data dir that holds imported documents.
const DOCS_SUBDIR: &str = "mdviewer-documents";

/// Extensions worth pulling in next to the document so `![](...)` resolves.
const IMAGE_EXTS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

/// Root of the import area inside app-private storage.
fn docs_root<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .android_fs()
        .private_storage()
        .resolve_path(PrivateDir::Data)
        .map_err(|e| format!("无法定位应用私有目录：{e}"))?;
    Ok(base.join(DOCS_SUBDIR))
}

/// Copy a `content://` document into app storage and return its local path.
///
/// Re-opening the same URI reuses the existing copy unless the source length
/// changed, so flipping between documents stays cheap.
pub fn import_document<R: Runtime>(
    app: &tauri::AppHandle<R>,
    uri: &str,
) -> Result<ImportedDoc, String> {
    let fs = app.android_fs();
    let src = FsUri::from_uri(uri);

    let len = fs
        .get_len(&src)
        .map_err(|e| format!("无法读取文件大小：{e}"))?;
    if len > MAX_DOC_BYTES {
        return Err(format!(
            "文件过大，无法打开（{} MB，上限 {} MB）",
            len / (1024 * 1024),
            MAX_DOC_BYTES / (1024 * 1024)
        ));
    }

    let name = sanitize_name(&fs.get_name_or_last_path_segment(&src));
    let dir = docs_root(app)?.join(sha256_hex(uri));
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建导入目录：{e}"))?;
    let dest = dir.join(&name);

    let source_mtime = fs
        .get_info(&src)
        .ok()
        .and_then(|e| e.last_modified().duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());

    let cached = decide_reuse(&dir, &dest, source_mtime);

    if !cached {
        // Stream into a temporary file first: an interrupted copy must never
        // leave a half-written document where the reader expects a whole one.
        let tmp = dir.join(".importing");
        let mut reader = fs
            .open_file_readable(&src)
            .map_err(|e| format!("无法读取文件：{e}"))?;
        {
            let mut out = std::fs::File::create(&tmp).map_err(|e| format!("无法写入副本：{e}"))?;
            std::io::copy(&mut reader, &mut out).map_err(|e| format!("复制失败：{e}"))?;
        }
        std::fs::rename(&tmp, &dest).map_err(|e| format!("无法完成导入：{e}"))?;

        // Remember where it came from and what the source looked like, so a
        // later open can tell "unchanged" from "edited on another device".
        let _ = std::fs::write(dir.join(".origin"), uri);
        if let Some(mtime) = source_mtime {
            let _ = std::fs::write(dir.join(".source-mtime"), mtime.to_string());
        }
        let now = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = std::fs::write(dir.join(".imported-at"), now.to_string());

        // Best effort: pull in the images the document references. This only
        // works for directory-style grants, because a single document grant
        // cannot read siblings.
        if let Ok(text) = std::fs::read_to_string(&dest) {
            import_referenced_images(app, &src, &text, &dir);
        }
    }

    Ok(ImportedDoc {
        path: dest.to_string_lossy().into_owned(),
        name,
        cached,
    })
}

/// Decide whether the existing copy can be reused, re-importing only when that
/// cannot lose local edits.
///
/// The copy is the document the user edits, so the rules are deliberately
/// conservative:
///
/// - no copy yet → import;
/// - local copy edited since import → always keep it (never clobber work);
/// - copy untouched *and* the source changed → refresh from the source, which
///   is how an edit made on a computer reaches the phone;
/// - copy untouched and source unchanged → reuse;
/// - missing bookkeeping files (older import, or no timestamp from the
///   provider) → reuse the copy rather than risk overwriting it.
///
/// Consequence worth knowing: once the copy has been edited on the phone it is
/// considered authoritative forever, so a later edit of the original on a
/// computer will not be picked up. That is the intended trade-off — the
/// alternative silently discards the phone's work.
fn decide_reuse(dir: &Path, dest: &Path, source_mtime: Option<u64>) -> bool {
    if !dest.is_file() {
        return false;
    }
    let Ok(meta) = std::fs::metadata(dest) else {
        return true;
    };
    let Some(imported_at) = read_stamp(&dir.join(".imported-at")) else {
        return true;
    };
    let local_mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());

    // A second of slack absorbs filesystem timestamp granularity.
    let locally_edited = local_mtime
        .map(|local| local.abs_diff(imported_at) > 1)
        .unwrap_or(false);
    if locally_edited {
        return true;
    }

    match (source_mtime, read_stamp(&dir.join(".source-mtime"))) {
        (Some(current), Some(at_import)) => current <= at_import,
        _ => true,
    }
}

fn read_stamp(path: &Path) -> Option<u64> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// List every document imported so far, newest first.
pub fn list_imported<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<DirListing, String> {
    let root = docs_root(app)?;

    let mut items: Vec<(SystemTime, DirEntry)> = Vec::new();
    if let Ok(buckets) = std::fs::read_dir(&root) {
        for bucket in buckets.flatten() {
            let bucket_path = bucket.path();
            if !bucket_path.is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&bucket_path) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if !path.is_file() || !is_markdown(&path) {
                    continue;
                }
                let modified = file
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                items.push((
                    modified,
                    DirEntry {
                        name: file.file_name().to_string_lossy().into_owned(),
                        path: path.to_string_lossy().into_owned(),
                        is_dir: false,
                    },
                ));
            }
        }
    }

    items.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));

    Ok(DirListing {
        dir: "已导入的文档".to_string(),
        parent: None,
        entries: items.into_iter().map(|(_, e)| e).collect(),
    })
}

/// Copy the images a document references, when the grant lets us read them.
///
/// Silent on failure: a single-document grant covers exactly one file, so most
/// picker flows simply have nothing to copy here.
fn import_referenced_images<R: Runtime>(
    app: &tauri::AppHandle<R>,
    doc_uri: &FsUri,
    text: &str,
    dest_dir: &Path,
) {
    let refs = collect_relative_refs(text);
    if refs.is_empty() {
        return;
    }
    let fs = app.android_fs();
    // The containing folder is only resolvable for directory-style grants.
    let Ok(parent) = fs.resolve_dir_uri(doc_uri, "") else {
        return;
    };

    for rel in refs {
        let target = dest_dir.join(&rel);
        if target.exists() {
            continue;
        }
        let Ok(remote) = fs.resolve_file_uri(&parent, &rel) else {
            continue;
        };
        let Ok(mut reader) = fs.open_file_readable(&remote) else {
            continue;
        };
        if let Some(dir) = target.parent() {
            if std::fs::create_dir_all(dir).is_err() {
                continue;
            }
        }
        if let Ok(mut out) = std::fs::File::create(&target) {
            let _ = std::io::copy(&mut reader, &mut out);
        }
    }
}

/// Collect relative image paths referenced by `![alt](path)` and `src="path"`.
///
/// Deliberately a scan rather than a Markdown parse: this only decides which
/// files are worth copying, and a missed or extra entry is harmless.
fn collect_relative_refs(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    // ![alt](path "optional title")
    let mut cursor = 0usize;
    while let Some(at) = text[cursor..].find("](") {
        let start = cursor + at + 2;
        let Some(end) = text[start..].find(')') else {
            break;
        };
        let candidate = &text[start..start + end];
        // Drop the optional title: `tree.png "A tree"`.
        let path = candidate.split_whitespace().next().unwrap_or("");
        consider_ref(path, &mut out);
        cursor = start + end;
    }

    // <img src="...">
    let mut cursor = 0usize;
    while let Some(at) = text[cursor..].find("src=") {
        let start = cursor + at + 4;
        let rest = &text[start..];
        let quote = rest.chars().next().unwrap_or('"');
        if quote != '"' && quote != '\'' {
            cursor = start;
            continue;
        }
        let inner = &rest[1..];
        let Some(end) = inner.find(quote) else {
            break;
        };
        consider_ref(&inner[..end], &mut out);
        cursor = start + 1 + end;
    }

    out
}

fn consider_ref(raw: &str, out: &mut Vec<String>) {
    let raw = raw.trim();
    if raw.is_empty() || raw.starts_with('/') || raw.starts_with("//") || raw.contains("://") {
        return;
    }
    if raw.starts_with("data:") || raw.starts_with('#') {
        return;
    }
    // Strip a query string / fragment before matching the extension.
    let path = raw.split(['?', '#']).next().unwrap_or(raw);
    let lower = path.to_ascii_lowercase();
    if !IMAGE_EXTS.iter().any(|ext| lower.ends_with(&format!(".{ext}"))) {
        return;
    }
    let rel = path.trim_start_matches("./").to_string();
    if rel.is_empty() || rel.contains("..") {
        return;
    }
    if !out.iter().any(|seen| seen == &rel) {
        out.push(rel);
    }
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

/// Reduce a display name to a single safe path component.
///
/// SAF display names come from the providing app, so treat them as untrusted:
/// a name containing separators or `..` would otherwise escape the import
/// directory.
fn sanitize_name(name: &str) -> String {
    let tail = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    let cleaned: String = tail
        .chars()
        .map(|c| if c == '\0' || c.is_control() { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim_matches('.').trim();
    if cleaned.is_empty() {
        "Document.md".to_string()
    } else {
        cleaned.to_string()
    }
}

/// Stable directory key for a source URI.
fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
