// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! A validation split reads every source of every file, ignores the training source weights, spreads a limited draw
//! over every row group, and receives no affix relabel.
mod common;

use common::{config, write_corpus_parquet, WriteOptions};
use mtf_sampler::{Row, Sampler};
use serde_json::json;
use std::collections::BTreeSet;
use std::path::Path;

/// A row whose tokens are `raw` split on spaces, each labeled `O` unless `labels` is given.
fn row(raw: &str, source: &str, labels: Option<&[&str]>) -> Row {
	let tokens: Vec<String> = raw.split(' ').map(str::to_owned).collect();
	Row {
		labels: labels.map_or_else(
			|| vec!["O".into(); tokens.len()],
			|l| l.iter().map(|s| (*s).to_owned()).collect(),
		),
		raw: raw.to_owned(),
		tokens,
		country: Some("US".into()),
		source: source.into(),
		spans: None,
	}
}

fn rows(text: &str, source: &str, n: usize) -> Vec<Row> {
	(0..n).map(|i| row(&format!("{i} {text}"), source, None)).collect()
}

fn write(path: &Path, rows: &[Row], row_group_size: usize) {
	let options = WriteOptions {
		without_spans: true,
		..Default::default()
	};
	write_corpus_parquet(rows, path, row_group_size, &options);
}

fn val_rows(corpus: &Path, extra: serde_json::Value, row_limit: Option<u64>) -> Vec<Row> {
	let mut settings = json!({"country_weights": {"US": 1.0}, "coarse_filter": false, "shuffle_buffer": 4});
	for (k, v) in extra.as_object().unwrap() {
		settings[k] = v.clone();
	}
	Sampler::open(&config(corpus, settings), "val", 0, row_limit)
		.unwrap()
		.rows()
		.map(|r| r.unwrap())
		.collect()
}

fn sources(rows: &[Row]) -> BTreeSet<&str> {
	rows.iter().map(|r| r.source.as_str()).collect()
}

#[test]
fn every_row_of_a_mixed_source_file_is_read() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let mixed: Vec<Row> = rows("Alpha St", "a", 5)
		.into_iter()
		.chain(rows("Beta St", "b", 5))
		.collect();
	write(&corpus.join("val/part-mixed.parquet"), &mixed, 1 << 20);
	let out = val_rows(&corpus, json!({}), None);
	assert_eq!(out.len(), 10, "every row of the mixed-source file");
	assert_eq!(sources(&out), BTreeSet::from(["a", "b"]));
}

#[test]
fn the_training_source_weights_do_not_apply() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	write(&corpus.join("val/part-a.parquet"), &rows("Alpha St", "a", 5), 1 << 20);
	write(&corpus.join("val/part-b.parquet"), &rows("Beta St", "b", 5), 1 << 20);
	let out = val_rows(&corpus, json!({"source_weights": {"a": 1.0, "b": 0.0}}), None);
	assert_eq!(out.len(), 10, "source_weights leaked into the val split");
	assert_eq!(sources(&out), BTreeSet::from(["a", "b"]));
}

#[test]
fn a_limited_draw_spreads_over_every_row_group() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	write(&corpus.join("val/part-a.parquet"), &rows("Gamma St", "a", 64), 8);
	let out = val_rows(&corpus, json!({"shuffle_buffer": 64}), Some(16));
	let groups: BTreeSet<usize> = out
		.iter()
		.map(|r| r.raw.split(' ').next().unwrap().parse::<usize>().unwrap() / 8)
		.collect();
	assert_eq!(out.len(), 16);
	assert_eq!(
		groups,
		(0..8).collect::<BTreeSet<_>>(),
		"a 16-row draw over 8 row groups of 8"
	);
}

#[test]
fn the_validation_split_receives_no_affix_relabel() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let lexicon = dir.path().join("lexicon.json");
	std::fs::write(
		&lexicon,
		r#"{"directionals": {"west": "W"}, "suffixes": {"road": "Rd"}, "version": "test"}"#,
	)
	.unwrap();
	let street = ["B-street", "I-street", "I-street"];
	write(
		&corpus.join("val/part-a.parquet"),
		&[row("Menlo Park Road", "a", Some(&street))],
		1 << 20,
	);
	write(
		&corpus.join("train/part-a.parquet"),
		&[row("Menlo Park Road", "a", Some(&street))],
		1 << 20,
	);
	let settings = json!({
		"country_weights": {"US": 1.0},
		"coarse_filter": false,
		"affix_relabel_lexicon_path": lexicon,
		"shuffle_buffer": 1,
	});
	let train: Vec<Row> = Sampler::open(&config(&corpus, settings), "train", 0, None)
		.unwrap()
		.rows()
		.map(|r| r.unwrap())
		.collect();
	assert_eq!(
		train[0].labels,
		["B-street", "I-street", "B-street_suffix"],
		"the lexicon fires on the train split"
	);
	let val = val_rows(
		&corpus,
		json!({"affix_relabel_lexicon_path": lexicon, "shuffle_buffer": 1}),
		None,
	);
	assert_eq!(val[0].labels, street, "the affix relabel leaked into the val split");
}
