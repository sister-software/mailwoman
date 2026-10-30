// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Encodes the row of `fixtures/encode-row-reference.json` and compares every tensor with the Python encoder's.
//!
//! The fixture's four cases are the token label source, the span label source, the shaped anchor and a row
//! without channels, each with every channel the case configures. Floats are compared as `f32` bit patterns,
//! the values `torch.tensor(..., dtype=torch.float32)` produced from the Python lists.

#![cfg(feature = "finders")]

use mtf_channels::anchor::AnchorLookup;
use mtf_channels::encoder::{EncodedBatch, CHANNEL_NAMES};
use mtf_channels::finders::{PostcodeShapes, PostcodeSyntax, RegexFinders};
use mtf_channels::gazetteer::Lexicon;
use mtf_channels::labels::{LabelTable, Spans};
use mtf_channels::{AnchorMode, Encoder, EncoderConfig, Lexicons, Piece, RowInput};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

fn read(relative: &str) -> String {
	let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
	std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

fn strings(v: &Value) -> Vec<String> {
	v.as_array()
		.unwrap()
		.iter()
		.map(|s| s.as_str().unwrap().to_string())
		.collect()
}

fn finders() -> RegexFinders {
	let shapes = "../../../../packages/trainer/data/postcode-shapes.json";
	let syntax = "../../../../packages/trainer/data/postcode-syntax.json";
	RegexFinders {
		shapes: PostcodeShapes::from_record(&read(shapes), shapes).unwrap(),
		syntax: PostcodeSyntax::from_json(&read(syntax), syntax).unwrap(),
	}
}

fn lexicons(doc: &Value, channels: bool) -> Lexicons {
	let label_to_id: HashMap<String, i64> = doc["label_to_id"]
		.as_object()
		.unwrap()
		.iter()
		.map(|(k, v)| (k.clone(), v.as_i64().unwrap()))
		.collect();
	let labels = LabelTable::new(
		&label_to_id,
		&strings(&doc["active_tags"]),
		doc["ignore_index"].as_i64().unwrap(),
	)
	.unwrap();
	let lexicon = |name: &str| channels.then(|| Lexicon::from_json(&doc["lexicons"][name].to_string(), name).unwrap());
	Lexicons {
		labels,
		locales: strings(&doc["locale_countries"]),
		anchor: channels.then(|| AnchorLookup::from_json(&doc["anchor_lookup"].to_string(), "anchor_lookup").unwrap()),
		gazetteer: lexicon("gazetteer"),
		country: lexicon("country"),
		street_type: lexicon("street_type"),
		locality_surface: lexicon("locality_surface"),
	}
}

fn encode(doc: &Value, case: &str) -> EncodedBatch {
	let channels = case != "no_channels";
	let lexicons = lexicons(doc, channels);
	let config = EncoderConfig {
		max_length: doc["max_length"].as_u64().unwrap() as usize,
		pad_id: doc["pad_id"].as_i64().unwrap(),
		anchor_mode: if case == "shaped_anchor" {
			AnchorMode::Shaped
		} else {
			AnchorMode::Gold
		},
		gazetteer_choreography: true,
		code_units: false,
	};
	let finders = finders();
	let encoder = Encoder::new(&config, &lexicons, Some(&finders)).unwrap();
	let tokens = strings(&doc["tokens"]);
	let labels = strings(&doc["labels"]);
	let starts: Vec<i64> = doc["spans"]["starts"]
		.as_array()
		.unwrap()
		.iter()
		.map(|v| v.as_i64().unwrap())
		.collect();
	let ends: Vec<i64> = doc["spans"]["ends"]
		.as_array()
		.unwrap()
		.iter()
		.map(|v| v.as_i64().unwrap())
		.collect();
	let tags = strings(&doc["spans"]["tags"]);
	let row = RowInput {
		raw: doc["raw"].as_str().unwrap(),
		tokens: &tokens,
		labels: &labels,
		spans: (case == "spans").then(|| Spans {
			starts: &starts,
			ends: &ends,
			tags: &tags,
		}),
	};
	let pieces: Vec<Piece> = doc["pieces"]
		.as_array()
		.unwrap()
		.iter()
		.map(|p| Piece {
			id: p[0].as_u64().unwrap() as u32,
			begin: p[1].as_u64().unwrap() as usize,
			end: p[2].as_u64().unwrap() as usize,
		})
		.collect();
	encoder.encode_rows(&[row], |_, _| Ok(pieces.clone())).unwrap()
}

fn ints(v: &Value) -> Vec<i64> {
	v.as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect()
}

fn float_bits(v: &Value) -> Vec<u32> {
	fn walk(v: &Value, out: &mut Vec<u32>) {
		match v {
			Value::Array(items) => items.iter().for_each(|i| walk(i, out)),
			other => out.push((other.as_f64().unwrap() as f32).to_bits()),
		}
	}
	let mut out = Vec::new();
	walk(v, &mut out);
	out
}

fn check(case: &str) {
	let doc: Value = serde_json::from_str(&read("tests/fixtures/encode-row-reference.json")).unwrap();
	let expected = doc["cases"][case].as_object().unwrap();
	let batch = encode(&doc, case);
	assert_eq!(batch.input_ids, ints(&expected["input_ids"]), "{case}: input_ids");
	assert_eq!(
		batch.attention_mask,
		ints(&expected["attention_mask"]),
		"{case}: attention_mask"
	);
	assert_eq!(batch.labels, ints(&expected["labels"]), "{case}: labels");
	let mut keys = vec![
		"input_ids".to_string(),
		"attention_mask".to_string(),
		"labels".to_string(),
	];
	for channel in &batch.channels {
		let bits = |v: &[f32]| v.iter().map(|f| f.to_bits()).collect::<Vec<_>>();
		let name = channel.name;
		assert_eq!(
			bits(&channel.features),
			float_bits(&expected[&format!("{name}_features")]),
			"{case}: {name} features"
		);
		assert_eq!(
			bits(&channel.confidence),
			float_bits(&expected[&format!("{name}_confidence")]),
			"{case}: {name} confidence"
		);
		keys.push(format!("{name}_features"));
		keys.push(format!("{name}_confidence"));
	}
	let mut expected_keys: Vec<String> = expected.keys().cloned().collect();
	expected_keys.sort();
	keys.sort();
	assert_eq!(keys, expected_keys, "{case}: the emitted keys");
	assert!(CHANNEL_NAMES.len() >= batch.channels.len());
}

#[test]
fn the_token_label_source_matches_the_record() {
	check("tokens");
}

#[test]
fn the_span_label_source_matches_the_record() {
	check("spans");
}

#[test]
fn the_shaped_anchor_matches_the_record() {
	check("shaped_anchor");
}

#[test]
fn a_row_without_channels_matches_the_record() {
	check("no_channels");
}
