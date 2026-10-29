// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! `augment_exclude_sources` keeps a source's rows unaugmented in the train stream, and an empty list changes
//! nothing.
mod common;

use common::{config, write_corpus_parquet, WriteOptions};
use mtf_sampler::{Row, Sampler};
use serde_json::json;
use std::path::{Path, PathBuf};

const EXCLUDED: &str = "synth-suffix-boundary";

fn quiet_lane(source: &str, n: usize) -> Vec<Row> {
	(0..n)
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

fn corpus(root: &Path) -> PathBuf {
	let corpus = root.join("corpus");
	let options = WriteOptions {
		without_spans: true,
		..Default::default()
	};
	write_corpus_parquet(
		&quiet_lane(EXCLUDED, 8),
		&corpus.join("train/part-synth.parquet"),
		8,
		&options,
	);
	write_corpus_parquet(
		&quiet_lane("tiger", 8),
		&corpus.join("train/part-a.parquet"),
		8,
		&options,
	);
	corpus
}

fn emit(corpus: &Path, extra: serde_json::Value) -> Vec<Row> {
	let mut settings = json!({
		"country_weights": {"US": 1.0},
		"source_weights": {EXCLUDED: 1.0, "tiger": 1.0},
		"coarse_filter": false,
		"augment": {"upper_case": 1.0},
		"shuffle_buffer": 1,
	});
	for (k, v) in extra.as_object().unwrap() {
		settings[k] = v.clone();
	}
	Sampler::open(&config(corpus, settings), "train", 0, None)
		.unwrap()
		.rows()
		.map(|r| r.unwrap())
		.collect()
}

#[test]
fn an_excluded_sources_rows_are_never_augmented() {
	let dir = tempfile::tempdir().unwrap();
	let out = emit(&corpus(dir.path()), json!({"augment_exclude_sources": [EXCLUDED]}));
	let excluded: Vec<&Row> = out.iter().filter(|r| r.source == EXCLUDED).collect();
	let other: Vec<&Row> = out.iter().filter(|r| r.source == "tiger").collect();
	assert!(!excluded.is_empty(), "the excluded source is still sampled");
	assert!(
		excluded.iter().all(|r| r.raw == r.raw.to_lowercase()),
		"an upper-cased copy leaked from the excluded source"
	);
	assert!(other.iter().any(|r| r.raw != r.raw.to_lowercase()));
}

#[test]
fn an_empty_exclusion_list_changes_nothing() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(dir.path());
	let pairs = |rows: Vec<Row>| rows.into_iter().map(|r| (r.source, r.raw)).collect::<Vec<_>>();
	assert_eq!(
		pairs(emit(&corpus, json!({}))),
		pairs(emit(&corpus, json!({"augment_exclude_sources": []})))
	);
}

#[test]
fn the_config_defaults_to_no_exclusion() {
	let dir = tempfile::tempdir().unwrap();
	assert!(config(&corpus(dir.path()), json!({}))
		.augment_exclude_sources
		.is_empty());
}
