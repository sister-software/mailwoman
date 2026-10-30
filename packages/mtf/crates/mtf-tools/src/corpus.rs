// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The corpus reads the tokenizer tools make: the train split's files, the balanced raw sample a tokenizer trains on,
//! the mined postcode literals, the per-piece use counts, and the random row sample the prune check encodes.
//!
//! Every draw comes from [`PyRandom`], at the point the Python tools drew, so a sample here is the one the Python
//! tools took for the same corpus and seed.

use crate::args::Result;
use mtf_core::Processor;
use mtf_sampler::columns::{column, StrColumn, StrListColumn};
use mtf_sampler::corpus_files::{manifest_files, reroot};
use mtf_sampler::parquet_file::ParquetFile;
use mtf_sampler::pyrandom::{PyRandom, Seed};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const BATCH_ROWS: usize = 65_536;

/// The path's `/`-separated parts, the key Python's `sorted` orders `pathlib.Path` values by.
fn python_path_key(path: &Path) -> Vec<String> {
	path.to_string_lossy().split('/').map(str::to_owned).collect()
}

/// One train file: the path read, and the SHA-256 the manifest records for it.
pub struct TrainFile {
	pub path: PathBuf,
	pub sha256: Option<String>,
}

/// The train split's parquet paths, as `tokenizer/train.py`'s `iter_train_files` listed them.
pub fn train_files(corpus_dir: &Path) -> Result<Vec<PathBuf>> {
	Ok(train_file_records(corpus_dir)?.into_iter().map(|f| f.path).collect())
}

/// The train split's parquet files, as `tokenizer/train.py`'s `iter_train_files` listed them.
///
/// The manifest's `split == "train"` entries win, sorted as Python sorts paths. A corpus with no such entry falls back
/// to `train/*.parquet`. A listed path that does not exist on this host, such as a training volume's `/data/...` path,
/// is re-rooted under the corpus directory the way the sampler re-roots it; the order stays the listed paths' order.
pub fn train_file_records(corpus_dir: &Path) -> Result<Vec<TrainFile>> {
	let manifest = corpus_dir.join("MANIFEST.json");
	if manifest.exists() {
		let text = std::fs::read_to_string(&manifest).map_err(|e| format!("{}: {e}", manifest.display()))?;
		let data: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", manifest.display()))?;
		let mut files: Vec<TrainFile> = manifest_files(&data)
			.iter()
			.filter(|entry| entry.get("split").and_then(Value::as_str) == Some("train"))
			.map(|entry| {
				let path = entry
					.get("path")
					.and_then(Value::as_str)
					.map(PathBuf::from)
					.ok_or_else(|| format!("{}: a train entry has no path", manifest.display()))?;
				let sha256 = entry.get("sha256").and_then(Value::as_str).map(str::to_owned);
				Ok(TrainFile { path, sha256 })
			})
			.collect::<Result<_>>()?;
		if !files.is_empty() {
			files.sort_by_cached_key(|f| python_path_key(&f.path));
			for file in &mut files {
				if !file.path.exists() {
					if let Some(local) = reroot(&file.path, corpus_dir, "train") {
						file.path = local;
					}
				}
			}
			return Ok(files);
		}
	}
	let train_dir = corpus_dir.join("train");
	let mut files: Vec<PathBuf> = std::fs::read_dir(&train_dir)
		.map(|entries| {
			entries
				.filter_map(|e| e.ok().map(|e| e.path()))
				.filter(|p| p.extension().is_some_and(|x| x == "parquet") && p.is_file())
				.collect()
		})
		.unwrap_or_default();
	if files.is_empty() {
		return Err(format!("no parquet files via MANIFEST.json or {}", train_dir.display()));
	}
	files.sort_by_cached_key(|p| python_path_key(p));
	Ok(files.into_iter().map(|path| TrainFile { path, sha256: None }).collect())
}

fn open(path: &Path) -> Result<ParquetFile> {
	ParquetFile::open(path).map_err(|e| e.to_string())
}

/// Calls `visit` with each row's `raw` whose `country` is `country`, in file and row order.
fn each_raw_of_country(files: &[PathBuf], country: &str, visit: &mut dyn FnMut(&str) -> Result<()>) -> Result<()> {
	for path in files {
		let file = open(path)?;
		for batch in file
			.batches(&["raw", "country"], BATCH_ROWS)
			.map_err(|e| e.to_string())?
		{
			let batch = batch.map_err(|e| e.to_string())?;
			let raws = StrColumn::new(column(&batch, "raw", path).map_err(|e| e.to_string())?, "raw")
				.map_err(|e| e.to_string())?;
			let countries = StrColumn::new(column(&batch, "country", path).map_err(|e| e.to_string())?, "country")
				.map_err(|e| e.to_string())?;
			for i in 0..raws.len() {
				if countries.get(i) != Some(country) {
					continue;
				}
				let raw = raws
					.get(i)
					.ok_or_else(|| format!("{}: a {country} row has a null raw", path.display()))?;
				visit(raw)?;
			}
		}
	}
	Ok(())
}

/// Algorithm R over `raws`: the first `size` are kept, and the item read as the n-th replaces slot `randrange(n)` when
/// that slot exists. Both the tokenizer trainer and the parity fixture sampler drew this way.
fn reservoir(rng: &mut PyRandom, size: usize, picked: &mut Vec<String>, seen: &mut i128, raw: &str) -> Result<()> {
	*seen += 1;
	if picked.len() < size {
		picked.push(raw.to_owned());
	} else {
		let j = rng.randrange_below(*seen).map_err(|e| e.0)? as usize;
		if j < size {
			picked[j] = raw.to_owned();
		}
	}
	Ok(())
}

/// A reservoir of `size` raws from one parquet file's `raw` column, in a generator seeded with `seed`.
pub fn reservoir_raws(path: &Path, size: usize, seed: i128) -> Result<Vec<String>> {
	let mut rng = PyRandom::new(Seed::Int(seed));
	let mut picked = Vec::with_capacity(size);
	let mut seen: i128 = 0;
	let file = open(path)?;
	for batch in file.batches(&["raw"], BATCH_ROWS).map_err(|e| e.to_string())? {
		let batch = batch.map_err(|e| e.to_string())?;
		let raws = StrColumn::new(column(&batch, "raw", path).map_err(|e| e.to_string())?, "raw")
			.map_err(|e| e.to_string())?;
		for i in 0..raws.len() {
			let raw = raws
				.get(i)
				.ok_or_else(|| format!("{}: raw row index {seen} is null; expected a string", path.display()))?;
			reservoir(&mut rng, size, &mut picked, &mut seen, raw)?;
		}
	}
	Ok(picked)
}

/// The balanced sample, and each country's sampled count in country order.
pub type BalancedSample = (Vec<String>, Vec<(String, usize)>);

/// `reservoir_sample(iter_raws_by_country(...), per_country, rng)` for each country in turn, then `rng.shuffle` over
/// the concatenation: `sample_balanced_raws`. Returns the sample and each country's sampled count.
pub fn sample_balanced_raws(
	files: &[PathBuf],
	countries: &[&str],
	per_country: usize,
	seed: i128,
) -> Result<BalancedSample> {
	let mut rng = PyRandom::new(Seed::Int(seed));
	let mut out = Vec::new();
	let mut counts = Vec::new();
	for &country in countries {
		let mut picked: Vec<String> = Vec::new();
		let mut seen: i128 = 0;
		// `rng.randint(0, i)` for the 0-based index `i` is `randrange(i + 1)`, the reservoir's draw.
		each_raw_of_country(files, country, &mut |raw| {
			reservoir(&mut rng, per_country, &mut picked, &mut seen, raw)
		})?;
		counts.push((country.to_owned(), picked.len()));
		out.extend(picked);
	}
	rng.shuffle(&mut out);
	Ok((out, counts))
}

/// The characters `mine_postcode_literals` strips from each end of a postcode token.
const POSTCODE_STRIP: &[char] = &[' ', ',', ';', ':', '.', '(', ')', '[', ']', '"', '\''];

/// `mine_postcode_literals`: the `top_k` most frequent postcode-labeled tokens, ties in first-seen order.
pub fn mine_postcode_literals(
	files: &[PathBuf],
	top_k: usize,
	countries: Option<&[&str]>,
	max_files: Option<usize>,
) -> Result<Vec<String>> {
	let mut order: Vec<String> = Vec::new();
	let mut counts: HashMap<String, (usize, u64)> = HashMap::new();
	let files = &files[..max_files.map_or(files.len(), |m| m.min(files.len()))];
	for path in files {
		let file = open(path)?;
		let mut columns = vec!["tokens", "labels"];
		if countries.is_some() {
			columns.push("country");
		}
		for batch in file.batches(&columns, BATCH_ROWS).map_err(|e| e.to_string())? {
			let batch = batch.map_err(|e| e.to_string())?;
			let tokens = StrListColumn::new(column(&batch, "tokens", path).map_err(|e| e.to_string())?, "tokens")
				.map_err(|e| e.to_string())?;
			let labels = StrListColumn::new(column(&batch, "labels", path).map_err(|e| e.to_string())?, "labels")
				.map_err(|e| e.to_string())?;
			let country = match countries {
				Some(_) => Some(
					StrColumn::new(column(&batch, "country", path).map_err(|e| e.to_string())?, "country")
						.map_err(|e| e.to_string())?,
				),
				None => None,
			};
			for i in 0..batch.num_rows() {
				if let (Some(filter), Some(column)) = (countries, &country) {
					if !column.get(i).is_some_and(|c| filter.contains(&c)) {
						continue;
					}
				}
				// A null list is a malformed row: reading it as empty would skip the row and undercount its postcodes.
				let toks = tokens
					.get(i)
					.map_err(|e| e.to_string())?
					.ok_or_else(|| format!("{}: row {i} has null tokens", path.display()))?;
				let labs = labels
					.get(i)
					.map_err(|e| e.to_string())?
					.ok_or_else(|| format!("{}: row {i} has null labels", path.display()))?;
				if toks.len() != labs.len() {
					return Err(format!(
						"{}: row {i} has {} tokens and {} labels",
						path.display(),
						toks.len(),
						labs.len()
					));
				}
				for (tok, lab) in toks.iter().zip(&labs) {
					if !lab.ends_with("-postcode") {
						continue;
					}
					let cleaned = tok.trim_matches(POSTCODE_STRIP);
					if cleaned.is_empty() {
						continue;
					}
					let next = order.len();
					let entry = counts.entry(cleaned.to_owned()).or_insert_with(|| (next, 0));
					if entry.0 == next {
						order.push(cleaned.to_owned());
					}
					entry.1 += 1;
				}
			}
		}
	}
	let mut ranked: Vec<(usize, u64, &String)> = order.iter().map(|k| (counts[k].0, counts[k].1, k)).collect();
	// `Counter.most_common` sorts by count, descending, and the sort is stable over insertion order.
	ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
	Ok(ranked.into_iter().take(top_k).map(|(_, _, k)| k.clone()).collect())
}

/// How often each piece id occurs when every `raw` of `files` is encoded: `tokenizer/vocab/utilization.py`.
pub fn count_pieces(processor: &Processor, files: &[PathBuf], threads: usize) -> Result<Vec<u64>> {
	let vocab = processor.vocab_size();
	let next = std::sync::atomic::AtomicUsize::new(0);
	let results = std::sync::Mutex::new(Vec::<Result<Vec<u64>>>::new());
	std::thread::scope(|scope| {
		for _ in 0..threads.max(1) {
			scope.spawn(|| loop {
				let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
				let Some(path) = files.get(index) else { break };
				let counted = count_file(processor, path, vocab);
				let failed = counted.is_err();
				results.lock().expect("counts lock").push(counted);
				if failed {
					break;
				}
			});
		}
	});
	let mut total = vec![0u64; vocab];
	for counted in results.into_inner().expect("counts lock") {
		for (slot, n) in total.iter_mut().zip(counted?) {
			*slot += n;
		}
	}
	Ok(total)
}

fn count_file(processor: &Processor, path: &Path, vocab: usize) -> Result<Vec<u64>> {
	let mut counts = vec![0u64; vocab];
	let file = open(path)?;
	for batch in file.batches(&["raw"], BATCH_ROWS).map_err(|e| e.to_string())? {
		let batch = batch.map_err(|e| e.to_string())?;
		let raws = StrColumn::new(column(&batch, "raw", path).map_err(|e| e.to_string())?, "raw")
			.map_err(|e| e.to_string())?;
		for i in 0..raws.len() {
			let raw = raws
				.get(i)
				.ok_or_else(|| format!("{}: row {i} of a batch has a null raw", path.display()))?;
			for piece in processor
				.encode(raw)
				.map_err(|e| format!("{}: {raw:?}: {e}", path.display()))?
			{
				counts[piece.id as usize] += 1;
			}
		}
	}
	Ok(counts)
}

/// `sample_training_rows` of `tokenizer/vocab/prune_verify.py`: shuffle the files, then from each read one random row
/// group, shuffle its rows and keep `n / len(files) + 1` of them, until `n` are held.
pub fn sample_training_rows(files: &[PathBuf], n: usize, seed: i128) -> Result<Vec<String>> {
	let mut rng = PyRandom::new(Seed::Int(seed));
	let mut files = files.to_vec();
	rng.shuffle(&mut files);
	if files.is_empty() {
		return Err("no train files to sample".to_owned());
	}
	let per_file = (n / files.len() + 1).max(1);
	let mut rows: Vec<String> = Vec::new();
	for path in &files {
		let file = open(path)?;
		let group = rng
			.randrange_below(file.num_row_groups() as i128)
			.map_err(|e| format!("{}: {}", path.display(), e.0))? as usize;
		let batch = file.read_row_group(group, &["raw"]).map_err(|e| e.to_string())?;
		let raws = StrColumn::new(batch.column(0), "raw").map_err(|e| e.to_string())?;
		let mut values = (0..raws.len())
			.map(|i| {
				raws.get(i)
					.map(str::to_owned)
					.ok_or_else(|| format!("{}: row group {group} has a null raw", path.display()))
			})
			.collect::<Result<Vec<_>>>()?;
		rng.shuffle(&mut values);
		rows.extend(values.into_iter().take(per_file));
		if rows.len() >= n {
			break;
		}
	}
	rows.truncate(n);
	Ok(rows)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn touch(path: &Path) {
		std::fs::create_dir_all(path.parent().unwrap()).unwrap();
		std::fs::write(path, b"").unwrap();
	}

	#[test]
	fn the_manifest_train_entries_win_over_the_directory() {
		let root = tempfile::tempdir().unwrap();
		let cross_version = root.path().join("elsewhere/part-0000.parquet");
		touch(&cross_version);
		let corpus = root.path().join("v0.4.0");
		touch(&corpus.join("train/part-local.parquet"));
		let manifest = serde_json::json!({
			"files": [
				{ "split": "train", "path": cross_version },
				{ "split": "test", "path": corpus.join("test/part-0000.parquet") },
			]
		});
		std::fs::write(corpus.join("MANIFEST.json"), manifest.to_string()).unwrap();
		assert_eq!(train_files(&corpus).unwrap(), vec![cross_version]);
	}

	#[test]
	fn a_manifest_without_train_entries_falls_back_to_the_directory() {
		let root = tempfile::tempdir().unwrap();
		let corpus = root.path().join("v0.4.0");
		let local = corpus.join("train/part-0000.parquet");
		touch(&local);
		let manifest = serde_json::json!({ "files": [{ "split": "test", "path": "/nowhere/test.parquet" }] });
		std::fs::write(corpus.join("MANIFEST.json"), manifest.to_string()).unwrap();
		assert_eq!(train_files(&corpus).unwrap(), vec![local]);
	}

	#[test]
	fn a_corpus_without_a_manifest_lists_its_train_directory_in_order() {
		let root = tempfile::tempdir().unwrap();
		let b = root.path().join("train/part-0001.parquet");
		let a = root.path().join("train/part-0000.parquet");
		touch(&b);
		touch(&a);
		assert_eq!(train_files(root.path()).unwrap(), vec![a, b]);
	}

	#[test]
	fn a_corpus_with_no_train_file_is_refused() {
		let root = tempfile::tempdir().unwrap();
		std::fs::create_dir_all(root.path().join("train")).unwrap();
		assert!(train_files(root.path()).is_err());
	}

	#[test]
	fn the_reservoir_is_deterministic_per_seed() {
		let draw = |seed| {
			let mut rng = PyRandom::new(Seed::Int(seed));
			let (mut picked, mut seen) = (Vec::new(), 0);
			for i in 0..1000 {
				reservoir(&mut rng, 50, &mut picked, &mut seen, &i.to_string()).unwrap();
			}
			picked
		};
		assert_eq!(draw(42).len(), 50);
		assert_eq!(draw(42), draw(42));
		assert_ne!(draw(42), draw(7));
	}

	#[test]
	fn a_row_with_null_tokens_is_refused_rather_than_read_as_empty() {
		use arrow_array::builder::{ListBuilder, StringBuilder};
		use arrow_array::{ArrayRef, RecordBatch};
		use std::sync::Arc;

		let lists = |rows: &[Option<&[&str]>]| -> ArrayRef {
			let mut builder = ListBuilder::new(StringBuilder::new());
			for row in rows {
				match row {
					Some(values) => {
						for v in *values {
							builder.values().append_value(v);
						}
						builder.append(true);
					}
					None => builder.append(false),
				}
			}
			Arc::new(builder.finish())
		};
		let batch = RecordBatch::try_from_iter([
			("tokens", lists(&[Some(&["10117"]), None])),
			("labels", lists(&[Some(&["B-postcode"]), Some(&[])])),
		])
		.unwrap();
		let root = tempfile::tempdir().unwrap();
		let path = root.path().join("train/part-0000.parquet");
		std::fs::create_dir_all(path.parent().unwrap()).unwrap();
		let mut writer =
			parquet::arrow::ArrowWriter::try_new(std::fs::File::create(&path).unwrap(), batch.schema(), None).unwrap();
		writer.write(&batch).unwrap();
		writer.close().unwrap();

		let refusal = mine_postcode_literals(&[path], 5, None, None).unwrap_err();
		assert!(refusal.contains("row 1 has null tokens"), "{refusal}");
	}

	#[test]
	fn paths_sort_by_their_parts() {
		let mut paths = vec![PathBuf::from("/c/a-b/x"), PathBuf::from("/c/a/x")];
		paths.sort_by_cached_key(|p| python_path_key(p));
		assert_eq!(paths, vec![PathBuf::from("/c/a/x"), PathBuf::from("/c/a-b/x")]);
	}
}
