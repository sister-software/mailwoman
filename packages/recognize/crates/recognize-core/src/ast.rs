// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The grammar AST. A grammar is plain data: it can be analyzed, compared and serialized, and it holds no closure.
//! Validators and handlers are identifiers outside the AST, because they are not regular-language operators.

use serde::{Deserialize, Serialize};

/// An inclusive range of Unicode scalar values, serialized as a two-element array of one-character strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ClassRange(pub char, pub char);

/// One operator of the grammar. The `op` tag names the operator in the IR.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Node {
	/// The exact text.
	Literal { value: String },
	/// One scalar value inside (or, when negated, outside) the ranges.
	Class { ranges: Vec<ClassRange>, negated: bool },
	/// The items in order.
	Sequence { items: Vec<Node> },
	/// One of the alternatives. Order carries no priority: recognition keeps every alternative that accepts.
	Choice { alternatives: Vec<Node> },
	/// The node, or nothing.
	Optional { node: Box<Node> },
	/// The node between `min` and `max` times; `max: null` is unbounded.
	Repeat {
		node: Box<Node>,
		min: u32,
		max: Option<u32>,
	},
	/// The node, with the matched text named by a dotted capture path.
	Capture { path: String, node: Box<Node> },
	/// The grammar of a named term.
	Reference { id: String },
	/// A grammar supplied as a regular-expression string. The IR stores the text; the compiler parses it.
	Pattern { regex: String },
}

/// The operator names the IR admits, in the order the schema lists them.
pub const OPERATORS: [&str; 9] = [
	"literal",
	"class",
	"sequence",
	"choice",
	"optional",
	"repeat",
	"capture",
	"reference",
	"pattern",
];

/// Exact text.
pub fn literal(value: &str) -> Node {
	Node::Literal {
		value: value.to_string(),
	}
}

/// One scalar value inside the inclusive ranges. A single character is `(c, c)`.
pub fn class(ranges: &[(char, char)]) -> Node {
	Node::Class {
		ranges: ranges.iter().map(|&(start, end)| ClassRange(start, end)).collect(),
		negated: false,
	}
}

/// One scalar value outside the inclusive ranges.
pub fn negated_class(ranges: &[(char, char)]) -> Node {
	Node::Class {
		ranges: ranges.iter().map(|&(start, end)| ClassRange(start, end)).collect(),
		negated: true,
	}
}

/// The items in order.
pub fn sequence(items: impl IntoIterator<Item = Node>) -> Node {
	Node::Sequence {
		items: items.into_iter().collect(),
	}
}

/// One of the alternatives.
pub fn choice(alternatives: impl IntoIterator<Item = Node>) -> Node {
	Node::Choice {
		alternatives: alternatives.into_iter().collect(),
	}
}

/// The node, or nothing.
pub fn optional(node: Node) -> Node {
	Node::Optional { node: Box::new(node) }
}

/// The node between `min` and `max` times, inclusive. Validation refuses `max < min` and `max == 0`.
pub fn repeat(node: Node, min: u32, max: u32) -> Node {
	Node::Repeat {
		node: Box::new(node),
		min,
		max: Some(max),
	}
}

/// The node at least `min` times, with no upper bound.
pub fn repeat_from(node: Node, min: u32) -> Node {
	Node::Repeat {
		node: Box::new(node),
		min,
		max: None,
	}
}

/// The node zero or more times.
pub fn zero_or_more(node: Node) -> Node {
	repeat_from(node, 0)
}

/// The node one or more times.
pub fn one_or_more(node: Node) -> Node {
	repeat_from(node, 1)
}

/// The node, with its matched text named by `path`.
pub fn capture(path: &str, node: Node) -> Node {
	Node::Capture {
		path: path.to_string(),
		node: Box::new(node),
	}
}

/// The grammar of the named term `id`.
pub fn reference(id: &str) -> Node {
	Node::Reference { id: id.to_string() }
}

/// A grammar supplied as a regular-expression string. The compiler's lowering step parses it.
pub fn pattern(regex: &str) -> Node {
	Node::Pattern {
		regex: regex.to_string(),
	}
}

impl Node {
	/// Visits this node and every descendant, parents first.
	pub fn visit<'a>(&'a self, visitor: &mut impl FnMut(&'a Node)) {
		visitor(self);

		match self {
			Node::Sequence { items } => items.iter().for_each(|item| item.visit(visitor)),
			Node::Choice { alternatives } => alternatives.iter().for_each(|item| item.visit(visitor)),
			Node::Optional { node } | Node::Repeat { node, .. } | Node::Capture { node, .. } => node.visit(visitor),
			Node::Literal { .. } | Node::Class { .. } | Node::Reference { .. } | Node::Pattern { .. } => {}
		}
	}

	/// Visits every descendant mutably, parents first.
	pub fn visit_mut(&mut self, visitor: &mut impl FnMut(&mut Node)) {
		visitor(self);

		match self {
			Node::Sequence { items } => items.iter_mut().for_each(|item| item.visit_mut(visitor)),
			Node::Choice { alternatives } => alternatives.iter_mut().for_each(|item| item.visit_mut(visitor)),
			Node::Optional { node } | Node::Repeat { node, .. } | Node::Capture { node, .. } => node.visit_mut(visitor),
			Node::Literal { .. } | Node::Class { .. } | Node::Reference { .. } | Node::Pattern { .. } => {}
		}
	}
}

/// Sorts a class's ranges and merges overlapping or adjacent ones, so equal classes serialize alike. A class with a
/// reversed range stays as written for validation to refuse.
pub fn canonical_ranges(ranges: &[ClassRange]) -> Vec<ClassRange> {
	if ranges.iter().any(|range| range.0 > range.1) {
		return ranges.to_vec();
	}

	let mut sorted = ranges.to_vec();

	sorted.sort();

	let mut merged: Vec<ClassRange> = Vec::with_capacity(sorted.len());

	for range in sorted {
		match merged.last_mut() {
			Some(last) if range.0 as u32 <= last.1 as u32 + 1 => {
				if range.1 > last.1 {
					last.1 = range.1;
				}
			}
			_ => merged.push(range),
		}
	}

	merged
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn ranges_sort_and_merge() {
		let merged = canonical_ranges(&[
			ClassRange('d', 'f'),
			ClassRange('a', 'c'),
			ClassRange('x', 'x'),
			ClassRange('e', 'g'),
		]);

		assert_eq!(merged, vec![ClassRange('a', 'g'), ClassRange('x', 'x')]);
	}

	#[test]
	fn a_reversed_range_is_left_for_validation() {
		let ranges = [ClassRange('z', 'a'), ClassRange('a', 'b')];

		assert_eq!(canonical_ranges(&ranges), ranges.to_vec());
	}

	#[test]
	fn nodes_serialize_with_their_operator_tag() {
		let node = capture("n", one_or_more(class(&[('0', '9')])));
		let text = serde_json::to_string(&node).unwrap();

		assert_eq!(
			text,
			r#"{"op":"capture","path":"n","node":{"op":"repeat","node":{"op":"class","ranges":[["0","9"]],"negated":false},"min":1,"max":null}}"#
		);
		assert_eq!(serde_json::from_str::<Node>(&text).unwrap(), node);
	}
}
