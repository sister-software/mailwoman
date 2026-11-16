// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The grammars of an angle and of the pairs of angles `coordinate.dms_pair` and `coordinate.dms_pair_spaced` accept.
//!
//! An angle is an optional sign, degrees, optional minutes and seconds, each with its mark, and an optional hemisphere
//! letter:
//!
//! ```text
//! angle   = [+-]? ws* degrees ws* degree-mark? ws* (minutes ws* minute-mark ws*)? (seconds ws* second-mark ws*)? [NSEW]?
//! degrees = digits ("." digits)?                 (the same shape for minutes and seconds)
//! degree-mark = "°" | "º" | "d"
//! minute-mark = "'" | "′" | "’" | "m"
//! second-mark = "\"" | "″" | "”" | "''" | "s"
//! ```
//!
//! Every letter is read in either case. Each group is optional and independent, so `12°30"` is 12 degrees and 30
//! seconds, and `12°30''` is too: the engine's capture walk backtracks as a regular-expression engine does, takes
//! the minutes group first, finds the second apostrophe cannot continue, and gives the group back.
//!
//! # Two grammars of an angle
//!
//! The *angle program* ([`angle_program`]) is the grammar above with a capture for each part and for each mark. It is
//! never compiled into an automaton. The `AnglePair` validator splits a span into its two halves and reads each with the
//! capture walk over this program, which is how a regular-expression engine reads an angle.
//!
//! The *filter* ([`filter_pair`]) is what the shapes compile: a loose grammar of numbers, marks and hemisphere letters
//! in any order. The exact grammar compiles to a deterministic automaton of several hundred states, because the three
//! numbers of an angle share digits and each optional group multiplies the positions a reader can be in, and
//! the artifact size and the load time of the family grow with it. The filter is a superset: it accepts the spans the
//! validator then reads, and the validator refuses with a typed code the ones that are not an angle. What the filter
//! requires is the structure that keeps the shapes apart from other shapes, which is a mark or a hemisphere letter in
//! each pair, so that a pair of bare decimals is a `coordinate.decimal_pair` and no overlap of the two shapes arises.
//!
//! # Word marks
//!
//! The letters `d`, `m` and `s` are marks only at a word boundary: `12d 30m` reads and `12d30m` does not. A grammar
//! cannot look ahead, so the angle program captures each mark with the white space after it, and the validator refuses
//! a word mark with no white space when more of the angle follows.

use std::sync::OnceLock;

use crate::ast::{capture, choice, class, literal, one_or_more, optional, reference, sequence, zero_or_more, Node};
use crate::captures::{CaptureProgram, ProgramShape};
use crate::diagnostic::Source;
use crate::ir::{CaptureSpec, CaptureType};

/// The characters JavaScript's `\s` matches: line terminators, the white space of the Unicode `Zs` category, the
/// byte order mark and the other separators. Spelled out because the grammar's `ws` is the same set the spatial
/// recognizers read, and the two must not drift.
pub fn whitespace() -> Node {
	class(&[
		('\t', '\r'),
		(' ', ' '),
		('\u{a0}', '\u{a0}'),
		('\u{1680}', '\u{1680}'),
		('\u{2000}', '\u{200a}'),
		('\u{2028}', '\u{2029}'),
		('\u{202f}', '\u{202f}'),
		('\u{205f}', '\u{205f}'),
		('\u{3000}', '\u{3000}'),
		('\u{feff}', '\u{feff}'),
	])
}

/// The letters of `text` in either case.
fn letter(text: char) -> Node {
	let (lower, upper) = (text.to_ascii_lowercase(), text.to_ascii_uppercase());

	class(&[(lower, lower), (upper, upper)])
}

/// Digits with an optional fraction: `12` and `12.5`.
fn number() -> Node {
	sequence([
		one_or_more(reference("digit")),
		optional(sequence([literal("."), one_or_more(reference("digit"))])),
	])
}

fn hemisphere_letters() -> Node {
	class(&[
		('E', 'E'),
		('N', 'N'),
		('S', 'S'),
		('W', 'W'),
		('e', 'e'),
		('n', 'n'),
		('s', 's'),
		('w', 'w'),
	])
}

fn sign() -> Node {
	class(&[('+', '+'), ('-', '-')])
}

/// The exact grammar of one angle, with a capture for each part and each mark. The mark is captured with the white
/// space after it. It needs the terms `whitespace` and `digit`.
fn angle() -> Node {
	let space = || zero_or_more(reference("whitespace"));
	let marked = |path: &str, symbols: Node| capture(path, sequence([symbols, space()]));
	let part =
		|value: &str, mark: &str, symbols: Node| sequence([capture(value, number()), space(), marked(mark, symbols)]);

	sequence([
		optional(capture("sign", sign())),
		space(),
		capture("degrees", number()),
		space(),
		optional(marked(
			"degree_mark",
			choice([class(&[('°', '°'), ('º', 'º')]), letter('d')]),
		)),
		optional(part(
			"minutes",
			"minute_mark",
			choice([class(&[('\'', '\''), ('′', '′'), ('’', '’')]), letter('m')]),
		)),
		optional(part(
			"seconds",
			"second_mark",
			choice([class(&[('"', '"'), ('″', '″'), ('”', '”')]), literal("''"), letter('s')]),
		)),
		optional(capture("hemisphere", hemisphere_letters())),
	])
}

/// The id of the one shape the angle program holds.
pub const ANGLE_SHAPE: &str = "coordinate.angle";

/// The capture program of one angle, for `AnglePair` to read each half of a pair with.
pub fn angle_program() -> &'static CaptureProgram {
	static PROGRAM: OnceLock<CaptureProgram> = OnceLock::new();

	PROGRAM.get_or_init(|| {
		let source = Source::here();
		let mut program = CaptureProgram::default();
		let text = [
			"degree_mark",
			"degrees",
			"hemisphere",
			"minute_mark",
			"minutes",
			"second_mark",
			"seconds",
			"sign",
		];

		for (id, grammar) in [("digit", class(&[('0', '9')])), ("whitespace", whitespace())] {
			program.terms.insert(id.to_string(), grammar);
			program.term_sources.insert(id.to_string(), source.clone());
		}

		program.shapes.insert(
			ANGLE_SHAPE.to_string(),
			ProgramShape {
				captures: text
					.iter()
					.map(|path| CaptureSpec {
						path: path.to_string(),
						kind: CaptureType::Text,
					})
					.collect(),
				node: angle(),
				validator: None,
				source,
			},
		);

		program
	})
}

/// A mark of an angle: a degree, minute or second symbol, or a letter `d`, `m` or `s`.
fn mark() -> Node {
	choice([
		class(&[
			('"', '"'),
			('\'', '\''),
			('°', '°'),
			('º', 'º'),
			('′', '′'),
			('″', '″'),
			('’', '’'),
			('”', '”'),
		]),
		letter('d'),
		letter('m'),
		letter('s'),
	])
}

/// How the filter reads an angle.
#[derive(Clone, Copy, PartialEq)]
enum Reading {
	/// Numbers, marks and a hemisphere letter in any order.
	Any,
	/// At least one mark or a hemisphere letter.
	Marked,
	/// A hemisphere letter ends the angle.
	EndingInHemisphere,
}

/// The loose grammar of one angle. A compact angle holds no white space, as a `\S+` token does.
fn filter_angle(reading: Reading, compact: bool) -> Node {
	let space = || -> Vec<Node> {
		if compact {
			Vec::new()
		} else {
			vec![zero_or_more(reference("whitespace"))]
		}
	};
	// Whitespace and then `node`, or just `node` when the angle is compact.
	let after_space = |node: Node| -> Node {
		let mut items = space();

		items.push(node);

		sequence(items)
	};
	let numbers = || sequence([number(), zero_or_more(after_space(number()))]);
	let items = || zero_or_more(after_space(choice([number(), mark()])));
	let hemisphere = || after_space(hemisphere_letters());
	// White space may follow a sign and may not lead the angle: a match that began with white space would start before
	// its digits, and an embedded search keeps the earliest start, which a neighbor check could then refuse.
	let leading = || -> Vec<Node> {
		let mut after_sign = vec![sign()];

		after_sign.extend(space());

		vec![optional(sequence(after_sign))]
	};
	let with = |tail: Node| -> Node {
		let mut parts = leading();

		parts.push(numbers());
		parts.push(tail);

		sequence(parts)
	};

	match reading {
		Reading::Any => with(sequence([items(), optional(hemisphere())])),
		Reading::EndingInHemisphere => with(sequence([items(), hemisphere()])),
		Reading::Marked => with(choice([
			sequence([after_space(mark()), items(), optional(hemisphere())]),
			hemisphere(),
		])),
	}
}

/// A pair of angles divided by a comma or a semicolon, at least one of them marked. A pair of bare decimals is a
/// `coordinate.decimal_pair`.
pub fn dms_pair() -> Node {
	let side = |first: Reading, second: Reading| {
		sequence([
			filter_angle(first, false),
			zero_or_more(reference("whitespace")),
			class(&[(',', ','), (';', ';')]),
			zero_or_more(reference("whitespace")),
			filter_angle(second, false),
		])
	};

	choice([side(Reading::Marked, Reading::Any), side(Reading::Any, Reading::Marked)])
}

/// A pair of angles divided by white space alone. Either the first ends in a hemisphere letter, or the two are
/// whitespace-free tokens and one is marked.
pub fn dms_pair_spaced() -> Node {
	let gap = || one_or_more(reference("whitespace"));

	choice([
		sequence([
			filter_angle(Reading::EndingInHemisphere, false),
			gap(),
			filter_angle(Reading::Any, false),
		]),
		sequence([
			filter_angle(Reading::Marked, true),
			gap(),
			filter_angle(Reading::Any, true),
		]),
		sequence([
			filter_angle(Reading::Any, true),
			gap(),
			filter_angle(Reading::Marked, true),
		]),
	])
}
