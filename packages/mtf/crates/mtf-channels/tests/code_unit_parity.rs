// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The code-unit channel reproduces `test/fixtures/code-unit-parity.json`, which the inference feed's
//! `codeUnitFeatures` and the training loader agreed on.
//!
//! Each case runs the whole path: the segmenter finds the units, the postcode syntax counts the countries
//! accepting each, and the painter projects them onto the fixture's piece ranges. The expected features come
//! from the fixture, so a wrong acceptance count fails here rather than being read back from the expectation.

#![cfg(feature = "finders")]

use mtf_channels::code_units::{channel, CODE_UNIT_FEATURE_DIM};
use mtf_channels::finders::{PostcodeShapes, PostcodeSyntax, RegexFinders};
use mtf_channels::Finders;
use serde_json::Value;
use std::path::PathBuf;

fn read(relative: &str) -> String {
	let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
	std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

#[test]
fn every_parity_case_matches_from_segmentation_to_features() {
	let shapes = "../../../../packages/trainer/data/postcode-shapes.json";
	let syntax = "../../../../packages/trainer/data/postcode-syntax.json";
	let finders = RegexFinders {
		shapes: PostcodeShapes::from_record(&read(shapes), shapes).unwrap(),
		syntax: PostcodeSyntax::from_json(&read(syntax), syntax).unwrap(),
	};
	let doc: Value = serde_json::from_str(&read("../../../../test/fixtures/code-unit-parity.json")).unwrap();
	let cases = doc["cases"].as_array().unwrap();
	assert!(!cases.is_empty());
	for case in cases {
		let text: Vec<char> = case["text"].as_str().unwrap().chars().collect();
		let spans: Vec<(usize, usize)> = case["spans"]
			.as_array()
			.unwrap()
			.iter()
			.map(|s| (s[0].as_u64().unwrap() as usize, s[1].as_u64().unwrap() as usize))
			.collect();
		let units = finders.code_units(&text).unwrap();
		let painted = channel(&text, &spans, &units);
		for (i, (expected, confidence)) in case["features"]
			.as_array()
			.unwrap()
			.iter()
			.zip(case["confidence"].as_array().unwrap())
			.enumerate()
		{
			let expected: Vec<f64> = expected
				.as_array()
				.unwrap()
				.iter()
				.map(|v| v.as_f64().unwrap())
				.collect();
			assert_eq!(expected.len(), CODE_UNIT_FEATURE_DIM);
			assert_eq!(painted.row(i), &expected[..], "{:?} piece {i}", case["text"]);
			assert_eq!(
				painted.confidence[i],
				confidence.as_f64().unwrap(),
				"{:?} piece {i}",
				case["text"]
			);
		}
	}
}

#[test]
fn acceptance_counts_match_known_postcodes() {
	let syntax = "../../../../packages/trainer/data/postcode-syntax.json";
	let syntax = PostcodeSyntax::from_json(&read(syntax), syntax).unwrap();
	let count = |s: &str| syntax.accepting(&s.chars().collect::<Vec<_>>()).unwrap();
	assert_eq!(count("SW1A"), 1);
	assert_eq!(count("10118-0110"), 1);
	assert!(count("28013") > 20);
}
