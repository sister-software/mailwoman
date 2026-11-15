// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Capture extraction on accepted spans.
//!
//! The automata report which shape accepts which span and no group offsets. A shape that declares captures also
//! carries a capture program in its family's artifact: its grammar as an AST, with each term kept by name and each
//! regular-expression string already lowered to AST nodes by the compiler. This module walks that AST over one accepted
//! span and records where each declared capture matched.
//!
//! # The route and why
//!
//! `regex-automata` has no capture-capable engine that is built at build time and serialized: the PikeVM and the
//! one-pass DFA both read a Thompson NFA, and building one needs the NFA compiler this crate must not link. The walk
//! is a small backtracking matcher over the AST. It runs only on a span the DFA already accepted, so its work is
//! bounded by the span and a step budget, never by the whole text.
//!
//! # Which parse is chosen
//!
//! A grammar can parse one span in several ways, and the walk reports one. Choices try their alternatives in declared
//! order, repeats take as many iterations as they can and then give some back, and an optional takes its node first.
//! This is the leftmost-greedy rule of a backtracking regular-expression engine. The first parse that consumes the
//! span exactly wins. A capture that sits in an alternative the winning parse skipped is absent.
//!
//! # Limits
//!
//! A walk stops with [`ExtractError::Limit`] after [`MAX_STEPS`] node visits or [`MAX_DEPTH`] nested visits. A limit is
//! reported and never turned into an absent capture.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ast::Node;
use crate::diagnostic::Source;
use crate::ir::CaptureSpec;

/// The most node visits one extraction makes.
pub const MAX_STEPS: usize = 1_000_000;

/// The deepest nesting of node visits one extraction reaches. Each pending continuation of a sequence or a repeat holds
/// a visit, so this bounds the stack the walk uses.
pub const MAX_DEPTH: usize = 1_024;

/// One shape's grammar, capture schema, validator and declaration site inside a capture program.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgramShape {
	pub captures: Vec<CaptureSpec>,
	pub node: Node,
	/// The shape's declared validator, which a trace reports as its last step.
	pub validator: Option<String>,
	/// Where the shape's grammar is declared. The IR records no finer location, so a trace reports this for every
	/// node of the shape's own grammar.
	pub source: Source,
}

/// The programs of one family: every shape, and the terms those shapes reach.
///
/// Capture extraction reads the shapes that declare captures. The diagnostic replay of a trace reads every shape,
/// because a shape without captures can still be asked why it did and did not match.
///
/// The serialized form is compact JSON with map keys in byte order, so equal programs have equal bytes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureProgram {
	pub shapes: BTreeMap<String, ProgramShape>,
	pub terms: BTreeMap<String, Node>,
	/// Where each term is declared, keyed like `terms`.
	pub term_sources: BTreeMap<String, Source>,
}

impl CaptureProgram {
	/// The canonical bytes the artifact stores.
	pub fn to_bytes(&self) -> Vec<u8> {
		serde_json::to_vec(self).expect("a capture program always serializes")
	}

	/// Reads and checks a program: every reference names a term of the program, no node is an unlowered
	/// regular-expression string, and every capture a grammar makes is declared.
	pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
		let program: CaptureProgram = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;

		if !program.terms.keys().eq(program.term_sources.keys()) {
			return Err("the program's terms and term sources differ".to_string());
		}

		if serde_json::to_vec(&program).map_err(|error| error.to_string())? != bytes {
			return Err("the program is not in canonical form".to_string());
		}

		let mut nodes: Vec<(&str, &Node)> = program.terms.iter().map(|(id, node)| (id.as_str(), node)).collect();

		nodes.extend(program.shapes.iter().map(|(id, shape)| (id.as_str(), &shape.node)));

		for (owner, node) in nodes {
			let mut problem = None;

			node.visit(&mut |visited| match visited {
				Node::Pattern { .. } => problem = Some(format!("`{owner}` holds a regular-expression string")),
				Node::Reference { id } if !program.terms.contains_key(id) => {
					problem = Some(format!("`{owner}` refers to the term `{id}`, which the program lacks"))
				}
				_ => {}
			});

			if let Some(problem) = problem {
				return Err(problem);
			}
		}

		for (id, shape) in &program.shapes {
			let mut undeclared = None;

			shape.node.visit(&mut |visited| {
				if let Node::Capture { path, .. } = visited {
					if !shape.captures.iter().any(|spec| &spec.path == path) {
						undeclared = Some(path.clone());
					}
				}
			});

			if let Some(path) = undeclared {
				return Err(format!("shape `{id}` makes the undeclared capture `{path}`"));
			}
		}

		Ok(program)
	}
}

/// What the walk of one span found: the span's text and where each declared capture matched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Captures<'a> {
	span: &'a str,
	entries: Vec<(&'a str, Option<&'a str>)>,
}

impl<'a> Captures<'a> {
	/// A capture set for a shape that declares no captures.
	pub fn of_span(span: &'a str) -> Self {
		Captures {
			span,
			entries: Vec::new(),
		}
	}

	/// The text of the whole accepted span.
	pub fn span(&self) -> &'a str {
		self.span
	}

	/// The text a capture matched, or `None` when the capture is not declared or the parse skipped it.
	pub fn get(&self, path: &str) -> Option<&'a str> {
		self.entries
			.iter()
			.find(|(entry, _)| *entry == path)
			.and_then(|(_, text)| *text)
	}

	/// Every declared capture with its text, in the schema's order.
	pub fn entries(&self) -> &[(&'a str, Option<&'a str>)] {
		&self.entries
	}
}

/// Why no capture set came back from a span the automaton accepted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtractError {
	/// The walk passed [`MAX_STEPS`] or [`MAX_DEPTH`].
	Limit,
	/// No parse of the program consumes the span. The artifact's automata and its program disagree.
	NoParse,
}

/// Walks `shape`'s program over `text[start..end]`, a span the shape's automaton accepted.
///
/// A shape the program does not list declares no captures, and its capture set holds only the span.
pub fn extract<'a>(
	program: &'a CaptureProgram,
	shape: &str,
	text: &'a str,
	start: usize,
	end: usize,
) -> Result<Captures<'a>, ExtractError> {
	let span = &text[start..end];
	let Some(entry) = program.shapes.get(shape) else {
		return Ok(Captures::of_span(span));
	};

	let mut walker = Walker::new(program, entry, &text[..end]);

	let found = walker.run(&entry.node, start, &mut |_, position| position == end);

	if walker.limited {
		return Err(ExtractError::Limit);
	}

	if !found {
		return Err(ExtractError::NoParse);
	}

	Ok(Captures {
		span,
		entries: entry
			.captures
			.iter()
			.zip(&walker.slots)
			.map(|(spec, slot)| (spec.path.as_str(), slot.map(|(from, to)| &text[from..to])))
			.collect(),
	})
}

pub(crate) type Continuation<'k, 'a> = &'k mut dyn FnMut(&mut Walker<'a>, usize) -> bool;

pub(crate) struct Walker<'a> {
	terms: &'a BTreeMap<String, Node>,
	/// The text up to the end of the span, so no node reads past the span.
	text: &'a str,
	slots: Vec<Option<(usize, usize)>>,
	paths: &'a [CaptureSpec],
	steps: usize,
	depth: usize,
	pub(crate) limited: bool,
}

fn inside(ranges: &[crate::ast::ClassRange], character: char) -> bool {
	ranges.iter().any(|range| range.0 <= character && character <= range.1)
}

impl<'a> Walker<'a> {
	/// The node a repeat can step with one character at a time, with references followed.
	fn single(&self, node: &'a Node) -> Option<&'a Node> {
		match node {
			Node::Class { .. } => Some(node),
			Node::Literal { value } if value.chars().count() == 1 => Some(node),
			Node::Reference { id } => self.terms.get(id).and_then(|term| self.single(term)),
			_ => None,
		}
	}

	/// The offset after the one character `unit` matches at `position`.
	fn advance(&self, unit: &Node, position: usize) -> Option<usize> {
		let character = self.text[position..].chars().next()?;

		match unit {
			Node::Class { ranges, negated } if inside(ranges, character) != *negated => {
				Some(position + character.len_utf8())
			}
			Node::Literal { value } if value.starts_with(character) => Some(position + character.len_utf8()),
			_ => None,
		}
	}

	/// A walker for `entry` over `text`, which ends where the walk must stop reading.
	pub(crate) fn new(program: &'a CaptureProgram, entry: &'a ProgramShape, text: &'a str) -> Self {
		Walker {
			terms: &program.terms,
			text,
			slots: vec![None; entry.captures.len()],
			paths: &entry.captures,
			steps: 0,
			depth: 0,
			limited: false,
		}
	}

	pub(crate) fn run(&mut self, node: &'a Node, position: usize, next: Continuation<'_, 'a>) -> bool {
		if self.limited {
			return false;
		}

		self.steps += 1;

		if self.steps > MAX_STEPS || self.depth >= MAX_DEPTH {
			self.limited = true;

			return false;
		}

		self.depth += 1;

		let found = self.step(node, position, next);

		self.depth -= 1;

		found
	}

	fn step(&mut self, node: &'a Node, position: usize, next: Continuation<'_, 'a>) -> bool {
		match node {
			Node::Literal { value } => {
				self.text[position..].starts_with(value.as_str()) && next(self, position + value.len())
			}
			Node::Class { .. } => match self.advance(node, position) {
				Some(after) => next(self, after),
				None => false,
			},
			Node::Sequence { items } => self.sequence(items, position, next),
			Node::Choice { alternatives } => {
				for alternative in alternatives {
					if self.run(alternative, position, &mut *next) {
						return true;
					}
				}

				false
			}
			Node::Optional { node } => {
				if self.run(node, position, &mut *next) {
					return true;
				}

				next(self, position)
			}
			Node::Repeat { node, min, max } => match self.single(node) {
				Some(unit) => self.repeat_unit(unit, *min as usize, max.map(|max| max as usize), position, next),
				None => self.repeat(node, *min as usize, max.map(|max| max as usize), 0, position, next),
			},
			Node::Capture { path, node } => {
				let Some(slot) = self.paths.iter().position(|spec| &spec.path == path) else {
					return false;
				};

				self.run(node, position, &mut |walker, after| {
					let previous = walker.slots[slot];

					walker.slots[slot] = Some((position, after));

					if next(walker, after) {
						return true;
					}

					walker.slots[slot] = previous;

					false
				})
			}
			Node::Reference { id } => match self.terms.get(id) {
				Some(term) => self.run(term, position, next),
				None => false,
			},
			// A loaded program holds no pattern; `CaptureProgram::from_bytes` refuses one.
			Node::Pattern { .. } => false,
		}
	}

	/// Matches `items` in order from `position` and finishes exactly at `end`, recording the span each item took on the
	/// parse the walk chooses. On success `spans` holds one span per item.
	pub(crate) fn trace_items(
		&mut self,
		items: &'a [Node],
		index: usize,
		position: usize,
		end: usize,
		spans: &mut Vec<(usize, usize)>,
	) -> bool {
		if index == items.len() {
			return position == end;
		}

		self.run(&items[index], position, &mut |walker, after| {
			spans.push((position, after));

			if walker.trace_items(items, index + 1, after, end, spans) {
				return true;
			}

			spans.pop();

			false
		})
	}

	/// Every offset `node` can finish at when it starts at `position`. The walk is exhaustive, so a limit stops it and
	/// leaves [`Walker::limited`] set.
	pub(crate) fn ends_of(&mut self, node: &'a Node, position: usize) -> std::collections::BTreeSet<usize> {
		let mut ends = std::collections::BTreeSet::new();

		self.run(node, position, &mut |_, after| {
			ends.insert(after);

			false
		});

		ends
	}

	fn sequence(&mut self, items: &'a [Node], position: usize, next: Continuation<'_, 'a>) -> bool {
		match items.split_first() {
			None => next(self, position),
			Some((first, rest)) => self.run(first, position, &mut |walker, after| {
				walker.sequence(rest, after, &mut *next)
			}),
		}
	}

	/// A repeat of a one-character node: match as far as the bounds allow, then give characters back one at a time.
	fn repeat_unit(
		&mut self,
		unit: &'a Node,
		min: usize,
		max: Option<usize>,
		position: usize,
		next: Continuation<'_, 'a>,
	) -> bool {
		let mut boundaries = vec![position];
		let mut cursor = position;

		while max.is_none_or(|max| boundaries.len() - 1 < max) {
			match self.advance(unit, cursor) {
				Some(after) => {
					cursor = after;
					boundaries.push(cursor);
				}
				None => break,
			}
		}

		self.steps += boundaries.len();

		if self.steps > MAX_STEPS {
			self.limited = true;

			return false;
		}

		let mut count = boundaries.len() - 1;

		loop {
			if count < min {
				return false;
			}

			if next(self, boundaries[count]) {
				return true;
			}

			if self.limited || count == 0 {
				return false;
			}

			count -= 1;
		}
	}

	fn repeat(
		&mut self,
		node: &'a Node,
		min: usize,
		max: Option<usize>,
		count: usize,
		position: usize,
		next: Continuation<'_, 'a>,
	) -> bool {
		if max.is_none_or(|max| count < max) {
			let taken = self.run(node, position, &mut |walker, after| {
				// An iteration that consumes nothing proves the node can repeat empty, so the remaining minimum is met
				// and more iterations would loop without progress.
				if after == position {
					return next(walker, after);
				}

				walker.repeat(node, min, max, count + 1, after, &mut *next)
			});

			if taken {
				return true;
			}
		}

		count >= min && next(self, position)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::ast::{
		capture, choice, class, literal, one_or_more, optional, reference, repeat, sequence, zero_or_more,
	};
	use crate::ir::CaptureType;

	fn spec(path: &str) -> CaptureSpec {
		CaptureSpec {
			path: path.to_string(),
			kind: CaptureType::Text,
		}
	}

	fn program(captures: &[&str], node: Node) -> CaptureProgram {
		let mut program = CaptureProgram::default();

		program.terms.insert("digit".to_string(), class(&[('0', '9')]));
		program
			.term_sources
			.insert("digit".to_string(), Source::new("test.rs", 1));
		program.shapes.insert(
			"s".to_string(),
			ProgramShape {
				captures: captures.iter().map(|path| spec(path)).collect(),
				node,
				validator: None,
				source: Source::new("test.rs", 2),
			},
		);
		program
	}

	fn run<'a>(program: &'a CaptureProgram, text: &'a str) -> Result<Vec<(&'a str, Option<&'a str>)>, ExtractError> {
		extract(program, "s", text, 0, text.len()).map(|captures| captures.entries().to_vec())
	}

	#[test]
	fn a_capture_reports_the_text_it_matched() {
		let program = program(
			&["a", "b"],
			sequence([
				capture("a", one_or_more(reference("digit"))),
				literal(","),
				capture("b", one_or_more(reference("digit"))),
			]),
		);

		assert_eq!(
			run(&program, "12,345").unwrap(),
			vec![("a", Some("12")), ("b", Some("345"))]
		);
	}

	#[test]
	fn repeats_are_greedy_and_give_characters_back() {
		let program = program(
			&["first", "second"],
			sequence([
				capture("first", one_or_more(reference("digit"))),
				capture("second", one_or_more(reference("digit"))),
			]),
		);

		assert_eq!(
			run(&program, "1234").unwrap(),
			vec![("first", Some("123")), ("second", Some("4"))]
		);
	}

	#[test]
	fn a_capture_in_a_skipped_branch_is_absent() {
		let program = program(
			&["left", "right"],
			choice([
				capture("left", one_or_more(class(&[('a', 'z')]))),
				capture("right", one_or_more(reference("digit"))),
			]),
		);

		assert_eq!(
			run(&program, "42").unwrap(),
			vec![("left", None), ("right", Some("42"))]
		);
		assert_eq!(
			run(&program, "ab").unwrap(),
			vec![("left", Some("ab")), ("right", None)]
		);
	}

	#[test]
	fn an_optional_capture_takes_its_node_first() {
		let program = program(
			&["sign"],
			sequence([optional(capture("sign", literal("-"))), one_or_more(reference("digit"))]),
		);

		assert_eq!(run(&program, "-7").unwrap(), vec![("sign", Some("-"))]);
		assert_eq!(run(&program, "7").unwrap(), vec![("sign", None)]);
	}

	#[test]
	fn the_walk_stays_inside_the_span_and_on_codepoint_boundaries() {
		let program = program(
			&["word"],
			sequence([
				capture("word", one_or_more(class(&[('\u{4e00}', '\u{9fff}')]))),
				literal("!"),
			]),
		);
		let text = "x東京!y";
		let captures = extract(&program, "s", text, 1, text.len() - 1).unwrap();

		assert_eq!(captures.get("word"), Some("東京"));
		assert_eq!(captures.span(), "東京!");
	}

	#[test]
	fn a_nullable_repeat_body_does_not_loop() {
		let program = program(
			&["x"],
			sequence([capture("x", zero_or_more(optional(literal("a")))), literal("b")]),
		);

		assert_eq!(run(&program, "aab").unwrap(), vec![("x", Some("aa"))]);
	}

	#[test]
	fn bounded_repeats_respect_their_bounds() {
		let program = program(&["x"], capture("x", repeat(reference("digit"), 2, 3)));

		assert_eq!(run(&program, "123").unwrap(), vec![("x", Some("123"))]);
		assert_eq!(run(&program, "1").unwrap_err(), ExtractError::NoParse);
		assert_eq!(run(&program, "1234").unwrap_err(), ExtractError::NoParse);
	}

	#[test]
	fn a_span_no_parse_consumes_is_reported() {
		let program = program(&["x"], capture("x", literal("a")));

		assert_eq!(run(&program, "b").unwrap_err(), ExtractError::NoParse);
	}

	#[test]
	fn a_shape_without_a_program_has_only_its_span() {
		let program = CaptureProgram::default();
		let captures = extract(&program, "other", "abc", 1, 3).unwrap();

		assert_eq!(captures.span(), "bc");
		assert!(captures.entries().is_empty());
	}

	#[test]
	fn deep_nesting_ends_at_the_limit_and_does_not_overflow() {
		// `(ab)+` repeats a node that is not one character, so each iteration holds a visit.
		let program = program(
			&["x"],
			capture("x", one_or_more(sequence([literal("a"), literal("b")]))),
		);
		let text = "ab".repeat(2_000);

		assert_eq!(run(&program, &text).unwrap_err(), ExtractError::Limit);
		assert_eq!(run(&program, &"ab".repeat(100)).unwrap().len(), 1);
	}

	#[test]
	fn backtracking_that_never_finishes_ends_at_the_step_budget() {
		// `(a|a)*` followed by a literal the text lacks forces every split of the run of a's.
		let program = program(
			&["x"],
			sequence([
				capture("x", zero_or_more(choice([literal("aa"), literal("a")]))),
				literal("b"),
			]),
		);
		let text = format!("{}c", "a".repeat(60));

		assert!(matches!(
			extract(&program, "s", &text, 0, text.len()),
			Err(ExtractError::Limit) | Err(ExtractError::NoParse)
		));
	}

	#[test]
	fn a_program_round_trips_and_a_malformed_one_is_refused() {
		let good = program(&["x"], capture("x", one_or_more(reference("digit"))));
		let bytes = good.to_bytes();

		assert_eq!(CaptureProgram::from_bytes(&bytes).unwrap(), good);

		let dangling = program(&["x"], capture("x", reference("missing")));

		assert!(CaptureProgram::from_bytes(&dangling.to_bytes())
			.unwrap_err()
			.contains("missing"));

		let unlowered = program(&["x"], capture("x", crate::ast::pattern("a+")));

		assert!(CaptureProgram::from_bytes(&unlowered.to_bytes())
			.unwrap_err()
			.contains("regular-expression"));

		let undeclared = program(&[], capture("x", literal("a")));

		assert!(CaptureProgram::from_bytes(&undeclared.to_bytes())
			.unwrap_err()
			.contains("undeclared"));
		assert!(CaptureProgram::from_bytes(b"{\"terms\":{},\"shapes\":{}} ").is_err());
	}
}
