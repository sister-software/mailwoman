// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Each refusal fires, and its diagnostic states the source file and line of the grammar that holds the fault.
//! A declaration records the line where its `shape(` or `term(` call starts. Each test takes the expected line from
//! `line!()` on the same line, or from `line!() + 1` when the declaration starts on the next line.

use recognize_core::{
	capture, choice, class, literal, one_or_more, optional, pattern, reference, repeat, shape, term, zero_or_more,
	CaptureType, Diagnostic, DiagnosticKind, Family, IrDocument, Source,
};
use serde_json::Value;

fn refused(family: Family) -> Vec<Diagnostic> {
	family.build().expect_err("the family should be refused")
}

fn digit() -> recognize_core::Node {
	class(&[('0', '9')])
}

fn only(diagnostics: &[Diagnostic], kind: DiagnosticKind) -> &Diagnostic {
	let matching: Vec<&Diagnostic> = diagnostics.iter().filter(|d| d.kind == kind).collect();

	assert_eq!(matching.len(), 1, "expected one {kind:?} in {diagnostics:#?}");

	matching[0]
}

fn at(diagnostic: &Diagnostic, line: u32) {
	assert_eq!(diagnostic.source, Source::new(file!(), line), "{diagnostic}");
	assert!(
		diagnostic.to_string().starts_with(&format!("{}:{line}: ", file!())),
		"{diagnostic}"
	);
}

#[test]
fn a_valid_family_builds() {
	let family = Family::new("ok")
		.term(term("digit", digit()))
		.term(term("spaces", zero_or_more(literal(" "))))
		.shape(shape("ok.number").grammar(one_or_more(reference("digit"))));

	assert!(family.build().is_ok());
}

#[test]
fn a_reference_cycle_is_refused_at_the_term_that_closes_it() {
	let (a, _) = (term("a", reference("b")), line!());
	let (b, b_line) = (term("b", reference("a")), line!());
	let family = Family::new("cycle")
		.term(a)
		.term(b)
		.shape(shape("cycle.x").grammar(digit()));
	let diagnostics = refused(family);
	let found = only(&diagnostics, DiagnosticKind::ReferenceCycle);

	at(found, b_line);
	assert!(found.message.contains("a -> b -> a"), "{found}");
}

#[test]
fn a_self_reference_is_a_cycle() {
	let (a, line) = (term("a", optional(reference("a"))), line!());
	let diagnostics = refused(Family::new("cycle").term(a).shape(shape("cycle.x").grammar(digit())));

	at(only(&diagnostics, DiagnosticKind::ReferenceCycle), line);
}

#[test]
fn an_unknown_reference_is_refused() {
	let (bad, line) = (shape("ref.x").grammar(reference("missing")), line!());
	let diagnostics = refused(Family::new("ref").shape(bad));
	let found = only(&diagnostics, DiagnosticKind::UnknownReference);

	at(found, line);
	assert!(found.message.contains("missing"));
}

#[test]
fn a_repeated_id_is_refused_at_the_second_declaration() {
	let (first, first_line) = (shape("dup.x").grammar(digit()), line!());
	let (second, second_line) = (shape("dup.x").grammar(digit()), line!());
	let diagnostics = refused(Family::new("dup").shape(first).shape(second));
	let found = only(&diagnostics, DiagnosticKind::RepeatedID);

	at(found, second_line);
	assert!(found.message.contains(&format!("{}:{first_line}", file!())), "{found}");
}

#[test]
fn a_term_and_a_shape_cannot_share_an_id() {
	let (t, _) = (term("dup.x", digit()), line!());
	let (s, line) = (shape("dup.x").grammar(digit()), line!());
	let diagnostics = refused(Family::new("dup").term(t).shape(s));

	at(only(&diagnostics, DiagnosticKind::RepeatedID), line);
}

#[test]
fn a_lookaround_or_backreference_pattern_is_an_unsupported_operator() {
	for regex in ["a(?=b)", "a(?!b)", "(?<=a)b", "(?<!a)b", r"(a)\1", "(?P<n>a)(?P=n)"] {
		let (bad, line) = (shape("pat.x").regex(regex), line!());
		let diagnostics = refused(Family::new("pat").shape(bad));

		at(only(&diagnostics, DiagnosticKind::UnsupportedOperator), line);
	}
}

#[test]
fn an_escaped_or_class_bound_lookaround_text_is_not_refused() {
	for regex in [r"a\(?=b", "[(?=]a", r"\d+"] {
		assert!(
			Family::new("pat").shape(shape("pat.x").regex(regex)).build().is_ok(),
			"{regex}"
		);
	}
}

#[test]
fn an_unknown_operator_in_ir_text_is_refused_at_its_shape() {
	let document = Family::new("ir").shape(shape("ir.x").grammar(digit())).build().unwrap();
	let line = document.shapes[0].source.line;
	let mut value: Value = serde_json::to_value(&document).unwrap();

	value["shapes"][0]["grammar"]["op"] = Value::String("lookahead".into());

	let diagnostics = IrDocument::from_json(&value.to_string()).unwrap_err();
	let found = only(&diagnostics, DiagnosticKind::UnsupportedOperator);

	assert_eq!(found.source, Source::new(file!(), line));
	assert!(found.message.contains("lookahead"));
}

#[test]
fn patterns_that_match_the_empty_string_are_refused() {
	let cases = [
		("optional", optional(digit())),
		("star", zero_or_more(digit())),
		("bounded", repeat(digit(), 0, 3)),
		("empty literal", literal("")),
		(
			"all optional",
			recognize_core::sequence([optional(digit()), zero_or_more(literal("x"))]),
		),
		("empty alternative", choice([digit(), literal("")])),
		("through a reference", reference("maybe")),
	];

	for (name, grammar) in cases {
		let (bad, line) = (shape("empty.x").grammar(grammar), line!());
		let family = Family::new("empty").term(term("maybe", optional(digit()))).shape(bad);
		let diagnostics = refused(family);

		at(only(&diagnostics, DiagnosticKind::EmptyMatch), line);
		eprintln!("{name}: refused");
	}
}

#[test]
fn the_empty_regular_expression_is_refused() {
	let (bad, line) = (shape("empty.x").grammar(pattern("")), line!());
	let diagnostics = refused(Family::new("empty").shape(bad));

	assert!(
		diagnostics.iter().all(|d| d.kind == DiagnosticKind::EmptyMatch),
		"{diagnostics:#?}"
	);
	diagnostics.iter().for_each(|d| at(d, line));
}

#[test]
fn a_term_may_match_the_empty_string_while_a_shape_may_not() {
	let family = Family::new("ok")
		.term(term("spaces", zero_or_more(literal(" "))))
		.shape(shape("ok.x").grammar(recognize_core::sequence([reference("spaces"), digit()])));

	assert!(family.build().is_ok());
}

#[test]
fn a_malformed_capture_path_is_refused() {
	for path in ["Latitude", "a..b", "a.", "1a", "a b", ""] {
		let line = line!() + 1;
		let bad = shape("cap.x")
			.grammar(capture(path, digit()))
			.capture("ok", CaptureType::Text);
		let diagnostics = refused(Family::new("cap").shape(bad));

		at(only(&diagnostics, DiagnosticKind::MalformedCapturePath), line);
	}
}

#[test]
fn a_malformed_declared_capture_path_is_refused() {
	let line = line!() + 1;
	let bad = shape("cap.x").grammar(digit()).capture("Bad.Path", CaptureType::Text);
	let diagnostics = refused(Family::new("cap").shape(bad));

	at(only(&diagnostics, DiagnosticKind::MalformedCapturePath), line);
}

#[test]
fn a_capture_that_is_a_value_and_a_parent_is_refused() {
	// The shape declaration starts on the line after `line!()`.
	let line = line!() + 1;
	let bad = shape("cap.x")
		.grammar(recognize_core::sequence([
			capture("a", digit()),
			capture("a.b", digit()),
		]))
		.capture("a", CaptureType::Text)
		.capture("a.b", CaptureType::Text);
	let diagnostics = refused(Family::new("cap").shape(bad));

	at(only(&diagnostics, DiagnosticKind::MalformedCapturePath), line);
}

#[test]
fn the_capture_schema_and_the_grammar_must_agree() {
	let (undeclared, undeclared_line) = (shape("cap.x").grammar(capture("a", digit())), line!());
	let (unmade, unmade_line) = (shape("cap.y").grammar(digit()).capture("b", CaptureType::Text), line!());
	let diagnostics = refused(Family::new("cap").shape(undeclared).shape(unmade));
	let lines: Vec<u32> = diagnostics
		.iter()
		.filter(|d| d.kind == DiagnosticKind::CaptureSchemaMismatch)
		.map(|d| d.source.line)
		.collect();

	assert_eq!(lines, vec![undeclared_line, unmade_line]);
}

#[test]
fn a_regex_grammar_may_make_captures_the_ast_cannot_see() {
	let family = Family::new("cap").shape(
		shape("cap.x")
			.regex(r"(?P<year>\d{4})")
			.capture("year", CaptureType::Integer),
	);

	assert!(family.build().is_ok());
}

#[test]
fn a_capture_in_a_term_or_under_a_repeat_is_refused() {
	let (in_term, term_line) = (term("t", capture("a", digit())), line!());
	let shape_line = line!() + 1;
	let repeated = shape("cap.x")
		.grammar(one_or_more(capture("a", digit())))
		.capture("a", CaptureType::Text);
	let diagnostics = refused(Family::new("cap").term(in_term).shape(repeated));
	let lines: Vec<u32> = diagnostics
		.iter()
		.filter(|d| d.kind == DiagnosticKind::CaptureSchemaMismatch)
		.map(|d| d.source.line)
		.collect();

	assert_eq!(lines, vec![term_line, shape_line]);
}

#[test]
fn a_shape_without_a_grammar_and_malformed_ids_are_refused() {
	let (none, none_line) = (shape("none.x"), line!());
	let (bad_id, id_line) = (shape("Bad-ID").grammar(digit()), line!());
	let (bad_validator, validator_line) = (shape("v.x").grammar(digit()).validator("not_pascal"), line!());
	let diagnostics = refused(Family::new("ids").shape(none).shape(bad_id).shape(bad_validator));

	at(only(&diagnostics, DiagnosticKind::MissingGrammar), none_line);

	let malformed: Vec<u32> = diagnostics
		.iter()
		.filter(|d| d.kind == DiagnosticKind::MalformedID)
		.map(|d| d.source.line)
		.collect();

	assert_eq!(malformed, vec![id_line, validator_line]);
}

#[test]
fn impossible_operands_are_refused() {
	let (reversed_class, class_line) = (shape("op.a").grammar(class(&[('z', 'a')])), line!());
	let (reversed_bounds, bounds_line) = (shape("op.b").grammar(repeat(digit(), 3, 2)), line!());
	let (empty_choice, choice_line) = (shape("op.c").grammar(choice([])), line!());
	let diagnostics = refused(
		Family::new("op")
			.shape(reversed_class)
			.shape(reversed_bounds)
			.shape(empty_choice),
	);
	let lines: Vec<u32> = diagnostics
		.iter()
		.filter(|d| d.kind == DiagnosticKind::InvalidOperand)
		.map(|d| d.source.line)
		.collect();

	assert_eq!(lines, vec![class_line, bounds_line, choice_line]);
}

#[test]
fn ir_text_with_a_wrong_hash_or_a_non_canonical_layout_is_refused() {
	let document = Family::new("ir").shape(shape("ir.x").grammar(digit())).build().unwrap();
	let text = document.to_json();

	assert_eq!(IrDocument::from_json(&text).unwrap(), document);

	let tampered = text.replace(&document.hash, &"0".repeat(64));

	assert_eq!(
		IrDocument::from_json(&tampered).unwrap_err()[0].kind,
		DiagnosticKind::MalformedIR
	);

	let compact = serde_json::to_string(&document).unwrap();

	assert_eq!(
		IrDocument::from_json(&compact).unwrap_err()[0].kind,
		DiagnosticKind::MalformedIR
	);
}

#[test]
fn building_twice_is_byte_identical_and_order_independent() {
	let build = |reverse: bool| {
		let mut shapes = vec![
			shape("order.a").grammar(digit()),
			shape("order.b").grammar(class(&[('a', 'c'), ('d', 'f')])),
		];
		let mut terms = vec![term("x", digit()), term("y", class(&[('d', 'f'), ('a', 'c')]))];

		if reverse {
			shapes.reverse();
			terms.reverse();
		}

		let family = terms.into_iter().fold(Family::new("order"), Family::term);
		let family = shapes.into_iter().fold(family, Family::shape);
		let mut document = family.build().unwrap();

		// Sources differ with the call line, so compare the content without them.
		for term in &mut document.terms {
			term.source = Source::new("x", 1);
		}

		for shape in &mut document.shapes {
			shape.source = Source::new("x", 1);
		}

		document.hash = String::new();
		document.to_json()
	};

	assert_eq!(build(false), build(true));
	assert_eq!(build(false), build(false));
}
