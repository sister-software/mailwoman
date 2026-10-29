// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The train mixture stays stationary across its epoch: a small source keeps appearing after its first pass, the
//! largest source is read once, the realized share holds between halves, and a source the weights do not name, or
//! name and cannot sample, is refused.
mod common;

use common::{config, write_corpus_parquet, WriteOptions};
use mtf_sampler::{Row, Sampler};
use serde_json::json;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn main_st(source: &str, n: usize, country: &str) -> Vec<Row> {
	(0..n)
		.map(|i| Row {
			raw: format!("{i} Main St {source}"),
			tokens: vec![i.to_string(), "Main".into(), "St".into(), source.into()],
			labels: vec!["O".into(); 4],
			country: Some(country.into()),
			source: source.into(),
			spans: None,
		})
		.collect()
}

fn corpus(root: &Path, files: &[(&str, Vec<Row>)]) -> PathBuf {
	let corpus = root.join("corpus");
	let options = WriteOptions {
		without_spans: true,
		..Default::default()
	};
	for (name, rows) in files {
		write_corpus_parquet(rows, &corpus.join("train").join(name), 1 << 20, &options);
	}
	corpus
}

fn sampler(corpus: &Path, split: &str, source_weights: serde_json::Value) -> mtf_sampler::Result<Sampler> {
	let settings = json!({
		"country_weights": {"US": 1.0},
		"source_weights": source_weights,
		"coarse_filter": false,
		"shuffle_buffer": 1,
	});
	Sampler::open(&config(corpus, settings), split, 0, None)
}

fn emit(corpus: &Path, source_weights: serde_json::Value) -> mtf_sampler::Result<Vec<Row>> {
	sampler(corpus, "train", source_weights)?.rows().collect()
}

fn big_and_small(root: &Path) -> PathBuf {
	corpus(
		root,
		&[
			("part-big.parquet", main_st("big", 120, "US")),
			("part-small.parquet", main_st("small", 12, "US")),
		],
	)
}

#[test]
fn a_small_source_keeps_appearing_after_its_first_pass() {
	let dir = tempfile::tempdir().unwrap();
	let emitted: Vec<String> = emit(&big_and_small(dir.path()), json!({"big": 1.0, "small": 1.0}))
		.unwrap()
		.into_iter()
		.map(|r| r.source)
		.collect();
	let q = emitted.len() / 4;
	for i in 0..4 {
		assert!(
			emitted[i * q..(i + 1) * q].iter().any(|s| s == "small"),
			"quarter {}/4 contains no 'small' draws — the source left the mixture after its first pass",
			i + 1
		);
	}
}

#[test]
fn an_epoch_covers_the_large_source_once_and_cycles_the_small_one() {
	let dir = tempfile::tempdir().unwrap();
	let emitted = emit(&big_and_small(dir.path()), json!({"big": 1.0, "small": 1.0})).unwrap();
	let mut big: Vec<&str> = emitted
		.iter()
		.filter(|r| r.source == "big")
		.map(|r| r.raw.as_str())
		.collect();
	let small: Vec<&str> = emitted
		.iter()
		.filter(|r| r.source == "small")
		.map(|r| r.raw.as_str())
		.collect();
	big.sort_unstable();
	let mut expected: Vec<String> = main_st("big", 120, "US").into_iter().map(|r| r.raw).collect();
	expected.sort_unstable();
	assert_eq!(big, expected);
	assert!(small.len() > 12, "the small source emitted at most one pass");
	assert_eq!(
		small.iter().copied().collect::<BTreeSet<_>>(),
		main_st("small", 12, "US")
			.iter()
			.map(|r| r.raw.as_str())
			.collect::<BTreeSet<_>>()
	);
}

#[test]
fn the_realized_share_is_stable_between_stream_halves() {
	let dir = tempfile::tempdir().unwrap();
	let emitted: Vec<String> = emit(&big_and_small(dir.path()), json!({"big": 1.0, "small": 1.0}))
		.unwrap()
		.into_iter()
		.map(|r| r.source)
		.collect();
	let half = emitted.len() / 2;
	for (name, part) in [("first", &emitted[..half]), ("second", &emitted[half..])] {
		let share = part.iter().filter(|s| *s == "small").count() as f64 / part.len() as f64;
		assert!(
			0.3 < share && share < 0.7,
			"{name} half: small share {share:.2} drifted from its 0.5 weight"
		);
	}
}

#[test]
fn a_positive_weight_source_with_zero_selectable_rows_is_refused() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(
		dir.path(),
		&[
			("part-big.parquet", main_st("big", 24, "US")),
			("part-empty.parquet", main_st("empty", 6, "FR")),
		],
	);
	let error = emit(&corpus, json!({"big": 1.0, "empty": 1.0})).expect_err("an error");
	assert!(error.to_string().contains("\"empty\""), "{error}");
}

#[test]
fn a_source_absent_from_the_weights_is_refused() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(
		dir.path(),
		&[
			("part-old.parquet", main_st("synth-fr-bare-street", 12, "US")),
			("part-new.parquet", main_st("synth-fr-bare-street-v22", 24, "US")),
		],
	);
	let error = emit(&corpus, json!({"synth-fr-bare-street": 12.0})).expect_err("an error");
	assert!(error.to_string().contains("synth-fr-bare-street-v22"), "{error}");
}

#[test]
fn a_source_named_at_zero_is_declined_without_an_error() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(
		dir.path(),
		&[
			("part-big.parquet", main_st("big", 24, "US")),
			("part-off.parquet", main_st("off", 6, "US")),
		],
	);
	let emitted = emit(&corpus, json!({"big": 1.0, "off": 0.0})).unwrap();
	assert_eq!(
		emitted.iter().map(|r| r.source.as_str()).collect::<BTreeSet<_>>(),
		BTreeSet::from(["big"])
	);
}

#[test]
fn the_validation_split_tolerates_an_unnamed_source() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let options = WriteOptions {
		without_spans: true,
		..Default::default()
	};
	write_corpus_parquet(
		&main_st("held-out", 8, "US"),
		&corpus.join("val/part-val.parquet"),
		1 << 20,
		&options,
	);
	let emitted: Vec<Row> = sampler(&corpus, "val", json!({"something-else": 1.0}))
		.unwrap()
		.rows()
		.map(|r| r.unwrap())
		.collect();
	assert_eq!(emitted.len(), 8);
}
