// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Lowering: a family's grammar nodes and regular-expression strings become `regex-syntax` HIR.
//!
//! One shape lowers to one HIR, and the position of a shape among the shapes a role selects is its pattern index in the
//! automaton built from them. The mapping from pattern index to shape ID stays outside the HIR: the compiler records it
//! in the artifact header.
//!
//! A term is inlined where a shape references it. A capture lowers to its inner node, because the automata report
//! spans and not group offsets. Lowering also finishes the checks that need a parser: a regular-expression string that
//! can match the empty string, or that uses an assertion or syntax the parser refuses, is a diagnostic against the
//! shape's source file and line.

use std::collections::HashMap;

use recognizer_core::{Diagnostic, DiagnosticKind, Node, Shape, Source, Term};
use regex_syntax::hir::{Class, ClassUnicode, ClassUnicodeRange, Hir, Repetition};

use crate::Limits;

/// The state one family's lowering shares across its shapes.
pub struct Lowerer<'a> {
	terms: HashMap<&'a str, &'a Term>,
	/// A lowered term and the node budget it cost.
	memo: HashMap<&'a str, (Hir, usize)>,
	limits: &'a Limits,
	budget: usize,
}

/// What stopped a lowering.
struct Refusal {
	kind: DiagnosticKind,
	message: String,
}

impl Refusal {
	fn new(kind: DiagnosticKind, message: impl Into<String>) -> Self {
		Refusal {
			kind,
			message: message.into(),
		}
	}
}

impl<'a> Lowerer<'a> {
	pub fn new(terms: &'a [Term], limits: &'a Limits) -> Self {
		Lowerer {
			terms: terms.iter().map(|term| (term.id.as_str(), term)).collect(),
			memo: HashMap::new(),
			limits,
			budget: limits.max_lowered_nodes,
		}
	}

	/// Lowers one shape, or reports every refusal against the shape's source.
	pub fn shape(&mut self, shape: &'a Shape) -> Result<Hir, Vec<Diagnostic>> {
		self.budget = self.limits.max_lowered_nodes;

		let refuse = |refusal: Refusal| vec![Diagnostic::new(refusal.kind, &shape.source, refusal.message)];

		let mut captures = 0;

		shape.grammar.visit(&mut |node| {
			if matches!(node, Node::Capture { .. }) {
				captures += 1;
			}
		});

		if captures > self.limits.max_captures {
			return Err(refuse(Refusal::new(
				DiagnosticKind::LimitExceeded,
				format!(
					"shape `{}` makes {captures} captures and the limit is {}",
					shape.id, self.limits.max_captures
				),
			)));
		}

		let hir = self.node(&shape.grammar, 0, &shape.source).map_err(refuse)?;
		let properties = hir.properties();

		// A shape with no minimum length has an empty language. It lowers to a pattern that never matches, and the
		// analysis then reports the shape as unreachable and fails the build unless the shape declares it.
		if properties.minimum_len() == Some(0) {
			return Err(refuse(Refusal::new(
				DiagnosticKind::EmptyMatch,
				format!("shape `{}` can match the empty string", shape.id),
			)));
		}

		Ok(hir)
	}

	fn node(&mut self, node: &'a Node, depth: usize, source: &Source) -> Result<Hir, Refusal> {
		if depth > self.limits.max_depth {
			return Err(Refusal::new(
				DiagnosticKind::LimitExceeded,
				format!("the grammar nests deeper than the limit of {}", self.limits.max_depth),
			));
		}

		self.budget = self.budget.checked_sub(1).ok_or_else(|| self.over_budget())?;

		Ok(match node {
			Node::Literal { value } => Hir::literal(value.as_bytes().to_vec()),
			Node::Class { ranges, negated } => {
				let mut class = ClassUnicode::new(ranges.iter().map(|range| ClassUnicodeRange::new(range.0, range.1)));

				if *negated {
					class.negate();
				}

				Hir::class(Class::Unicode(class))
			}
			Node::Sequence { items } => Hir::concat(self.each(items, depth, source)?),
			Node::Choice { alternatives } => Hir::alternation(self.each(alternatives, depth, source)?),
			Node::Optional { node } => repetition(self.node(node, depth + 1, source)?, 0, Some(1)),
			Node::Repeat { node, min, max } => repetition(self.node(node, depth + 1, source)?, *min, *max),
			Node::Capture { node, .. } => self.node(node, depth + 1, source)?,
			Node::Reference { id } => {
				// A reused term is charged what lowering it cost, so a chain of terms that each use the one before
				// twice is refused by the node budget before it clones an exponential tree.
				if let Some((known, cost)) = self.memo.get(id.as_str()) {
					self.budget = self.budget.checked_sub(*cost).ok_or_else(|| self.over_budget())?;

					return Ok(known.clone());
				}

				let term = *self
					.terms
					.get(id.as_str())
					.ok_or_else(|| Refusal::new(DiagnosticKind::UnknownReference, format!("undeclared term `{id}`")))?;
				let before = self.budget;
				let lowered = self.node(&term.grammar, depth + 1, source)?;

				self.memo
					.insert(term.id.as_str(), (lowered.clone(), before - self.budget));
				lowered
			}
			Node::Pattern { regex } => parse_pattern(regex)?,
		})
	}

	fn over_budget(&self) -> Refusal {
		Refusal::new(
			DiagnosticKind::LimitExceeded,
			format!(
				"the grammar lowers to more than {} nodes after its terms expand",
				self.limits.max_lowered_nodes
			),
		)
	}

	fn each(&mut self, nodes: &'a [Node], depth: usize, source: &Source) -> Result<Vec<Hir>, Refusal> {
		nodes.iter().map(|node| self.node(node, depth + 1, source)).collect()
	}
}

fn repetition(sub: Hir, min: u32, max: Option<u32>) -> Hir {
	Hir::repetition(Repetition {
		min,
		max,
		greedy: true,
		sub: Box::new(sub),
	})
}

/// Parses a regular-expression string into HIR. The parser matches Unicode scalar values, as the class nodes do, so a
/// `\d` is the Unicode decimal digits. An assertion has no meaning in a grammar whose scope is declared, so it is
/// refused with the way to express it.
fn parse_pattern(regex: &str) -> Result<Hir, Refusal> {
	let hir = regex_syntax::ParserBuilder::new()
		.utf8(true)
		.build()
		.parse(regex)
		.map_err(|error| {
			Refusal::new(
				DiagnosticKind::UnsupportedOperator,
				format!(
					"regular expression `{regex}` is not supported: {}",
					one_line(&error.to_string())
				),
			)
		})?;

	if !hir.properties().look_set().is_empty() {
		return Err(Refusal::new(
			DiagnosticKind::UnsupportedOperator,
			format!(
				"regular expression `{regex}` uses an assertion (`^`, `$` or a word boundary); declare the shape's scope or add a class on either side instead"
			),
		));
	}

	Ok(hir)
}

fn one_line(text: &str) -> String {
	text.lines()
		.map(str::trim)
		.filter(|line| !line.is_empty())
		.collect::<Vec<_>>()
		.join(" ")
}

#[cfg(test)]
mod tests {
	use super::*;
	use recognizer_core::{family::shape as shape_builder, ir::Scope};

	fn lower_one(regex: &str) -> Result<Hir, Vec<Diagnostic>> {
		let family = recognizer_core::Family::new("sample")
			.shape(shape_builder("sample.one").regex(regex).scope(Scope::Embedded));
		let document = family.build().expect("validation passes");
		let limits = Limits::default();
		let mut lowerer = Lowerer::new(&document.terms, &limits);

		lowerer.shape(&document.shapes[0])
	}

	#[test]
	fn a_pattern_that_can_match_nothing_is_refused_with_its_line() {
		let diagnostics = lower_one("a*").unwrap_err();

		assert_eq!(diagnostics[0].kind, DiagnosticKind::EmptyMatch);
		assert!(diagnostics[0].source.file.ends_with("lower.rs"));
		assert!(diagnostics[0].source.line > 0);
	}

	#[test]
	fn assertions_and_broken_syntax_are_refused() {
		for regex in ["^a", "a$", r"\bword\b", "(unclosed", "[z-a]", r"(?-u:\xFF)"] {
			let diagnostics = lower_one(regex).unwrap_err();

			assert_eq!(diagnostics[0].kind, DiagnosticKind::UnsupportedOperator, "{regex}");
		}
	}
}
