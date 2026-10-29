// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! A version manifest's `deletions[]` removes rows by `source_id` from the files it targets: a deleted row leaves the
//! row stream and the source counts, a file the deletion does not target keeps every row, and a sidecar whose bytes
//! changed is refused.
mod common;

use arrow_array::{ArrayRef, RecordBatch, StringArray};
use common::{config, write_corpus_parquet, WriteOptions};
use mtf_sampler::corpus_files::{corpus_split_files, file_sha256, source_row_counts};
use mtf_sampler::{Row, Sampler, SamplerConfig};
use parquet::arrow::ArrowWriter;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Writes `n` rows of `source`, each with the `source_id` `<source>:<i>`, and returns the file's manifest entry.
fn write(path: &Path, source: &str, n: usize) -> Value {
	let rows: Vec<Row> = (0..n)
		.map(|i| Row {
			raw: format!("{i} quiet lane"),
			tokens: vec![i.to_string(), "quiet".into(), "lane".into()],
			labels: vec!["O".into(); 3],
			country: Some("US".into()),
			source: source.into(),
			spans: None,
		})
		.collect();
	let options = WriteOptions {
		without_spans: true,
		source_ids: Some((0..n).map(|i| Some(format!("{source}:{i}"))).collect()),
	};
	write_corpus_parquet(&rows, path, 1 << 20, &options);
	json!({"split": "train", "path": path, "source": source, "rows": n, "sha256": file_sha256(path).unwrap()})
}

fn corpus(root: &Path, deletions: Value) -> PathBuf {
	let corpus = root.join("corpus");
	let tiger = write(&corpus.join("train/tiger.parquet"), "tiger", 6);
	let nad = write(&corpus.join("train/nad.parquet"), "usgov-nad", 4);
	std::fs::write(
		corpus.join("MANIFEST.json"),
		json!({"files": [tiger, nad], "deletions": deletions}).to_string(),
	)
	.unwrap();
	corpus
}

fn settings(corpus: &Path) -> SamplerConfig {
	config(
		corpus,
		json!({
			"country_weights": {"US": 1.0},
			"source_weights": {"tiger": 1.0, "usgov-nad": 1.0},
			"coarse_filter": false,
		}),
	)
}

fn counts(corpus: &Path) -> BTreeMap<String, u64> {
	source_row_counts(&settings(corpus), "train")
		.unwrap()
		.into_iter()
		.collect()
}

/// Writes a sidecar holding only a `source_id` column.
fn write_sidecar(path: &Path, ids: &[&str]) {
	std::fs::create_dir_all(path.parent().unwrap()).unwrap();
	let columns: Vec<(&str, ArrayRef)> = vec![("source_id", Arc::new(StringArray::from(ids.to_vec())))];
	let batch = RecordBatch::try_from_iter(columns).unwrap();
	let mut writer = ArrowWriter::try_new(std::fs::File::create(path).unwrap(), batch.schema(), None).unwrap();
	writer.write(&batch).unwrap();
	writer.close().unwrap();
}

#[test]
fn an_inline_deletion_drops_its_rows_from_its_source_target_only() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(
		dir.path(),
		json!([{"target": {"source": "tiger"}, "source_ids": ["tiger:1", "tiger:4"], "reason": "r", "issue": "#1"}]),
	);
	assert_eq!(
		counts(&corpus),
		BTreeMap::from([("tiger".to_owned(), 4), ("usgov-nad".to_owned(), 4)])
	);
	// Every source completes a pass before the epoch ends, so the distinct rows are every admitted row.
	let rows: BTreeSet<String> = Sampler::open(&settings(&corpus), "train", 0, None)
		.unwrap()
		.rows()
		.map(|r| {
			let r = r.unwrap();
			format!("{}|{}", r.raw, r.source)
		})
		.collect();
	assert!(!rows.contains("1 quiet lane|tiger"));
	assert!(!rows.contains("4 quiet lane|tiger"));
	assert!(rows.contains("1 quiet lane|usgov-nad"));
	assert_eq!(rows.len(), 8);
}

#[test]
fn a_sidecar_deletion_is_verified_and_applied_by_path() {
	let dir = tempfile::tempdir().unwrap();
	let sidecar = dir.path().join("corpus/deletions/ids.parquet");
	write_sidecar(&sidecar, &["usgov-nad:0", "usgov-nad:3"]);
	let digest = file_sha256(&sidecar).unwrap();
	let nad_path = dir.path().join("corpus/train/nad.parquet");
	let corpus = corpus(
		dir.path(),
		json!([{
			"target": {"path": nad_path},
			// The Modal path. The loader re-roots it under the corpus's own `deletions/`.
			"source_ids_file": {"path": "/data/elsewhere/deletions/ids.parquet", "sha256": digest, "ids": 2},
			"reason": "r",
			"issue": "#2",
		}]),
	);
	assert_eq!(
		counts(&corpus),
		BTreeMap::from([("tiger".to_owned(), 6), ("usgov-nad".to_owned(), 2)])
	);
}

#[test]
fn a_sidecar_whose_bytes_changed_is_refused() {
	let dir = tempfile::tempdir().unwrap();
	let sidecar = dir.path().join("corpus/deletions/ids.parquet");
	write_sidecar(&sidecar, &["tiger:0"]);
	let corpus = corpus(
		dir.path(),
		json!([{
			"target": {"source": "tiger"},
			"source_ids_file": {"path": sidecar, "sha256": "0".repeat(64), "ids": 1},
			"reason": "r",
			"issue": "#3",
		}]),
	);
	let error = corpus_split_files(&settings(&corpus), "train").expect_err("an error");
	assert!(error.to_string().contains("hashes to"), "{error}");
}
