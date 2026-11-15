// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! `recognize-core` holds two halves of `@mailwoman/recognize`.
//!
//! The grammar half is a declarative AST, the builders grammar modules are written with, validation that refuses a
//! malformed grammar at its source line, and the deterministic JSON intermediate representation (IR) the compiler
//! reads. The runtime half is the [`Engine`], which loads compiled family artifacts ([`artifact`]) and reports which
//! shapes a text contains. The compiler is a separate crate, `recognize-build`: this crate links only the search half of
//! `regex-automata` (`dfa-search`), so a binary that links it carries no regex parser and no automaton builder.
//!
//! # Span policy
//!
//! Offsets are UTF-8 byte offsets, and no span splits a codepoint: a span starts at the first byte of a character and
//! ends after the last byte of one.
//!
//! For one shape and one text, call a span `start..end` a match when the shape's grammar accepts exactly
//! `text[start..end]`. A shape that matches at several lengths from one start, or at several starts, has many matches.
//! The engine reports a match as a candidate unless another match of the same shape contains it, which means the other
//! match starts at or before `start` and ends at or after `end`. In plain terms:
//!
//! * From one start, only the longest match is reported. `\d+` on `"12345"` reports `0..5` and none of `0..1`,
//!   `0..2`, `0..3` or `0..4`.
//! * A match inside a longer match of the same shape is dropped. `\d+` on `"12345"` does not report `1..5` or `4..5`.
//! * Matches that overlap without one containing the other are all reported. `\d{3}` on `"12345"` reports `0..3`,
//!   `1..4` and `2..5`.
//! * Different shapes never hide each other. Nested spans, spans that end at the same byte and spans that start at the
//!   same byte are all reported, one candidate per shape. `\d+` and `\d{2}` on `"123"` report `0..3` for the first
//!   and `0..2` and `1..3` for the second.
//!
//! The scope a shape declares decides which of those spans it may report:
//!
//! * [`Scope::Whole`] reports `0..len` only, and only when the shape matches the entire text. It is searched by the
//!   anchored whole-input automaton.
//! * [`Scope::Embedded`] reports spans inside the text and never the span `0..len`. A shape that matches the entire
//!   text and nothing smaller therefore reports nothing.
//! * [`Scope::WholeOrEmbedded`] reports both: the whole text when it matches, and every embedded candidate, with
//!   `0..len` reported once.
//!
//! A candidate is `(start, end, family, shape)`, and a search returns them sorted by that tuple. The empty text has no
//! candidate, and a grammar that can match the empty string is refused at build time, so no candidate is empty.
//!
//! The search is complete under this policy: the engine tries every character boundary as a start, and
//! `MatchKind::All` keeps every pattern that accepts at each end position. Its cost is the number of starts times the
//! length each start scans before the automaton dies, so a family's `inputLimitBytes` bounds the input.

pub mod artifact;
pub mod ast;
pub mod diagnostic;
pub mod engine;
pub mod family;
pub mod grammars;
pub mod ids;
pub mod ir;
pub mod validate;

pub use artifact::{ArtifactError, Backend, Role};
pub use ast::{
	capture, choice, class, literal, negated_class, one_or_more, optional, pattern, reference, repeat, repeat_from,
	sequence, zero_or_more, ClassRange, Node, OPERATORS,
};
pub use diagnostic::{render, Diagnostic, DiagnosticKind, Source};
pub use engine::{Candidate, Engine, Expected, SearchError};
pub use family::{shape, term, Family, ShapeBuilder};
pub use ids::{HandlerID, ValidatorID};
pub use ir::{AmbiguityPolicy, CaptureSpec, CaptureType, IrDocument, Scope, Shape, Term, IR_FORMAT, IR_VERSION};
