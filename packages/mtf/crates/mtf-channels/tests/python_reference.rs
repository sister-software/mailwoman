// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Compares the finders and the string operations with the answers the Python implementations recorded.
//!
//! `fixtures/python-reference.json` holds, for a list of adversarial texts, the Python postcode shapes, code units
//! with acceptance counts, and `lower`, `upper` and `strip`. For each template it also holds every scalar value
//! grouped by the answer it gives when placed in the template. The default test checks each group's range ends and
//! a stride through each range; `every_scalar_value_in_every_template` checks all of them and is run in release
//! mode with `--ignored`.

#![cfg(feature = "finders")]

use mtf_channels::code_units::segment;
use mtf_channels::finders::{PostcodeShapes, PostcodeSyntax};
use mtf_channels::python_text::{lower, strip, upper, UNICODE_VERSION};
use serde_json::{json, Value};
use std::path::PathBuf;

fn path(relative: &str) -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn read(relative: &str) -> String {
	std::fs::read_to_string(path(relative)).unwrap_or_else(|e| panic!("cannot read {relative}: {e}"))
}

struct Fixture {
	doc: Value,
	shapes: PostcodeShapes,
	syntax: PostcodeSyntax,
}

fn fixture() -> Fixture {
	let shapes_path = "../../../../corpus-python/src/mailwoman_train/features/postcode-shapes.json";
	let syntax_path = "../../../../corpus-python/src/mailwoman_train/data/postcode-syntax.json";
	Fixture {
		doc: serde_json::from_str(&read("tests/fixtures/python-reference.json")).expect("the fixture is JSON"),
		shapes: PostcodeShapes::from_record(&read(shapes_path), shapes_path).expect("the shapes compile"),
		syntax: PostcodeSyntax::from_json(&read(syntax_path), syntax_path).expect("the syntax compiles"),
	}
}

fn shapes(f: &Fixture, text: &str) -> Value {
	json!(f
		.shapes
		.collect_matches(text)
		.expect("matching succeeds")
		.into_iter()
		.map(|m| json!([m.start, m.end, m.kind, m.priority]))
		.collect::<Vec<_>>())
}

fn units(f: &Fixture, text: &str) -> Value {
	let chars: Vec<char> = text.chars().collect();
	json!(segment(&chars)
		.into_iter()
		.map(|(s, e)| json!([s, e, f.syntax.accepting(&chars[s..e]).expect("acceptance succeeds")]))
		.collect::<Vec<_>>())
}

#[test]
fn the_fixture_was_recorded_under_the_tables_unicode_version() {
	assert_eq!(fixture().doc["unicode"], UNICODE_VERSION);
}

#[test]
fn every_adversarial_text_matches_python() {
	let f = fixture();
	for case in f.doc["texts"].as_array().expect("texts") {
		let text = case["text"].as_str().expect("text");
		let chars: Vec<char> = text.chars().collect();
		assert_eq!(lower(&chars), case["lower"].as_str().unwrap(), "lower of {text:?}");
		assert_eq!(upper(&chars), case["upper"].as_str().unwrap(), "upper of {text:?}");
		assert_eq!(
			strip(&chars).iter().collect::<String>(),
			case["strip"].as_str().unwrap(),
			"strip of {text:?}"
		);
		if let Some(expected) = case.get("shapes") {
			assert_eq!(&shapes(&f, text), expected, "shapes of {text:?}");
		}
		if let Some(expected) = case.get("units") {
			assert_eq!(&units(&f, text), expected, "units of {text:?}");
		}
	}
}

/// Checks the scalar values of each template's groups that `select` picks from each range.
fn check_templates(select: impl Fn(u32, u32) -> Vec<u32>) {
	let f = fixture();
	let mut checked = 0usize;
	for (key, run) in [
		("shape_templates", shapes as fn(&Fixture, &str) -> Value),
		("unit_templates", units),
	] {
		for template in f.doc[key].as_array().expect("templates") {
			let pattern = template["template"].as_str().unwrap();
			for group in template["groups"].as_array().unwrap() {
				for range in group["ranges"].as_array().unwrap() {
					let (a, b) = (range[0].as_u64().unwrap() as u32, range[1].as_u64().unwrap() as u32);
					for code in select(a, b) {
						let Some(c) = char::from_u32(code) else { continue };
						let text = pattern.replace("{c}", &c.to_string());
						assert_eq!(run(&f, &text), group["answer"], "{key} {pattern:?} with U+{code:04X}");
						checked += 1;
					}
				}
			}
		}
	}
	assert!(checked > 0, "the fixture holds no template groups");
}

#[test]
fn template_range_ends_and_a_stride_match_python() {
	check_templates(|a, b| {
		let mut codes: Vec<u32> = (a..=b).step_by(997).collect();
		codes.push(b);
		codes
	});
}

#[test]
#[ignore = "checks 1.1M scalar values per template; run with --release -- --ignored"]
fn every_scalar_value_in_every_template() {
	check_templates(|a, b| (a..=b).collect());
}
