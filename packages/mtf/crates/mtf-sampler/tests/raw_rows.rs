// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The audits' raw stream: the mixture's rows before the shuffle buffer, with the emit step on the same generator.

mod common;

use common::{config, fixture_row, write_corpus_parquet, WriteOptions};
use mtf_sampler::{CancelToken, RawRows, Row, Sampler};
use serde_json::json;
use std::path::Path;

fn corpus(root: &Path) -> std::path::PathBuf {
	let corpus = root.join("corpus");
	let o = WriteOptions::default();
	let big: Vec<Row> = (0..30).map(|i| fixture_row(i, "US", "big")).collect();
	let small: Vec<Row> = (0..5).map(|i| fixture_row(i, "US", "small")).collect();
	write_corpus_parquet(&big, &corpus.join("train/part-big.parquet"), 4, &o);
	write_corpus_parquet(&small, &corpus.join("train/part-small.parquet"), 4, &o);
	corpus
}

fn open(corpus: &Path, extra: serde_json::Value) -> RawRows {
	let mut settings = json!({"country_weights": {"US": 1.0}, "source_weights": {"big": 1.0, "small": 1.0}});
	settings
		.as_object_mut()
		.unwrap()
		.extend(extra.as_object().unwrap().clone());
	RawRows::open(
		&config(corpus, settings),
		"train",
		11,
		None,
		CancelToken::default(),
		None,
	)
	.unwrap()
}

#[test]
fn without_augmentation_the_emit_step_passes_each_row_through_and_draws_nothing() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(dir.path());
	let mut raw = open(&corpus, json!({}));
	let mut emitting = open(&corpus, json!({}));
	let mut drawn = Vec::new();
	while let Some(row) = raw.next_raw().unwrap() {
		drawn.push(row);
	}
	let mut passed = Vec::new();
	while let Some((row, emitted)) = emitting.next_emitted().unwrap() {
		assert_eq!(emitted, vec![row.clone()]);
		passed.push(row);
	}
	assert!(drawn.len() >= 35, "every source completes a pass: {}", drawn.len());
	assert_eq!(
		drawn, passed,
		"an emit step that draws nothing leaves the stream unchanged"
	);
	assert_eq!(raw.drawn(), drawn.len() as u64);
}

#[test]
fn equal_seeds_draw_equal_raw_rows() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(dir.path());
	let draw = || {
		let mut raw = open(&corpus, json!({}));
		std::iter::from_fn(|| raw.next_raw().unwrap()).collect::<Vec<Row>>()
	};
	assert_eq!(draw(), draw());
}

#[test]
fn the_raw_stream_leaves_augment_exclude_sources_unchecked() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(dir.path());
	let settings = json!({"augment_exclude_sources": ["no-such-source"]});
	let mut raw = open(&corpus, settings.clone());
	assert!(raw.next_raw().unwrap().is_some());
	let mut full = json!({"country_weights": {"US": 1.0}, "source_weights": {"big": 1.0, "small": 1.0}});
	full.as_object_mut()
		.unwrap()
		.extend(settings.as_object().unwrap().clone());
	assert!(Sampler::open(&config(&corpus, full), "train", 11, None).is_err());
}
