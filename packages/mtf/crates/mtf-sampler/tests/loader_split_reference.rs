// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The sampler reproduces the rows the Python loader drew on the loader-split fixture.
//!
//! `fixtures/loader-split-reference.json` was written by the Python loader over the corpus `build_reference_corpus`
//! writes: two sources, three countries with unequal weights, several row groups per file and every augmentation
//! before the postcode move on, so every consumer of the shared generator is live. The order of the rows is the
//! assertion, because a reordered or added draw reshuffles it.

mod common;

use common::{build_reference_corpus, config, fixture, TEMPLATES};
use mtf_channels::label_schema::LabelSchema;
use mtf_sampler::char_path::CharEncoder;
use mtf_sampler::{CharConfig, Sampler};
use serde_json::{json, Value};

fn reference() -> Value {
	let text = std::fs::read_to_string(fixture("loader-split-reference.json")).expect("the reference");
	serde_json::from_str(&text).expect("JSON")
}

fn augmentation() -> Value {
	json!({
		"directional": 0.5,
		"region": 0.5,
		"glue": 0.3,
		"case": 0.3,
		"punct_drop": 0.3,
		"upper_case": 0.2,
		"ordinal": 0.2,
	})
}

fn rows(corpus: &std::path::Path, split: &str) -> Vec<String> {
	let config = config(
		corpus,
		json!({
			"source_weights": {"alpha": 3.0, "beta": 1.0},
			"coarse_filter": false,
			"shuffle_buffer": 6,
			"augment": augmentation(),
		}),
	);
	let mut sampler = Sampler::open(&config, split, 11, None).expect("open");
	sampler
		.rows()
		.map(|r| {
			let r = r.expect("a row");
			format!("{}|{}|{}", r.source, r.country.unwrap_or_default(), r.raw)
		})
		.collect()
}

fn strings(value: &Value) -> Vec<String> {
	value
		.as_array()
		.expect("an array")
		.iter()
		.map(|v| v.as_str().expect("a string").to_owned())
		.collect()
}

#[test]
fn train_rows_match_the_python_loader() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = build_reference_corpus(dir.path());
	let expected = strings(&reference()["rows"]);
	let actual = rows(&corpus, "train");
	assert_eq!(actual.len(), expected.len(), "the row count changed");
	let first = actual.iter().zip(&expected).position(|(a, e)| a != e);
	assert_eq!(
		first,
		None,
		"first moved row: {:?}",
		first.map(|i| (&actual[i], &expected[i]))
	);
}

#[test]
fn held_out_rows_match_the_python_loader() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = build_reference_corpus(dir.path());
	assert_eq!(rows(&corpus, "val"), strings(&reference()["val_rows"]));
}

#[test]
fn source_row_counts_match_the_python_loader() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = build_reference_corpus(dir.path());
	let counts = mtf_sampler::corpus_files::source_row_counts(&config(&corpus, json!({})), "train").unwrap();
	let expected: Vec<(String, u64)> = reference()["source_row_counts"]
		.as_object()
		.unwrap()
		.iter()
		.map(|(k, v)| (k.clone(), v.as_u64().unwrap()))
		.collect();
	assert_eq!(counts, expected);
}

/// The vocabulary `write_char_vocab` built: every character of the templates and of the digit and letter set,
/// sorted by code point, from id 2.
fn write_vocab(dir: &std::path::Path) -> std::path::PathBuf {
	let mut chars: Vec<char> = TEMPLATES
		.iter()
		.flat_map(|(t, _)| t.chars())
		.chain("0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz,.".chars())
		.collect();
	chars.sort_unstable();
	chars.dedup();
	let mut vocab = serde_json::Map::new();
	vocab.insert("<pad>".into(), json!(0));
	vocab.insert("<unk>".into(), json!(1));
	for (i, c) in chars.iter().enumerate() {
		vocab.insert(c.to_string(), json!(i + 2));
	}
	let path = dir.join("char-vocab.json");
	std::fs::write(&path, Value::Object(vocab).to_string()).unwrap();
	path
}

#[test]
fn char_path_examples_match_the_python_loader() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = build_reference_corpus(dir.path());
	let char_config = CharConfig {
		mode: "word".into(),
		vocab_path: write_vocab(dir.path()),
		max_units: 24,
		max_unit_width: 12,
		char_ctx: 0,
		label_set: "stage3".into(),
	};
	let schema_text = std::fs::read_to_string(
		std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../neural/data/label-schema.v1.json"),
	)
	.unwrap();
	let encoder = CharEncoder::new(&char_config, &LabelSchema::from_json(&schema_text).unwrap()).unwrap();
	let config = config(
		&corpus,
		json!({
			"source_weights": {"alpha": 3.0, "beta": 1.0},
			"coarse_filter": false,
			"augment": augmentation(),
		}),
	);
	let mut sampler = Sampler::open(&config, "train", 11, None).unwrap();
	let expected = reference()["encoded"].as_array().unwrap().clone();
	let mut count = 0;
	for (index, row) in sampler.rows().enumerate() {
		let (char_ids, attention, labels) = encoder.encode_row(&row.unwrap()).unwrap();
		let want = &expected[index];
		let ints = |v: &Value| {
			v.as_array()
				.unwrap()
				.iter()
				.map(|x| x.as_i64().unwrap())
				.collect::<Vec<_>>()
		};
		assert_eq!(labels, ints(&want["labels"]), "labels of example {index}");
		assert_eq!(attention, ints(&want["attention_mask"]), "attention of example {index}");
		let first_three: Vec<i64> = want["char_ids"].as_array().unwrap().iter().flat_map(ints).collect();
		assert_eq!(
			char_ids[..first_three.len()],
			first_three[..],
			"char ids of example {index}"
		);
		count += 1;
	}
	assert_eq!(count, expected.len());
}
