// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Source locations and the diagnostics validation reports against them.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::panic::Location;

/// The file and line of a declaration. A builder records its caller's location, so a diagnostic points at the line
/// that declared the grammar.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Source {
	pub file: String,
	pub line: u32,
}

impl Source {
	/// The location of the caller of the nearest function that is not `#[track_caller]`.
	#[track_caller]
	pub fn here() -> Self {
		let location = Location::caller();

		Source {
			file: location.file().replace('\\', "/"),
			line: location.line(),
		}
	}

	pub fn new(file: impl Into<String>, line: u32) -> Self {
		Source {
			file: file.into(),
			line,
		}
	}
}

impl fmt::Display for Source {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(formatter, "{}:{}", self.file, self.line)
	}
}

/// What a diagnostic refuses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum DiagnosticKind {
	/// A named term reaches itself through references.
	ReferenceCycle,
	/// A reference names no declared term.
	UnknownReference,
	/// Two declarations share one identifier.
	RepeatedID,
	/// An operator or a regular-expression construct the grammar does not support.
	UnsupportedOperator,
	/// An operand outside the operator's domain: an empty class, a reversed range, impossible repeat bounds.
	InvalidOperand,
	/// A terminal that can match the empty string.
	EmptyMatch,
	/// A capture path that is not a dotted lowercase name, or a schema whose paths conflict.
	MalformedCapturePath,
	/// A capture in the grammar that the schema does not declare, or a declared capture the grammar never makes.
	CaptureSchemaMismatch,
	/// An identifier that does not follow the naming rule.
	MalformedID,
	/// A shape declared without a grammar.
	MissingGrammar,
	/// IR text that is not valid, canonical IR.
	MalformedIR,
	/// A grammar that grows past a configured compiler limit on every backend.
	LimitExceeded,
}

impl DiagnosticKind {
	pub fn as_str(self) -> &'static str {
		match self {
			DiagnosticKind::ReferenceCycle => "reference-cycle",
			DiagnosticKind::UnknownReference => "unknown-reference",
			DiagnosticKind::RepeatedID => "repeated-id",
			DiagnosticKind::UnsupportedOperator => "unsupported-operator",
			DiagnosticKind::InvalidOperand => "invalid-operand",
			DiagnosticKind::EmptyMatch => "empty-match",
			DiagnosticKind::MalformedCapturePath => "malformed-capture-path",
			DiagnosticKind::CaptureSchemaMismatch => "capture-schema-mismatch",
			DiagnosticKind::MalformedID => "malformed-id",
			DiagnosticKind::MissingGrammar => "missing-grammar",
			DiagnosticKind::MalformedIR => "malformed-ir",
			DiagnosticKind::LimitExceeded => "limit-exceeded",
		}
	}
}

/// One refusal, with the source file and line of the grammar it refuses.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Diagnostic {
	pub source: Source,
	pub kind: DiagnosticKind,
	pub message: String,
}

impl Diagnostic {
	pub fn new(kind: DiagnosticKind, source: &Source, message: impl Into<String>) -> Self {
		Diagnostic {
			source: source.clone(),
			kind,
			message: message.into(),
		}
	}
}

impl fmt::Display for Diagnostic {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(formatter, "{}: {}: {}", self.source, self.kind.as_str(), self.message)
	}
}

impl std::error::Error for Diagnostic {}

/// Renders diagnostics one per line.
pub fn render(diagnostics: &[Diagnostic]) -> String {
	diagnostics.iter().map(|diagnostic| format!("{diagnostic}\n")).collect()
}
