// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Recognitions: a candidate span with the shape's kind and the outcome of validating its captures.
//!
//! The three claims stay separate. A candidate says a shape's grammar accepts a span. Validation says the span's
//! captured values obey the shape's constraints, and its result is a typed payload or a typed rejection. Resolution,
//! which asks whether a code is allocated or a place is known, belongs to the caller.

use serde::Serialize;

use crate::declared::{Kind, Payload};
use crate::engine::Candidate;

/// Why a span's captured values failed validation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Rejection {
	/// A stable machine-readable code, such as `not_a_decimal`.
	pub code: &'static str,
	/// The capture the code is about, when it is about one.
	pub capture: Option<String>,
	pub message: String,
}

impl Rejection {
	pub fn new(code: &'static str, capture: Option<&str>, message: impl Into<String>) -> Self {
		Rejection {
			code,
			capture: capture.map(str::to_string),
			message: message.into(),
		}
	}
}

/// The outcome of validating one candidate.
#[derive(Clone, Debug, PartialEq)]
pub enum ValidationResult {
	/// The shape declares no validator, so the candidate carries its span and raw text only.
	Unvalidated,
	/// The validator accepted the captured values and built the typed payload.
	Validated(Payload),
	/// The span matched the shape's grammar and its values failed validation.
	Rejected(Rejection),
}

/// One recognized span: the candidate, its kind, and its validation.
#[derive(Clone, Debug, PartialEq)]
pub struct Recognition<'engine, 'text> {
	/// The family, the shape and the UTF-8 byte span.
	pub candidate: Candidate<'engine>,
	/// The raw text of the span.
	pub text: &'text str,
	/// The shape's closed kind, or `None` when the crate holds no declarations for the candidate's family.
	pub kind: Option<Kind>,
	pub validation: ValidationResult,
}
