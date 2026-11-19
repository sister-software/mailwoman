// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Compiler limits: a grammar over a limit fails the build with a diagnostic at its source line, the documented
//! fallback picks the sparse backend, and no limit is removed to make a build succeed.

mod support;

use recognize_build::{compile_families, compile_repository_families, Limits};
use recognize_core::{
	class, literal, one_or_more, optional, reference, render, sequence, shape, term, Backend, DiagnosticKind, Family,
	Role, Scope,
};

use support::probe_family;

fn failure_kinds(families: Vec<Family>, limits: &Limits) -> Vec<DiagnosticKind> {
	compile_families(families, limits)
		.expect_err("the build refuses the grammar")
		.into_iter()
		.map(|diagnostic| diagnostic.kind)
		.collect()
}

#[test]
fn too_many_states_fails_the_build_at_the_shape_that_causes_it() {
	let limits = Limits {
		max_states: 4,
		..Limits::default()
	};
	let diagnostics =
		compile_families(vec![probe_family()], &limits).expect_err("the probe family needs more than 4 states");

	assert!(diagnostics
		.iter()
		.all(|diagnostic| diagnostic.kind == DiagnosticKind::LimitExceeded));
	assert!(diagnostics
		.iter()
		.all(|diagnostic| diagnostic.source.file.ends_with("tests/support/mod.rs") && diagnostic.source.line > 0));
	assert!(render(&diagnostics).contains("states"));
}

#[test]
fn a_construction_budget_below_every_grammar_fails_the_build() {
	let limits = Limits {
		build_bytes: 64,
		..Limits::default()
	};

	assert!(failure_kinds(vec![probe_family()], &limits).contains(&DiagnosticKind::LimitExceeded));
}

#[test]
fn a_dense_serialization_over_its_limit_falls_back_to_sparse_and_records_it() {
	let limits = Limits {
		dense_bytes: 1,
		..Limits::default()
	};
	let built = compile_families(vec![probe_family()], &limits).expect("sparse takes what dense refuses");

	assert!(!built[0].compiled.automata.is_empty());
	assert!(built[0]
		.compiled
		.automata
		.iter()
		.all(|automaton| automaton.backend == Backend::Sparse));
}

#[test]
fn a_grammar_over_the_limit_of_every_backend_fails_the_build() {
	let limits = Limits {
		dense_bytes: 1,
		sparse_bytes: 1,
		..Limits::default()
	};
	let diagnostics = compile_families(vec![probe_family()], &limits).expect_err("neither backend fits");

	assert!(diagnostics
		.iter()
		.all(|diagnostic| diagnostic.kind == DiagnosticKind::LimitExceeded));
	assert!(render(&diagnostics).contains("sparse serialization"));
}

#[test]
fn deep_nesting_fails_the_build() {
	let mut grammar = literal("x");

	for _ in 0..10 {
		grammar = sequence([optional(grammar.clone()), literal("y")]);
	}

	let family = Family::new("deep").shape(shape("deep.nest").grammar(grammar).scope(Scope::Embedded));
	let limits = Limits {
		max_depth: 5,
		..Limits::default()
	};

	assert_eq!(
		failure_kinds(vec![family], &limits),
		vec![DiagnosticKind::LimitExceeded]
	);
}

#[test]
fn terms_that_double_at_every_level_are_refused_before_they_expand() {
	// Each term uses the one before it twice, so the shape lowers to 2^30 nodes if it expands. The nesting stays inside
	// the depth limit, so the node budget is what refuses it.
	let mut family = Family::new("blowup").term(term("t0", class(&[('a', 'a')])));

	for level in 1..30 {
		family = family.term(term(
			&format!("t{level}"),
			sequence([
				reference(&format!("t{}", level - 1)),
				reference(&format!("t{}", level - 1)),
			]),
		));
	}

	let family = family.shape(shape("blowup.big").grammar(reference("t29")).scope(Scope::Embedded));

	assert_eq!(
		failure_kinds(vec![family], &Limits::default()),
		vec![DiagnosticKind::LimitExceeded]
	);
}

#[test]
fn too_many_captures_fail_the_build() {
	let family = Family::new("captures").shape(
		shape("captures.pair")
			.grammar(sequence([
				recognize_core::capture("left", literal("a")),
				recognize_core::capture("right", literal("b")),
			]))
			.capture("left", recognize_core::CaptureType::Text)
			.capture("right", recognize_core::CaptureType::Text)
			.scope(Scope::Embedded),
	);
	let limits = Limits {
		max_captures: 1,
		..Limits::default()
	};

	assert_eq!(
		failure_kinds(vec![family], &limits),
		vec![DiagnosticKind::LimitExceeded]
	);
}

#[test]
fn a_pattern_that_can_match_the_empty_string_fails_the_build_at_its_line() {
	let family = Family::new("empty").shape(shape("empty.maybe").regex("[0-9]*").scope(Scope::Embedded));
	let diagnostics = compile_families(vec![family], &Limits::default()).expect_err("the pattern is nullable");

	assert_eq!(diagnostics[0].kind, DiagnosticKind::EmptyMatch);
	assert!(diagnostics[0].source.file.ends_with("tests/limits.rs"));
}

#[test]
fn unsupported_pattern_syntax_fails_the_build_at_its_line() {
	for regex in [r"\bword", "(?<=a)b", "[0-9", r"\d{2,1}"] {
		let family = Family::new("syntax").shape(shape("syntax.bad").regex(regex).scope(Scope::Embedded));
		let diagnostics = compile_families(vec![family], &Limits::default()).expect_err(regex);

		assert!(
			diagnostics[0].kind == DiagnosticKind::UnsupportedOperator,
			"{regex}: {}",
			render(&diagnostics)
		);
		assert!(diagnostics[0].source.file.ends_with("tests/limits.rs"), "{regex}");
	}
}

#[test]
fn the_repository_families_compile_under_the_default_limits_with_room_to_spare() {
	let built = compile_repository_families(&Limits::default()).expect("the repository families compile");
	let limits = Limits::default();

	for family in &built {
		for automaton in &family.compiled.automata {
			assert!(
				automaton.states * 10 < limits.max_states,
				"{} is near the state limit",
				family.ir.family
			);

			// The automata whose dense serialization is past the dense budget of `Limits::default` are the sparse ones:
			// the whole-input automata of `coordinates`, `identifiers` and `spatial`, and the embedded automaton of
			// `coordinates`. Every other automaton, the `structure` partitions the speed requirement measures among them,
			// stays dense.
			let sparse = matches!(
				(family.ir.family.as_str(), automaton.role),
				("coordinates", _) | ("identifiers", Role::Whole) | ("spatial", Role::Whole)
			);

			assert_eq!(
				automaton.backend,
				if sparse { Backend::Sparse } else { Backend::Dense },
				"{} {:?}",
				family.ir.family,
				automaton.role
			);
		}
	}
}

#[test]
fn the_unicode_version_the_artifacts_record_is_the_version_of_the_parser_tables() {
	let parses = |name: &str| regex_syntax::Parser::new().parse(&format!(r"\p{{Age={name}}}")).is_ok();

	assert!(parses("V16_0"));
	assert!(!parses("V17_0"));
	assert_eq!(recognize_build::UNICODE_VERSION, "16.0.0");
}

#[test]
fn the_build_binary_exits_one_and_prints_the_source_line_when_a_limit_is_exceeded() {
	let out = std::env::temp_dir().join(format!("recognize-limit-{}", std::process::id()));
	let output = std::process::Command::new(env!("CARGO_BIN_EXE_recognize-build"))
		.args(["--max-states", "2"])
		.arg(&out)
		.output()
		.expect("the binary runs");
	let stderr = String::from_utf8_lossy(&output.stderr);

	assert_eq!(output.status.code(), Some(1), "{stderr}");
	assert!(
		stderr.contains("limit-exceeded") && stderr.contains("grammars/"),
		"{stderr}"
	);
	assert!(!out.join("primitives.rca1").exists());
}

#[test]
fn a_family_without_a_whole_shape_has_no_whole_automaton() {
	let family = Family::new("embedded").shape(
		shape("embedded.digits")
			.grammar(one_or_more(class(&[('0', '9')])))
			.scope(Scope::Embedded),
	);
	let built = compile_families(vec![family], &Limits::default()).unwrap();

	assert_eq!(built[0].compiled.automata.len(), 1);
}
