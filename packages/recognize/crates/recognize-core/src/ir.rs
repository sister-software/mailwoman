// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The versioned JSON intermediate representation of one grammar family.
//!
//! The content is deterministic: terms and shapes sort by ID, class ranges are merged, and keys follow struct order.
//! The content hash is the SHA-256 of the compact serialization with `hash` set to the empty string. The pretty
//! text [`IrDocument::to_json`] writes is a convenience layout. The committed file is that text passed through the
//! repository's formatter, and reading it back checks the hash rather than the layout.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ast::{canonical_ranges, Node, OPERATORS};
use crate::diagnostic::{Diagnostic, DiagnosticKind, Source};
use crate::ids::{HandlerID, ValidatorID};
use crate::validate::validate;
use sha2::{Digest, Sha256};

/// The `format` field of every IR document.
pub const IR_FORMAT: &str = "mailwoman.recognize.ir";

/// The IR version this crate writes and reads.
pub const IR_VERSION: u32 = 1;

/// Where in the input a shape may match.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
	/// The whole input only.
	Whole,
	/// A span inside the input only.
	Embedded,
	/// Either the whole input or a span inside it.
	WholeOrEmbedded,
}

/// What a shape declares about overlapping other shapes on the same span.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "policy", rename_all = "snake_case")]
pub enum AmbiguityPolicy {
	/// No other shape may match the span the shape matches.
	Exclusive,
	/// The shape intentionally overlaps the listed shapes, which may belong to other families.
	MayOverlap { with: Vec<String> },
}

/// The value type of a capture.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureType {
	Text,
	Integer,
	Decimal,
}

/// One declared capture of a shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureSpec {
	pub path: String,
	#[serde(rename = "type")]
	pub kind: CaptureType,
}

/// A named, reusable grammar. A term holds no captures and can be nullable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Term {
	pub id: String,
	pub grammar: Node,
	pub source: Source,
}

/// A terminal: a named language recognition reports.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Shape {
	pub id: String,
	pub grammar: Node,
	pub captures: Vec<CaptureSpec>,
	pub scope: Scope,
	pub validator: Option<ValidatorID>,
	pub handler: Option<HandlerID>,
	pub ambiguity: AmbiguityPolicy,
	pub source: Source,
}

/// One family's IR.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IrDocument {
	pub format: String,
	pub version: u32,
	pub hash: String,
	pub family: String,
	pub terms: Vec<Term>,
	pub shapes: Vec<Shape>,
}

impl IrDocument {
	/// Sorts everything the builder may have left in authored order and merges class ranges.
	pub fn canonicalize(&mut self) {
		self.terms.sort_by(|a, b| a.id.cmp(&b.id));
		self.shapes.sort_by(|a, b| a.id.cmp(&b.id));

		let mut normalize = |node: &mut Node| {
			if let Node::Class { ranges, .. } = node {
				*ranges = canonical_ranges(ranges);
			}
		};

		for term in &mut self.terms {
			term.grammar.visit_mut(&mut normalize);
		}

		for shape in &mut self.shapes {
			shape.grammar.visit_mut(&mut normalize);
			shape.captures.sort_by(|a, b| a.path.cmp(&b.path));

			if let AmbiguityPolicy::MayOverlap { with } = &mut shape.ambiguity {
				with.sort();
				with.dedup();
			}
		}
	}

	/// The hash the document's content has: SHA-256 of the compact serialization with `hash` empty.
	pub fn content_hash(&self) -> String {
		let mut blank = self.clone();

		blank.hash = String::new();

		let digest = Sha256::digest(serde_json::to_vec(&blank).expect("an IR document always serializes"));

		digest.iter().map(|byte| format!("{byte:02x}")).collect()
	}

	/// Canonicalizes the document and fills `hash`.
	pub fn seal(mut self) -> Self {
		self.canonicalize();
		self.hash = self.content_hash();

		self
	}

	/// The committed text: tab-indented JSON with a trailing newline, laid out as [`crate::render`] describes.
	pub fn to_json(&self) -> String {
		let mut text = serde_json::to_string_pretty(self).expect("an IR document always serializes");

		text.push('\n');

		text
	}

	/// Reads IR text and refuses what is not valid IR: an unsupported operator, a wrong format or version, a grammar
	/// that fails validation, or a stored `hash` that differs from the hash of the content as read. The layout of the
	/// text is not checked, so a formatter may rewrite the committed file. A reordered or edited document no longer
	/// matches its hash.
	pub fn from_json(text: &str) -> Result<IrDocument, Vec<Diagnostic>> {
		let unreadable = |message: String, line: usize| {
			vec![Diagnostic::new(
				DiagnosticKind::MalformedIR,
				&Source::new("<ir>", line as u32),
				message,
			)]
		};

		let value: Value = serde_json::from_str(text).map_err(|error| unreadable(error.to_string(), error.line()))?;

		let operators = unsupported_operators(&value);

		if !operators.is_empty() {
			return Err(operators);
		}

		let document: IrDocument = serde_json::from_value(value).map_err(|error| unreadable(error.to_string(), 0))?;
		let anchor = document
			.terms
			.first()
			.map(|term| term.source.clone())
			.unwrap_or_else(|| Source::new("<ir>", 0));
		let mut diagnostics = Vec::new();

		if document.format != IR_FORMAT {
			diagnostics.push(Diagnostic::new(
				DiagnosticKind::MalformedIR,
				&anchor,
				format!("format is `{}`, expected `{IR_FORMAT}`", document.format),
			));
		}

		if document.version != IR_VERSION {
			diagnostics.push(Diagnostic::new(
				DiagnosticKind::MalformedIR,
				&anchor,
				format!("version is {}, this reader implements {IR_VERSION}", document.version),
			));
		}

		if !diagnostics.is_empty() {
			return Err(diagnostics);
		}

		diagnostics.extend(validate(&document.family, &anchor, &document.terms, &document.shapes));

		if !diagnostics.is_empty() {
			diagnostics.sort();

			return Err(diagnostics);
		}

		if document.hash != document.content_hash() {
			return Err(vec![Diagnostic::new(
				DiagnosticKind::MalformedIR,
				&anchor,
				format!(
					"hash `{}` does not match the content's hash `{}`",
					document.hash,
					document.content_hash()
				),
			)]);
		}

		Ok(document)
	}
}

/// Finds every `op` outside [`OPERATORS`], reporting each against the term or shape that holds it.
fn unsupported_operators(document: &Value) -> Vec<Diagnostic> {
	let mut found = Vec::new();

	for section in ["terms", "shapes"] {
		let Some(entries) = document.get(section).and_then(Value::as_array) else {
			continue;
		};

		for entry in entries {
			let source = entry
				.get("source")
				.and_then(|source| {
					Some(Source::new(
						source.get("file")?.as_str()?,
						u32::try_from(source.get("line")?.as_u64()?).ok()?,
					))
				})
				.unwrap_or_else(|| Source::new("<ir>", 0));

			if let Some(grammar) = entry.get("grammar") {
				scan_operators(grammar, &source, &mut found);
			}
		}
	}

	found.sort();
	found
}

fn scan_operators(node: &Value, source: &Source, found: &mut Vec<Diagnostic>) {
	let Some(object) = node.as_object() else { return };

	match object.get("op").and_then(Value::as_str) {
		Some(op) if OPERATORS.contains(&op) => {}
		Some(op) => found.push(Diagnostic::new(
			DiagnosticKind::UnsupportedOperator,
			source,
			format!("operator `{op}` is not one of {}", OPERATORS.join(", ")),
		)),
		None => found.push(Diagnostic::new(
			DiagnosticKind::UnsupportedOperator,
			source,
			"a grammar node has no `op`",
		)),
	}

	if let Some(child) = object.get("node") {
		scan_operators(child, source, found);
	}

	for key in ["items", "alternatives"] {
		if let Some(children) = object.get(key).and_then(Value::as_array) {
			children.iter().for_each(|child| scan_operators(child, source, found));
		}
	}
}
