//! Temporary files for pasted images and for attachments opened from a chat.
//!
//! A screenshot on the clipboard has no file behind it, but attachments are
//! uploaded from a path. Pasted images are therefore written to a scratch
//! folder first; files the user opens from a chat are downloaded into one too.
//! Both folders are swept of old files whenever something new is written.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

// Images, plus markdown/text for notes, chats and web pages attached as documents.
const IMAGE_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "md", "txt"];
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const KEEP_FOR: Duration = Duration::from_secs(24 * 60 * 60);

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn pasted_images_dir() -> PathBuf {
    std::env::temp_dir().join("opendesktopui-paste")
}

pub fn opened_files_dir() -> PathBuf {
    std::env::temp_dir().join("opendesktopui-files")
}

/// Writes pasted image bytes to `dir` and returns the new file's path. Only
/// image formats the chat accepts are allowed, and only up to 25 MB.
pub fn save_pasted_image(bytes: &[u8], extension: &str, dir: &Path) -> Result<PathBuf, String> {
    let extension = extension.trim().trim_start_matches('.').to_ascii_lowercase();
    if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!("`{extension}` is not a file type the chat accepts"));
    }
    if bytes.is_empty() {
        return Err("the pasted image was empty".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("the pasted image is larger than 25 MB".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    sweep(dir, KEEP_FOR);

    let millis = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("pasted-{millis}-{n}.{extension}"));
    std::fs::write(&path, bytes).map_err(|e| format!("could not save the image: {e}"))?;
    Ok(path)
}

/// Deletes files in `dir` (one level of sub-folders too) that haven't been
/// modified for `older_than`. Best effort: failures are ignored.
pub fn sweep(dir: &Path, older_than: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            sweep(&path, older_than);
            let _ = std::fs::remove_dir(&path); // only succeeds when empty
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .map_or(false, |age| age > older_than);
        if old {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// A file name that is safe to create inside a folder we own: no path
/// separators, no characters Windows forbids, no leading dots.
pub fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim().to_string();
    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned.chars().take(120).collect()
    }
}

/// A server file id as a folder name (ids are UUIDs; anything else is cleaned).
pub fn safe_id(id: &str) -> String {
    let cleaned: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_an_image_under_a_unique_name() {
        let dir = tempfile::tempdir().unwrap();
        let a = save_pasted_image(&[1, 2, 3], "PNG", dir.path()).unwrap();
        let b = save_pasted_image(&[1, 2, 3], ".png", dir.path()).unwrap();
        assert_ne!(a, b);
        assert_eq!(a.extension().unwrap(), "png");
        assert_eq!(std::fs::read(&a).unwrap(), vec![1, 2, 3]);
    }

    #[test]
    fn rejects_other_types_empty_and_oversized_images() {
        let dir = tempfile::tempdir().unwrap();
        assert!(save_pasted_image(&[1], "exe", dir.path()).is_err());
        assert!(save_pasted_image(&[1], "png/../x", dir.path()).is_err());
        assert!(save_pasted_image(&[], "png", dir.path()).is_err());
        assert!(save_pasted_image(&vec![0u8; MAX_IMAGE_BYTES + 1], "png", dir.path()).is_err());
    }

    #[test]
    fn sweeping_removes_only_old_files() {
        let dir = tempfile::tempdir().unwrap();
        let fresh = dir.path().join("fresh.png");
        std::fs::write(&fresh, [1]).unwrap();
        // nothing is older than a day yet
        sweep(dir.path(), KEEP_FOR);
        assert!(fresh.exists());
        // with a zero limit everything counts as old
        std::thread::sleep(Duration::from_millis(20));
        sweep(dir.path(), Duration::from_millis(1));
        assert!(!fresh.exists());
    }

    #[test]
    fn file_names_cannot_escape_the_folder() {
        assert_eq!(safe_file_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_file_name("a:b*c?.pdf"), "a_b_c_.pdf");
        assert_eq!(safe_file_name("  ...hidden  "), "hidden");
        assert_eq!(safe_file_name(""), "file");
        assert_eq!(safe_id("3f2a-9c../x"), "3f2a-9cx");
    }
}
