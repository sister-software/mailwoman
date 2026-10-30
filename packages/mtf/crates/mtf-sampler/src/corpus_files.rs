// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! List the parquet files of a corpus split, with the row filter each file's rows pass, and count rows per source.
//!
//! A manifest lists a `path`, `split` and `sha256` per file. An overlay manifest also lists files of its base corpus,
//! and a manifest built on the training volume lists paths under the volume mount. Each path is used as-is when it
//! exists, then as its host copy under the data root, then re-rooted under the corpus directory. Every resolved file
//! is hashed against its listed sha256 once per process, and an unresolvable or mismatched file is an error rather
//! than a smaller corpus.
//!
//! A file with a split attribute holds every split's rows; the attribute's held-out id sets decide each row by its
//! `source_id`. The manifest's `deletions[]` remove further ids. Both become a [`RowFilter`].

use crate::columns::{column, StrColumn};
use crate::config::SamplerConfig;
use crate::error::{Error, Result};
use crate::parquet_file::ParquetFile;
use crate::sha256_cache;
use rustc_hash::{FxHashMap, FxHashSet};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// The retired manifest keys older corpora use for their parquet file list, newest first. Built corpora are
/// immutable, so the reader accepts every key and the writer emits only `files`. The keys are concatenated because
/// the repository's vocabulary checks ban both words.
const RETIRED_MANIFEST_KEYS: [&str; 2] = ["sl\u{69}ces", "sh\u{61}rds"];

/// The directory the corpus build writes single-source files under, beside the corpus version directories.
const STORE_DIR: &str = "store";

/// The suffix of the record a corpus writer puts beside each parquet file: `data.parquet` has `data.RECORD.json`.
const RECORD_SUFFIX: &str = ".RECORD.json";

/// A set of `source_id` values.
pub type IdSet = FxHashSet<Box<str>>;

/// The rows of one file a split reads, decided by each row's `source_id`.
///
/// `keep`, when set, holds the only ids the split reads. Each set in `drop` removes its ids. A row with a null
/// `source_id` is never admitted by a filter, as Arrow's `is_in` gave it a null mask entry.
#[derive(Debug, Default)]
pub struct RowFilter {
	pub keep: Option<Arc<IdSet>>,
	pub drop: Vec<Arc<IdSet>>,
}

impl RowFilter {
	pub fn admits(&self, source_id: Option<&str>) -> bool {
		let Some(id) = source_id else {
			return false;
		};
		self.keep.as_ref().is_none_or(|keep| keep.contains(id)) && !self.drop.iter().any(|d| d.contains(id))
	}
}

/// One parquet file of a split, with the filter its rows pass, or `None` when the split reads every row.
#[derive(Debug, Clone)]
pub struct CorpusFile {
	pub path: PathBuf,
	pub filter: Option<Arc<RowFilter>>,
}

/// The hex sha256 of a file, read in 8 MiB chunks.
pub fn file_sha256(path: &Path) -> Result<String> {
	let mut file = std::fs::File::open(path).map_err(|e| Error::Io(format!("{}: {e}", path.display())))?;
	let mut digest = Sha256::new();
	let mut buffer = vec![0u8; 8 << 20];
	loop {
		let read = file
			.read(&mut buffer)
			.map_err(|e| Error::Io(format!("{}: {e}", path.display())))?;
		if read == 0 {
			break;
		}
		digest.update(&buffer[..read]);
	}
	Ok(digest.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// The files this process has already verified, keyed by path and the digest the manifest lists.
fn verified() -> &'static Mutex<HashSet<(PathBuf, String)>> {
	static VERIFIED: OnceLock<Mutex<HashSet<(PathBuf, String)>>> = OnceLock::new();
	VERIFIED.get_or_init(Default::default)
}

/// The number of files hashed at once.
const HASH_THREADS: usize = 4;

/// Verifies each file against the sha256 its manifest entry lists, hashing the unverified ones in parallel.
///
/// An entry with no sha256 is an error: a file the manifest cannot vouch for is not one the loader can tell apart
/// from a file rewritten in place. Digests measured here are recorded in the sha256 cache when one is configured.
pub fn verify_sha256s(files: &[(PathBuf, Option<String>)], cache_path: Option<&Path>) -> Result<()> {
	let mut pending: Vec<(usize, &Path)> = Vec::new();
	let mut actual: Vec<Option<String>> = vec![None; files.len()];
	let entries = cache_path.map(sha256_cache::load_entries).unwrap_or_default();
	{
		let done = verified().lock().expect("the verified set is never poisoned");
		for (index, (path, expected)) in files.iter().enumerate() {
			let Some(expected) = expected.as_deref().filter(|e| !e.is_empty()) else {
				return Err(Error::Input(format!(
					"MANIFEST lists {} with no sha256, so its bytes cannot be verified",
					path.display()
				)));
			};
			if done.contains(&(path.clone(), expected.to_owned())) {
				actual[index] = Some(expected.to_owned());
				continue;
			}
			match sha256_cache::entry_digest(&entries, path)? {
				Some(digest) => actual[index] = Some(digest),
				None => pending.push((index, path)),
			}
		}
	}
	let measured: Vec<(usize, Result<String>)> = std::thread::scope(|scope| {
		let chunks: Vec<Vec<(usize, &Path)>> = (0..HASH_THREADS)
			.map(|t| pending.iter().skip(t).step_by(HASH_THREADS).copied().collect())
			.collect();
		let handles: Vec<_> = chunks
			.into_iter()
			.map(|chunk| scope.spawn(move || chunk.into_iter().map(|(i, p)| (i, file_sha256(p))).collect::<Vec<_>>()))
			.collect();
		handles
			.into_iter()
			.flat_map(|h| h.join().expect("a hashing thread panicked"))
			.collect()
	});
	let mut recorded = Vec::new();
	for (index, digest) in measured {
		let digest = digest?;
		recorded.push((files[index].0.as_path(), digest.clone()));
		actual[index] = Some(digest);
	}
	if let Some(cache) = cache_path {
		let pairs: Vec<(&Path, &str)> = recorded.iter().map(|(p, d)| (*p, d.as_str())).collect();
		sha256_cache::record_sha256s(cache, &pairs)?;
	}
	let mut done = verified().lock().expect("the verified set is never poisoned");
	for ((path, expected), digest) in files.iter().zip(actual) {
		let expected = expected.as_deref().expect("checked above");
		let digest = digest.expect("every file was looked up or hashed");
		if digest != expected {
			return Err(Error::Input(format!(
				"{} hashes to sha256 {digest} and MANIFEST lists {expected}",
				path.display()
			)));
		}
		done.insert((path.clone(), expected.to_owned()));
	}
	Ok(())
}

/// The manifest's parquet file list from the `files` key or a retired key; the first non-empty list wins.
pub fn manifest_files(data: &Value) -> Vec<Value> {
	for key in std::iter::once("files").chain(RETIRED_MANIFEST_KEYS) {
		if let Some(Value::Array(listed)) = data.get(key) {
			if !listed.is_empty() {
				return listed.clone();
			}
		}
	}
	Vec::new()
}

fn exists(path: &Path) -> bool {
	path.exists()
}

fn parts(path: &Path) -> Vec<String> {
	path.components()
		.map(|c| match c {
			Component::RootDir => "/".to_owned(),
			other => other.as_os_str().to_string_lossy().into_owned(),
		})
		.collect()
}

fn join_parts(base: &Path, parts: &[String]) -> PathBuf {
	let mut out = base.to_owned();
	for part in parts {
		out.push(part);
	}
	out
}

/// Maps a stale manifest path to an existing local file.
///
/// The path segment before `<split>` identifies the corpus that owns the file: when it is this corpus the
/// `<split>/<file>` tail is joined under `corpus_dir`, and when it is another corpus, such as an overlay's base, the
/// `<corpus>/<split>/<file>` tail is joined under the parent of `corpus_dir`. Part files are numbered by position, so a
/// base part and an overlay part can share a file name, and re-rooting on the name alone would read the wrong one.
pub fn reroot(raw: &Path, corpus_dir: &Path, split: &str) -> Option<PathBuf> {
	let parts = parts(raw);
	let parent = corpus_dir.parent().unwrap_or(Path::new(""));
	if let Some(store) = parts.iter().position(|p| p == STORE_DIR) {
		let cand = join_parts(parent, &parts[store..]);
		return exists(&cand).then_some(cand);
	}
	let Some(at) = parts.iter().position(|p| p == split) else {
		let cand = corpus_dir.join(split).join(raw.file_name()?);
		return exists(&cand).then_some(cand);
	};
	let corpus_name = corpus_dir.file_name().map(|n| n.to_string_lossy().into_owned());
	let cand = if at == 0 || parts[at - 1] == split || Some(&parts[at - 1]) == corpus_name.as_ref() {
		join_parts(corpus_dir, &parts[at..])
	} else {
		join_parts(parent, &parts[at - 1..])
	};
	exists(&cand).then_some(cand)
}

/// Resolves a sidecar path a manifest lists: as-is, under the data root's copy of the volume mount, or under
/// `corpus_dir/<directory>`.
fn resolve_sidecar(raw: &str, corpus_dir: &Path, directory: &str, config: &SamplerConfig) -> Result<PathBuf> {
	let path = PathBuf::from(raw);
	if exists(&path) {
		return Ok(path);
	}
	if let Some(mirrored) = config.volume_path_on_host(&path) {
		if exists(&mirrored) {
			return Ok(mirrored);
		}
	}
	let within = if directory.is_empty() {
		corpus_dir.to_owned()
	} else {
		corpus_dir.join(directory)
	};
	if let Some(name) = path.file_name() {
		let cand = within.join(name);
		if exists(&cand) {
			return Ok(cand);
		}
	}
	Err(Error::Input(format!(
		"MANIFEST lists sidecar {raw}, absent as-is, under the data root's copy of the volume mount, and under {}",
		within.display()
	)))
}

/// The distinct `source_id` values of a sidecar parquet.
fn read_id_column(path: &Path) -> Result<IdSet> {
	let file = ParquetFile::open(path)?;
	let mut out = IdSet::default();
	for batch in file.batches(&["source_id"], 65_536)? {
		let batch = batch?;
		let ids = StrColumn::new(column(&batch, "source_id", path)?, "source_id")?;
		for i in 0..ids.len() {
			if let Some(id) = ids.get(i) {
				out.insert(id.into());
			}
		}
	}
	Ok(out)
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
	value.get(key).and_then(Value::as_str)
}

/// One deletion's `source_id` set, inline or from its verified sidecar.
fn deletion_ids(deletion: &Value, corpus_dir: &Path, config: &SamplerConfig) -> Result<IdSet> {
	let inline = deletion.get("source_ids").filter(|v| !v.is_null());
	let sidecar = deletion.get("source_ids_file").filter(|v| !v.is_null());
	match (inline, sidecar) {
		// A non-array, or an entry that is not a string, would otherwise read as fewer deletions than the manifest lists.
		(Some(ids), None) => ids
			.as_array()
			.ok_or_else(|| Error::Input(format!("MANIFEST deletion source_ids is {ids}, not an array")))?
			.iter()
			.map(|id| {
				id.as_str()
					.map(Into::into)
					.ok_or_else(|| Error::Input(format!("MANIFEST deletion source_ids holds {id}, not a string")))
			})
			.collect(),
		(None, Some(sidecar)) => {
			let raw = str_field(sidecar, "path")
				.ok_or_else(|| Error::Input("MANIFEST deletion sidecar has no path".into()))?;
			let path = resolve_sidecar(raw, corpus_dir, "deletions", config)?;
			verify_sha256s(
				&[(path.clone(), str_field(sidecar, "sha256").map(str::to_owned))],
				config.sha256_cache_path.as_deref(),
			)?;
			let ids = read_id_column(&path)?;
			if Some(ids.len() as u64) != sidecar.get("ids").and_then(Value::as_u64) {
				return Err(Error::Input(format!(
					"{} holds {} source_ids and MANIFEST records {}",
					path.display(),
					ids.len(),
					sidecar.get("ids").unwrap_or(&Value::Null)
				)));
			}
			Ok(ids)
		}
		_ => Err(Error::Input(format!(
			"MANIFEST deletion {} must give source_ids or source_ids_file, not both",
			deletion.get("issue").unwrap_or(&Value::Null)
		))),
	}
}

/// Whether a deletion's target names this manifest entry, by its listed path or its source.
fn deletion_targets(target: &Value, entry: &Value) -> bool {
	if let Some(path) = target.get("path") {
		return Some(path) == entry.get("path");
	}
	target.get("source").filter(|v| !v.is_null()) == entry.get("source").filter(|v| !v.is_null())
		&& target.get("source").is_some_and(|v| !v.is_null())
}

/// The held-out id sets of one split attribute.
struct HeldOut {
	val: Arc<IdSet>,
	test: Arc<IdSet>,
}

/// Split attributes parsed in this process, keyed by path and sha256. A run lists its splits several times, and
/// each attribute holds up to hundreds of thousands of ids.
type AttributeCache = FxHashMap<(PathBuf, String), Arc<HeldOut>>;

fn attribute_cache() -> &'static Mutex<AttributeCache> {
	static CACHE: OnceLock<Mutex<AttributeCache>> = OnceLock::new();
	CACHE.get_or_init(Default::default)
}

#[derive(serde::Deserialize)]
struct AttributeFile {
	attribute: Option<String>,
	#[serde(rename = "policyHash")]
	policy_hash: Option<String>,
	file: AttributeTarget,
	val: Vec<String>,
	test: Vec<String>,
}

#[derive(serde::Deserialize)]
struct AttributeTarget {
	sha256: Option<String>,
}

/// Reads and verifies the split attribute a manifest entry names. The attribute's sha256 must match the entry, and the
/// data file it describes must be the entry's file, or each row's split would come from a decision about other bytes.
fn split_attribute(entry: &Value, corpus_dir: &Path, config: &SamplerConfig) -> Result<Arc<HeldOut>> {
	let reference = &entry["split_attribute"];
	let raw = str_field(reference, "path").ok_or_else(|| Error::Input("split_attribute has no path".into()))?;
	let path = resolve_sidecar(raw, corpus_dir, "", config)?;
	let sha = str_field(reference, "sha256").map(str::to_owned);
	let key = (path.clone(), sha.clone().unwrap_or_default());
	if let Some(found) = attribute_cache().lock().expect("not poisoned").get(&key) {
		return Ok(found.clone());
	}
	verify_sha256s(&[(path.clone(), sha)], config.sha256_cache_path.as_deref())?;
	let text = std::fs::read_to_string(&path).map_err(|e| Error::Io(format!("{}: {e}", path.display())))?;
	let attribute: AttributeFile =
		serde_json::from_str(&text).map_err(|e| Error::Input(format!("{}: {e}", path.display())))?;
	let policy = str_field(reference, "policy_hash");
	if attribute.attribute.as_deref() != Some("split") || attribute.policy_hash.as_deref() != policy {
		return Err(Error::Input(format!(
			"{} is not the split attribute under policy {}",
			path.display(),
			policy.unwrap_or("None")
		)));
	}
	if attribute.file.sha256.as_deref() != str_field(entry, "sha256") {
		return Err(Error::Input(format!(
			"{} describes sha256 {} and MANIFEST lists {}",
			path.display(),
			attribute.file.sha256.as_deref().unwrap_or("None"),
			str_field(entry, "sha256").unwrap_or("None")
		)));
	}
	let held = Arc::new(HeldOut {
		val: Arc::new(attribute.val.into_iter().map(Into::into).collect()),
		test: Arc::new(attribute.test.into_iter().map(Into::into).collect()),
	});
	attribute_cache()
		.lock()
		.expect("not poisoned")
		.insert(key, held.clone());
	Ok(held)
}

/// The directory-glob listing of a corpus with no manifest file list, each file verified against its record.
fn glob_split(corpus_dir: &Path, split: &str, config: &SamplerConfig) -> Result<Vec<PathBuf>> {
	let dir = corpus_dir.join(split);
	// A missing directory lists no file and is refused below with the corpus's own message. Any other failure to read
	// the directory or one of its entries is reported, because a partial listing would sample from fewer files.
	let entries = match std::fs::read_dir(&dir) {
		Ok(entries) => entries
			.map(|entry| entry.map(|e| e.path()))
			.collect::<std::io::Result<Vec<_>>>()
			.map_err(|e| Error::Input(format!("{}: {e}", dir.display())))?,
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
		Err(e) => return Err(Error::Input(format!("{}: {e}", dir.display()))),
	};
	let mut paths: Vec<PathBuf> = entries
		.into_iter()
		.filter(|p| {
			let name = p
				.file_name()
				.map(|n| n.to_string_lossy().into_owned())
				.unwrap_or_default();
			!name.starts_with('.') && name.ends_with(".parquet")
		})
		.collect();
	paths.sort();
	if paths.is_empty() {
		return Err(Error::Input(format!(
			"no parquet files via MANIFEST or {}",
			dir.display()
		)));
	}
	let mut listed = Vec::with_capacity(paths.len());
	for path in &paths {
		let name = path.file_name().expect("a listed file").to_string_lossy();
		let record = path.with_file_name(format!("{}{RECORD_SUFFIX}", name.trim_end_matches(".parquet")));
		if !exists(&record) {
			return Err(Error::Input(format!(
				"{} is listed by no MANIFEST and has no {} beside it, so its bytes cannot be verified",
				path.display(),
				record.file_name().expect("named").to_string_lossy()
			)));
		}
		let text = std::fs::read_to_string(&record).map_err(|e| Error::Io(format!("{}: {e}", record.display())))?;
		let value: Value =
			serde_json::from_str(&text).map_err(|e| Error::Input(format!("{}: {e}", record.display())))?;
		listed.push((path.clone(), str_field(&value, "sha256").map(str::to_owned)));
	}
	verify_sha256s(&listed, config.sha256_cache_path.as_deref())?;
	Ok(paths)
}

/// Resolves and verifies the manifest entries of one split. Any declared entry that resolves to no file is an error.
fn manifest_split_entries(
	files: &[Value],
	corpus_dir: &Path,
	split: &str,
	config: &SamplerConfig,
) -> Result<Vec<(PathBuf, Value)>> {
	let mut resolved = Vec::new();
	let mut missing = Vec::new();
	let mut declared = 0usize;
	for entry in files {
		let attributed = entry.get("split_attribute").is_some();
		if str_field(entry, "split") != Some(split) && !attributed {
			continue;
		}
		declared += 1;
		let raw = PathBuf::from(str_field(entry, "path").unwrap_or_default());
		if exists(&raw) {
			resolved.push((raw, entry.clone()));
			continue;
		}
		if let Some(mirrored) = config.volume_path_on_host(&raw) {
			if exists(&mirrored) {
				resolved.push((mirrored, entry.clone()));
				continue;
			}
		}
		let beside = attributed
			.then(|| raw.file_name().map(|n| corpus_dir.join(n)))
			.flatten()
			.filter(|c| exists(c));
		match beside.or_else(|| reroot(&raw, corpus_dir, split)) {
			Some(cand) => resolved.push((cand, entry.clone())),
			None => missing.push(raw.display().to_string()),
		}
	}
	if !missing.is_empty() {
		let mut listing = missing.iter().take(10).cloned().collect::<Vec<_>>().join("\n  ");
		if missing.len() > 10 {
			listing.push_str("\n  ...");
		}
		return Err(Error::Input(format!(
			"MANIFEST declares {declared} '{split}' parquet files but {} are unresolvable (as-is, under the data \
			 root's copy of the volume mount, AND re-rooted under {}):\n  {listing}",
			missing.len(),
			corpus_dir.display()
		)));
	}
	let listed: Vec<(PathBuf, Option<String>)> = resolved
		.iter()
		.map(|(p, e)| (p.clone(), str_field(e, "sha256").map(str::to_owned)))
		.collect();
	verify_sha256s(&listed, config.sha256_cache_path.as_deref())?;
	Ok(resolved)
}

/// The parquet files of one split, sorted by path, each with the row filter the manifest sets.
pub fn corpus_split_files(config: &SamplerConfig, split: &str) -> Result<Vec<CorpusFile>> {
	let corpus_dir = &config.corpus_dir;
	let manifest = corpus_dir.join("MANIFEST.json");
	let data: Value = if exists(&manifest) {
		let text = std::fs::read_to_string(&manifest).map_err(|e| Error::Io(format!("{}: {e}", manifest.display())))?;
		serde_json::from_str(&text).map_err(|e| Error::Input(format!("{}: {e}", manifest.display())))?
	} else {
		Value::Object(Default::default())
	};
	let files = manifest_files(&data);
	if files.is_empty() {
		return Ok(glob_split(corpus_dir, split, config)?
			.into_iter()
			.map(|path| CorpusFile { path, filter: None })
			.collect());
	}
	let entries = manifest_split_entries(&files, corpus_dir, split, config)?;
	if entries.is_empty() {
		return Err(Error::Input(format!(
			"{} lists no '{split}' parquet file",
			manifest.display()
		)));
	}
	let mut deletions = Vec::new();
	if let Some(Value::Array(listed)) = data.get("deletions") {
		for deletion in listed {
			deletions.push((
				deletion["target"].clone(),
				Arc::new(deletion_ids(deletion, corpus_dir, config)?),
			));
		}
	}
	let mut out = Vec::with_capacity(entries.len());
	for (path, entry) in entries {
		let mut drop: Vec<Arc<IdSet>> = deletions
			.iter()
			.filter(|(target, ids)| deletion_targets(target, &entry) && !ids.is_empty())
			.map(|(_, ids)| ids.clone())
			.collect();
		let mut keep = None;
		if entry.get("split_attribute").is_some() {
			let held = split_attribute(&entry, corpus_dir, config)?;
			match split {
				"train" => drop.extend(
					[held.val.clone(), held.test.clone()]
						.into_iter()
						.filter(|s| !s.is_empty()),
				),
				"val" => keep = Some(held.val.clone()),
				"test" => keep = Some(held.test.clone()),
				other => {
					return Err(Error::Input(format!(
						"{}: a split attribute holds train, val and test, not {other:?}",
						path.display()
					)))
				}
			}
		}
		let filter = (!drop.is_empty() || keep.is_some()).then(|| Arc::new(RowFilter { keep, drop }));
		out.push(CorpusFile { path, filter });
	}
	out.sort_by(|a, b| a.path.cmp(&b.path));
	Ok(out)
}

/// The rows per source of one file over the rows its filter admits, in the order each source first appears.
///
/// A null `source` among the admitted rows is an error: the known cause is a label-less golden file listed as a
/// training file.
pub fn file_source_counts(file: &CorpusFile) -> Result<Vec<(String, u64)>> {
	let key = CountsKey::of(file);
	if let Some(found) = counts_cache().lock().expect("not poisoned").get(&key) {
		return Ok(found.clone());
	}
	let counted = count_sources(file)?;
	counts_cache()
		.lock()
		.expect("not poisoned")
		.insert(key, counted.clone());
	Ok(counted)
}

/// One file's rows per source in first-appearance order, or the failure to count them.
pub type SourceCounts = Result<Vec<(String, u64)>>;

/// A file's path and the id sets its filter reads.
///
/// Each listing builds a new `RowFilter`, but its id sets are shared `Arc`s from the split-attribute cache, so two
/// listings with the same split share them. The key holds those `Arc`s, which keeps each set's address unique while
/// its entry exists, and compares them by address, so equal sets are recognized without hashing their ids.
struct CountsKey {
	path: PathBuf,
	keep: Option<Arc<IdSet>>,
	drop: Vec<Arc<IdSet>>,
}

impl CountsKey {
	fn of(file: &CorpusFile) -> Self {
		let (keep, drop) = file
			.filter
			.as_ref()
			.map_or((None, Vec::new()), |filter| (filter.keep.clone(), filter.drop.clone()));
		Self {
			path: file.path.clone(),
			keep,
			drop,
		}
	}

	fn addresses(&self) -> (Option<*const IdSet>, Vec<*const IdSet>) {
		(
			self.keep.as_ref().map(Arc::as_ptr),
			self.drop.iter().map(Arc::as_ptr).collect(),
		)
	}
}

impl PartialEq for CountsKey {
	fn eq(&self, other: &Self) -> bool {
		self.path == other.path && self.addresses() == other.addresses()
	}
}

impl Eq for CountsKey {}

impl std::hash::Hash for CountsKey {
	fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
		self.path.hash(state);
		self.addresses().hash(state);
	}
}

/// Counts are cached only when they succeed, so a failed read is retried rather than replayed for the process.
type CountsCache = FxHashMap<CountsKey, Vec<(String, u64)>>;

/// Source counts computed in this process, keyed by path and the id sets the file's filter reads.
fn counts_cache() -> &'static Mutex<CountsCache> {
	static CACHE: OnceLock<Mutex<CountsCache>> = OnceLock::new();
	CACHE.get_or_init(Default::default)
}

fn count_sources(file: &CorpusFile) -> Result<Vec<(String, u64)>> {
	let parquet = ParquetFile::open(&file.path)?;
	let columns: &[&str] = if file.filter.is_some() {
		&["source", "source_id"]
	} else {
		&["source"]
	};
	let mut order: Vec<(String, u64)> = Vec::new();
	let mut index: FxHashMap<String, usize> = FxHashMap::default();
	for batch in parquet.batches(columns, 65_536)? {
		let batch = batch?;
		let sources = StrColumn::new(column(&batch, "source", &file.path)?, "source")?;
		let ids = match &file.filter {
			Some(_) => Some(StrColumn::new(column(&batch, "source_id", &file.path)?, "source_id")?),
			None => None,
		};
		for i in 0..sources.len() {
			if let (Some(filter), Some(ids)) = (&file.filter, &ids) {
				if !filter.admits(ids.get(i)) {
					continue;
				}
			}
			let source = sources.get(i).ok_or_else(|| {
				Error::Input(format!(
					"{}: a source column cell is null, expected a string",
					file.path.display()
				))
			})?;
			match index.get(source) {
				Some(&at) => order[at].1 += 1,
				None => {
					index.insert(source.to_owned(), order.len());
					order.push((source.to_owned(), 1));
				}
			}
		}
	}
	Ok(order)
}

/// Source counts for many files, computed four files at a time and returned in the files' order.
pub fn files_source_counts(files: &[CorpusFile]) -> Vec<SourceCounts> {
	let next = std::sync::atomic::AtomicUsize::new(0);
	let results: Mutex<Vec<Option<SourceCounts>>> = Mutex::new(vec![None; files.len()]);
	std::thread::scope(|scope| {
		for _ in 0..HASH_THREADS {
			scope.spawn(|| loop {
				let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
				if i >= files.len() {
					break;
				}
				let counted = file_source_counts(&files[i]);
				results.lock().expect("not poisoned")[i] = Some(counted);
			});
		}
	});
	results
		.into_inner()
		.expect("not poisoned")
		.into_iter()
		.map(|r| r.expect("every file was counted"))
		.collect()
}

/// Rows per source across every file of a split, which `source_reps` and the epoch audit divide by.
pub fn source_row_counts(config: &SamplerConfig, split: &str) -> Result<Vec<(String, u64)>> {
	let files = corpus_split_files(config, split)?;
	let mut out: Vec<(String, u64)> = Vec::new();
	for (file, counted) in files.iter().zip(files_source_counts(&files)) {
		let counted =
			counted.map_err(|e| Error::Input(format!("counting the sources of {}: {e}", file.path.display())))?;
		for (source, rows) in counted {
			match out.iter_mut().find(|(s, _)| *s == source) {
				Some(entry) => entry.1 += rows,
				None => out.push((source, rows)),
			}
		}
	}
	Ok(out)
}
