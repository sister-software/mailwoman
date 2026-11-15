// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Overlap analysis: unreachable shapes, equivalent shapes, shared strings and their witnesses, the committed report,
//! and the witness fixture.

mod support;

use std::path::PathBuf;

use recognize_build::{build_families, build_repository_families, Analysis, Limits, Overlap};
use recognize_core::{
	class, literal, negated_class, one_or_more, repeat, repeat_from, sequence, shape, DiagnosticKind, Engine, Family,
	Scope,
};
use serde_json::Value;

use support::{documents, strings_up_to, Interpreter};

fn package_path(segments: &[&str]) -> PathBuf {
	let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");

	path.extend(segments);

	path
}

fn any_character() -> recognize_core::Node {
	class(&[('\0', '\u{10FFFF}')])
}

fn analysis_of(families: Vec<Family>) -> Analysis {
	build_families(families, &Limits::default())
		.unwrap_or_else(|diagnostics| panic!("the families do not build:\n{}", recognize_core::render(&diagnostics)))
		.analysis
}

fn overlap<'a>(analysis: &'a Analysis, a: &str, b: &str) -> Option<&'a Overlap> {
	analysis
		.overlaps
		.iter()
		.find(|found| (found.a.shape == a && found.b.shape == b) || (found.a.shape == b && found.b.shape == a))
}

#[test]
fn a_shape_with_an_empty_language_fails_the_build_unless_it_declares_it() {
	let empty = || negated_class(&[('\0', '\u{10FFFF}')]);
	let refused = build_families(
		vec![Family::new("empty").shape(shape("empty.never").grammar(empty()).scope(Scope::Whole))],
		&Limits::default(),
	)
	.unwrap_err();

	assert_eq!(refused.len(), 1, "{refused:#?}");
	assert_eq!(refused[0].kind, DiagnosticKind::Unreachable);
	// The diagnostic points at the declaration of the shape, which is a line of this file.
	assert!(refused[0].source.file.ends_with("tests/analysis.rs"), "{}", refused[0]);
	assert!(refused[0].message.contains("empty.never"), "{}", refused[0]);

	let declared = build_families(
		vec![Family::new("empty").shape(
			shape("empty.never")
				.grammar(empty())
				.scope(Scope::Whole)
				.declare_unreachable("a placeholder for a grammar a later phase writes"),
		)],
		&Limits::default(),
	)
	.expect("a declared unreachable shape builds");

	assert_eq!(declared.analysis.unreachable.len(), 1);
	assert_eq!(
		declared.analysis.unreachable[0].declared.as_deref(),
		Some("a placeholder for a grammar a later phase writes")
	);
	// The declaration is part of the IR and survives a read.
	let read = recognize_core::IrDocument::from_json(&declared.families[0].ir.json).expect("the IR reads back");

	assert!(read.shapes[0].unreachable.is_some());

	let report: Value = serde_json::from_str(&declared.report_json()).unwrap();

	assert_eq!(
		report["families"]["empty"]["unreachable"],
		serde_json::json!(["empty.never"])
	);
	assert_eq!(
		report["families"]["empty"]["shapes"][0]["unreachable"]["declared"],
		"a placeholder for a grammar a later phase writes"
	);
}

#[test]
fn a_declaration_on_a_shape_that_can_be_reported_is_refused() {
	let refused = build_families(
		vec![Family::new("fine").shape(
			shape("fine.digits")
				.grammar(one_or_more(class(&[('0', '9')])))
				.scope(Scope::Whole)
				.declare_unreachable("wrongly declared"),
		)],
		&Limits::default(),
	)
	.unwrap_err();

	assert_eq!(refused[0].kind, DiagnosticKind::Unreachable);
	assert!(
		refused[0].message.contains("declares itself unreachable"),
		"{}",
		refused[0]
	);
}

#[test]
fn an_embedded_shape_that_every_search_would_report_as_the_whole_text_is_unreachable() {
	// Any run of three or more characters: each match extends to a longer one on both sides, so no search reports a
	// span of it that is not the whole text.
	let refused = build_families(
		vec![Family::new("wide").shape(
			shape("wide.long_run")
				.grammar(repeat_from(any_character(), 3))
				.scope(Scope::Embedded),
		)],
		&Limits::default(),
	)
	.unwrap_err();

	assert_eq!(refused[0].kind, DiagnosticKind::Unreachable);
	assert!(refused[0].message.contains("wide.long_run"), "{}", refused[0]);

	// The same grammar over the whole text, and an embedded grammar that does not extend, are both reachable.
	let analysis = analysis_of(vec![Family::new("wide")
		.shape(
			shape("wide.whole_run")
				.grammar(repeat_from(any_character(), 3))
				.scope(Scope::Whole),
		)
		.shape(
			shape("wide.three_digits")
				.grammar(repeat(class(&[('0', '9')]), 3, 3))
				.scope(Scope::Embedded),
		)
		.shape(
			// A match extends to the right and not to the left: a text that starts with another character holds it.
			shape("wide.digits_after_letter")
				.grammar(sequence([literal("x"), one_or_more(class(&[('0', '9')]))]))
				.scope(Scope::Embedded),
		)]);

	assert!(analysis.unreachable.is_empty(), "{:?}", analysis.unreachable);
}

#[test]
fn equivalent_shapes_are_reported_and_a_longer_shape_is_only_an_overlap() {
	let a = || class(&[('a', 'a')]);
	let analysis = analysis_of(vec![Family::new("eq")
		.shape(shape("eq.plus").grammar(one_or_more(a())).scope(Scope::Whole))
		.shape(
			shape("eq.sequence")
				.grammar(sequence([a(), recognize_core::zero_or_more(a())]))
				.scope(Scope::Whole),
		)
		.shape(shape("eq.two_or_more").grammar(repeat_from(a(), 2)).scope(Scope::Whole))]);
	let same = overlap(&analysis, "eq.plus", "eq.sequence").expect("the equivalent pair overlaps");
	let nested = overlap(&analysis, "eq.plus", "eq.two_or_more").expect("the nested pair overlaps");

	assert!(same.equivalent);
	assert_eq!(same.witness, "a");
	assert!(!nested.equivalent);
	assert_eq!(nested.witness, "aa");
	assert!(!same.declared && !nested.declared);
}

#[test]
fn a_witness_is_the_shortest_string_in_both_languages_and_may_be_multibyte() {
	let analysis = analysis_of(vec![Family::new("w")
		.shape(
			shape("w.three_lower")
				.grammar(repeat(class(&[('a', 'z')]), 3, 3))
				.scope(Scope::Whole),
		)
		.shape(
			shape("w.abc_run")
				.grammar(one_or_more(class(&[('a', 'c')])))
				.scope(Scope::Whole),
		)
		.shape(
			shape("w.han_run")
				.grammar(one_or_more(class(&[('\u{4e00}', '\u{9fff}')])))
				.scope(Scope::Whole),
		)
		.shape(shape("w.nihon").grammar(literal("日本")).scope(Scope::Whole))
		.shape(
			shape("w.digits")
				.grammar(one_or_more(class(&[('0', '9')])))
				.scope(Scope::Whole),
		)]);

	assert_eq!(overlap(&analysis, "w.three_lower", "w.abc_run").unwrap().witness, "aaa");
	assert_eq!(overlap(&analysis, "w.han_run", "w.nihon").unwrap().witness, "日本");
	assert!(overlap(&analysis, "w.digits", "w.abc_run").is_none());
	assert!(overlap(&analysis, "w.digits", "w.nihon").is_none());
}

#[test]
fn a_witness_is_found_by_the_reference_interpreter_and_nothing_shorter_is() {
	let families = || {
		vec![
			recognize_core::grammars::primitives::family(),
			recognize_core::grammars::coordinates::family(),
			support::probe_family(),
		]
	};
	let analysis = analysis_of(families());
	let documents = documents(families());
	let alphabet = ['0', '1', '.', '-', '+', ',', ' ', 'a', 'b', 'c'];
	let shorter = strings_up_to(&alphabet, 4);

	assert!(!analysis.overlaps.is_empty());

	for found in &analysis.overlaps {
		let shape_of = |key: &recognize_build::ShapeKey| {
			let document = documents.iter().find(|document| document.family == key.family).unwrap();

			(
				document,
				document.shapes.iter().find(|shape| shape.id == key.shape).unwrap(),
			)
		};
		let (first_document, first) = shape_of(&found.a);
		let (second_document, second) = shape_of(&found.b);
		let both = |text: &str| {
			Interpreter::new(first_document, text).accepts(first)
				&& Interpreter::new(second_document, text).accepts(second)
		};

		assert!(both(&found.witness), "{found:?}");

		// Nothing shorter in the alphabet is in both languages. A witness of more than four characters is not
		// compared, because the enumeration stops there.
		let length = found.witness.chars().count();

		for text in shorter
			.iter()
			.filter(|text| !text.is_empty() && text.chars().count() < length)
		{
			assert!(
				!both(text),
				"{text:?} is in both {} and {} and is shorter than {:?}",
				found.a.shape,
				found.b.shape,
				found.witness
			);
		}
	}
}

#[test]
fn an_overlap_across_families_is_found_and_a_declaration_in_either_direction_counts() {
	let digits = || one_or_more(class(&[('0', '9')]));
	let analysis = analysis_of(vec![
		Family::new("left").shape(
			shape("left.digits")
				.grammar(digits())
				.scope(Scope::Whole)
				.may_overlap(&["right.number"]),
		),
		Family::new("right")
			.shape(
				shape("right.number")
					.grammar(repeat(class(&[('0', '9')]), 5, 5))
					.scope(Scope::Whole),
			)
			.shape(
				shape("right.letters")
					.grammar(one_or_more(class(&[('a', 'z')])))
					.scope(Scope::Whole),
			),
	]);
	let found = overlap(&analysis, "left.digits", "right.number").expect("the pair overlaps across families");

	assert_eq!(found.witness, "00000");
	assert!(found.declared, "the declaration is on one side and counts");
	assert_ne!(found.a.family, found.b.family);
	assert!(overlap(&analysis, "left.digits", "right.letters").is_none());

	let undeclared = analysis_of(vec![
		Family::new("left").shape(shape("left.digits").grammar(digits()).scope(Scope::Whole)),
		Family::new("right").shape(shape("right.number").grammar(digits()).scope(Scope::Whole)),
	]);
	let found = overlap(&undeclared, "left.digits", "right.number").unwrap();

	// An undeclared overlap is reported and the build still succeeds.
	assert!(!found.declared && found.equivalent);
}

#[test]
fn a_pair_whose_product_passes_the_limit_fails_the_build_rather_than_being_skipped() {
	let limits = Limits {
		max_product_states: 2,
		..Limits::default()
	};
	let refused = build_families(
		vec![Family::new("p")
			.shape(
				shape("p.one")
					.grammar(repeat(class(&[('0', '9')]), 4, 4))
					.scope(Scope::Whole),
			)
			.shape(
				shape("p.two")
					.grammar(repeat(class(&[('0', '9')]), 5, 5))
					.scope(Scope::Whole),
			)],
		&limits,
	)
	.unwrap_err();

	assert!(
		refused
			.iter()
			.any(|diagnostic| diagnostic.kind == DiagnosticKind::LimitExceeded),
		"{refused:#?}"
	);
}

#[test]
fn the_repository_families_are_reachable_and_the_report_is_committed() {
	let build = build_repository_families(&Limits::default()).expect("the repository families build");

	assert!(build.analysis.unreachable.is_empty());
	assert!(build.analysis.overlaps.iter().filter(|found| found.declared).count() >= 1);
	assert!(
		build.analysis.overlaps.iter().all(|found| found.declared),
		"an undeclared overlap in the repository families: {:?}",
		build
			.analysis
			.overlaps
			.iter()
			.filter(|found| !found.declared)
			.collect::<Vec<_>>()
	);

	for (name, wanted) in [
		(["data", "reports", "compiler-report.json"], build.report_json()),
		(["data", "fixtures", "overlap-witnesses.json"], build.witnesses_json()),
	] {
		let committed = std::fs::read_to_string(package_path(&name))
			.unwrap_or_else(|error| panic!("data/{}/{} is not committed: {error}", name[1], name[2]));

		// The committed text passed through the repository formatter, so compare what it means.
		assert_eq!(
			serde_json::from_str::<Value>(&committed).unwrap(),
			serde_json::from_str::<Value>(&wanted).unwrap(),
			"run tools/generate.run.ts to regenerate data/{}/{}",
			name[1],
			name[2]
		);
	}
}

#[test]
fn the_engine_reports_both_shapes_of_every_declared_pair_on_its_committed_witness() {
	let committed: Value = serde_json::from_str(
		&std::fs::read_to_string(package_path(&["data", "fixtures", "overlap-witnesses.json"]))
			.expect("the witness fixture is committed"),
	)
	.unwrap();
	let pairs = committed["pairs"].as_array().unwrap();
	let build = build_repository_families(&Limits::default()).unwrap();
	let mut engine = Engine::new();

	for family in &build.families {
		engine.load(&family.compiled.artifact).unwrap();
	}

	// Each declared pair has a witness in the fixture, and the fixture holds no other pair.
	let declared: Vec<&Overlap> = build.analysis.overlaps.iter().filter(|found| found.declared).collect();

	assert_eq!(pairs.len(), declared.len());

	for found in declared {
		assert!(
			pairs.iter().any(|pair| pair["a"]["shape"] == found.a.shape.as_str()
				&& pair["b"]["shape"] == found.b.shape.as_str()
				&& pair["witness"] == found.witness.as_str()),
			"no fixture entry for {found:?}"
		);
	}

	for pair in pairs {
		let witness = pair["witness"].as_str().unwrap();
		let reported = engine.search(witness).unwrap();

		for side in ["a", "b"] {
			let (family, shape) = (
				pair[side]["family"].as_str().unwrap(),
				pair[side]["shape"].as_str().unwrap(),
			);
			let scope = build
				.documents
				.iter()
				.find(|document| document.family == family)
				.and_then(|document| document.shapes.iter().find(|candidate| candidate.id == shape))
				.unwrap()
				.scope;

			// A witness is the whole text, so a shape that never reports the whole text cannot show it here.
			assert_ne!(
				scope,
				Scope::Embedded,
				"{shape} is embedded-only and its witness is the whole text"
			);
			assert!(
				reported.iter().any(|candidate| candidate.family == family
					&& candidate.shape == shape
					&& candidate.start == 0
					&& candidate.end == witness.len()),
				"{family}/{shape} is not reported on {witness:?}: {reported:?}"
			);
		}
	}
}
