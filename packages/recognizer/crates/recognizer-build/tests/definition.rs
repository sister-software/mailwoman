// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! A family defined as data: the definition format validates against its schema, a definition that declares a capture, a
//! validator or a handler is refused, and the compiled family drives the engine's known-formats pass.

mod validator;

use std::path::PathBuf;

use recognizer_build::definition::read;
use recognizer_build::{build_documents, Limits};
use recognizer_core::known_formats::{HitKind, KnownFormats, NO_SHAPE};
use recognizer_core::structure::Structure;
use recognizer_core::{Engine, IrDocument};
use serde_json::{json, Value};

fn package_path(segments: &[&str]) -> PathBuf {
	let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");

	path.extend(segments);

	path
}

fn schema() -> Value {
	let text = std::fs::read_to_string(package_path(&["definitions", "family-definition.schema.json"]))
		.expect("the schema is committed");

	serde_json::from_str(&text).expect("the schema is JSON")
}

fn sample() -> Value {
	json!({
		"format": "mailwoman.recognizer.family-definition",
		"version": 1,
		"family": "sample_formats",
		"shapes": [
			{ "id": "format.zip", "pattern": "[0-9]{5}", "overlaps": ["format.other"], "order": 1,
			  "metadata": { "confidence": 0.6 } },
			{ "id": "format.other", "pattern": "[0-9]{5}", "order": 0 },
			{ "id": "format.pair", "pattern": "(?i-u:[A-Z]{2} [0-9]{2})", "order": 2 },
			{ "id": "words.en", "role": "po_box_leader", "pattern": "(?i-u:po|p\\.o\\.|box)" }
		]
	})
}

fn engine_for_definition(definition: &Value) -> Engine {
	let read = read("sample.definition.json", &definition.to_string()).expect("the definition reads");
	let documents: Vec<IrDocument> = vec![
		recognizer_core::grammars::structure::family().build().unwrap(),
		read.document,
	];
	let build = build_documents(documents, &Limits::default()).expect("the families build");
	let mut engine = Engine::new();

	for family in &build.families {
		engine.load(&family.compiled.artifact).expect("the artifact loads");
	}

	engine
}

#[test]
fn the_committed_postcode_definition_validates_against_the_schema_and_builds() {
	let text = std::fs::read_to_string(package_path(&[
		"..",
		"postcode",
		"data",
		"definitions",
		"postcode_legacy.definition.json",
	]))
	.expect("the definition is committed");
	let value: Value = serde_json::from_str(&text).unwrap();

	assert_eq!(validator::violations(&schema(), &value), Vec::<String>::new());

	let definition = read("postcode_legacy.definition.json", &text).expect("the definition reads");

	build_documents(vec![definition.document], &Limits::default()).expect("the family builds");
}

#[test]
fn a_definition_that_declares_a_capture_a_validator_or_a_handler_is_refused() {
	for key in ["captures", "validator", "handler"] {
		let mut definition = sample();

		definition["shapes"][1][key] = json!("x");

		let text = serde_json::to_string_pretty(&definition).unwrap();
		let diagnostics = read("sample.definition.json", &text).expect_err("the definition is refused");
		let rendered = recognizer_build::render_diagnostics(&diagnostics);

		assert!(rendered.contains("format.other"), "{rendered}");
		assert!(rendered.contains(key) && rendered.contains("shape-only"), "{rendered}");
		assert!(rendered.contains("sample.definition.json:"), "{rendered}");
	}
}

#[test]
fn the_schema_refuses_what_the_reader_refuses() {
	let mut definition = sample();

	definition["shapes"][0]["validator"] = json!("Money");

	assert!(!validator::violations(&schema(), &definition).is_empty());
	assert_eq!(validator::violations(&schema(), &sample()), Vec::<String>::new());
}

#[test]
fn an_assertion_in_a_pattern_is_refused_by_the_compiler() {
	let mut definition = sample();

	definition["shapes"][0]["pattern"] = json!("^[0-9]{5}$");

	let read = read("sample.definition.json", &definition.to_string()).unwrap();
	let diagnostics = build_documents(vec![read.document], &Limits::default()).unwrap_err();

	assert!(recognizer_build::render_diagnostics(&diagnostics).contains("assertion"));
}

#[test]
fn the_known_formats_pass_reports_token_pair_and_po_box_hits_in_order() {
	let engine = engine_for_definition(&sample());
	// The engine loads families in the order of their IDs.
	let (structure_at, formats_at) = (1, 0);
	let shapes: Vec<String> = engine.shapes(formats_at).to_vec();
	let text = "Box 12345, ab 12";
	let mut structure = Structure::default();
	let mut known = KnownFormats::default();

	assert_eq!(engine.family_ids(), vec!["sample_formats", "structure"]);

	engine.structure(structure_at, text, &mut structure).unwrap();
	engine.known_formats(formats_at, text, &structure, &mut known).unwrap();

	let hits: Vec<(HitKind, String, &str)> = known
		.hits
		.iter()
		.map(|hit| {
			(
				hit.kind,
				if hit.shape == NO_SHAPE {
					"po_box".to_string()
				} else {
					shapes[hit.shape as usize].clone()
				},
				&text[hit.start as usize..hit.end as usize],
			)
		})
		.collect();

	assert_eq!(
		hits,
		vec![
			// `format.zip` has order 1 and `format.other` order 0, and by ID alone `format.other` also sorts first, so
			// the next test flips the orders to separate the two rules.
			(HitKind::Token, "format.other".to_string(), "12345"),
			(HitKind::Token, "format.zip".to_string(), "12345"),
			(HitKind::Pair, "format.pair".to_string(), "ab 12"),
			(HitKind::POBox, "po_box".to_string(), "Box 12345"),
		]
	);
}

#[test]
fn the_order_field_decides_the_hit_order_and_an_id_prefix_decides_nothing() {
	let mut definition = sample();

	definition["shapes"][0]["order"] = json!(0);
	definition["shapes"][1]["order"] = json!(1);
	// A shape whose ID starts with `leader.` and has no role is an ordinary format.
	definition["shapes"][3]["id"] = json!("leader.en");
	definition["shapes"][3].as_object_mut().unwrap().remove("role");

	let engine = engine_for_definition(&definition);
	let shapes: Vec<String> = engine.shapes(0).to_vec();
	let text = "12345";
	let mut structure = Structure::default();
	let mut known = KnownFormats::default();

	engine.structure(1, text, &mut structure).unwrap();
	engine.known_formats(0, text, &structure, &mut known).unwrap();

	let names: Vec<&str> = known
		.hits
		.iter()
		.map(|hit| shapes[hit.shape as usize].as_str())
		.collect();

	assert_eq!(names, vec!["format.zip", "format.other"]);
}

#[test]
fn a_token_boundary_drops_the_embedded_matches_that_touch_a_letter_a_digit_or_a_connector() {
	let definition = json!({
		"format": "mailwoman.recognizer.family-definition",
		"version": 1,
		"family": "sample_bounded",
		"shapes": [
			{ "id": "bounded.five", "pattern": "[0-9]{5}", "scope": "whole_or_embedded", "boundary": "token",
			  "overlaps": ["free.five"] },
			{ "id": "free.five", "pattern": "[0-9]{5}", "scope": "whole_or_embedded" }
		]
	});

	assert_eq!(validator::violations(&schema(), &definition), Vec::<String>::new());

	let read = read("sample.definition.json", &definition.to_string()).expect("the definition reads");
	let build = build_documents(vec![read.document], &Limits::default()).expect("the family builds");
	let mut engine = Engine::new();

	engine.load(&build.families[0].compiled.artifact).unwrap();

	let text = "123456 12345 x12345 12345-6 東12345京 12345";
	let spans_of = |shape: &str| -> Vec<usize> {
		engine
			.search(text)
			.unwrap()
			.into_iter()
			.filter(|found| found.shape == shape)
			.map(|found| found.start)
			.collect()
	};
	let bounded: Vec<&str> = spans_of("bounded.five")
		.iter()
		.map(|start| &text[*start..*start + 5])
		.collect();

	assert_eq!(bounded, vec!["12345", "12345", "12345"]);
	// Byte offsets: the ideographs are three bytes each.
	assert_eq!(spans_of("bounded.five"), vec![7, 31, 40]);
	// The shape with no boundary reports every window, including the ones inside a longer run.
	assert!(spans_of("free.five").len() > 3);
	// A match of the whole text has no neighbor and is always reported.
	assert_eq!(
		engine
			.search("12345")
			.unwrap()
			.iter()
			.filter(|found| found.shape == "bounded.five")
			.count(),
		1
	);
	assert!(read_boundary_is_refused());
}

#[test]
fn an_alnum_boundary_drops_the_matches_that_touch_a_letter_or_a_digit_and_admits_a_connector() {
	let definition = json!({
		"format": "mailwoman.recognizer.family-definition",
		"version": 1,
		"family": "sample_alnum",
		"shapes": [
			{ "id": "alnum.five", "pattern": "[0-9]{5}", "scope": "whole_or_embedded", "boundary": "alnum" }
		]
	});

	assert_eq!(validator::violations(&schema(), &definition), Vec::<String>::new());

	let read = read("sample.definition.json", &definition.to_string()).expect("the definition reads");
	let build = build_documents(vec![read.document], &Limits::default()).expect("the family builds");
	let mut engine = Engine::new();

	engine.load(&build.families[0].compiled.artifact).unwrap();

	// A digit, a letter or a hyphen-joined run: only the hyphen lets a code stand beside it.
	let text = "123456 x12345 12345y Lahore-54000 FI-FI-01730 54_321 12345";
	let found: Vec<&str> = engine
		.search(text)
		.unwrap()
		.into_iter()
		.map(|candidate| &text[candidate.start..candidate.end])
		.collect();

	assert_eq!(found, vec!["54000", "01730", "12345"]);
}

fn read_boundary_is_refused() -> bool {
	let mut definition = sample();

	definition["shapes"][1]["boundary"] = json!("word");

	read("sample.definition.json", &definition.to_string()).is_err()
}

#[test]
fn an_unknown_role_or_a_bad_order_is_refused() {
	for (key, value) in [("role", json!("page")), ("order", json!(-1)), ("order", json!("first"))] {
		let mut definition = sample();

		definition["shapes"][1][key] = value;

		assert!(
			read("sample.definition.json", &definition.to_string()).is_err(),
			"{key} was accepted"
		);
	}
}

#[test]
fn a_family_with_no_whole_shape_is_refused_by_the_pass() {
	let mut engine = Engine::new();
	let build =
		recognizer_build::build_families(vec![recognizer_core::grammars::structure::family()], &Limits::default())
			.unwrap();

	engine.load(&build.families[0].compiled.artifact).unwrap();

	let mut structure = Structure::default();
	let mut known = KnownFormats::default();

	engine.structure(0, "a", &mut structure).unwrap();

	assert!(engine.known_formats(0, "a", &structure, &mut known).is_err());
}
