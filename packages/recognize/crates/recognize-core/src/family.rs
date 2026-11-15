// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The builders a grammar module writes against: terms, shapes and the family that groups them.
//!
//! Each constructor is `#[track_caller]`, so the IR records the file and line of the declaration and a diagnostic
//! points at the grammar's own source.

use crate::ast::{pattern, Node};
use crate::diagnostic::{Diagnostic, DiagnosticKind, Source};
use crate::ids::{HandlerID, ValidatorID};
use crate::ir::{AmbiguityPolicy, CaptureSpec, CaptureType, IrDocument, Scope, Shape, Term, IR_FORMAT, IR_VERSION};
use crate::validate::validate;

/// Declares a named, reusable grammar.
#[track_caller]
pub fn term(id: &str, grammar: Node) -> Term {
	Term {
		id: id.to_string(),
		grammar,
		source: Source::here(),
	}
}

/// Starts a shape declaration. The shape matches the whole input only, and no other shape may overlap it, until the
/// builder says otherwise.
#[track_caller]
pub fn shape(id: &str) -> ShapeBuilder {
	ShapeBuilder {
		id: id.to_string(),
		grammar: None,
		captures: Vec::new(),
		scope: Scope::Whole,
		validator: None,
		handler: None,
		ambiguity: AmbiguityPolicy::Exclusive,
		unreachable: None,
		partition: None,
		source: Source::here(),
	}
}

/// A shape under construction. The identifiers stay text until the family builds, so a malformed one reports its
/// declaration's line.
#[derive(Clone, Debug)]
pub struct ShapeBuilder {
	id: String,
	grammar: Option<Node>,
	captures: Vec<CaptureSpec>,
	scope: Scope,
	validator: Option<String>,
	handler: Option<String>,
	ambiguity: AmbiguityPolicy,
	unreachable: Option<String>,
	partition: Option<String>,
	source: Source,
}

impl ShapeBuilder {
	/// Sets the grammar.
	pub fn grammar(mut self, grammar: Node) -> Self {
		self.grammar = Some(grammar);
		self
	}

	/// Sets the grammar to a regular-expression string, stored as a string node.
	pub fn regex(self, regex: &str) -> Self {
		self.grammar(pattern(regex))
	}

	/// Declares a capture and its value type.
	pub fn capture(mut self, path: &str, kind: CaptureType) -> Self {
		self.captures.push(CaptureSpec {
			path: path.to_string(),
			kind,
		});
		self
	}

	/// Sets where the shape may match.
	pub fn scope(mut self, scope: Scope) -> Self {
		self.scope = scope;
		self
	}

	/// Makes the shape a piece of the partition `name`: sets the scope to [`Scope::Partition`] and names the partition.
	pub fn partition(mut self, name: &str) -> Self {
		self.scope = Scope::Partition;
		self.partition = Some(name.to_string());
		self
	}

	/// Names the validator that checks the captured values.
	pub fn validator(mut self, id: &str) -> Self {
		self.validator = Some(id.to_string());
		self
	}

	/// Names the handler that receives the validated recognition.
	pub fn handler(mut self, id: &str) -> Self {
		self.handler = Some(id.to_string());
		self
	}

	/// Declares the shapes this one intentionally overlaps.
	pub fn may_overlap(mut self, with: &[&str]) -> Self {
		self.ambiguity = AmbiguityPolicy::MayOverlap {
			with: with.iter().map(|id| id.to_string()).collect(),
		};
		self
	}

	/// Declares the shape unreachable, with the reason. The compiler then reports the shape as unreachable without
	/// failing the build. A declaration on a shape the compiler finds reachable is itself refused.
	pub fn declare_unreachable(mut self, reason: &str) -> Self {
		self.unreachable = Some(reason.to_string());
		self
	}
}

fn typed_id<T>(
	kind: &str,
	shape_id: &str,
	source: &Source,
	text: Option<String>,
	make: fn(&str) -> Result<T, String>,
	diagnostics: &mut Vec<Diagnostic>,
) -> Option<T> {
	let text = text?;

	match make(&text) {
		Ok(value) => Some(value),
		Err(message) => {
			diagnostics.push(Diagnostic::new(
				DiagnosticKind::MalformedID,
				source,
				format!("shape `{shape_id}` {kind}: {message}"),
			));

			None
		}
	}
}

/// A family: the shapes and terms that compile into one artifact.
#[derive(Clone, Debug)]
pub struct Family {
	id: String,
	terms: Vec<Term>,
	shapes: Vec<ShapeBuilder>,
	source: Source,
}

impl Family {
	/// Starts the family `id`. The declaration's line anchors diagnostics about the family itself.
	#[track_caller]
	pub fn new(id: &str) -> Self {
		Family {
			id: id.to_string(),
			terms: Vec::new(),
			shapes: Vec::new(),
			source: Source::here(),
		}
	}

	/// Adds a term.
	pub fn term(mut self, term: Term) -> Self {
		self.terms.push(term);
		self
	}

	/// Adds a shape, which makes it a member of this family.
	pub fn shape(mut self, shape: ShapeBuilder) -> Self {
		self.shapes.push(shape);
		self
	}

	/// Validates the family and renders its sealed IR document, or returns every diagnostic.
	pub fn build(self) -> Result<IrDocument, Vec<Diagnostic>> {
		let mut diagnostics = Vec::new();
		let mut shapes = Vec::new();

		for builder in self.shapes {
			let ShapeBuilder {
				id,
				grammar,
				captures,
				scope,
				validator,
				handler,
				ambiguity,
				unreachable,
				partition,
				source,
			} = builder;

			let Some(grammar) = grammar else {
				diagnostics.push(Diagnostic::new(
					DiagnosticKind::MissingGrammar,
					&source,
					format!("shape `{id}` declares no grammar"),
				));

				continue;
			};

			let validator = typed_id("validator", &id, &source, validator, ValidatorID::new, &mut diagnostics);
			let handler = typed_id("handler", &id, &source, handler, HandlerID::new, &mut diagnostics);

			shapes.push(Shape {
				id,
				grammar,
				captures,
				scope,
				validator,
				handler,
				ambiguity,
				unreachable,
				partition,
				source,
			});
		}

		diagnostics.extend(validate(&self.id, &self.source, &self.terms, &shapes));

		if !diagnostics.is_empty() {
			diagnostics.sort();
			diagnostics.dedup();

			return Err(diagnostics);
		}

		Ok(IrDocument {
			format: IR_FORMAT.to_string(),
			version: IR_VERSION,
			hash: String::new(),
			family: self.id,
			terms: self.terms,
			shapes,
		}
		.seal())
	}
}
