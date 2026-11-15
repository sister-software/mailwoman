// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! A family defined as data: the definition format validates against its schema, a definition that declares a capture, a
//! validator or a handler is refused, and the compiled family drives the engine's known-formats pass.

mod validator;

use std::path::PathBuf;

use recognize_build::definition::read;
use recognize_build::{build_documents, Limits};
use recognize_core::known_formats::{HitKind, KnownFormats, NO_SHAPE};
use recognize_core::structure::Structure;
use recognize_core::{Engine, IrDocument};
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
		"format": "mailwoman.recognize.family-definition",
		"version": 1,
		"family": "sample_formats",
		"shapes": [
			{ "id": "format.one_0_zip", "pattern": "[0-9]{5}", "overlaps": ["format.one_1_other"],
			  "metadata": { "confidence": 0.6 } },
			{ "id": "format.one_1_other", "pattern": "[0-9]{5}" },
			{ "id": "format.two_2_pair", "pattern": "(?i-u:[A-Z]{2} [0-9]{2})" },
			{ "id": "leader.en", "pattern": "(?i-u:po|p\\.o\\.|box)" }
		]
	})
}

fn engine_for_definition(definition: &Value) -> Engine {
	let read = read("sample.definition.json", &definition.to_string()).expect("the definition reads");
	let documents: Vec<IrDocument> = vec![
		recognize_core::grammars::structure::family().build().unwrap(),
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
		let rendered = recognize_build::render_diagnostics(&diagnostics);

		assert!(rendered.contains("format.one_1_other"), "{rendered}");
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

	assert!(recognize_build::render_diagnostics(&diagnostics).contains("assertion"));
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
			(HitKind::Token, "format.one_0_zip".to_string(), "12345"),
			(HitKind::Token, "format.one_1_other".to_string(), "12345"),
			(HitKind::Pair, "format.two_2_pair".to_string(), "ab 12"),
			(HitKind::POBox, "po_box".to_string(), "Box 12345"),
		]
	);
}

#[test]
fn a_family_with_no_whole_shape_is_refused_by_the_pass() {
	let mut engine = Engine::new();
	let build =
		recognize_build::build_families(vec![recognize_core::grammars::structure::family()], &Limits::default())
			.unwrap();

	engine.load(&build.families[0].compiled.artifact).unwrap();

	let mut structure = Structure::default();
	let mut known = KnownFormats::default();

	engine.structure(0, "a", &mut structure).unwrap();

	assert!(engine.known_formats(0, "a", &structure, &mut known).is_err());
}
