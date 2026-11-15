// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Test support: a reference interpreter and a reference span policy, written without the automata so they can grade
//! the compiled engine.
//!
//! The interpreter computes, for a grammar node and a start offset, the set of end offsets the node can reach. It is
//! a set-based backtracking search over the IR AST and shares no code with the compiler. The policy function states
//! the crate's span policy by brute force over every pair of matches.

#![allow(dead_code)]

use std::collections::{BTreeSet, HashMap};

use recognize_build::{compile_families, Limits};
use recognize_core::{Engine, Family, IrDocument, Node, Scope, Shape};

type Ends = BTreeSet<usize>;

pub struct Interpreter<'a> {
	text: &'a str,
	terms: HashMap<&'a str, &'a Node>,
}

impl<'a> Interpreter<'a> {
	pub fn new(document: &'a IrDocument, text: &'a str) -> Self {
		Interpreter {
			text,
			terms: document
				.terms
				.iter()
				.map(|term| (term.id.as_str(), &term.grammar))
				.collect(),
		}
	}

	fn ends(&self, node: &Node, start: usize) -> Ends {
		match node {
			Node::Literal { value } => {
				if self.text[start..].starts_with(value.as_str()) {
					Ends::from([start + value.len()])
				} else {
					Ends::new()
				}
			}
			Node::Class { ranges, negated } => match self.text[start..].chars().next() {
				Some(character) => {
					let inside = ranges.iter().any(|range| range.0 <= character && character <= range.1);

					if inside != *negated {
						Ends::from([start + character.len_utf8()])
					} else {
						Ends::new()
					}
				}
				None => Ends::new(),
			},
			Node::Sequence { items } => {
				let mut frontier = Ends::from([start]);

				for item in items {
					frontier = self.step(item, &frontier);
				}

				frontier
			}
			Node::Choice { alternatives } => alternatives
				.iter()
				.flat_map(|alternative| self.ends(alternative, start))
				.collect(),
			Node::Optional { node } => {
				let mut out = self.ends(node, start);

				out.insert(start);
				out
			}
			Node::Repeat { node, min, max } => {
				let cap = max.map_or(self.text.len() + *min as usize + 1, |max| max as usize);
				let mut frontier = Ends::from([start]);
				let mut out = Ends::new();

				if *min == 0 {
					out.insert(start);
				}

				for count in 1..=cap {
					frontier = self.step(node, &frontier);

					if frontier.is_empty() {
						break;
					}

					if count >= *min as usize {
						out.extend(frontier.iter().copied());
					}
				}

				out
			}
			Node::Capture { node, .. } => self.ends(node, start),
			Node::Reference { id } => self.ends(self.terms[id.as_str()], start),
			Node::Pattern { regex } => panic!("the interpreter does not run the regular-expression string `{regex}`"),
		}
	}

	fn step(&self, node: &Node, frontier: &Ends) -> Ends {
		frontier.iter().flat_map(|start| self.ends(node, *start)).collect()
	}

	/// Whether the shape's grammar accepts the whole text.
	pub fn accepts(&self, shape: &Shape) -> bool {
		self.ends(&shape.grammar, 0).contains(&self.text.len())
	}

	/// Every non-empty `start..end` the shape's grammar accepts exactly.
	pub fn matches(&self, shape: &Shape) -> BTreeSet<(usize, usize)> {
		let mut out = BTreeSet::new();

		for (start, _) in self.text.char_indices() {
			for end in self.ends(&shape.grammar, start) {
				if end > start {
					out.insert((start, end));
				}
			}
		}

		out
	}
}

/// The crate's span policy, by brute force: a match is a candidate unless another match of the same shape contains
/// it, and the scope then picks which candidates the shape may report.
pub fn reference_candidates(
	matches: &BTreeSet<(usize, usize)>,
	scope: Scope,
	length: usize,
) -> BTreeSet<(usize, usize)> {
	let candidates: BTreeSet<(usize, usize)> = matches
		.iter()
		.copied()
		.filter(|(start, end)| {
			!matches.iter().any(|(other_start, other_end)| {
				(other_start, other_end) != (start, end) && other_start <= start && end <= other_end
			})
		})
		.collect();

	match scope {
		Scope::Whole => matches.iter().copied().filter(|span| *span == (0, length)).collect(),
		Scope::Embedded => candidates.into_iter().filter(|span| *span != (0, length)).collect(),
		Scope::WholeOrEmbedded => candidates
			.into_iter()
			.chain(matches.iter().copied().filter(|span| *span == (0, length)))
			.collect(),
	}
}

/// Every `(start, end, family, shape)` the reference interpreter expects for the documents on `text`.
pub fn expected(documents: &[IrDocument], text: &str) -> BTreeSet<(usize, usize, String, String)> {
	let mut out = BTreeSet::new();

	for document in documents {
		let interpreter = Interpreter::new(document, text);

		for shape in &document.shapes {
			for (start, end) in reference_candidates(&interpreter.matches(shape), shape.scope, text.len()) {
				out.insert((start, end, document.family.clone(), shape.id.clone()));
			}
		}
	}

	out
}

/// Every string of at most `max` characters over `alphabet`, the empty string first, in length order.
pub fn strings_up_to(alphabet: &[char], max: usize) -> Vec<String> {
	let mut all = vec![String::new()];
	let mut layer = vec![String::new()];

	for _ in 0..max {
		layer = layer
			.iter()
			.flat_map(|prefix| {
				alphabet.iter().map(move |character| {
					let mut next = prefix.clone();

					next.push(*character);
					next
				})
			})
			.collect();
		all.extend(layer.iter().cloned());
	}

	all
}

/// A family that exercises every operator, every scope, nested and same-end shapes, and non-ASCII classes.
pub fn probe_family() -> Family {
	use recognize_core::{
		choice, class, literal, negated_class, one_or_more, optional, reference, repeat, sequence, shape, term,
		zero_or_more,
	};

	Family::new("probe")
		.term(term("digit", class(&[('0', '9')])))
		.term(term("letter", class(&[('a', 'z')])))
		.term(term("sign", class(&[('+', '+'), ('-', '-')])))
		.shape(
			shape("probe.digits")
				.grammar(one_or_more(reference("digit")))
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(
			shape("probe.triple")
				.grammar(repeat(reference("digit"), 3, 3))
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(
			shape("probe.pair")
				.grammar(repeat(reference("digit"), 2, 2))
				.scope(Scope::Embedded),
		)
		.shape(
			shape("probe.word")
				.grammar(one_or_more(reference("letter")))
				.scope(Scope::Whole),
		)
		.shape(
			shape("probe.ab")
				.grammar(sequence([literal("a"), literal("b")]))
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(shape("probe.abc").grammar(literal("abc")).scope(Scope::Embedded))
		.shape(
			shape("probe.nonspace")
				.grammar(one_or_more(negated_class(&[(' ', ' ')])))
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(
			shape("probe.decimal")
				.grammar(sequence([
					optional(reference("sign")),
					one_or_more(reference("digit")),
					optional(sequence([literal("."), one_or_more(reference("digit"))])),
				]))
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(
			shape("probe.han")
				.grammar(one_or_more(class(&[('\u{4e00}', '\u{9fff}')])))
				.scope(Scope::Embedded),
		)
		.shape(
			shape("probe.parenthesized")
				.grammar(sequence([
					literal("("),
					zero_or_more(choice([reference("digit"), literal(" ")])),
					literal(")"),
				]))
				.scope(Scope::Embedded),
		)
}

/// Compiles the families under `limits` and loads each artifact into one engine.
pub fn engine_with(families: Vec<Family>, limits: &Limits) -> Engine {
	let built = compile_families(families, limits)
		.unwrap_or_else(|diagnostics| panic!("the families do not compile:\n{}", recognize_core::render(&diagnostics)));
	let mut engine = Engine::new();

	for family in &built {
		engine.load(&family.compiled.artifact).expect("a built artifact loads");
	}

	engine
}

pub fn engine_for(families: Vec<Family>) -> Engine {
	engine_with(families, &Limits::default())
}

/// What the engine reports, in the same tuple shape as [`expected`].
pub fn actual(engine: &Engine, text: &str) -> BTreeSet<(usize, usize, String, String)> {
	engine
		.search(text)
		.expect("the search runs")
		.into_iter()
		.map(|candidate| {
			(
				candidate.start,
				candidate.end,
				candidate.family.to_string(),
				candidate.shape.to_string(),
			)
		})
		.collect()
}

/// The documents of the families, sealed, for the interpreter.
pub fn documents(families: Vec<Family>) -> Vec<IrDocument> {
	families
		.into_iter()
		.map(|family| family.build().expect("the family validates"))
		.collect()
}
