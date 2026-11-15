// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The grammar half of `@mailwoman/recognize`: a declarative AST, the builders grammar modules are written with,
//! validation that refuses a malformed grammar at its source line, and the deterministic JSON intermediate
//! representation (IR) a later phase compiles into automata.

pub mod ast;
pub mod diagnostic;
pub mod family;
pub mod grammars;
pub mod ids;
pub mod ir;
pub mod validate;

pub use ast::{
	capture, choice, class, literal, negated_class, one_or_more, optional, pattern, reference, repeat, repeat_from,
	sequence, zero_or_more, ClassRange, Node, OPERATORS,
};
pub use diagnostic::{render, Diagnostic, DiagnosticKind, Source};
pub use family::{shape, term, Family, ShapeBuilder};
pub use ids::{HandlerID, ValidatorID};
pub use ir::{AmbiguityPolicy, CaptureSpec, CaptureType, IrDocument, Scope, Shape, Term, IR_FORMAT, IR_VERSION};
