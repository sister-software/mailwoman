// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Validation of a family's terms and shapes. Every refusal carries the source file and line of the declaration that
//! holds the fault.
//!
//! A regular-expression string is not parsed here, because the runtime crate links no regex parser. Validation scans
//! it for the constructs no automaton can run (lookaround and backreferences) and refuses the empty pattern. The
//! compiler's lowering step in `recognizer-build` parses the string, and there it refuses a pattern that can match the
//! empty string and any syntax the parser or the automata do not support, against the same source file and line.

use std::collections::{BTreeSet, HashMap};

use crate::ast::Node;
use crate::diagnostic::{Diagnostic, DiagnosticKind, Source};
use crate::ids::is_dotted_name;
use crate::ir::{AmbiguityPolicy, Scope, Shape, Term};

/// Validates one family. The result is sorted and empty when the family is valid.
pub fn validate(family: &str, anchor: &Source, terms: &[Term], shapes: &[Shape]) -> Vec<Diagnostic> {
	let mut out = Vec::new();

	if !is_dotted_name(family) {
		out.push(Diagnostic::new(
			DiagnosticKind::MalformedID,
			anchor,
			format!("family `{family}` is not a dotted lowercase name"),
		));
	}

	let mut seen: HashMap<&str, &Source> = HashMap::new();

	for (id, source) in terms
		.iter()
		.map(|t| (&t.id, &t.source))
		.chain(shapes.iter().map(|s| (&s.id, &s.source)))
	{
		if !is_dotted_name(id) {
			out.push(Diagnostic::new(
				DiagnosticKind::MalformedID,
				source,
				format!("`{id}` is not a dotted lowercase name"),
			));
		}

		match seen.get(id.as_str()) {
			Some(first) => out.push(Diagnostic::new(
				DiagnosticKind::RepeatedID,
				source,
				format!("`{id}` is already declared at {first}"),
			)),
			None => {
				seen.insert(id, source);
			}
		}
	}

	let mut by_id: HashMap<&str, &Term> = HashMap::new();

	for term in terms {
		by_id.entry(&term.id).or_insert(term);
	}

	for term in terms {
		let mut walk = Walk::new(&term.source, true, &by_id);

		walk.visit(&term.grammar, false);
		out.extend(walk.out);
	}

	let cyclic = find_cycles(terms, &by_id, &mut out);
	let mut memo: HashMap<String, bool> = HashMap::new();

	for shape in shapes {
		let mut walk = Walk::new(&shape.source, false, &by_id);

		walk.visit(&shape.grammar, false);

		let Walk {
			captures,
			has_pattern,
			out: found,
			..
		} = walk;

		out.extend(found);
		check_captures(shape, &captures, has_pattern, &mut out);
		check_ambiguity(shape, &mut out);
		check_partition(shape, &mut out);

		if !cyclic && nullable(&shape.grammar, &by_id, &mut memo) {
			out.push(Diagnostic::new(
				DiagnosticKind::EmptyMatch,
				&shape.source,
				format!("shape `{}` can match the empty string", shape.id),
			));
		}
	}

	out.sort();
	out.dedup();
	out
}

struct Walk<'a> {
	source: &'a Source,
	in_term: bool,
	by_id: &'a HashMap<&'a str, &'a Term>,
	captures: Vec<String>,
	has_pattern: bool,
	out: Vec<Diagnostic>,
}

impl<'a> Walk<'a> {
	fn new(source: &'a Source, in_term: bool, by_id: &'a HashMap<&'a str, &'a Term>) -> Self {
		Walk {
			source,
			in_term,
			by_id,
			captures: Vec::new(),
			has_pattern: false,
			out: Vec::new(),
		}
	}

	fn refuse(&mut self, kind: DiagnosticKind, message: String) {
		self.out.push(Diagnostic::new(kind, self.source, message));
	}

	fn visit(&mut self, node: &Node, many: bool) {
		match node {
			Node::Literal { .. } => {}
			Node::Class { ranges, .. } => {
				if ranges.is_empty() {
					self.refuse(DiagnosticKind::InvalidOperand, "a class has no ranges".to_string());
				}

				for range in ranges.iter().filter(|range| range.0 > range.1) {
					self.refuse(
						DiagnosticKind::InvalidOperand,
						format!("class range {:?}..{:?} is reversed", range.0, range.1),
					);
				}
			}
			Node::Sequence { items } => items.iter().for_each(|item| self.visit(item, many)),
			Node::Choice { alternatives } => {
				if alternatives.is_empty() {
					self.refuse(
						DiagnosticKind::InvalidOperand,
						"a choice has no alternatives".to_string(),
					);
				}

				alternatives.iter().for_each(|item| self.visit(item, many));
			}
			Node::Optional { node } => self.visit(node, many),
			Node::Repeat { node, min, max } => {
				if let Some(max) = max {
					if max < min {
						self.refuse(
							DiagnosticKind::InvalidOperand,
							format!("repeat bounds {min}..{max} are reversed"),
						);
					} else if *max == 0 {
						self.refuse(
							DiagnosticKind::InvalidOperand,
							"a repeat of at most zero times matches nothing".to_string(),
						);
					}
				}

				self.visit(node, many || max.is_none_or(|max| max > 1));
			}
			Node::Capture { path, node } => {
				if self.in_term {
					self.refuse(
						DiagnosticKind::CaptureSchemaMismatch,
						format!("capture `{path}` sits in a named term; captures belong to a shape's own grammar"),
					);
				} else if !is_dotted_name(path) {
					self.refuse(
						DiagnosticKind::MalformedCapturePath,
						format!("capture path `{path}` is not a dotted lowercase name"),
					);
				} else {
					if many {
						self.refuse(
							DiagnosticKind::CaptureSchemaMismatch,
							format!("capture `{path}` sits under a repeat that can match more than once"),
						);
					}

					self.captures.push(path.clone());
				}

				self.visit(node, many);
			}
			Node::Reference { id } => {
				if !self.by_id.contains_key(id.as_str()) {
					self.refuse(
						DiagnosticKind::UnknownReference,
						format!("reference to undeclared term `{id}`"),
					);
				}
			}
			Node::Pattern { regex } => {
				self.has_pattern = true;

				if regex.is_empty() {
					self.refuse(
						DiagnosticKind::EmptyMatch,
						"a regular-expression grammar is empty".to_string(),
					);
				} else if let Some(construct) = unsupported_regex_construct(regex) {
					self.refuse(
						DiagnosticKind::UnsupportedOperator,
						format!("regular expression `{regex}` uses {construct}, which no automaton can run"),
					);
				}
			}
		}
	}
}

/// Scans a regular-expression string for lookaround and backreferences. It skips escaped characters and character
/// classes, and it is not a parser.
fn unsupported_regex_construct(regex: &str) -> Option<&'static str> {
	let chars: Vec<char> = regex.chars().collect();
	let mut index = 0;
	let mut in_class = false;

	while index < chars.len() {
		match chars[index] {
			'\\' => {
				match chars.get(index + 1) {
					Some('1'..='9') if !in_class => return Some("a backreference"),
					Some('k') if !in_class => return Some("a named backreference"),
					_ => {}
				}

				index += 1;
			}
			'[' if !in_class => in_class = true,
			']' if in_class => in_class = false,
			'(' if !in_class && chars.get(index + 1) == Some(&'?') => {
				let rest: String = chars[index + 2..].iter().take(2).collect();

				if rest.starts_with('=') || rest.starts_with('!') {
					return Some("lookahead");
				}

				if rest == "<=" || rest == "<!" {
					return Some("lookbehind");
				}

				if rest.starts_with("P=") {
					return Some("a named backreference");
				}
			}
			_ => {}
		}

		index += 1;
	}

	None
}

fn references(node: &Node) -> Vec<&str> {
	let mut found = Vec::new();

	node.visit(&mut |visited| {
		if let Node::Reference { id } = visited {
			found.push(id.as_str());
		}
	});

	found
}

/// Reports each reference cycle once, against the term whose reference closes it. Returns whether any exists.
fn find_cycles(terms: &[Term], by_id: &HashMap<&str, &Term>, out: &mut Vec<Diagnostic>) -> bool {
	fn descend<'a>(
		id: &'a str,
		by_id: &HashMap<&'a str, &'a Term>,
		state: &mut HashMap<&'a str, u8>,
		stack: &mut Vec<&'a str>,
		out: &mut Vec<Diagnostic>,
	) -> bool {
		state.insert(id, 1);
		stack.push(id);

		let mut found = false;
		let mut next_ids = references(&by_id[id].grammar);

		next_ids.sort();
		next_ids.dedup();

		for next in next_ids.into_iter().filter(|next| by_id.contains_key(next)) {
			match state.get(next).copied().unwrap_or(0) {
				0 => found |= descend(next, by_id, state, stack, out),
				1 => {
					let start = stack.iter().position(|member| *member == next).unwrap_or(0);
					let mut path: Vec<&str> = stack[start..].to_vec();

					path.push(next);
					out.push(Diagnostic::new(
						DiagnosticKind::ReferenceCycle,
						&by_id[id].source,
						format!("terms form a reference cycle: {}", path.join(" -> ")),
					));

					found = true;
				}
				_ => {}
			}
		}

		stack.pop();
		state.insert(id, 2);

		found
	}

	let ids: BTreeSet<&str> = terms.iter().map(|term| term.id.as_str()).collect();
	let mut state: HashMap<&str, u8> = HashMap::new();
	let mut found = false;

	for id in ids {
		if state.get(id).copied().unwrap_or(0) == 0 {
			found |= descend(id, by_id, &mut state, &mut Vec::new(), out);
		}
	}

	found
}

fn nullable(node: &Node, by_id: &HashMap<&str, &Term>, memo: &mut HashMap<String, bool>) -> bool {
	match node {
		Node::Literal { value } => value.is_empty(),
		Node::Class { .. } => false,
		Node::Sequence { items } => items.iter().all(|item| nullable(item, by_id, memo)),
		Node::Choice { alternatives } => alternatives.iter().any(|item| nullable(item, by_id, memo)),
		Node::Optional { .. } => true,
		Node::Repeat { node, min, .. } => *min == 0 || nullable(node, by_id, memo),
		Node::Capture { node, .. } => nullable(node, by_id, memo),
		Node::Reference { id } => {
			if let Some(known) = memo.get(id) {
				return *known;
			}

			let result = by_id
				.get(id.as_str())
				.is_some_and(|term| nullable(&term.grammar, by_id, memo));

			memo.insert(id.clone(), result);
			result
		}
		Node::Pattern { regex } => regex.is_empty(),
	}
}

fn check_captures(shape: &Shape, captured: &[String], has_pattern: bool, out: &mut Vec<Diagnostic>) {
	let mut declared: BTreeSet<&str> = BTreeSet::new();

	for spec in &shape.captures {
		if !is_dotted_name(&spec.path) {
			out.push(Diagnostic::new(
				DiagnosticKind::MalformedCapturePath,
				&shape.source,
				format!("declared capture path `{}` is not a dotted lowercase name", spec.path),
			));
		} else if !declared.insert(&spec.path) {
			out.push(Diagnostic::new(
				DiagnosticKind::MalformedCapturePath,
				&shape.source,
				format!("capture `{}` is declared twice", spec.path),
			));
		}
	}

	for path in &declared {
		if let Some(inner) = declared.iter().find(|other| other.starts_with(&format!("{path}."))) {
			out.push(Diagnostic::new(
				DiagnosticKind::MalformedCapturePath,
				&shape.source,
				format!("capture `{path}` holds a value and also a parent of `{inner}`"),
			));
		}
	}

	let mut made: BTreeSet<&str> = BTreeSet::new();

	for path in captured {
		if !made.insert(path) {
			out.push(Diagnostic::new(
				DiagnosticKind::CaptureSchemaMismatch,
				&shape.source,
				format!("capture `{path}` is made twice in one grammar"),
			));
		}

		if !declared.contains(path.as_str()) {
			out.push(Diagnostic::new(
				DiagnosticKind::CaptureSchemaMismatch,
				&shape.source,
				format!("capture `{path}` is in the grammar and not in the capture schema"),
			));
		}
	}

	if !has_pattern {
		for path in declared.difference(&made) {
			out.push(Diagnostic::new(
				DiagnosticKind::CaptureSchemaMismatch,
				&shape.source,
				format!("capture `{path}` is declared and the grammar never makes it"),
			));
		}
	}
}

/// A partition shape names its partition, and nothing else does. The engine reports a partition's pieces as spans and
/// never validates or hands them to a handler, so such a shape has no captures, validator or handler.
fn check_partition(shape: &Shape, out: &mut Vec<Diagnostic>) {
	let refuse = |message: String| Diagnostic::new(DiagnosticKind::Partition, &shape.source, message);

	match (&shape.scope, &shape.partition) {
		(Scope::Partition, None) => out.push(refuse(format!(
			"shape `{}` has the partition scope and names no partition",
			shape.id
		))),
		(Scope::Partition, Some(name)) => {
			if !is_dotted_name(name) {
				out.push(refuse(format!(
					"the partition `{name}` of shape `{}` is not a dotted lowercase name",
					shape.id
				)));
			}

			if !shape.captures.is_empty() || shape.validator.is_some() || shape.handler.is_some() {
				out.push(refuse(format!(
					"shape `{}` is a partition piece, which has no captures, validator or handler",
					shape.id
				)));
			}
		}
		(_, Some(name)) => out.push(refuse(format!(
			"shape `{}` names the partition `{name}` and its scope is not partition",
			shape.id
		))),
		(_, None) => {}
	}
}

fn check_ambiguity(shape: &Shape, out: &mut Vec<Diagnostic>) {
	let AmbiguityPolicy::MayOverlap { with } = &shape.ambiguity else {
		return;
	};
	let mut seen: BTreeSet<&str> = BTreeSet::new();

	if with.is_empty() {
		out.push(Diagnostic::new(
			DiagnosticKind::MalformedID,
			&shape.source,
			"a may-overlap policy names no shape",
		));
	}

	for other in with {
		if !is_dotted_name(other) {
			out.push(Diagnostic::new(
				DiagnosticKind::MalformedID,
				&shape.source,
				format!("overlap partner `{other}` is not a dotted lowercase name"),
			));
		} else if *other == shape.id {
			out.push(Diagnostic::new(
				DiagnosticKind::MalformedID,
				&shape.source,
				format!("shape `{}` lists itself as an overlap partner", shape.id),
			));
		} else if !seen.insert(other) {
			out.push(Diagnostic::new(
				DiagnosticKind::MalformedID,
				&shape.source,
				format!("overlap partner `{other}` is listed twice"),
			));
		}
	}
}
