// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The embedded search takes time linear in the length of the text, and reports what the search it replaced reported.
//!
//! [`previous`] is the previous implementation kept as test code: one anchored walk from every character boundary,
//! the longest end for each pattern at each start, and a match reported when it ends past every earlier start's. It
//! reads the artifact's DFA through `regex-automata` directly, so it shares nothing with the engine's search. The
//! property tests hold the engine equal to it over generated text, and the scaling test holds the engine's transition
//! count to `length * states` where the reference's count grows with the square of the length.

mod support;

use std::collections::BTreeSet;
use std::sync::LazyLock;

use proptest::prelude::*;
use recognize_build::{compile_families, Limits};
use recognize_core::artifact::{parse, Backend, Role};
use recognize_core::grammars::{coordinates, primitives, structure};
use recognize_core::{
	choice, class, literal, one_or_more, optional, reference, repeat, sequence, shape, term, Boundary, Engine, Family,
	Scope,
};
use regex_automata::dfa::{dense, sparse, Automaton};
use regex_automata::util::primitives::StateID;
use regex_automata::{Anchored, Input};

use support::{actual, engine_with, probe_family};

type Found = BTreeSet<(usize, usize, String, String)>;

/// The scope, the shape ID and the boundary of one pattern of an automaton.
type PatternFacts = (Scope, String, Option<Boundary>);

/// One family's embedded and whole-input automata, read for the reference search.
struct Reference {
	family: String,
	shapes: Vec<(Role, Vec<PatternFacts>)>,
	automata: Vec<(Role, Reader)>,
}

enum Reader {
	Dense(dense::DFA<Vec<u32>>),
	Sparse(sparse::DFA<Vec<u8>>),
}

fn read(artifact: &[u8]) -> Reference {
	let parsed = parse(artifact).expect("a built artifact parses");
	let mut automata = Vec::new();
	let mut shapes = Vec::new();

	for (meta, payload) in parsed.header.automata.iter().zip(&parsed.payloads) {
		if meta.role == Role::Partition {
			continue;
		}

		let reader = match meta.backend {
			Backend::Dense => {
				let mut buffer = vec![0u8; payload.bytes.len() + 4];
				let skip = (4 - buffer.as_ptr() as usize % 4) % 4;
				let aligned = &mut buffer[skip..skip + payload.bytes.len()];

				aligned.copy_from_slice(payload.bytes);
				Reader::Dense(dense::DFA::from_bytes(aligned).expect("a dense DFA reads").0.to_owned())
			}
			Backend::Sparse => Reader::Sparse(
				sparse::DFA::from_bytes(payload.bytes)
					.expect("a sparse DFA reads")
					.0
					.to_owned(),
			),
		};

		shapes.push((
			meta.role,
			meta.patterns
				.iter()
				.map(|pattern| (pattern.scope, pattern.shape.clone(), pattern.boundary))
				.collect(),
		));
		automata.push((meta.role, reader));
	}

	Reference {
		family: parsed.header.family.clone(),
		shapes,
		automata,
	}
}

/// The previous `walk`: an anchored run from `from`, calling `on_match` with the match state and the end for every
/// match state it passes. Counts each transition in `steps`.
fn walk<A: Automaton>(
	dfa: &A,
	start: StateID,
	bytes: &[u8],
	from: usize,
	steps: &mut usize,
	mut on_match: impl FnMut(&A, StateID, usize),
) {
	let mut state = start;

	for (offset, byte) in bytes.iter().enumerate().skip(from) {
		state = dfa.next_state(state, *byte);
		*steps += 1;

		if dfa.is_special_state(state) {
			if dfa.is_dead_state(state) {
				return;
			}

			assert!(!dfa.is_quit_state(state), "no automaton here has a quit state");

			if dfa.is_match_state(state) {
				on_match(dfa, state, offset);
			}
		}
	}

	state = dfa.next_eoi_state(state);

	if dfa.is_match_state(state) {
		on_match(dfa, state, bytes.len());
	}
}

/// The previous `search_embedded`, calling `found` with `(pattern, start, end)`.
fn embedded_reference<A: Automaton>(
	dfa: &A,
	patterns: usize,
	text: &str,
	steps: &mut usize,
	mut found: impl FnMut(usize, usize, usize),
) {
	let bytes = text.as_bytes();
	let start_state = dfa
		.start_state_forward(&Input::new("").anchored(Anchored::Yes))
		.expect("the automaton has an anchored start");
	let mut reach = vec![0usize; patterns];
	let mut longest = vec![0usize; patterns];
	let mut touched: Vec<usize> = Vec::new();

	for start in 0..bytes.len() {
		if bytes[start] & 0xC0 == 0x80 {
			continue;
		}

		walk(dfa, start_state, bytes, start, steps, |dfa, state, end| {
			for index in 0..dfa.match_len(state) {
				let pattern = dfa.match_pattern(state, index).as_usize();

				if longest[pattern] == 0 {
					touched.push(pattern);
				}

				longest[pattern] = end;
			}
		});

		for pattern in touched.drain(..) {
			let end = std::mem::take(&mut longest[pattern]);

			if end > reach[pattern] {
				found(pattern, start, end);
				reach[pattern] = end;
			}
		}
	}
}

/// The previous whole-input search: the patterns that accept exactly `text`.
fn whole_reference<A: Automaton>(dfa: &A, text: &str, mut found: impl FnMut(usize)) {
	let bytes = text.as_bytes();
	let start_state = dfa
		.start_state_forward(&Input::new("").anchored(Anchored::Yes))
		.expect("the automaton has an anchored start");

	walk(dfa, start_state, bytes, 0, &mut 0, |dfa, state, end| {
		if end == bytes.len() {
			for index in 0..dfa.match_len(state) {
				found(dfa.match_pattern(state, index).as_usize());
			}
		}
	});
}

/// Every `(start, end, family, shape)` the previous search reports, and the transitions its embedded searches took.
fn previous(references: &[Reference], text: &str) -> (Found, usize) {
	let mut out = Found::new();
	let mut steps = 0;

	if text.is_empty() {
		return (out, 0);
	}

	for family in references {
		for (role, reader) in &family.automata {
			let patterns = &family
				.shapes
				.iter()
				.find(|(shape_role, _)| shape_role == role)
				.unwrap()
				.1;
			let mut report = |pattern: usize, start: usize, end: usize| {
				let (scope, shape, boundary) = &patterns[pattern];

				if *role == Role::Embedded && *scope == Scope::Embedded && start == 0 && end == text.len() {
					return;
				}

				// A shape with a boundary reports no match that touches a character the boundary forbids.
				if *role == Role::Embedded && boundary.is_some_and(|boundary| !boundary.admits(text, start, end)) {
					return;
				}

				out.insert((start, end, family.family.clone(), shape.clone()));
			};

			match (role, reader) {
				(Role::Whole, Reader::Dense(dfa)) => {
					whole_reference(dfa, text, |pattern| report(pattern, 0, text.len()))
				}
				(Role::Whole, Reader::Sparse(dfa)) => {
					whole_reference(dfa, text, |pattern| report(pattern, 0, text.len()))
				}
				(Role::Embedded, Reader::Dense(dfa)) => {
					embedded_reference(dfa, patterns.len(), text, &mut steps, &mut report)
				}
				(Role::Embedded, Reader::Sparse(dfa)) => {
					embedded_reference(dfa, patterns.len(), text, &mut steps, &mut report)
				}
				(Role::Partition, _) => unreachable!("partitions are skipped when the artifact is read"),
			}
		}
	}

	(out, steps)
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
				.scope(Scope::Embedded),
		)
		.shape(
			shape("digits.window")
				.grammar(repeat(reference("digit"), 2, 7))
				.scope(Scope::Embedded),
		)
}

/// Matches of several lengths from one start, of one shape that overlap without containment, and of nested shapes.
fn letters_family() -> Family {
	Family::new("letters")
		.shape(
			shape("letters.pairs")
				.grammar(one_or_more(literal("ab")))
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(
			shape("letters.bounded")
				.grammar(sequence([repeat(literal("a"), 2, 5), optional(literal("b"))]))
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(
			shape("letters.backward")
				.grammar(sequence([repeat(literal("b"), 1, 3), literal("a")]))
				.scope(Scope::Embedded),
		)
		.shape(
			shape("letters.choice")
				.grammar(choice([literal("aa"), literal("aaa"), literal("aaaa"), literal("ba")]))
				.scope(Scope::Embedded),
		)
		.shape(
			shape("letters.whole")
				.grammar(one_or_more(choice([literal("a"), literal("b")])))
				.scope(Scope::Whole),
		)
}

fn families() -> Vec<Family> {
	vec![
		probe_family(),
		digits_family(),
		letters_family(),
		primitives::family(),
		coordinates::family(),
		structure::family(),
	]
}

fn built(limits: &Limits) -> (Engine, Vec<Reference>) {
	let compiled = compile_families(families(), limits)
		.unwrap_or_else(|diagnostics| panic!("the families compile:\n{}", recognize_core::render(&diagnostics)));
	let references = compiled.iter().map(|family| read(&family.compiled.artifact)).collect();

	(engine_with(families(), limits), references)
}

static DENSE: LazyLock<(Engine, Vec<Reference>)> = LazyLock::new(|| built(&Limits::default()));
static SPARSE: LazyLock<(Engine, Vec<Reference>)> = LazyLock::new(|| {
	built(&Limits {
		dense_bytes: 1,
		..Limits::default()
	})
});

/// Pieces a text is made of: single characters that build runs, and words that build the repository's shapes.
const PIECES: &[&str] = &[
	"0",
	"1",
	"9",
	".",
	"-",
	"+",
	" ",
	",",
	";",
	":",
	"=",
	"%",
	"a",
	"b",
	"F",
	"g",
	"e",
	"o",
	"(",
	")",
	"é",
	"日",
	"😀",
	"٣",
	"\u{301}",
	"я",
	"\n",
	"\t",
	"ab",
	"ba",
	"aaa",
	"geo:",
	"12.5",
	"-45",
	";crs=wgs84",
	"%2F",
	"abab",
	"日本",
	"٣٤",
	"1600 Pennsylvania Avenue",
	"(1 2)",
	"+4.5,-.5",
];

/// Text made of runs: each piece repeated, so the text holds long runs, nested matches and matches that share a start
/// or an end, and the alphabet reaches multi-byte characters.
fn text() -> impl Strategy<Value = String> {
	proptest::collection::vec((proptest::sample::select(PIECES), 1usize..40), 0..9)
		.prop_map(|runs| runs.into_iter().map(|(piece, count)| piece.repeat(count)).collect())
}

/// Short text over the whole alphabet, so mixed boundaries and shorter matches get as much coverage as long runs.
fn short_text() -> impl Strategy<Value = String> {
	proptest::collection::vec(proptest::sample::select(PIECES), 0..16).prop_map(|pieces| pieces.concat())
}

proptest! {
	#![proptest_config(ProptestConfig::with_cases(1500))]

	#[test]
	fn the_dense_engine_reports_what_the_previous_search_reported_on_runs(input in text()) {
		prop_assert_eq!(actual(&DENSE.0, &input), previous(&DENSE.1, &input).0, "{:?}", input);
	}

	#[test]
	fn the_dense_engine_reports_what_the_previous_search_reported_on_short_text(input in short_text()) {
		prop_assert_eq!(actual(&DENSE.0, &input), previous(&DENSE.1, &input).0, "{:?}", input);
	}

	#[test]
	fn the_sparse_engine_reports_what_the_previous_search_reported(input in text()) {
		prop_assert_eq!(actual(&SPARSE.0, &input), previous(&SPARSE.1, &input).0, "{:?}", input);
	}
}

/// Inputs chosen for the cases a leftmost-longest scan gets wrong: several lengths from one start, overlap without
/// containment, a match that starts earlier than another and ends at the same byte, and the whole text.
#[test]
fn the_engine_reports_what_the_previous_search_reported_on_the_policy_cases() {
	let (engine, references) = &*DENSE;
	let cases = [
		"12345",
		"123",
		"1234567890123",
		"abababab",
		"aaaaaab",
		"aaaaaaa",
		"bbbbabbbba",
		"ba ba",
		"abc!",
		"xabcx",
		"12",
		"1",
		"é12日34😀5",
		"1.5,-2.5 geo:1,2;crs=wgs84 %41",
		"a",
		"",
	];

	for text in cases {
		assert_eq!(actual(engine, text), previous(references, text).0, "{text:?}");
	}
}

/// `\d{3}` on `12345` reports `0..3`, `1..4` and `2..5`, as the span policy states.
#[test]
fn matches_that_overlap_without_containment_are_all_kept() {
	let (engine, _) = &*DENSE;
	let spans: Vec<(usize, usize)> = engine
		.search("12345")
		.unwrap()
		.into_iter()
		.filter(|candidate| candidate.shape == "digits.triple")
		.map(|candidate| (candidate.start, candidate.end))
		.collect();

	assert_eq!(spans, vec![(0, 3), (1, 4), (2, 5)]);
}

fn digit_run(length: usize) -> String {
	"1".repeat(length)
}

/// The most transitions the search may take, per byte of text: the states the families' embedded automata hold.
fn steps_per_byte_bound(engine: &Engine) -> usize {
	["probe", "digits", "letters", "primitives", "coordinates", "structure"]
		.iter()
		.filter_map(|family| engine.header(family))
		.flat_map(|header| header.automata.iter())
		.filter(|automaton| automaton.role == Role::Embedded)
		.map(|automaton| automaton.states as usize)
		.sum()
}

/// The embedded search takes at most `bytes * states` transitions and about the same number for each byte at every
/// length, where the previous search's count for each byte grew with the length.
#[test]
fn the_embedded_search_takes_the_same_steps_for_each_byte_at_every_length() {
	let (engine, references) = &*DENSE;
	let bound = steps_per_byte_bound(engine);
	let mut per_byte = Vec::new();
	let mut previous_per_byte = Vec::new();

	for length in [100, 1_000, 4_000] {
		let text = digit_run(length);
		let steps = engine.embedded_steps(&text).unwrap();
		let before = previous(references, &text).1;

		assert!(
			steps <= length * bound,
			"{steps} steps for {length} bytes passes the bound of {bound} per byte"
		);

		per_byte.push(steps as f64 / length as f64);
		previous_per_byte.push(before as f64 / length as f64);
	}

	// The search settles at a constant number of walks once the longest bounded match has been read, so the count for
	// each byte rises toward that constant from below and is flat within the first hundred bytes' start-up.
	assert!(per_byte[2] <= per_byte[0] * 1.05, "steps per byte grew: {per_byte:?}");
	assert!(
		per_byte[2] >= per_byte[0] * 0.9,
		"steps per byte changed shape: {per_byte:?}"
	);

	// The previous search's count for each byte was proportional to the length, so a bound on its growth marks the
	// difference this test exists to hold.
	assert!(
		previous_per_byte[2] > previous_per_byte[0] * 20.0,
		"the previous search no longer grows with the length: {previous_per_byte:?}"
	);

	eprintln!("transitions per byte at 100, 1,000 and 4,000 digits: now {per_byte:?}, before {previous_per_byte:?}");
}

/// A text at the default input limit is searched and validated, and a longer one is refused. The units are the ones
/// that report the most candidates for their length.
#[test]
fn a_text_at_the_input_limit_is_recognized_in_every_family() {
	let limit = Limits::default().max_input_bytes as usize;
	let engine = engine_with(vec![primitives::family(), coordinates::family()], &Limits::default());

	for unit in ["1", "1,", "1.1,", "geo:1,2;crs=wgs84;u=3 ", "a ", "%41", "日"] {
		let text = unit.repeat(limit / unit.len());

		assert!(engine.recognize(&text).is_ok(), "{unit:?} at the limit");
		assert!(
			engine.recognize(&format!("{text}{unit}")).is_err(),
			"{unit:?} past the limit"
		);
	}
}

/// Runs of other kinds are linear too: a word, a run that no shape accepts, a decimal that never closes and a CJK run.
#[test]
fn runs_of_other_characters_take_a_bounded_number_of_steps_for_each_byte() {
	let (engine, _) = &*DENSE;
	let bound = steps_per_byte_bound(engine);

	for unit in ["a", "ab", "1.", "1,", "-", "日", " ", "0 ", "geo:1,", ".1"] {
		let mut per_byte = Vec::new();

		for length in [100, 1_000, 4_000] {
			let text = unit.repeat(length / unit.len().max(1));
			let steps = engine.embedded_steps(&text).unwrap();

			assert!(
				steps <= text.len() * bound,
				"{unit:?}: {steps} steps for {} bytes",
				text.len()
			);
			per_byte.push(steps as f64 / text.len() as f64);
		}

		assert!(
			per_byte[2] <= per_byte[0] * 1.1,
			"{unit:?}: steps per byte grew: {per_byte:?}"
		);
	}
}
