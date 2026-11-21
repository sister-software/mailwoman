// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Traces: a record, per recognition, of which grammar nodes accepted, whether the validator accepted, and why a shape
//! did not match.
//!
//! A trace is opt-in. The search and [`Engine::recognize`](crate::Engine::recognize) never build one: a trace comes from
//! [`Engine::trace`](crate::Engine::trace) and [`Engine::explain`](crate::Engine::explain), which run after the search
//! and read the family's program. [`traces_built`] counts the traces this process has built, so a test or a host can
//! prove that a call that did not ask for tracing built none.
//!
//! # The replay
//!
//! A DFA state does not say why a branch failed, so a trace comes from a diagnostic replay of the shape's grammar
//! against the text. The replay reads the family's program ([`crate::captures`]), which holds every shape's grammar and
//! the terms it reaches, and it runs the same backtracking matcher capture extraction uses.
//!
//! The replay works one level deep. A shape's grammar is a sequence of items, and each item is one step: a literal, a
//! class, a reference to a term, a capture, an optional or a repeat. Each step has the stable node ID `<shape>#<index>`,
//! its operator, its name (the capture path, the term ID or the literal text), the declaration site of its shape or,
//! for a reference, of the term it names, and an outcome. A shape whose grammar is not a sequence is one step.
//! A step does not say which node inside a failing item failed.
//!
//! * [`accepted`] replays a span the automaton accepted. Every item passes, each with the span it took on the parse the
//!   matcher chose, and a last step reports the validator: `pass`, or `rejected` with the typed rejection.
//! * [`explain`] replays a whole text against a shape that may not match it. It tracks the set of offsets the items
//!   reach, which is exact for a sequence, and reports the first item no offset survives as `fail`, at the furthest
//!   offset the earlier items reached. When every item passes and the text is not used up, the step `<shape>#end`
//!   fails. Steps that pass carry no span, because several parses can reach different offsets. It explains the whole
//!   text only, so it says nothing about a shape that matches a span inside the text.
//!
//! A replay that passes the matcher's step budget ends with the outcome `limit` and the result `incomplete`.
//!
//! # Outcomes the engine does not produce
//!
//! Recognition makes no membership claim and reads no data, so [`Outcome::Miss`] (a code that is not in the set
//! consulted) and [`Outcome::Gap`] (the data does not cover the question) never come from this crate. A later
//! consumer that resolves a recognition reports them in the same shape.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;

use crate::ast::Node;
use crate::captures::{CaptureProgram, ProgramShape, Walker};
use crate::diagnostic::Source;
use crate::recognition::{Rejection, ValidationResult};

static TRACES_BUILT: AtomicUsize = AtomicUsize::new(0);

/// How many traces this process has built.
pub fn traces_built() -> usize {
	TRACES_BUILT.load(Ordering::Relaxed)
}

/// The outcome of one step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
	/// The grammar node accepted, or the validator accepted.
	Pass,
	/// The grammar node did not accept: a grammar rejection.
	Fail,
	/// The validator refused values the grammar accepted: a semantic rejection.
	Rejected,
	/// A membership check found no entry. This crate never produces it.
	Miss,
	/// The data that would answer the question does not cover it. This crate never produces it.
	Gap,
	/// The replay passed its step budget before it could say.
	Limit,
}

/// How a whole trace ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TraceResult {
	/// The grammar accepted and the validator built a payload.
	Validated,
	/// The grammar accepted and the shape declares no validator.
	Accepted,
	/// The grammar accepted and the validator refused the values.
	Rejected,
	/// The grammar did not accept.
	NoMatch,
	/// The replay did not finish.
	Incomplete,
}

/// A half-open span in UTF-8 bytes. The TypeScript adapter converts it to UTF-16 code units.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Span {
	pub start: usize,
	pub end: usize,
}

/// One step of a trace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Step {
	/// The node's stable ID: `<shape>#<index>` for an item of the shape's grammar, `<shape>#validator` for the
	/// validator and `<shape>#end` for the end of the text.
	pub node: String,
	pub op: &'static str,
	/// The capture path, the term ID or the literal text, when the operator has one.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub name: Option<String>,
	/// The declaration site of the node's shape, or of the term a reference names.
	pub source: Source,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub span: Option<Span>,
	pub outcome: Outcome,
	/// The typed rejection, on a step whose outcome is [`Outcome::Rejected`].
	#[serde(skip_serializing_if = "Option::is_none")]
	pub rejection: Option<Rejection>,
}

/// The trace of one shape over one span or one text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Trace {
	pub family: String,
	pub shape: String,
	/// The recognized span. A trace of a text no grammar match covers has none.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub span: Option<Span>,
	pub steps: Vec<Step>,
	pub result: TraceResult,
}

fn built(trace: Trace) -> Trace {
	TRACES_BUILT.fetch_add(1, Ordering::Relaxed);

	trace
}

/// The items of a grammar: a sequence's own, or the node alone.
fn items(node: &Node) -> &[Node] {
	match node {
		Node::Sequence { items } => items,
		other => std::slice::from_ref(other),
	}
}

fn describe(node: &Node) -> (&'static str, Option<String>) {
	match node {
		Node::Literal { value } => ("literal", Some(value.clone())),
		Node::Class { .. } => ("class", None),
		Node::Sequence { .. } => ("sequence", None),
		Node::Choice { .. } => ("choice", None),
		Node::Optional { .. } => ("optional", None),
		Node::Repeat { .. } => ("repeat", None),
		Node::Capture { path, .. } => ("capture", Some(path.clone())),
		Node::Reference { id } => ("reference", Some(id.clone())),
		Node::Pattern { .. } => ("pattern", None),
	}
}

/// The declaration site of an item: the term a reference names, looking through a capture, or else the shape.
fn site(program: &CaptureProgram, entry: &ProgramShape, node: &Node) -> Source {
	let inner = match node {
		Node::Capture { node, .. } => node.as_ref(),
		other => other,
	};

	match inner {
		Node::Reference { id } => program
			.term_sources
			.get(id)
			.cloned()
			.unwrap_or_else(|| entry.source.clone()),
		_ => entry.source.clone(),
	}
}

fn step(program: &CaptureProgram, entry: &ProgramShape, shape: &str, index: usize, node: &Node) -> Step {
	let (op, name) = describe(node);

	Step {
		node: format!("{shape}#{index}"),
		op,
		name,
		source: site(program, entry, node),
		span: None,
		outcome: Outcome::Pass,
		rejection: None,
	}
}

fn special(entry: &ProgramShape, shape: &str, suffix: &str, op: &'static str, outcome: Outcome) -> Step {
	Step {
		node: format!("{shape}#{suffix}"),
		op,
		name: None,
		source: entry.source.clone(),
		span: None,
		outcome,
		rejection: None,
	}
}

fn single(family: &str, shape: &str, span: Option<Span>, step: Step, result: TraceResult) -> Trace {
	built(Trace {
		family: family.to_string(),
		shape: shape.to_string(),
		span,
		steps: vec![step],
		result,
	})
}

/// Replays `text[start..end]`, a span the shape's automaton accepted, and states what `validation` decided.
///
/// A shape the program does not list yields a trace with one failing step, because an artifact whose automata and
/// program disagree is a fault the trace must show.
pub(crate) fn accepted(
	family: &str,
	program: &CaptureProgram,
	shape: &str,
	text: &str,
	start: usize,
	end: usize,
	validation: &ValidationResult,
) -> Trace {
	let span = Some(Span { start, end });
	let Some(entry) = program.shapes.get(shape) else {
		let missing = Source::new("<program>", 0);

		return single(
			family,
			shape,
			span,
			Step {
				node: format!("{shape}#0"),
				op: "shape",
				name: None,
				source: missing,
				span: None,
				outcome: Outcome::Fail,
				rejection: None,
			},
			TraceResult::NoMatch,
		);
	};

	let mut walker = Walker::new(program, entry, &text[..end]);
	let nodes = items(&entry.node);
	let mut spans = Vec::with_capacity(nodes.len());
	let found = walker.trace_items(nodes, 0, start, end, &mut spans);

	if walker.limited {
		return single(
			family,
			shape,
			span,
			special(entry, shape, "0", "limit", Outcome::Limit),
			TraceResult::Incomplete,
		);
	}

	if !found {
		return single(
			family,
			shape,
			span,
			special(entry, shape, "0", "shape", Outcome::Fail),
			TraceResult::NoMatch,
		);
	}

	let mut steps: Vec<Step> = nodes
		.iter()
		.zip(&spans)
		.enumerate()
		.map(|(index, (node, &(from, to)))| {
			let mut step = step(program, entry, shape, index, node);

			step.span = Some(Span { start: from, end: to });

			step
		})
		.collect();

	let result = match (&entry.validator, validation) {
		(Some(_), ValidationResult::Validated(_)) => {
			steps.push(special(entry, shape, "validator", "validator", Outcome::Pass));
			TraceResult::Validated
		}
		(Some(_), ValidationResult::Rejected(rejection)) => {
			let mut last = special(entry, shape, "validator", "validator", Outcome::Rejected);

			last.rejection = Some(rejection.clone());
			steps.push(last);
			TraceResult::Rejected
		}
		_ => TraceResult::Accepted,
	};

	built(Trace {
		family: family.to_string(),
		shape: shape.to_string(),
		span,
		steps,
		result,
	})
}

/// What an explanation found.
pub(crate) enum Explained {
	/// The shape is not in the program.
	Unknown,
	/// The grammar accepts the whole text, so the caller builds the trace of an accepted span.
	Accepts,
	/// The grammar does not accept the whole text, or the replay did not finish.
	Trace(Trace),
}

/// Replays `text` against `shape` from offset 0 and states why the whole text is not a match, when it is not.
pub(crate) fn explain(family: &str, program: &CaptureProgram, shape: &str, text: &str) -> Explained {
	let Some(entry) = program.shapes.get(shape) else {
		return Explained::Unknown;
	};

	let mut walker = Walker::new(program, entry, text);
	let nodes = items(&entry.node);
	let mut frontier = BTreeSet::from([0usize]);
	let mut steps = Vec::with_capacity(nodes.len() + 1);

	for (index, node) in nodes.iter().enumerate() {
		let furthest = frontier.last().copied().unwrap_or(0);
		let mut reached = BTreeSet::new();

		for &from in &frontier {
			reached.extend(walker.ends_of(node, from));

			if walker.limited {
				break;
			}
		}

		let mut current = step(program, entry, shape, index, node);

		if walker.limited {
			current.outcome = Outcome::Limit;
			current.span = Some(Span {
				start: furthest,
				end: furthest,
			});
			steps.push(current);

			return Explained::Trace(built(Trace {
				family: family.to_string(),
				shape: shape.to_string(),
				span: None,
				steps,
				result: TraceResult::Incomplete,
			}));
		}

		if reached.is_empty() {
			current.outcome = Outcome::Fail;
			current.span = Some(Span {
				start: furthest,
				end: furthest,
			});
			steps.push(current);

			return Explained::Trace(built(Trace {
				family: family.to_string(),
				shape: shape.to_string(),
				span: None,
				steps,
				result: TraceResult::NoMatch,
			}));
		}

		steps.push(current);
		frontier = reached;
	}

	if frontier.contains(&text.len()) {
		return Explained::Accepts;
	}

	let furthest = frontier.last().copied().unwrap_or(0);
	let mut last = special(entry, shape, "end", "end", Outcome::Fail);

	last.span = Some(Span {
		start: furthest,
		end: text.len(),
	});
	steps.push(last);

	Explained::Trace(built(Trace {
		family: family.to_string(),
		shape: shape.to_string(),
		span: None,
		steps,
		result: TraceResult::NoMatch,
	}))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn outcomes_and_results_serialize_in_snake_case() {
		assert_eq!(serde_json::to_string(&Outcome::Pass).unwrap(), r#""pass""#);
		assert_eq!(serde_json::to_string(&Outcome::Miss).unwrap(), r#""miss""#);
		assert_eq!(serde_json::to_string(&Outcome::Gap).unwrap(), r#""gap""#);
		assert_eq!(serde_json::to_string(&Outcome::Rejected).unwrap(), r#""rejected""#);
		assert_eq!(serde_json::to_string(&TraceResult::NoMatch).unwrap(), r#""no_match""#);
	}

	#[test]
	fn a_membership_miss_and_a_coverage_gap_are_representable() {
		let step = |outcome| Step {
			node: "identifier.numeric#lookup".to_string(),
			op: "lookup",
			name: None,
			source: Source::new("a.rs", 1),
			span: None,
			outcome,
			rejection: None,
		};

		for (outcome, text) in [(Outcome::Miss, "miss"), (Outcome::Gap, "gap")] {
			assert!(serde_json::to_string(&step(outcome))
				.unwrap()
				.contains(&format!(r#""outcome":"{text}""#)));
		}
	}
}
