// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Overlap analysis: which shapes can never be reported, which shapes recognize the same language, and which pairs of
//! shapes share a string, with the shortest string they share.
//!
//! Every shape gets its own single-pattern DFA over its whole language: anchored at the start, with the end-of-input
//! assertion appended, so a string is in the language exactly when the end-of-input transition from the state it reaches
//! is a match state. Each question below is a walk over the DFAs of one shape or of a pair, and none of them reads the
//! grammar's source text.
//!
//! * **Unreachable.** A shape is unreachable when its language is empty, or when it is `Embedded` and no search can report
//!   one of its matches. A search reports a match of an `Embedded` shape unless another match of the same shape contains
//!   it, and never reports the span of the whole text. A match `w` in some text is therefore reportable exactly when
//!   some `w` in the language and some character `c` give `w·c` or `c·w` outside the language (the text `w·c` or `c·w`
//!   then holds `w` as a span no other match contains). A shape is unreachable when the language is non-empty and closed
//!   under appending a character and under prepending one.
//! * **Equivalent.** Two shapes are equivalent when no string is in one language and not the other.
//! * **Overlapping.** Two shapes overlap when some string is in both languages. The witness is the shortest such string
//!   in UTF-8 bytes. Among strings of one length it is the first in a fixed byte order that tries printable ASCII before
//!   anything else, so a witness is stable across builds and reads as ordinary text when the languages allow it.
//!
//! Overlap is a property of languages, so a shape's scope does not change it. A pair is declared when either shape's
//! `may_overlap` names the other's ID.

use std::collections::{BTreeSet, HashMap};

use recognize_core::{AmbiguityPolicy, Diagnostic, DiagnosticKind, IrDocument, Scope, Shape};
use regex_automata::dfa::{dense, Automaton, StartKind};
use regex_automata::nfa::thompson::{self, WhichCaptures};
use regex_automata::util::primitives::StateID;
use regex_automata::{Anchored, Input, MatchKind};
use regex_syntax::hir::{Hir, Look};

use crate::lower::Lowerer;
use crate::Limits;

/// A shape named by its family and ID.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ShapeKey {
	pub family: String,
	pub shape: String,
}

/// A shape the compiler finds unreachable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unreachable {
	pub key: ShapeKey,
	/// Why no search reports the shape.
	pub reason: String,
	/// The reason the shape declares, when it declares unreachability.
	pub declared: Option<String>,
}

/// Two shapes that share a string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Overlap {
	pub a: ShapeKey,
	pub b: ShapeKey,
	/// The shortest string both languages hold.
	pub witness: String,
	/// Whether either shape's `may_overlap` names the other.
	pub declared: bool,
	/// Whether the two languages are equal.
	pub equivalent: bool,
}

/// What the analysis finds across a set of families.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Analysis {
	pub unreachable: Vec<Unreachable>,
	/// Every overlapping pair of reachable shapes, sorted by `(a, b)`. An equivalent pair is also here.
	pub overlaps: Vec<Overlap>,
}

/// One shape's language as a DFA.
struct Language<'a> {
	key: ShapeKey,
	shape: &'a Shape,
	dfa: dense::DFA<Vec<u32>>,
	start: StateID,
}

/// The bytes in the order a witness search tries them: printable ASCII, the space, the other ASCII, then the rest.
fn byte_order() -> Vec<u8> {
	let mut order: Vec<u8> = (0x21..=0x7E).collect();

	order.push(0x20);
	order.extend(0x00..0x20);
	order.push(0x7F);
	order.extend(0x80..=0xFF);

	order
}

fn accepts(dfa: &dense::DFA<Vec<u32>>, state: StateID) -> bool {
	dfa.is_match_state(dfa.next_eoi_state(state))
}

fn language_of<'a>(family: &str, shape: &'a Shape, hir: &Hir, limits: &Limits) -> Result<Language<'a>, Diagnostic> {
	let refuse = |message: String| {
		Diagnostic::new(
			DiagnosticKind::LimitExceeded,
			&shape.source,
			format!("family `{family}`, shape `{}`: {message}", shape.id),
		)
	};
	let nfa = thompson::Compiler::new()
		.configure(
			thompson::Config::new()
				.which_captures(WhichCaptures::None)
				.nfa_size_limit(Some(limits.nfa_bytes)),
		)
		.build_from_hir(&Hir::concat(vec![hir.clone(), Hir::look(Look::End)]))
		.map_err(|error| refuse(format!("the language NFA does not build: {error}")))?;
	let dfa = dense::Builder::new()
		.configure(
			dense::Config::new()
				.match_kind(MatchKind::All)
				.start_kind(StartKind::Anchored)
				.minimize(true)
				.dfa_size_limit(Some(limits.build_bytes))
				.determinize_size_limit(Some(limits.build_bytes)),
		)
		.build_from_nfa(&nfa)
		.map_err(|error| refuse(format!("the language DFA does not build: {error}")))?;
	let start = dfa
		.start_state_forward(&Input::new("").anchored(Anchored::Yes))
		.map_err(|error| refuse(format!("the language DFA has no start state: {error}")))?;

	Ok(Language {
		key: ShapeKey {
			family: family.to_string(),
			shape: shape.id.clone(),
		},
		shape,
		dfa,
		start,
	})
}

/// What one walk over the product of two languages finds.
struct Walk {
	/// The shortest string in both languages.
	both: Option<Vec<u8>>,
	/// Whether some string is in the first language and not the second.
	only_first: bool,
	/// Whether some string is in the second language and not the first.
	only_second: bool,
}

struct Node {
	first: StateID,
	second: StateID,
	parent: usize,
	byte: u8,
}

/// Walks every reachable pair of states breadth-first from the two start states.
fn walk(
	first: &dense::DFA<Vec<u32>>,
	first_start: StateID,
	second: &dense::DFA<Vec<u32>>,
	second_start: StateID,
	limits: &Limits,
) -> Result<Walk, usize> {
	// One byte per distinct pair of byte classes, in the order the search tries them.
	let mut seen_classes = BTreeSet::new();
	let bytes: Vec<u8> = byte_order()
		.into_iter()
		.filter(|byte| seen_classes.insert((first.byte_classes().get(*byte), second.byte_classes().get(*byte))))
		.collect();
	let mut index: HashMap<(u32, u32), usize> = HashMap::new();
	let mut nodes = vec![Node {
		first: first_start,
		second: second_start,
		parent: usize::MAX,
		byte: 0,
	}];
	let mut out = Walk {
		both: None,
		only_first: false,
		only_second: false,
	};
	let mut at = 0;

	index.insert((first_start.as_u32(), second_start.as_u32()), 0);

	while at < nodes.len() {
		let (state_a, state_b) = (nodes[at].first, nodes[at].second);
		let (in_first, in_second) = (accepts(first, state_a), accepts(second, state_b));

		match (in_first, in_second) {
			(true, true) if out.both.is_none() => {
				let mut text = Vec::new();
				let mut cursor = at;

				while nodes[cursor].parent != usize::MAX {
					text.push(nodes[cursor].byte);
					cursor = nodes[cursor].parent;
				}

				text.reverse();
				out.both = Some(text);
			}
			(true, false) => out.only_first = true,
			(false, true) => out.only_second = true,
			_ => {}
		}

		if !(first.is_dead_state(state_a) && second.is_dead_state(state_b)) {
			for byte in &bytes {
				let next = (first.next_state(state_a, *byte), second.next_state(state_b, *byte));

				if index.contains_key(&(next.0.as_u32(), next.1.as_u32())) {
					continue;
				}

				if nodes.len() >= limits.max_product_states {
					return Err(nodes.len());
				}

				index.insert((next.0.as_u32(), next.1.as_u32()), nodes.len());
				nodes.push(Node {
					first: next.0,
					second: next.1,
					parent: at,
					byte: *byte,
				});
			}
		}

		at += 1;
	}

	Ok(out)
}

/// The UTF-8 encodings of one character, as the byte ranges each position admits.
const UTF8_SHAPES: [&[(u8, u8)]; 9] = [
	&[(0x00, 0x7F)],
	&[(0xC2, 0xDF), (0x80, 0xBF)],
	&[(0xE0, 0xE0), (0xA0, 0xBF), (0x80, 0xBF)],
	&[(0xE1, 0xEC), (0x80, 0xBF), (0x80, 0xBF)],
	&[(0xED, 0xED), (0x80, 0x9F), (0x80, 0xBF)],
	&[(0xEE, 0xEF), (0x80, 0xBF), (0x80, 0xBF)],
	&[(0xF0, 0xF0), (0x90, 0xBF), (0x80, 0xBF), (0x80, 0xBF)],
	&[(0xF1, 0xF3), (0x80, 0xBF), (0x80, 0xBF), (0x80, 0xBF)],
	&[(0xF4, 0xF4), (0x80, 0x8F), (0x80, 0xBF), (0x80, 0xBF)],
];

/// The states the DFA can be in after reading one whole character from `state`.
fn after_one_character(dfa: &dense::DFA<Vec<u32>>, state: StateID) -> Vec<StateID> {
	let mut out: HashMap<u32, StateID> = HashMap::new();

	for shape in UTF8_SHAPES {
		let mut frontier: HashMap<u32, StateID> = HashMap::from([(state.as_u32(), state)]);

		for (low, high) in shape {
			let mut next = HashMap::new();

			for from in frontier.values() {
				for byte in *low..=*high {
					let to = dfa.next_state(*from, byte);

					next.insert(to.as_u32(), to);
				}
			}

			frontier = next;
		}

		out.extend(frontier);
	}

	let mut states: Vec<StateID> = out.into_values().collect();

	states.sort_by_key(|id| id.as_u32());

	states
}

/// The states a text in the language can leave the DFA in, which is every reachable state that accepts.
fn accepting_states(dfa: &dense::DFA<Vec<u32>>, start: StateID) -> Vec<StateID> {
	let bytes: Vec<u8> = crate::reach::representatives(dfa.byte_classes());
	let mut seen: HashMap<u32, StateID> = HashMap::from([(start.as_u32(), start)]);
	let mut stack = vec![start];

	while let Some(state) = stack.pop() {
		for byte in &bytes {
			let next = dfa.next_state(state, *byte);

			if seen.insert(next.as_u32(), next).is_none() {
				stack.push(next);
			}
		}
	}

	let mut out: Vec<StateID> = seen.into_values().filter(|state| accepts(dfa, *state)).collect();

	out.sort_by_key(|id| id.as_u32());

	out
}

fn over_limit(language: &Language<'_>, other: Option<&Language<'_>>, reached: usize, limits: &Limits) -> Diagnostic {
	let pair = other.map_or(String::new(), |other| format!(" against shape `{}`", other.key.shape));

	Diagnostic::new(
		DiagnosticKind::LimitExceeded,
		&language.shape.source,
		format!(
			"family `{}`, shape `{}`{pair}: the product automaton passes {reached} states and the limit is {}",
			language.key.family, language.shape.id, limits.max_product_states
		),
	)
}

/// Whether some search can report a match of an `Embedded` shape whose language is not empty.
fn embedded_reportable(language: &Language<'_>, limits: &Limits) -> Result<bool, Diagnostic> {
	let dfa = &language.dfa;

	// Appending a character: some accepting state has a character that leaves the language.
	for state in accepting_states(dfa, language.start) {
		if after_one_character(dfa, state).iter().any(|next| !accepts(dfa, *next)) {
			return Ok(true);
		}
	}

	// Prepending a character `c`: the language must lie inside what remains of it after `c`.
	for state in after_one_character(dfa, language.start) {
		let found = walk(dfa, language.start, dfa, state, limits)
			.map_err(|reached| over_limit(language, None, reached, limits))?;

		if found.only_first {
			return Ok(true);
		}
	}

	Ok(false)
}

fn declares(first: &Shape, second: &Shape) -> bool {
	let names = |shape: &Shape, other: &Shape| match &shape.ambiguity {
		AmbiguityPolicy::MayOverlap { with } => with.contains(&other.id),
		AmbiguityPolicy::Exclusive => false,
	};

	names(first, second) || names(second, first)
}

fn lower_all<'a>(documents: &'a [IrDocument], limits: &Limits) -> Result<Vec<Language<'a>>, Vec<Diagnostic>> {
	let mut languages = Vec::new();
	let mut diagnostics = Vec::new();

	for document in documents {
		let mut lowerer = Lowerer::new(&document.terms, limits);

		for shape in &document.shapes {
			match lowerer.shape(shape) {
				Ok(hir) => match language_of(&document.family, shape, &hir, limits) {
					Ok(language) => languages.push(language),
					Err(diagnostic) => diagnostics.push(diagnostic),
				},
				Err(found) => diagnostics.extend(found),
			}
		}
	}

	if diagnostics.is_empty() {
		Ok(languages)
	} else {
		diagnostics.sort();
		diagnostics.dedup();

		Err(diagnostics)
	}
}

/// What the reachability check finds among a set of languages.
struct Reachability {
	found: Vec<Unreachable>,
	/// The positions of the unreachable shapes among the languages.
	indices: BTreeSet<usize>,
	/// A diagnostic for each shape that is unreachable and undeclared, or declared and reachable.
	diagnostics: Vec<Diagnostic>,
}

/// Finds the unreachable shapes among `languages`.
fn unreachable_among(languages: &[Language<'_>], limits: &Limits) -> Result<Reachability, Vec<Diagnostic>> {
	let mut found = Vec::new();
	let mut indices = BTreeSet::new();
	let mut diagnostics = Vec::new();

	for (at, language) in languages.iter().enumerate() {
		let empty = walk(&language.dfa, language.start, &language.dfa, language.start, limits)
			.map_err(|reached| vec![over_limit(language, None, reached, limits)])?
			.both
			.is_none();
		let reason = if empty {
			Some("its language is empty".to_string())
		} else if language.shape.scope == Scope::Embedded
			&& !embedded_reportable(language, limits).map_err(|diagnostic| vec![diagnostic])?
		{
			Some(
				"every string it matches extends to another match on both sides, so a search never reports a span of it"
					.to_string(),
			)
		} else {
			None
		};

		match (&reason, &language.shape.unreachable) {
			(Some(reason), declared) => {
				if declared.is_none() {
					diagnostics.push(Diagnostic::new(
						DiagnosticKind::Unreachable,
						&language.shape.source,
						format!(
							"family `{}`, shape `{}` is unreachable: {reason}; declare it with `declare_unreachable` or change the grammar",
							language.key.family, language.shape.id
						),
					));
				}

				found.push(Unreachable {
					key: language.key.clone(),
					reason: reason.clone(),
					declared: declared.clone(),
				});
				indices.insert(at);
			}
			(None, Some(_)) => diagnostics.push(Diagnostic::new(
				DiagnosticKind::Unreachable,
				&language.shape.source,
				format!(
					"family `{}`, shape `{}` declares itself unreachable and a search can report it",
					language.key.family, language.shape.id
				),
			)),
			(None, None) => {}
		}
	}

	Ok(Reachability {
		found,
		indices,
		diagnostics,
	})
}

/// The diagnostics for the unreachable shapes of one family, undeclared or wrongly declared.
pub fn unreachable_diagnostics(document: &IrDocument, limits: &Limits) -> Result<Vec<Diagnostic>, Vec<Diagnostic>> {
	let languages = lower_all(std::slice::from_ref(document), limits)?;
	Ok(unreachable_among(&languages, limits)?.diagnostics)
}

/// Analyzes every shape of `documents`: the unreachable ones, and every overlapping pair, within and across families.
///
/// Fails with a diagnostic for an undeclared unreachable shape, for a declaration on a reachable shape, and for a
/// search that passes `max_product_states`. An overlap never fails the build, declared or not.
pub fn analyze(documents: &[IrDocument], limits: &Limits) -> Result<Analysis, Vec<Diagnostic>> {
	let languages = lower_all(documents, limits)?;
	let Reachability {
		found: unreachable,
		indices: dead,
		diagnostics,
	} = unreachable_among(&languages, limits)?;

	if !diagnostics.is_empty() {
		let mut diagnostics = diagnostics;

		diagnostics.sort();
		diagnostics.dedup();

		return Err(diagnostics);
	}

	let mut overlaps = Vec::new();

	for (left, first) in languages.iter().enumerate() {
		for (right, second) in languages.iter().enumerate().skip(left + 1) {
			if dead.contains(&left) || dead.contains(&right) {
				continue;
			}

			let found = walk(&first.dfa, first.start, &second.dfa, second.start, limits)
				.map_err(|reached| vec![over_limit(first, Some(second), reached, limits)])?;

			if let Some(bytes) = found.both {
				let (a, b) = if first.key <= second.key {
					(first.key.clone(), second.key.clone())
				} else {
					(second.key.clone(), first.key.clone())
				};

				overlaps.push(Overlap {
					a,
					b,
					witness: String::from_utf8(bytes)
						.expect("an accepted string is UTF-8, because every grammar is over characters"),
					declared: declares(first.shape, second.shape),
					equivalent: !found.only_first && !found.only_second,
				});
			}
		}
	}

	overlaps.sort_by(|x, y| (&x.a, &x.b).cmp(&(&y.a, &y.b)));

	let mut unreachable = unreachable;

	unreachable.sort_by(|x, y| x.key.cmp(&y.key));

	Ok(Analysis { unreachable, overlaps })
}
