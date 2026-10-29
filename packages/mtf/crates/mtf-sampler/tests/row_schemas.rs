// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The sampler reads a corpus file of either row schema alike: a v0.7.x file with `corpus_version` and `recipe`
//! columns and a current file with `augmentation` and a register license id, because it reads only the columns it
//! trains on.
mod common;

use arrow_array::builder::{Int64Builder, ListBuilder, StringBuilder};
use arrow_array::{ArrayRef, NullArray, RecordBatch, StringArray};
use common::config;
use mtf_sampler::corpus_files::file_sha256;
use mtf_sampler::{Row, Sampler};
use parquet::arrow::ArrowWriter;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn string(value: &str) -> ArrayRef {
	Arc::new(StringArray::from(vec![value]))
}

fn string_list(values: &[&str]) -> ArrayRef {
	let mut builder = ListBuilder::new(StringBuilder::new());
	for v in values {
		builder.values().append_value(v);
	}
	builder.append(true);
	Arc::new(builder.finish())
}

/// An `int64` list, the type pyarrow infers for a Python int list.
fn int_list(values: &[i64]) -> ArrayRef {
	let mut builder = ListBuilder::new(Int64Builder::new());
	for &v in values {
		builder.values().append_value(v);
	}
	builder.append(true);
	Arc::new(builder.finish())
}

/// The columns every row of both schemas carries, including the provenance columns the sampler does not read.
fn base_columns() -> Vec<(&'static str, ArrayRef, bool)> {
	vec![
		("raw", string("1 Main St"), true),
		("tokens", string_list(&["1", "Main", "St"]), true),
		("labels", string_list(&["B-house_number", "B-street", "I-street"]), true),
		("span_starts", int_list(&[0, 2]), true),
		("span_ends", int_list(&[1, 9]), true),
		("span_tags", string_list(&["house_number", "street"]), true),
		("country", string("US"), true),
		("source", string("tiger"), true),
		("source_id", string("t-1"), true),
		("register", string("us-census-tiger"), true),
		("surface", string("attested"), true),
		("base_source_id", Arc::new(NullArray::new(1)), true),
	]
}

/// Writes one file with `extra` columns into its own corpus's train split, with the record beside it.
fn write_corpus(root: &Path, extra: Vec<(&'static str, ArrayRef, bool)>) -> PathBuf {
	let corpus = root.join("corpus");
	let path = corpus.join("train/part-0000.parquet");
	std::fs::create_dir_all(path.parent().unwrap()).unwrap();
	let batch = RecordBatch::try_from_iter_with_nullable(base_columns().into_iter().chain(extra)).unwrap();
	let mut writer = ArrowWriter::try_new(std::fs::File::create(&path).unwrap(), batch.schema(), None).unwrap();
	writer.write(&batch).unwrap();
	writer.close().unwrap();
	let record = json!({"sha256": file_sha256(&path).unwrap(), "rows": 1});
	std::fs::write(corpus.join("train/part-0000.RECORD.json"), record.to_string()).unwrap();
	corpus
}

fn read(corpus: &Path) -> Vec<Row> {
	let settings = json!({"country_weights": {"US": 1.0}, "source_weights": {"tiger": 1.0}, "coarse_filter": false});
	Sampler::open(&config(corpus, settings), "train", 0, None)
		.unwrap()
		.rows()
		.map(|r| r.unwrap())
		.collect()
}

#[test]
fn an_older_and_a_current_file_read_alike() {
	let old_dir = tempfile::tempdir().unwrap();
	let old = write_corpus(
		old_dir.path(),
		vec![
			("corpus_version", string("0.7.0-de-holdout"), true),
			("license", string("public domain"), true),
			("recipe", Arc::new(NullArray::new(1)), true),
		],
	);
	// The sampler never reads `license`, so any register-shaped id stands in for the one the writer stamps.
	let current_dir = tempfile::tempdir().unwrap();
	let current = write_corpus(
		current_dir.path(),
		vec![
			("license", string("LicenseRef-us-census-tiger"), true),
			("augmentation", Arc::new(NullArray::new(1)), true),
		],
	);
	let old_rows = read(&old);
	assert_eq!(old_rows.len(), 1);
	assert_eq!(old_rows, read(&current));
	assert_eq!(old_rows[0].raw, "1 Main St");
	assert_eq!(old_rows[0].spans.as_ref().unwrap().starts, vec![0, 2]);
}
