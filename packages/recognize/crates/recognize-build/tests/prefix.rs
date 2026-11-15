// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Prefix continuation against a brute-force answer.
//!
//! For each grammar, every string of up to `PREFIX` characters over a small alphabet is a prefix, and the reference
//! answer comes from the reference interpreter alone: the language is every string of up to `WORD` characters the
//! interpreter accepts, a prefix is accepted when it is in that language, and it is extendable when a longer string of
//! the language starts with it. The engine's `PrefixStatus` must equal that answer for every shape, on a dense
//! artifact and on a sparse one, and when the text arrives in pieces.
//!
//! The reference language is bounded, so an agreement is a proof up to that bound and no further. Each alphabet holds
//! one character for each behavior a grammar distinguishes, and `WORD - PREFIX` is at least the length of the shortest
//! completion of every prefix, so a `Viable` or `Dead` answer is checked against every completion the bound admits.

mod support;

use std::collections::{BTreeMap, BTreeSet};

use recognize_build::{compile_families, Limits};
use recognize_core::grammars;
use recognize_core::{
	choice, class, literal, one_or_more, optional, reference, repeat, sequence, shape, term, zero_or_more, Backend,
	Engine, Family, IrDocument, PrefixStatus, Scope,
};

use support::{documents, engine_for, engine_with, probe_family, strings_up_to, Interpreter};

fn sparse_limits() -> Limits {
	Limits {
		dense_bytes: 1,
		..Limits::default()
	}
}

fn reference_status(words: &BTreeSet<String>, prefix: &str) -> PrefixStatus {
	let accepted = words.contains(prefix);
	let extendable = words
		.range(prefix.to_string()..)
		.take_while(|word| word.starts_with(prefix))
		.any(|word| word != prefix);

	match (accepted, extendable) {
		(false, false) => PrefixStatus::Dead,
		(false, true) => PrefixStatus::Viable,
		(true, false) => PrefixStatus::Accepted,
		(true, true) => PrefixStatus::AcceptedAndExtendable,
	}
}

fn status_of(engine: &Engine, family: &str, shape: &str, text: &str) -> PrefixStatus {
	engine
		.prefix_status(text)
		.expect("the prefix status runs")
		.into_iter()
		.find(|entry| entry.family == family && entry.shape == shape)
		.unwrap_or_else(|| panic!("no status for {family}/{shape}"))
		.status
}

/// How many prefix and shape pairs of each status a check compared.
type Tally = BTreeMap<&'static str, usize>;

fn verify(families: Vec<Family>, alphabet: &[char], prefix_length: usize, word_length: usize) -> Tally {
	verify_except(families, alphabet, prefix_length, word_length, &[])
}

/// Like [`verify`], leaving out the shapes in `skip`, whose languages need characters the alphabet does not hold.
fn verify_except(
	families: Vec<Family>,
	alphabet: &[char],
	prefix_length: usize,
	word_length: usize,
	skip: &[&str],
) -> Tally {
	let documents: Vec<IrDocument> = documents(families.clone());
	let dense = engine_for(families.clone());
	let sparse = engine_with(families, &sparse_limits());
	let mut tally = Tally::new();

	for document in &documents {
		for engine in [&dense, &sparse] {
			assert!(engine
				.header(&document.family)
				.unwrap()
				.automata
				.iter()
				.all(|automaton| automaton.backend
					== if std::ptr::eq(engine, &dense) {
						Backend::Dense
					} else {
						Backend::Sparse
					}));
		}
	}

	let everything = strings_up_to(alphabet, word_length);
	let prefixes = strings_up_to(alphabet, prefix_length);

	for document in &documents {
		for shape in document
			.shapes
			.iter()
			.filter(|shape| !skip.contains(&shape.id.as_str()))
		{
			let words: BTreeSet<String> = everything
				.iter()
				.filter(|text| !text.is_empty() && Interpreter::new(document, text).accepts(shape))
				.cloned()
				.collect();

			for prefix in &prefixes {
				let wanted = reference_status(&words, prefix);

				for (name, engine) in [("dense", &dense), ("sparse", &sparse)] {
					assert_eq!(
						status_of(engine, &document.family, &shape.id, prefix),
						wanted,
						"{name} {}/{} on {prefix:?}",
						document.family,
						shape.id
					);
				}

				*tally.entry(wanted.as_str()).or_default() += 1;

				// The same text in pieces, one character at a time, and split once at every character boundary.
				let mut cursor = dense.prefix_cursor().unwrap();

				for character in prefix.chars() {
					cursor.push(&character.to_string()).unwrap();
				}

				assert_eq!(
					cursor
						.status()
						.iter()
						.find(|entry| entry.shape == shape.id)
						.unwrap()
						.status,
					wanted,
					"{}/{} on {prefix:?} one character at a time",
					document.family,
					shape.id
				);

				for (at, _) in prefix.char_indices() {
					let mut first = dense.prefix_cursor().unwrap();

					first.push(&prefix[..at]).unwrap();

					// A clone is a checkpoint: the original keeps its text while the clone moves on.
					let mut second = first.clone();

					second.push(&prefix[at..]).unwrap();
					assert_eq!(first.len(), at);
					assert_eq!(
						second
							.status()
							.iter()
							.find(|entry| entry.shape == shape.id)
							.unwrap()
							.status,
						wanted,
						"{}/{} on {prefix:?} split at {at}",
						document.family,
						shape.id
					);
				}
			}
		}
	}

	assert!(
		!tally.contains_key("unknown"),
		"an artifact the repository builds never answers Unknown"
	);

	tally
}

fn digit_class() -> recognize_core::Node {
	class(&[('0', '9')])
}

/// `ab` and `abc` share the states of their common prefix and differ in where they end.
fn alternatives() -> Family {
	Family::new("alternatives")
		.shape(
			shape("alt.ab_or_abc")
				.grammar(choice([literal("ab"), literal("abc")]))
				.scope(Scope::Whole),
		)
		.shape(
			shape("alt.abc_only")
				.grammar(literal("abc"))
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(shape("alt.ac").grammar(literal("ac")).scope(Scope::Embedded))
}

/// A bounded repeat, an optional lead, and nested repeats.
fn counted() -> Family {
	Family::new("counted")
		.term(term("digit", digit_class()))
		.shape(
			shape("count.two_or_three")
				.grammar(repeat(reference("digit"), 2, 3))
				.scope(Scope::Whole),
		)
		.shape(
			shape("count.optional_lead")
				.grammar(sequence([optional(literal("x")), literal("y")]))
				.scope(Scope::Whole),
		)
		.shape(
			shape("count.pairs_then_c")
				.grammar(sequence([
					one_or_more(sequence([literal("a"), literal("b")])),
					literal("c"),
				]))
				.scope(Scope::WholeOrEmbedded),
		)
}

/// Two shapes that share every state of a common prefix, where one state is live for one shape and dead for the other.
fn shared_states() -> Family {
	Family::new("shared")
		.shape(shape("share.xs").grammar(one_or_more(literal("x"))).scope(Scope::Whole))
		.shape(
			shape("share.xs_then_y")
				.grammar(sequence([one_or_more(literal("x")), literal("y")]))
				.scope(Scope::Whole),
		)
		.shape(shape("share.xz").grammar(literal("xz")).scope(Scope::Whole))
}

/// Multi-byte characters, so a piece boundary never falls inside a codepoint and the byte transitions cross several
/// bytes for one character.
fn multibyte() -> Family {
	Family::new("multibyte")
		.shape(shape("han.pair").grammar(literal("日本")).scope(Scope::Whole))
		.shape(
			shape("han.run")
				.grammar(one_or_more(class(&[('\u{4e00}', '\u{9fff}')])))
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(
			shape("han.then_latin")
				.grammar(sequence([zero_or_more(literal("é")), literal("日"), literal("a")]))
				.scope(Scope::Whole),
		)
}

#[test]
fn the_repository_families_agree_with_the_reference_interpreter() {
	let mut tally = verify(vec![grammars::primitives::family()], &['0', '.', '-', ' ', 'a'], 4, 7);

	for (status, count) in verify(vec![grammars::coordinates::family()], &['0', '.', '-', ',', ' '], 3, 7) {
		*tally.entry(status).or_default() += count;
	}

	// The repository grammars have no finite language, so every viable and extendable answer is compared and no
	// `Accepted` one is. The hand-written grammars below cover that answer.
	for status in ["dead", "viable", "accepted_and_extendable"] {
		assert!(
			tally.get(status).copied().unwrap_or(0) > 0,
			"no {status} case: {tally:?}"
		);
	}
}

#[test]
fn the_probe_family_covers_every_operator_and_scope() {
	let parenthesized = ["probe.parenthesized"];
	let everything_else = [
		"probe.digits",
		"probe.triple",
		"probe.pair",
		"probe.word",
		"probe.ab",
		"probe.abc",
		"probe.nonspace",
		"probe.decimal",
		"probe.han",
	];

	verify_except(
		vec![probe_family()],
		&['1', 'a', 'b', 'c', ' ', '日'],
		3,
		6,
		&parenthesized,
	);
	verify_except(vec![probe_family()], &['1', '(', ')', ' '], 4, 7, &everything_else);
}

#[test]
fn hand_written_grammars_agree_with_the_reference_interpreter() {
	let mut tally = verify(vec![alternatives()], &['a', 'b', 'c'], 5, 8);

	for (families, alphabet, prefix, word) in [
		(vec![counted()], vec!['0', 'x', 'y', 'a', 'b', 'c'], 4, 7),
		(vec![shared_states()], vec!['x', 'y', 'z'], 5, 8),
		(vec![multibyte()], vec!['日', '本', 'é', 'a'], 5, 8),
	] {
		for (status, count) in verify(families, &alphabet, prefix, word) {
			*tally.entry(status).or_default() += count;
		}
	}

	for status in ["dead", "viable", "accepted", "accepted_and_extendable"] {
		assert!(
			tally.get(status).copied().unwrap_or(0) > 0,
			"no {status} case: {tally:?}"
		);
	}
}

#[test]
fn one_state_is_live_for_one_shape_and_dead_for_another() {
	let engine = engine_for(vec![shared_states()]);

	assert_eq!(
		status_of(&engine, "shared", "share.xs", "xx"),
		PrefixStatus::AcceptedAndExtendable
	);
	assert_eq!(
		status_of(&engine, "shared", "share.xs_then_y", "xx"),
		PrefixStatus::Viable
	);
	assert_eq!(status_of(&engine, "shared", "share.xz", "xx"), PrefixStatus::Dead);
	assert_eq!(status_of(&engine, "shared", "share.xz", "xz"), PrefixStatus::Accepted);
	assert_eq!(
		status_of(&engine, "shared", "share.xs_then_y", "xy"),
		PrefixStatus::Accepted
	);
	assert_eq!(status_of(&engine, "shared", "share.xs", "xy"), PrefixStatus::Dead);
}

#[test]
fn a_text_past_the_input_limit_is_refused_and_the_cursor_keeps_its_text() {
	let limits = Limits {
		max_input_bytes: 4,
		..Limits::default()
	};
	let engine = engine_with(vec![shared_states()], &limits);
	let mut cursor = engine.prefix_cursor().unwrap();

	cursor.push("xxx").unwrap();
	assert!(cursor.push("xx").is_err());
	assert_eq!(cursor.len(), 3);
	assert!(engine.prefix_status("xxxxx").is_err());
}

#[test]
fn an_engine_with_no_family_has_nothing_to_say() {
	assert!(Engine::new().prefix_status("12").unwrap().is_empty());
}

#[test]
fn the_empty_text_is_viable_for_every_primitive_and_never_accepted() {
	let engine = engine_for(vec![grammars::primitives::family()]);

	for entry in engine.prefix_status("").unwrap() {
		assert_eq!(entry.status, PrefixStatus::Viable, "{}", entry.shape);
	}
}

#[test]
fn compile_families_still_builds_what_the_analysis_accepts() {
	assert!(compile_families(
		vec![alternatives(), counted(), shared_states(), multibyte()],
		&Limits::default()
	)
	.is_ok());
}
