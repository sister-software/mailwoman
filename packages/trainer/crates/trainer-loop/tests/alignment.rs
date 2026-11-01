//! `verify_tokenizer_alignment` passes a corpus whose rows recover their tokens from `raw`, and names the row and
//! file of one that does not.

#[path = "../../../../mtf/crates/mtf-sampler/tests/common/mod.rs"]
mod common;

use mtf_core::Processor;
use std::path::Path;
use trainer_loop::alignment::{verify_tokenizer_alignment, SAMPLE_SIZE};

fn processor() -> Processor {
	let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../neural/test/fixtures/tokenizer-v0.1.0.model");
	Processor::from_model_proto(&std::fs::read(&path).unwrap()).unwrap()
}

#[test]
fn a_corpus_whose_tokens_are_found_in_raw_passes() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = common::build_reference_corpus(dir.path());
	verify_tokenizer_alignment(
		&common::config(&corpus, serde_json::json!({})),
		&processor(),
		SAMPLE_SIZE,
	)
	.unwrap();
}

#[test]
fn a_row_whose_token_is_not_in_raw_is_named() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let mut rows: Vec<mtf_sampler::Row> = (0..4).map(|i| common::fixture_row(i, "US", "alpha")).collect();
	rows[2].tokens[0] = "Nowhere".into();
	let options = common::WriteOptions::default();
	common::write_corpus_parquet(&rows, &corpus.join("train/part-alpha-0.parquet"), 8, &options);
	common::write_corpus_parquet(&rows[..1], &corpus.join("val/part-val-0.parquet"), 8, &options);
	let error = verify_tokenizer_alignment(
		&common::config(&corpus, serde_json::json!({})),
		&processor(),
		SAMPLE_SIZE,
	)
	.unwrap_err()
	.to_string();
	assert!(error.contains("invariant broken at row 2"), "{error}");
	assert!(error.contains("part-alpha-0.parquet"), "{error}");
	// Only the first `sample_size` rows are read.
	verify_tokenizer_alignment(&common::config(&corpus, serde_json::json!({})), &processor(), 2).unwrap();
}
