// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The character path's unit encoding: the positional window, the per-character and per-word labels read from the
//! span triple, UNK and PAD, truncation, and the stream's char branch over a span-schema corpus.

mod common;

use common::{config, write_corpus_parquet, WriteOptions};
use mtf_channels::label_schema::LabelSchema;
use mtf_sampler::char_path::{CharEncoder, PAD_CHAR_ID, UNK_CHAR_ID};
use mtf_sampler::{CharConfig, Row, Sampler, SpanTriple};
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;

fn schema() -> LabelSchema {
	let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../neural/data/label-schema.v1.json");
	LabelSchema::from_json(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The id of `label` in the default label set.
fn label_id(label: &str) -> i64 {
	let schema = schema();
	let set = schema.set(&schema.default_label_set).unwrap();
	set.bio_labels.iter().position(|l| l == label).unwrap() as i64
}

fn ignore_index() -> i64 {
	schema().ignore_index
}

/// A vocabulary of the distinct characters of `texts`, numbered from 2 after PAD and UNK.
fn vocab(texts: &[&str]) -> HashMap<char, i64> {
	let mut out = HashMap::new();
	for c in texts.iter().flat_map(|t| t.chars()) {
		let next = out.len() as i64 + 2;
		out.entry(c).or_insert(next);
	}
	out
}

/// Writes `vocab` as the `{char: id}` JSON file the encoder reads.
fn write_vocab(dir: &Path, vocab: &HashMap<char, i64>) -> std::path::PathBuf {
	let path = dir.join("char-vocab.json");
	let doc: serde_json::Map<String, serde_json::Value> =
		vocab.iter().map(|(c, id)| (c.to_string(), json!(id))).collect();
	std::fs::write(&path, serde_json::Value::Object(doc).to_string()).unwrap();
	path
}

fn encoder(
	dir: &Path,
	vocab: &HashMap<char, i64>,
	mode: &str,
	max_units: usize,
	width: usize,
	ctx: usize,
) -> CharEncoder {
	let config = CharConfig {
		mode: mode.into(),
		vocab_path: write_vocab(dir, vocab),
		max_units,
		max_unit_width: width,
		char_ctx: ctx,
		label_set: schema().default_label_set,
	};
	CharEncoder::new(&config, &schema()).unwrap()
}

fn span_row(raw: &str, tokens: &[&str], starts: &[i64], ends: &[i64], tags: &[&str]) -> Row {
	Row {
		raw: raw.into(),
		tokens: tokens.iter().map(|s| (*s).to_owned()).collect(),
		labels: vec!["O".into(); tokens.len()],
		country: Some("JP".into()),
		source: "test".into(),
		spans: Some(SpanTriple {
			starts: starts.to_vec(),
			ends: ends.to_vec(),
			tags: tags.iter().map(|s| (*s).to_owned()).collect(),
		}),
	}
}

fn ids(vocab: &HashMap<char, i64>, text: &str) -> Vec<i64> {
	text.chars().map(|c| vocab[&c]).collect()
}

#[test]
fn the_char_mode_window_is_positional() {
	let dir = tempfile::tempdir().unwrap();
	let raw = "東京都千代田区";
	let v = vocab(&[raw]);
	let encoder = encoder(dir.path(), &v, "char", 16, 7, 3);
	let row = span_row(raw, &[raw], &[0, 3], &[3, 7], &["region", "locality"]);
	let (char_ids, attention, _) = encoder.encode_row(&row).unwrap();
	let unit = |u: usize| &char_ids[u * 7..(u + 1) * 7];
	assert_eq!(char_ids.len(), 16 * 7);
	assert_eq!(attention, [vec![1; 7], vec![0; 9]].concat());
	// Unit 0 (東): the window covers raw[-3:4], three leading PAD slots and then 東京都千.
	assert_eq!(unit(0)[..3], [PAD_CHAR_ID; 3]);
	assert_eq!(unit(0)[3..], ids(&v, "東京都千")[..]);
	// Unit 3 (千) is interior: the window is exactly raw[0:7].
	assert_eq!(unit(3), &ids(&v, "東京都千代田区")[..]);
	// Unit 6 (区): three trailing PAD slots.
	assert_eq!(unit(6)[..4], ids(&v, "千代田区")[..]);
	assert_eq!(unit(6)[4..], [PAD_CHAR_ID; 3]);
}

#[test]
fn char_mode_labels_are_each_characters_own() {
	let dir = tempfile::tempdir().unwrap();
	let raw = "青森市";
	let encoder = encoder(dir.path(), &vocab(&[raw]), "char", 4, 3, 1);
	let (_, _, labels) = encoder
		.encode_row(&span_row(raw, &[raw], &[0], &[3], &["locality"]))
		.unwrap();
	assert_eq!(
		labels[..3],
		[label_id("B-locality"), label_id("I-locality"), label_id("I-locality")]
	);
	assert_eq!(labels[3], ignore_index());
}

#[test]
fn a_char_mode_whitespace_unit_carries_o() {
	let dir = tempfile::tempdir().unwrap();
	let raw = "〒100 東京";
	let encoder = encoder(dir.path(), &vocab(&[raw]), "char", 8, 3, 1);
	let row = span_row(raw, &["〒100", "東京"], &[0, 5], &[4, 7], &["postcode", "region"]);
	let (_, attention, labels) = encoder.encode_row(&row).unwrap();
	assert_eq!(labels[4], label_id("O"), "the space between 100 and 東京");
	assert_eq!(attention[4], 1, "still a real position");
}

#[test]
fn word_mode_bio_comes_straight_from_the_span_triple() {
	let dir = tempfile::tempdir().unwrap();
	let raw = "main st buffalo";
	let encoder = encoder(dir.path(), &vocab(&[raw]), "word", 4, 8, 0);
	let tokens = ["main", "st", "buffalo"];
	// `st` starts inside the street span, so its first character is I-street.
	let (_, _, labels) = encoder
		.encode_row(&span_row(raw, &tokens, &[0, 8], &[7, 15], &["street", "locality"]))
		.unwrap();
	assert_eq!(
		labels[..3],
		[label_id("B-street"), label_id("I-street"), label_id("B-locality")]
	);
	// Two adjacent street spans are distinct entities, and each keeps its own B.
	let row = span_row(raw, &tokens, &[0, 5, 8], &[4, 7, 15], &["street", "street", "locality"]);
	let (_, _, labels) = encoder.encode_row(&row).unwrap();
	assert_eq!(
		labels[..3],
		[label_id("B-street"), label_id("B-street"), label_id("B-locality")]
	);
}

#[test]
fn an_unknown_character_is_unk_and_the_width_truncates() {
	let dir = tempfile::tempdir().unwrap();
	let raw = "abcdef zz";
	let v = vocab(&["abcdef"]);
	let encoder = encoder(dir.path(), &v, "word", 2, 4, 0);
	let (char_ids, _, _) = encoder
		.encode_row(&span_row(raw, &["abcdef", "zz"], &[], &[], &[]))
		.unwrap();
	assert_eq!(char_ids[..4], ids(&v, "abcd")[..], "truncated at W=4");
	assert_eq!(char_ids[4..], [UNK_CHAR_ID, UNK_CHAR_ID, PAD_CHAR_ID, PAD_CHAR_ID]);
}

#[test]
fn the_units_truncate_at_max_units() {
	let dir = tempfile::tempdir().unwrap();
	let raw = "a b c";
	let encoder = encoder(dir.path(), &vocab(&[raw]), "word", 2, 2, 0);
	let (char_ids, attention, _) = encoder
		.encode_row(&span_row(raw, &["a", "b", "c"], &[], &[], &[]))
		.unwrap();
	assert_eq!(char_ids.len(), 2 * 2);
	assert_eq!(attention, [1, 1]);
}

fn jp_row() -> Row {
	Row {
		labels: vec!["B-region".into()],
		source: "overture-jp".into(),
		..span_row(
			"青森県青森市中央1-22-5",
			&["青森県青森市中央1-22-5"],
			&[0, 3, 6, 8],
			&[3, 6, 8, 14],
			&["region", "locality", "street", "house_number"],
		)
	}
}

fn char_config(dir: &Path, max_unit_width: usize) -> CharConfig {
	CharConfig {
		mode: "char".into(),
		vocab_path: write_vocab(dir, &vocab(&[&jp_row().raw])),
		max_units: 32,
		max_unit_width,
		char_ctx: 3,
		label_set: schema().default_label_set,
	}
}

fn jp_corpus(dir: &Path, without_spans: bool) -> std::path::PathBuf {
	let corpus = dir.join("corpus");
	let options = WriteOptions {
		without_spans,
		..Default::default()
	};
	write_corpus_parquet(&[jp_row()], &corpus.join("train/part-0000.parquet"), 8, &options);
	corpus
}

fn sampled(corpus: &Path) -> Vec<Row> {
	let settings = json!({"country_weights": {"JP": 1.0}, "coarse_filter": false});
	Sampler::open(&config(corpus, settings), "train", 0, None)
		.unwrap()
		.rows()
		.map(|r| r.unwrap())
		.collect()
}

#[test]
fn the_char_branch_yields_unit_tensors() {
	let dir = tempfile::tempdir().unwrap();
	let rows = sampled(&jp_corpus(dir.path(), false));
	assert_eq!(rows.len(), 1);
	let encoder = CharEncoder::new(&char_config(dir.path(), 7), &schema()).unwrap();
	let (char_ids, attention, labels) = encoder.encode_row(&rows[0]).unwrap();
	let n = jp_row().raw.chars().count();
	assert_eq!(char_ids.len(), 32 * 7);
	assert_eq!(attention, [vec![1; n], vec![0; 32 - n]].concat());
	assert_eq!(labels[0], label_id("B-region"));
	assert_eq!(labels[1], label_id("I-region"));
	assert_eq!(labels[3], label_id("B-locality"));
	assert_eq!(labels[8], label_id("B-house_number"));
	assert_eq!(labels[13], label_id("I-house_number"));
	assert_eq!(labels[n..], vec![ignore_index(); 32 - n][..]);
}

#[test]
fn the_char_branch_requires_the_span_schema() {
	let dir = tempfile::tempdir().unwrap();
	let rows = sampled(&jp_corpus(dir.path(), true));
	let encoder = CharEncoder::new(&char_config(dir.path(), 7), &schema()).unwrap();
	let error = encoder.encode_row(&rows[0]).expect_err("an error");
	assert!(error.to_string().contains("span-schema"), "{error}");
}

#[test]
fn a_window_narrower_than_the_context_is_refused() {
	let dir = tempfile::tempdir().unwrap();
	let error = CharEncoder::new(&char_config(dir.path(), 5), &schema())
		.err()
		.expect("an error");
	assert!(error.to_string().contains("truncates the char window"), "{error}");
}
