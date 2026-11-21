// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The search engine under the crate's span policy: hand-checked cases for nested, same-end and same-start matches,
//! scope, non-ASCII boundaries and the backends, and a property test that holds the engine equal to the reference
//! interpreter over generated text.

mod support;

use std::sync::LazyLock;

use proptest::prelude::*;
use recognizer_build::Limits;
use recognizer_core::grammars::{coordinates, primitives};
use recognizer_core::{
	class, literal, one_or_more, reference, repeat, sequence, shape, term, Engine, Family, IrDocument, Scope,
};

use support::{actual, documents, engine_for, engine_with, expected, probe_family};

/// The spans one shape reports on `text`, in order.
fn spans(engine: &Engine, text: &str, shape: &str) -> Vec<(usize, usize)> {
	engine
		.search(text)
		.unwrap()
		.into_iter()
		.filter(|candidate| candidate.shape == shape)
		.map(|candidate| (candidate.start, candidate.end))
		.collect()
}

fn digits_family() -> Family {
	Family::new("digits")
		.term(term("digit", class(&[('0', '9')])))
		.shape(
			shape("digits.run")
				.grammar(one_or_more(reference("digit")))
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(
			shape("digits.triple")
				.grammar(repeat(reference("digit"), 3, 3))
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(
			shape("digits.pair")
				.grammar(repeat(reference("digit"), 2, 2))
				.scope(Scope::WholeOrEmbedded),
		)
}

#[test]
fn only_the_longest_match_from_a_start_is_reported_and_contained_matches_are_dropped() {
	let engine = engine_for(vec![digits_family()]);

	assert_eq!(spans(&engine, "12345", "digits.run"), vec![(0, 5)]);
	assert_eq!(spans(&engine, "ab12 345", "digits.run"), vec![(2, 4), (5, 8)]);
}

#[test]
fn matches_that_overlap_without_containing_each_other_are_all_reported() {
	let engine = engine_for(vec![digits_family()]);

	assert_eq!(spans(&engine, "12345", "digits.triple"), vec![(0, 3), (1, 4), (2, 5)]);
}

#[test]
fn shapes_do_not_hide_each_other_when_nested_or_ending_together() {
	let engine = engine_for(vec![digits_family()]);
	let found: Vec<(usize, usize, &str)> = engine
		.search("123")
		.unwrap()
		.into_iter()
		.map(|candidate| (candidate.start, candidate.end, candidate.shape))
		.collect();

	// `digits.run` and `digits.triple` match 0..3 together. `digits.pair` matches 0..2 and 1..3: the first nests inside
	// the run, the second shares the run's end.
	assert_eq!(
		found,
		vec![
			(0, 2, "digits.pair"),
			(0, 3, "digits.run"),
			(0, 3, "digits.triple"),
			(1, 3, "digits.pair")
		]
	);
}

#[test]
fn matches_that_start_together_are_all_reported_one_per_shape() {
	let family = Family::new("starts")
		.shape(shape("starts.short").grammar(literal("ab")).scope(Scope::Embedded))
		.shape(shape("starts.long").grammar(literal("abc")).scope(Scope::Embedded));
	let engine = engine_for(vec![family]);
	let found: Vec<(usize, usize, &str)> = engine
		.search("xabcx")
		.unwrap()
		.into_iter()
		.map(|candidate| (candidate.start, candidate.end, candidate.shape))
		.collect();

	assert_eq!(found, vec![(1, 3, "starts.short"), (1, 4, "starts.long")]);
}

#[test]
fn a_shape_with_several_lengths_from_one_start_reports_the_longest() {
	let family = Family::new("lengths").shape(
		shape("lengths.ab")
			.grammar(sequence([
				literal("a"),
				recognizer_core::optional(literal("bc")),
				recognizer_core::optional(literal("b")),
			]))
			.scope(Scope::Embedded),
	);
	let engine = engine_for(vec![family]);

	// From byte 0, "a", "ab" and "abc" all match. Only the longest is a candidate.
	assert_eq!(spans(&engine, "abc!", "lengths.ab"), vec![(0, 3)]);
}

#[test]
fn scope_decides_which_spans_a_shape_may_report() {
	let engine = engine_for(vec![probe_family()]);

	// `probe.word` is whole-input only.
	assert_eq!(spans(&engine, "abcd", "probe.word"), vec![(0, 4)]);
	assert_eq!(spans(&engine, "abcd ", "probe.word"), vec![]);
	assert_eq!(spans(&engine, "xx abcd", "probe.word"), vec![]);

	// `probe.pair` is embedded only: it never reports the whole text, even when the whole text matches.
	assert_eq!(spans(&engine, "12", "probe.pair"), vec![]);
	assert_eq!(spans(&engine, "x12", "probe.pair"), vec![(1, 3)]);

	// `probe.ab` is both: the whole text once, and embedded spans.
	assert_eq!(spans(&engine, "ab", "probe.ab"), vec![(0, 2)]);
	assert_eq!(spans(&engine, "abxab", "probe.ab"), vec![(0, 2), (3, 5)]);
}

#[test]
fn the_empty_text_reports_nothing() {
	assert!(engine_for(vec![probe_family()]).search("").unwrap().is_empty());
}

#[test]
fn spans_on_non_ascii_text_are_byte_offsets_on_codepoint_boundaries() {
	let engine = engine_for(vec![probe_family()]);
	// é is 2 bytes, 日 is 3 and 😀 is 4.
	let text = "é12日34😀5";

	assert_eq!(spans(&engine, text, "probe.digits"), vec![(2, 4), (7, 9), (13, 14)]);
	assert_eq!(spans(&engine, text, "probe.han"), vec![(4, 7)]);

	for candidate in engine.search(text).unwrap() {
		assert!(text.is_char_boundary(candidate.start) && text.is_char_boundary(candidate.end));
	}
}

#[test]
fn a_combining_mark_stays_inside_a_negated_class_match_as_its_own_scalar() {
	let engine = engine_for(vec![probe_family()]);
	// e followed by U+0301: two scalars, three bytes. The negated class matches each scalar separately and the run
	// covers both.
	let text = "e\u{301} x";

	assert_eq!(spans(&engine, text, "probe.nonspace"), vec![(0, 3), (4, 5)]);
}

#[test]
fn bytes_that_are_not_utf8_are_refused_before_any_span_exists() {
	let engine = engine_for(vec![probe_family()]);

	assert!(engine.search_bytes(&[b'1', 0xE6, 0x97]).is_err());
	assert!(engine.search_bytes("12".as_bytes()).is_ok());
}

#[test]
fn text_over_the_family_limit_is_refused() {
	let engine = engine_with(
		vec![digits_family()],
		&Limits {
			max_input_bytes: 8,
			..Limits::default()
		},
	);

	assert!(engine.search("12345678").is_ok());
	assert!(engine.search("123456789").is_err());
}

#[test]
fn a_regular_expression_string_matches_what_the_same_grammar_written_as_nodes_matches() {
	let by_regex = Family::new("regex")
		.shape(
			shape("regex.number")
				.regex(r"[+-]?[0-9]+(\.[0-9]+)?")
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(shape("regex.han").regex(r"\p{Han}+").scope(Scope::Embedded));
	let engine = engine_for(vec![by_regex]);

	assert_eq!(spans(&engine, "a -12.5, 7", "regex.number"), vec![(2, 7), (9, 10)]);
	assert_eq!(spans(&engine, "x日本y", "regex.han"), vec![(1, 7)]);
}

#[test]
fn the_sparse_backend_reports_what_the_dense_backend_reports() {
	let dense = engine_for(vec![probe_family()]);
	let sparse = engine_with(
		vec![probe_family()],
		&Limits {
			dense_bytes: 1,
			..Limits::default()
		},
	);

	assert!(sparse
		.header("probe")
		.unwrap()
		.automata
		.iter()
		.all(|automaton| automaton.backend == recognizer_core::Backend::Sparse));
	assert!(dense
		.header("probe")
		.unwrap()
		.automata
		.iter()
		.all(|automaton| automaton.backend == recognizer_core::Backend::Dense));

	for text in ["12 ab3 (1 2)", "é12日34😀5", "abc", "+4.5 -.5 7"] {
		assert_eq!(actual(&dense, text), actual(&sparse, text), "{text}");
	}
}

const ALPHABET: &[char] = &[
	'0', '1', '9', '.', '-', '+', ' ', ',', 'a', 'b', 'c', 'z', '(', ')', 'é', '日', '😀', '٣', '\u{301}',
];

fn text() -> impl Strategy<Value = String> {
	proptest::collection::vec(proptest::sample::select(ALPHABET), 0..14).prop_map(|chars| chars.into_iter().collect())
}

fn all_families() -> Vec<Family> {
	vec![probe_family(), primitives::family(), coordinates::family()]
}

static DENSE: LazyLock<Engine> = LazyLock::new(|| engine_for(all_families()));
static SPARSE: LazyLock<Engine> = LazyLock::new(|| {
	engine_with(
		all_families(),
		&Limits {
			dense_bytes: 1,
			..Limits::default()
		},
	)
});
static DOCUMENTS: LazyLock<Vec<IrDocument>> = LazyLock::new(|| documents(all_families()));

proptest! {
	#![proptest_config(ProptestConfig::with_cases(400))]

	#[test]
	fn the_engine_reports_what_the_reference_interpreter_reports(input in text()) {
		prop_assert_eq!(actual(&DENSE, &input), expected(&DOCUMENTS, &input), "{:?}", input);
	}

	#[test]
	fn the_sparse_engine_reports_what_the_reference_interpreter_reports(input in text()) {
		prop_assert_eq!(actual(&SPARSE, &input), expected(&DOCUMENTS, &input), "{:?}", input);
	}

	#[test]
	fn no_candidate_splits_a_codepoint(input in text()) {
		for candidate in DENSE.search(&input).unwrap() {
			prop_assert!(input.is_char_boundary(candidate.start));
			prop_assert!(input.is_char_boundary(candidate.end));
			prop_assert!(candidate.start < candidate.end);
		}
	}

	#[test]
	fn arbitrary_bytes_never_yield_a_span_over_invalid_utf8(bytes in proptest::collection::vec(any::<u8>(), 0..24)) {
		match DENSE.search_bytes(&bytes) {
			Ok(found) => {
				let text = std::str::from_utf8(&bytes).expect("a search that ran saw UTF-8");

				for candidate in found {
					prop_assert!(text.is_char_boundary(candidate.start) && text.is_char_boundary(candidate.end));
				}
			}
			Err(_) => prop_assert!(std::str::from_utf8(&bytes).is_err()),
		}
	}
}
