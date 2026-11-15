// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The partition scan under its span policy: the engine's pieces equal the pieces of a reference scan built on the
//! reference interpreter, over every string of a small alphabet and over generated text for the `structure` family, and
//! the build refuses a partition whose shapes share a string.

mod support;

use std::sync::LazyLock;

use proptest::prelude::*;
use recognize_build::{build_families, Limits};
use recognize_core::grammars::structure;
use recognize_core::structure::Structure;
use recognize_core::{class, one_or_more, shape, Engine, Family, IrDocument, Scope};

use support::{documents, engine_for, strings_up_to, Interpreter};

/// The reference scan: at each position take the longest match of any shape of the partition, continue where it ends,
/// and skip one character where nothing matches. A tie goes to the shape that sorts first by ID.
fn reference_scan(document: &IrDocument, partition: &str, text: &str) -> Vec<(usize, usize, String)> {
	let interpreter = Interpreter::new(document, text);
	let shapes: Vec<_> = document
		.shapes
		.iter()
		.filter(|shape| shape.scope == Scope::Partition && shape.partition.as_deref() == Some(partition))
		.collect();
	let matches: Vec<_> = shapes
		.iter()
		.map(|shape| (shape.id.clone(), interpreter.matches(shape)))
		.collect();
	let mut out = Vec::new();
	let mut at = 0;

	while at < text.len() {
		let best = matches
			.iter()
			.flat_map(|(id, set)| {
				set.iter()
					.filter(move |(start, _)| *start == at)
					.map(move |(_, end)| (*end, id))
			})
			.max_by(|left, right| left.0.cmp(&right.0).then(right.1.cmp(left.1)));

		match best {
			Some((end, id)) => {
				out.push((at, end, id.clone()));
				at = end;
			}
			None => at += text[at..].chars().next().unwrap().len_utf8(),
		}
	}

	out
}

fn engine_scan(engine: &Engine, family: usize, partition: &str, text: &str) -> Vec<(usize, usize, String)> {
	let mut out = Vec::new();

	engine
		.scan(family, partition, text, |shape, _, start, end| {
			out.push((start, end, engine.shapes(family)[shape].clone()));
		})
		.expect("the scan runs");

	out
}

/// A family whose partition leaves some characters unmatched, shares a prefix between shapes and has a tie-free overlap.
fn gaps_family() -> Family {
	Family::new("gaps")
		.term(term_digit())
		.shape(
			shape("gaps.digits")
				.grammar(one_or_more(recognize_core::reference("digit")))
				.partition("run"),
		)
		.shape(
			shape("gaps.letters")
				.grammar(one_or_more(class(&[('a', 'c')])))
				.partition("run"),
		)
		.shape(
			shape("gaps.ab_then_digit")
				.grammar(recognize_core::sequence([
					recognize_core::literal("ab"),
					recognize_core::reference("digit"),
				]))
				.partition("other"),
		)
}

fn term_digit() -> recognize_core::Term {
	recognize_core::term("digit", class(&[('0', '9')]))
}

#[test]
fn the_scan_equals_the_reference_scan_on_every_short_string() {
	let family = gaps_family();
	let documents = documents(vec![gaps_family()]);
	let engine = engine_for(vec![family]);
	let alphabet = ['a', 'b', 'c', '1', '2', ' ', 'é'];

	for text in strings_up_to(&alphabet, 5) {
		for partition in ["run", "other"] {
			assert_eq!(
				engine_scan(&engine, 0, partition, &text),
				reference_scan(&documents[0], partition, &text),
				"{partition} {text:?}"
			);
		}
	}
}

#[test]
fn the_scan_skips_what_no_shape_matches_and_reports_the_longest_match() {
	let engine = engine_for(vec![gaps_family()]);

	// A space and a letter outside `a..c` match nothing, and the digit run is one piece.
	assert_eq!(
		engine_scan(&engine, 0, "run", "12 abz345"),
		vec![
			(0, 2, "gaps.digits".to_string()),
			(3, 5, "gaps.letters".to_string()),
			(6, 9, "gaps.digits".to_string())
		]
	);
}

#[test]
fn an_unknown_partition_and_an_oversized_text_are_errors() {
	let engine = engine_for(vec![gaps_family()]);

	assert!(engine.scan(0, "missing", "a", |_, _, _, _| {}).is_err());
}

#[test]
fn a_partition_whose_shapes_share_a_string_fails_the_build() {
	let family = Family::new("tie")
		.shape(
			shape("tie.one")
				.grammar(one_or_more(class(&[('a', 'b')])))
				.partition("p"),
		)
		.shape(
			shape("tie.two")
				.grammar(one_or_more(class(&[('b', 'c')])))
				.partition("p"),
		);
	let diagnostics = build_families(vec![family], &Limits::default()).unwrap_err();

	assert!(
		diagnostics
			.iter()
			.any(|diagnostic| diagnostic.to_string().contains("share the string \"b\"")),
		"{diagnostics:?}"
	);
}

static STRUCTURE_ENGINE: LazyLock<(Engine, IrDocument)> = LazyLock::new(|| {
	let families = vec![structure::family()];
	let document = documents(families.clone()).remove(0);

	(engine_for(families), document)
});

#[test]
fn the_structure_partitions_equal_the_reference_scan_on_every_short_string() {
	let (engine, document) = &*STRUCTURE_ENGINE;
	let alphabet = ['a', '1', ' ', ',', '-', '漢', 'ж', 'ع', '\t', '\u{200b}', 'α'];

	for text in strings_up_to(&alphabet, 4) {
		for partition in [structure::TOKEN, structure::SEGMENT] {
			assert_eq!(
				engine_scan(engine, 0, partition, &text),
				reference_scan(document, partition, &text),
				"{partition} {text:?}"
			);
		}
	}
}

proptest! {
	#![proptest_config(ProptestConfig::with_cases(400))]

	#[test]
	fn the_structure_partitions_equal_the_reference_scan_on_generated_text(
		text in proptest::collection::vec(
			prop_oneof![
				Just('a'), Just('Z'), Just('7'), Just(' '), Just('\n'), Just('\t'), Just(','), Just(';'), Just('-'), Just('\''),
				Just('.'), Just('\u{a0}'), Just('\u{2003}'), Just('\u{feff}'), Just('漢'), Just('ｱ'), Just('한'), Just('ж'), Just('ع'),
				Just('α'), Just('Ａ'), Just('\u{301}'), Just('😀'), Just('\u{20000}'),
			],
			0..14,
		).prop_map(|characters| characters.into_iter().collect::<String>())
	) {
		let (engine, document) = &*STRUCTURE_ENGINE;

		for partition in [structure::TOKEN, structure::SEGMENT] {
			prop_assert_eq!(
				engine_scan(engine, 0, partition, &text),
				reference_scan(document, partition, &text)
			);
		}
	}
}

#[test]
fn the_structure_pass_reads_a_postal_line() {
	let (engine, _) = &*STRUCTURE_ENGINE;
	let mut out = Structure::default();
	let text = "350 5th Ave, New York, NY 10118";

	engine.structure(0, text, &mut out).unwrap();

	assert_eq!(out.segments.len(), 3);
	assert_eq!(out.tokens.len(), 7);
	// The only region abbreviation is `NY`, the sixth token.
	assert_eq!(out.regions, vec![5]);
}
