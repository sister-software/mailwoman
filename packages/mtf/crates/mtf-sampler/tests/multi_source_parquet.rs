// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! A parquet file holding more than one source is counted and indexed under every one of them, so the unnamed-source
//! guard sees a source that opens no file and the row counts split the file between its sources.
mod common;

use arrow_array::{ArrayRef, NullArray, RecordBatch, StringArray};
use common::{config, write_corpus_parquet, WriteOptions};
use mtf_sampler::corpus_files::{file_source_counts, source_row_counts, CorpusFile, IdSet, RowFilter};
use mtf_sampler::{Row, Sampler};
use parquet::arrow::ArrowWriter;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

/// `n` rows of `source`, numbered from `first`.
fn quiet_lane(source: &str, first: usize, n: usize) -> Vec<Row> {
	(first..first + n)
		.map(|i| Row {
			raw: format!("{i} quiet lane {source}"),
			tokens: vec![i.to_string(), "quiet".into(), "lane".into(), source.into()],
			labels: vec!["O".into(); 4],
			country: Some("US".into()),
			source: source.into(),
			spans: None,
		})
		.collect()
}

fn write(path: &Path, rows: &[Row]) {
	let options = WriteOptions {
		without_spans: true,
		..Default::default()
	};
	write_corpus_parquet(rows, path, 1 << 20, &options);
}

fn concat(parts: &[Vec<Row>]) -> Vec<Row> {
	parts.concat()
}

fn as_map(counts: Vec<(String, u64)>) -> BTreeMap<String, u64> {
	counts.into_iter().collect()
}

#[test]
fn file_source_counts_reports_every_source_with_its_own_row_count() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("train/part-0000.parquet");
	write(
		&path,
		&concat(&[quiet_lane("tiger", 0, 7), quiet_lane("usgov-nad", 0, 3)]),
	);
	let counts = file_source_counts(&CorpusFile { path, filter: None }).unwrap();
	assert_eq!(counts, vec![("tiger".to_owned(), 7), ("usgov-nad".to_owned(), 3)]);
}

#[test]
fn file_source_counts_refuses_a_label_less_golden_file() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("train/golden.parquet");
	std::fs::create_dir_all(path.parent().unwrap()).unwrap();
	let columns: Vec<(&str, ArrayRef, bool)> = vec![
		("raw", Arc::new(StringArray::from(vec!["x"])), true),
		("source", Arc::new(NullArray::new(1)), true),
	];
	let batch = RecordBatch::try_from_iter_with_nullable(columns).unwrap();
	let mut writer = ArrowWriter::try_new(std::fs::File::create(&path).unwrap(), batch.schema(), None).unwrap();
	writer.write(&batch).unwrap();
	writer.close().unwrap();
	assert!(file_source_counts(&CorpusFile { path, filter: None }).is_err());
}

#[test]
fn a_multi_source_file_is_read_under_each_of_its_sources() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	write(&corpus.join("train/part-0000.parquet"), &quiet_lane("tiger", 0, 4));
	write(
		&corpus.join("train/part-0001.parquet"),
		&concat(&[quiet_lane("tiger", 4, 4), quiet_lane("usgov-nad", 0, 2)]),
	);
	let settings = json!({
		"country_weights": {"US": 1.0},
		"source_weights": {"tiger": 1.0, "usgov-nad": 1.0},
		"coarse_filter": false,
		"shuffle_buffer": 1,
	});
	let rows: Vec<Row> = Sampler::open(&config(&corpus, settings), "train", 0, None)
		.unwrap()
		.rows()
		.map(|r| r.unwrap())
		.collect();
	// A source's pass covers every file it is indexed under, and the epoch ends only after each source's first pass.
	let tiger: BTreeSet<&str> = rows
		.iter()
		.filter(|r| r.source == "tiger")
		.map(|r| r.raw.as_str())
		.collect();
	let expected: Vec<Row> = quiet_lane("tiger", 0, 8);
	assert_eq!(tiger, expected.iter().map(|r| r.raw.as_str()).collect::<BTreeSet<_>>());
	assert!(rows.iter().any(|r| r.source == "usgov-nad"));
}

#[test]
fn the_unnamed_source_guard_sees_a_source_that_never_opens_a_file() {
	// `usgov-nad` is second in the file and opens no file.
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	write(
		&corpus.join("train/part-0000.parquet"),
		&concat(&[quiet_lane("tiger", 0, 4), quiet_lane("usgov-nad", 0, 2)]),
	);
	let settings = json!({"country_weights": {"US": 1.0}, "source_weights": {"tiger": 1.0}, "coarse_filter": false});
	let error = Sampler::open(&config(&corpus, settings), "train", 0, None)
		.err()
		.expect("an error");
	assert!(error.to_string().contains("usgov-nad"), "{error}");
}

#[test]
fn row_counts_split_a_multi_source_file_between_its_sources() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	write(
		&corpus.join("train/part-0000.parquet"),
		&concat(&[quiet_lane("tiger", 0, 4), quiet_lane("usgov-nad", 0, 6)]),
	);
	write(&corpus.join("train/part-0001.parquet"), &quiet_lane("tiger", 0, 5));
	let counts = source_row_counts(&config(&corpus, json!({"country_weights": {"US": 1.0}})), "train").unwrap();
	assert_eq!(
		as_map(counts),
		BTreeMap::from([("tiger".to_owned(), 9), ("usgov-nad".to_owned(), 6)])
	);
}

#[test]
fn source_counts_follow_the_filter_a_listing_passes_not_an_earlier_listings() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("train/part-0000.parquet");
	let rows = concat(&[quiet_lane("tiger", 0, 4), quiet_lane("usgov-nad", 0, 2)]);
	let ids: Vec<Option<String>> = (0..rows.len()).map(|i| Some(format!("id-{i}"))).collect();
	let options = WriteOptions {
		without_spans: true,
		source_ids: Some(ids),
	};
	write_corpus_parquet(&rows, &path, 1 << 20, &options);
	let set = |members: &[&str]| -> Arc<IdSet> { Arc::new(members.iter().map(|m| Box::from(*m)).collect()) };
	let listing = |keep: Arc<IdSet>| CorpusFile {
		path: path.clone(),
		filter: Some(Arc::new(RowFilter {
			keep: Some(keep),
			drop: Vec::new(),
		})),
	};

	// Two listings of one file, as a val pass then a train pass make them, each with its own id sets. The first
	// listing's filter is freed before the second is built, so the allocator may hand the second the same address.
	let tiger_only = file_source_counts(&listing(set(&["id-0", "id-1"]))).unwrap();
	let nad_only = file_source_counts(&listing(set(&["id-4", "id-5"]))).unwrap();

	assert_eq!(tiger_only, vec![("tiger".to_owned(), 2)]);
	assert_eq!(nad_only, vec![("usgov-nad".to_owned(), 2)]);
}
