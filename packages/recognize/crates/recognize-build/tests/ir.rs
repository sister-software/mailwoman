// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

mod validator;

use std::path::PathBuf;

use recognize_build::{emit, emit_repository_families};
use recognize_core::{capture, class, one_or_more, render, shape, term, CaptureType, Family, IrDocument, Scope};
use serde_json::Value;

fn package_path(segments: &[&str]) -> PathBuf {
	let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");

	path.extend(segments);

	path
}

fn schema() -> Value {
	let text =
		std::fs::read_to_string(package_path(&["definitions", "ir.schema.json"])).expect("the schema is committed");

	serde_json::from_str(&text).expect("the schema is JSON")
}

#[test]
fn two_generations_are_byte_identical() {
	let first = emit_repository_families().expect("the repository families validate");
	let second = emit_repository_families().expect("the repository families validate");

	assert_eq!(first, second);
	assert!(!first.is_empty());
}

#[test]
fn the_hash_is_stable_across_a_read_and_a_write() {
	for ir in emit_repository_families().unwrap() {
		let document = IrDocument::from_json(&ir.json).expect("emitted IR reads back");

		assert_eq!(document.hash, ir.hash);
		assert_eq!(document.to_json(), ir.json);
	}
}

#[test]
fn emitted_ir_validates_against_the_schema() {
	let schema = schema();

	for ir in emit_repository_families().unwrap() {
		let value: Value = serde_json::from_str(&ir.json).unwrap();

		assert_eq!(
			validator::violations(&schema, &value),
			Vec::<String>::new(),
			"{}",
			ir.family
		);
	}
}

#[test]
fn a_family_with_captures_validates_against_the_schema() {
	let family = Family::new("sample").term(term("digit", class(&[('0', '9')]))).shape(
		shape("sample.pair")
			.grammar(capture("left", one_or_more(recognize_core::reference("digit"))))
			.capture("left", CaptureType::Integer)
			.scope(Scope::Embedded)
			.validator("RangeCheck")
			.handler("SamplePair")
			.may_overlap(&["other.shape"]),
	);

	let emitted = emit(vec![family]).unwrap().remove(0);
	let value: Value = serde_json::from_str(&emitted.json).unwrap();

	assert_eq!(validator::violations(&schema(), &value), Vec::<String>::new());
}

#[test]
fn the_schema_validator_refuses_a_broken_document() {
	let schema = schema();
	let ir = emit_repository_families().unwrap().remove(0);
	let mut value: Value = serde_json::from_str(&ir.json).unwrap();

	value["shapes"][0]["grammar"]["op"] = Value::String("lookahead".into());
	value["version"] = Value::from(2);

	assert!(validator::violations(&schema, &value).len() >= 2);
}

#[test]
fn the_committed_ir_matches_the_generator() {
	for ir in emit_repository_families().unwrap() {
		let committed = std::fs::read_to_string(package_path(&["data", "ir", &ir.file_name()]))
			.unwrap_or_else(|error| panic!("data/ir/{} is not committed: {error}", ir.file_name()));

		// The committed file is the writer's text after the repository formatter, so compare what it means.
		let read = IrDocument::from_json(&committed)
			.unwrap_or_else(|diagnostics| panic!("data/ir/{} is invalid:\n{}", ir.file_name(), render(&diagnostics)));

		assert_eq!(
			read,
			IrDocument::from_json(&ir.json).unwrap(),
			"run tools/generate.run.ts to regenerate data/ir/{}",
			ir.file_name()
		);
		assert_eq!(read.hash, ir.hash);
	}
}
