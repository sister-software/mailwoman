// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Recognition end to end: captures on accepted spans, validation before payloads, the generated declarations, the
//! declarations hash, and capture programs built from regular-expression strings.

mod support;

use recognizer_build::{codegen, compile_families, compile_family, Limits};
use recognizer_core::artifact::{assemble, parse, ArtifactError};
use recognizer_core::declared::{self, Kind};
use recognizer_core::grammars::{coordinates, primitives};
use recognizer_core::{CaptureType, Declarations, DiagnosticKind, Engine, Expected, Family, Scope, ValidationResult};

use support::engine_for;

fn repository_engine() -> Engine {
	engine_for(recognizer_core::grammars::families())
}

#[test]
fn a_decimal_pair_is_validated_into_a_typed_payload() {
	let engine = repository_engine();
	let text = "at 40.7128, -74.0060 now";
	let recognitions = engine.recognize(text).unwrap();
	let pair = recognitions
		.iter()
		.find(|recognition| recognition.candidate.shape == "coordinate.decimal_pair")
		.expect("the pair is recognized");

	assert_eq!((pair.candidate.start, pair.candidate.end), (3, 20));
	assert_eq!(pair.text, "40.7128, -74.0060");
	assert!(matches!(pair.kind, Some(Kind::Coordinates(_))));

	match &pair.validation {
		ValidationResult::Validated(payload) => assert_eq!(
			serde_json::to_string(payload).unwrap(),
			r#"{"latitude":40.7128,"longitude":-74.006,"order":"lat_lon"}"#
		),
		other => panic!("expected a validated payload, got {other:?}"),
	}
}

#[test]
fn a_shape_without_a_validator_carries_its_span_and_text_only() {
	let engine = repository_engine();
	let recognitions = engine.recognize("ab 12").unwrap();
	let word = recognitions
		.iter()
		.find(|recognition| recognition.candidate.shape == "word.ascii")
		.unwrap();

	assert_eq!(word.text, "ab");
	assert_eq!(word.validation, ValidationResult::Unvalidated);
}

#[test]
fn a_span_whose_values_fail_validation_is_rejected_with_its_reason() {
	let engine = repository_engine();
	let text = format!("{}, 1", "9".repeat(400));
	let recognitions = engine.recognize(&text).unwrap();
	let pair = recognitions
		.iter()
		.find(|recognition| recognition.candidate.shape == "coordinate.decimal_pair")
		.unwrap();

	match &pair.validation {
		ValidationResult::Rejected(rejection) => {
			assert_eq!(rejection.code, "not_finite");
			assert_eq!(rejection.capture.as_deref(), Some("first"));
		}
		other => panic!("expected a rejection, got {other:?}"),
	}
}

#[test]
fn recognitions_can_be_limited_to_the_families_a_caller_composes() {
	let engine = repository_engine();
	let ids = engine.family_ids();
	let coordinates_only = engine
		.recognize_in("1, 2", |index| ids[index] == "coordinates")
		.unwrap();

	assert!(!coordinates_only.is_empty());
	assert!(coordinates_only
		.iter()
		.all(|recognition| recognition.candidate.family == "coordinates"));
}

#[test]
fn the_generated_declarations_match_the_grammars() {
	for family in recognizer_core::grammars::families() {
		let document = family.build().unwrap();
		let declarations = Declarations::from_ir(&document);

		assert_eq!(
			declared::declarations_hash(&document.family),
			Some(declarations.hash().as_str()),
			"run tools/generate.run.ts: the declarations of `{}` are stale",
			document.family
		);

		for shape in &declarations.shapes {
			let kind = declared::kind(&document.family, &shape.id)
				.unwrap_or_else(|| panic!("`{}` has no generated kind", shape.id));

			assert_eq!(kind.shape(), shape.id);
			assert_eq!(kind.validated(), shape.validator.is_some());
		}
	}
}

#[test]
fn the_generated_files_are_what_the_generator_writes() {
	let documents = support::documents(recognizer_core::grammars::families());
	let all: Vec<Declarations> = documents.iter().map(Declarations::from_ir).collect();
	let declared_rs = std::fs::read_to_string(concat!(
		env!("CARGO_MANIFEST_DIR"),
		"/../recognizer-core/src/declared.rs"
	))
	.unwrap();

	// The committed text passed through rustfmt, so compare the module list and the hashes it carries.
	for declarations in &all {
		assert!(declared_rs.contains(&format!("pub mod {};", codegen::module_name(&declarations.family))));
		assert!(codegen::rust_family(declarations)
			.unwrap()
			.contains(&declarations.hash()));
	}
}

#[test]
fn a_payload_serializes_the_fields_the_declarations_list() {
	let engine = repository_engine();

	for family in ["coordinates"] {
		let document = support::documents(vec![coordinates::family()]).remove(0);
		let declarations = Declarations::from_ir(&document);

		for shape in declarations.shapes.iter().filter(|shape| shape.validator.is_some()) {
			// A text that fills every field, optional ones included.
			let text = match shape.id.as_str() {
				"coordinate.decimal_pair" => "1.5, 2.5",
				"coordinate.decimal_pair_spaced" => "1.5 2.5",
				"coordinate.dms_pair" => "1.5N, 2.5E",
				"coordinate.dms_pair_spaced" => "1.5N 2.5E",
				"coordinate.labeled_pair" => "lat 1.5 lon 2.5",
				"coordinate.maps_segment" => "@1.5,2.5,17z",
				_ => "geo:1.5,2.5,3;u=4",
			};
			let recognition = engine
				.recognize(text)
				.unwrap()
				.into_iter()
				.find(|recognition| recognition.candidate.shape == shape.id)
				.unwrap_or_else(|| panic!("{family}: no recognition of `{}`", shape.id));
			let ValidationResult::Validated(payload) = recognition.validation else {
				panic!("`{}` did not validate", shape.id)
			};
			let value = serde_json::to_value(payload).unwrap();
			let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
			let mut declared_keys: Vec<&str> = shape.payload.iter().map(|field| field.name).collect();

			keys.sort();
			declared_keys.sort();
			assert_eq!(keys, declared_keys, "`{}`", shape.id);
		}
	}
}

#[test]
fn an_artifact_whose_declarations_hash_differs_from_the_crates_is_refused_with_both_hashes() {
	let built = compile_families(vec![coordinates::family()], &Limits::default()).unwrap();
	let artifact = parse(&built[0].compiled.artifact).unwrap();
	let mut header = artifact.header.clone();

	header.declarations_hash = "ab".repeat(32);

	let other = assemble(&header, &artifact.payloads, artifact.captures).unwrap();
	let error = Engine::new().load(&other).unwrap_err();

	assert!(matches!(error, ArtifactError::DeclarationsHash { .. }));

	let message = error.to_string();

	assert!(message.contains(&"ab".repeat(32)), "{message}");
	assert!(
		message.contains(declared::declarations_hash("coordinates").unwrap()),
		"{message}"
	);
}

#[test]
fn the_caller_can_pin_the_declarations_hash_it_holds() {
	let built = compile_families(vec![primitives::family()], &Limits::default()).unwrap();
	let mut engine = Engine::new();
	let error = engine
		.load_checked(
			&built[0].compiled.artifact,
			&Expected {
				ir_hash: None,
				declarations_hash: Some(&"0".repeat(64)),
			},
		)
		.unwrap_err();

	assert!(matches!(error, ArtifactError::DeclarationsHash { .. }));
}

fn pattern_family(regex: &str, captures: &[&str]) -> Family {
	let mut shape = recognizer_core::shape("pattern.shape")
		.regex(regex)
		.scope(Scope::WholeOrEmbedded);

	for capture in captures {
		shape = shape.capture(capture, CaptureType::Text);
	}

	Family::new("patterns").shape(shape)
}

#[test]
fn a_regular_expression_shape_makes_its_named_groups_captures() {
	let family = pattern_family(r"(?P<unit>[a-z]+)-(?P<number>\d+)(?:x)?", &["unit", "number"]);
	let document = family.build().unwrap();
	let compiled = compile_family(&document, &Limits::default()).unwrap();
	let mut engine = Engine::new();

	engine.load(&compiled.artifact).unwrap();

	let text = "see ab-12x";
	let program = parse(&compiled.artifact).unwrap();
	let program = recognizer_core::captures::CaptureProgram::from_bytes(program.captures).unwrap();
	let candidates = engine.search(text).unwrap();
	let candidate = candidates
		.iter()
		.find(|candidate| candidate.shape == "pattern.shape")
		.unwrap();
	let captures =
		recognizer_core::captures::extract(&program, "pattern.shape", text, candidate.start, candidate.end).unwrap();

	assert_eq!(captures.get("unit"), Some("ab"));
	assert_eq!(captures.get("number"), Some("12"));
}

#[test]
fn a_regular_expression_capture_the_schema_does_not_declare_is_refused() {
	// Every shape has a program since traces replay it, so a group a shape never declared is refused even when the
	// shape declares no captures at all.
	let undeclared = compile_family(
		&pattern_family(r"(?P<unit>[a-z]+)\d", &[]).build().unwrap(),
		&Limits::default(),
	)
	.unwrap_err();

	assert!(undeclared
		.iter()
		.any(|diagnostic| diagnostic.message.contains("`unit`")
			&& diagnostic.message.contains("not in the capture schema")));

	let refused = compile_family(
		&pattern_family(r"(?P<unit>[a-z]+)\d", &["other"]).build().unwrap(),
		&Limits::default(),
	)
	.unwrap_err();
	let messages: Vec<&str> = refused.iter().map(|diagnostic| diagnostic.message.as_str()).collect();

	assert!(messages
		.iter()
		.any(|message| message.contains("`unit`") && message.contains("not in the capture schema")));
	assert!(messages
		.iter()
		.any(|message| message.contains("`other`") && message.contains("never makes it")));
	assert!(refused
		.iter()
		.all(|diagnostic| diagnostic.kind == DiagnosticKind::CaptureSchemaMismatch));
}

#[test]
fn a_regular_expression_capture_under_a_repeat_or_with_a_dotted_path_is_refused() {
	let under_repeat = compile_family(
		&pattern_family(r"(?P<unit>[a-z])+\d", &["unit"]).build().unwrap(),
		&Limits::default(),
	)
	.unwrap_err();

	assert!(under_repeat[0].message.contains("repeat"));

	// A regular expression cannot spell a dotted group name; the parser refuses it before the compiler sees it.
	let dotted = compile_family(
		&pattern_family(r"(?P<unit.name>[a-z])\d", &["unit.name"])
			.build()
			.unwrap(),
		&Limits::default(),
	);

	assert!(dotted.is_err());
}
