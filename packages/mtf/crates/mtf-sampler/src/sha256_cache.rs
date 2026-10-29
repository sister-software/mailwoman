// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! A sidecar that remembers each file's sha256 by path, size and modification time, across processes.
//!
//! The loader verifies every corpus file against its manifest sha256. A corpus on the training volume holds hundreds
//! of files and tens of gigabytes, so the CPU preflight hashes each file once and records the digest here, and a
//! later process reuses an entry whose size and `mtime_ns` still match. A rewrite changes the size or the
//! modification time, so a stale entry cannot pass a rewritten file. The file format is the one the Python loader
//! wrote: `{"version": 1, "entries": {path: {"size", "mtime_ns", "sha256"}}}` with sorted keys.

use crate::error::{Error, Result};
use serde_json::{json, Map, Value};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// Bumped when an entry's shape changes, so an old sidecar is ignored rather than misread.
pub const CACHE_VERSION: u64 = 1;

fn stat_key(path: &Path) -> Result<(u64, i128)> {
	let meta = std::fs::metadata(path).map_err(|e| Error::Io(format!("{}: {e}", path.display())))?;
	Ok((
		meta.size(),
		i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec()),
	))
}

fn load(cache_path: &Path) -> Map<String, Value> {
	let Ok(text) = std::fs::read_to_string(cache_path) else {
		return Map::new();
	};
	let Ok(Value::Object(data)) = serde_json::from_str::<Value>(&text) else {
		return Map::new();
	};
	if data.get("version").and_then(Value::as_u64) != Some(CACHE_VERSION) {
		return Map::new();
	}
	match data.get("entries") {
		Some(Value::Object(entries)) => entries.clone(),
		_ => Map::new(),
	}
}

/// The sha256 recorded for `path` when its size and mtime still match the entry.
pub fn cached_sha256(cache_path: &Path, path: &Path) -> Result<Option<String>> {
	entry_digest(&load(cache_path), path)
}

/// The cache's entries read once, for a caller that looks up many files.
pub fn load_entries(cache_path: &Path) -> Map<String, Value> {
	load(cache_path)
}

/// Whether an entry read by `load_entries` still describes `path`, and its digest when it does.
pub fn entry_digest(entries: &Map<String, Value>, path: &Path) -> Result<Option<String>> {
	let Some(entry) = entries.get(&path.to_string_lossy().into_owned()) else {
		return Ok(None);
	};
	let (size, mtime_ns) = stat_key(path)?;
	let matches = entry.get("size").and_then(Value::as_u64) == Some(size)
		&& entry.get("mtime_ns").and_then(|v| v.as_i64().map(i128::from)) == Some(mtime_ns);
	Ok(matches
		.then(|| entry.get("sha256").and_then(Value::as_str).map(str::to_owned))
		.flatten())
}

/// Records measured digests, merging with whatever another process wrote since, through an atomic rename.
pub fn record_sha256s(cache_path: &Path, measured: &[(&Path, &str)]) -> Result<()> {
	if measured.is_empty() {
		return Ok(());
	}
	let mut entries = load(cache_path);
	for &(path, digest) in measured {
		let (size, mtime_ns) = stat_key(path)?;
		entries.insert(
			path.to_string_lossy().into_owned(),
			json!({"mtime_ns": mtime_ns as i64, "sha256": digest, "size": size}),
		);
	}
	let parent = cache_path.parent().unwrap_or(Path::new("."));
	std::fs::create_dir_all(parent).map_err(|e| Error::Io(format!("{}: {e}", parent.display())))?;
	// serde_json's map is a BTreeMap, so the entries serialize with sorted keys, as Python's `sort_keys=True` wrote.
	let mut document = Map::new();
	document.insert("entries".into(), Value::Object(entries));
	document.insert("version".into(), json!(CACHE_VERSION));
	let name = cache_path
		.file_name()
		.and_then(|n| n.to_str())
		.unwrap_or("sha256-cache");
	let temporary = parent.join(format!(".{name}.{}.tmp", std::process::id()));
	let text = serde_json::to_string(&Value::Object(document)).map_err(|e| Error::Io(e.to_string()))?;
	let written = std::fs::write(&temporary, text).and_then(|()| std::fs::rename(&temporary, cache_path));
	if let Err(e) = written {
		let _ = std::fs::remove_file(&temporary);
		return Err(Error::Io(format!("{}: {e}", cache_path.display())));
	}
	Ok(())
}
